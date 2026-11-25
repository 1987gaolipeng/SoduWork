"""Read the executing Codex CLI's model catalog in its bound account without starting a turn."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import threading
import time

from .acp_process import OwnedProcessGroup, close_process
from . import cli_account_auth
from .native_history_archive import stamp

_TIMEOUT = 5.0
_MAX_OUTPUT = 24 * 1024 * 1024


_MAX_CACHE_BYTES = 16 * 1024 * 1024


class UpgradeRequired(Exception):
    """The selected CLI cannot provide the account catalog used by the picker."""


class _CommandRejected(ValueError):
    pass


def _cache(home: str) -> tuple[dict, tuple]:
    target = Path(home) / "models_cache.json"
    info = target.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_reparse_tag", 0) or target.resolve(strict=True) != target:
        raise ValueError("Unexpected Codex catalog location")
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > _MAX_CACHE_BYTES:
        raise ValueError("Unusable Codex catalog")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(target, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        # Windows fstat and lstat can disagree about ctime after an in-place
        # write. Compare file identity across views and changes within each view.
        if not os.path.samestat(opened, info) or (opened.st_size, opened.st_mtime_ns) != (info.st_size, info.st_mtime_ns):
            raise ValueError("Codex catalog replaced")
        content = stream.read(info.st_size + 1)
        if (len(content) != info.st_size or stamp(os.fstat(stream.fileno())) != stamp(opened)
                or target.resolve(strict=True) != target or stamp(target.lstat()) != stamp(info)):
            raise ValueError("Codex catalog changed")
    try:
        value = json.loads(content)
    except (ValueError, RecursionError):
        # A regular but corrupt cache can be refreshed by its owning native CLI.
        value = {}
    return (value if isinstance(value, dict) else {}), stamp(info)


def _environment(scratch: str, home: str = "") -> dict[str, str]:
    # Let the native CLI use its own account store and OS proxy/certificates.
    # No API key, model override, plugin environment, or project config is forwarded.
    keys = ("PATH", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
            "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY",
            "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy")
    env = {key: os.environ[key] for key in keys if key in os.environ}
    env.update(CODEX_HOME=home or scratch, CODEX_SQLITE_HOME=scratch, TMPDIR=scratch, TMP=scratch, TEMP=scratch)
    return env


def _run(executable: str, args: list[str], env: dict, deadline: float, limit: int, *, status_output=False) -> bytes:
    if time.monotonic() >= deadline:
        raise TimeoutError
    flags = ({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True})
    proc = subprocess.Popen([executable, *args], cwd=env["TMPDIR"], env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT if status_output else subprocess.DEVNULL, **flags)
    ownership = OwnedProcessGroup(proc.pid) if os.name != "nt" else None
    output = []

    def read():
        try:
            output.append(proc.stdout.read(limit + 1))
        except OSError:
            pass

    reader = threading.Thread(target=read, daemon=True, name="codex-catalog-stdout")
    reader.start()
    try:
        reader.join(max(0, deadline - time.monotonic()))
        if reader.is_alive() or not output or len(output[0]) > limit:
            raise ValueError("Codex catalog probe exceeded its bounds")
        code = proc.wait(timeout=max(0, deadline - time.monotonic()))
        if code:
            raise _CommandRejected(code)
        return output[0]
    finally:
        close_process(proc, [reader], ownership)


def _model_id(row: dict):
    return row.get("slug") or row.get("id") or row.get("name")


def _index(rows: list) -> dict:
    result = {}
    for row in rows:
        if isinstance(row, dict) and isinstance(model := _model_id(row), str):
            result.setdefault(model, row)
    return result


def _matches_version(cached: dict, reported: str) -> bool:
    version = cached.get("client_version") or cached.get("clientVersion")
    if not isinstance(version, str) or not version:
        return False
    actual = reported.removeprefix("codex-cli ").strip()
    # The desktop CLI writes major.minor.patch even for its prerelease builds.
    core = re.fullmatch(r"(\d+\.\d+\.\d+)(?:-[\w.-]+)?(?:\+[\w.-]+)?", actual, re.ASCII)
    return version == actual or bool(core and version == core[1])


def _catalog_command_missing(executable: str, env: dict, deadline: float, bundled: bool) -> bool:
    if bundled:
        help_text = _run(executable, ["debug", "models", "--help"], env, deadline, 65536)
        return b"Usage:" in help_text and b"--bundled" not in help_text
    command = b"models"
    try:
        help_text = _run(executable, ["debug", "--help"], env, deadline, 65536)
    except _CommandRejected as exc:
        if exc.args != (2,):
            raise
        command = b"debug"
        help_text = _run(executable, ["--help"], env, deadline, 65536)
    return b"Commands:" in help_text and not re.search(rb"(?m)^\s+" + command + rb"(?:\s|$)", help_text)


def _rows(executable: str, env: dict, deadline: float, reported: str, *, bundled: bool) -> list:
    args = ["debug", "models"] + (["--bundled"] if bundled else [])
    try:
        data = json.loads(_run(executable, args, env, deadline, _MAX_OUTPUT))
    except _CommandRejected as exc:
        # Confirm the unsupported syntax before updating an installation on a read failure.
        if exc.args == (2,) and _catalog_command_missing(executable, env, deadline, bundled):
            raise UpgradeRequired(reported) from exc
        raise
    if not isinstance(data, dict) or not isinstance(data.get("models"), list):
        raise ValueError("Unexpected Codex catalog")
    return data["models"]


def _used_cache(account: dict, effective: dict, bundled: dict) -> bool:
    # An unchanged cache can belong to a previous login in the same directory.
    # Look for a menu or metadata change actually applied by this native CLI.
    applied = False
    for model, row in account.items():
        active = effective.get(model)
        if active is None:
            if not row.get("hidden") and row.get("visibility") in (None, "", "list"):
                return False
            continue
        baseline = bundled.get(model)
        if baseline is None:
            applied = True
            continue
        for key in ("display_name", "visibility", "hidden", "default_reasoning_level"):
            if key in row and key in active and baseline.get(key) != row[key]:
                if active[key] != row[key]:
                    return False
                applied = True
    # Some native versions replace the bundled catalog with the service list
    # instead of overlaying it. Removing a bundled entry is observable too.
    return applied or bool(bundled.keys() - effective.keys() - account.keys())


def _default_route(executable: str, env: dict, deadline: float, check_default: bool) -> tuple[None, str]:
    # Native login status is local, may use stderr, and shares the catalog's total time budget.
    if check_default:
        def run(command, args):
            output = _run(command, args, env, deadline, 4096, status_output=True)
            return 0, output.decode("utf-8", "replace")
        if cli_account_auth.probe("codex", executable, runner=run)[0] == "authed":
            return None, "codex-native-default"
    return None, ""


def discover(executable: str, home: str, *, check_default: bool = False) -> tuple[list | None, str]:
    """Only expose service-reported entries accepted by the executing native CLI."""
    if (not executable or (os.name == "nt" and not executable.lower().endswith(".exe"))
            or not os.path.isdir(home) or os.path.normcase(os.path.realpath(home)) != os.path.normcase(home)):
        return None, ""
    try:
        try:
            before, before_stamp = _cache(home)
        except FileNotFoundError:
            before, before_stamp = {}, None
        with tempfile.TemporaryDirectory(prefix="soduwork-codex-models-") as scratch:
            env = _environment(scratch, home)
            deadline = time.monotonic() + _TIMEOUT
            reported = _run(executable, ["--version"], env, deadline, 1024).decode().strip()
            try:
                effective = _index(_rows(executable, env, deadline, reported, bundled=False))
            except _CommandRejected as exc:
                if exc.args != (1,):
                    raise
                return _default_route(executable, env, deadline, check_default)
            try:
                observed, after_stamp = _cache(home)
            except FileNotFoundError:
                if before_stamp is not None:
                    return None, ""
                return _default_route(executable, env, deadline, check_default)
            if before.get("identity") and before["identity"] != observed.get("identity"):
                return None, ""
            if not _matches_version(observed, reported) or not isinstance(observed.get("models"), list):
                return _default_route(executable, env, deadline, check_default)
            account = _index(observed["models"])
            fetched_at = observed.get("fetched_at")
            refreshed = (before_stamp != after_stamp and isinstance(fetched_at, str) and bool(fetched_at)
                         and before.get("fetched_at") != fetched_at)
            if not refreshed:
                # Compare against the same CLI's credential-free default menu.
                isolated = _environment(scratch)
                bundled = _index(_rows(executable, isolated, deadline, reported, bundled=True))
                if not _used_cache(account, effective, bundled):
                    return _default_route(executable, env, deadline, check_default)
            if stamp((Path(home) / "models_cache.json").lstat()) != after_stamp:
                return None, ""
            # Preserve account visibility even if the native menu also contains
            # a bundled entry with the same id. A menu alone proves no access.
            return [effective[model] for model, row in account.items() if model in effective
                    and not row.get("hidden") and row.get("visibility") in (None, "", "list")], "codex-native"
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        return None, ""
