"""Prepare native OpenCode plugin dependencies without Node, models or personal state."""
from __future__ import annotations

import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import urlsplit

from . import managed_agent_network
from .acp_process import OwnedProcessGroup, close_process


TIMEOUT = 120
_NAMES = ("package.json", "package-lock.json", "node_modules")
_RECEIPT = ".soduwork-dependencies.json"
_MISSING = "OpenCode 执行依赖尚未准备完整，请点「装上」或「重装/更新」修复。"
_FAILED = "OpenCode 执行依赖准备失败，请检查网络或系统代理后重试；本次未完成安装。"
_TIMED_OUT = "OpenCode 执行依赖准备超时，请检查网络或系统代理后重试；本次未完成安装。"


def _config(data_root) -> Path:
    root = Path(data_root).resolve()
    config = root / "agents" / "opencode" / "config" / "opencode"
    if not config.resolve().is_relative_to(root):
        raise RuntimeError(_FAILED)
    return config


def _json(path: Path):
    with path.open("rb") as stream:
        raw = stream.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise RuntimeError(_FAILED)
    return json.loads(raw)


def _path(root: Path, relative: str) -> Path:
    value = PurePosixPath(relative)
    if ("\\" in relative or value.is_absolute() or ".." in value.parts
            or not value.parts or ":" in relative):
        raise RuntimeError(_FAILED)
    target = root.joinpath(*value.parts)
    if target.is_symlink() or not target.resolve().is_relative_to(root.resolve()):
        raise RuntimeError(_FAILED)
    return target


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _entries(value):
    if isinstance(value, str):
        if value.startswith("./") and "*" not in value:
            yield value
    elif isinstance(value, dict):
        for nested in value.values():
            yield from _entries(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _entries(nested)


def _validate(config: Path, version: str) -> dict:
    package, lock = _json(config / "package.json"), _json(config / "package-lock.json")
    rows = lock.get("packages") or {}
    expected = {"@opencode-ai/plugin": version}
    if (lock.get("lockfileVersion") not in {2, 3} or len(rows) > 4096
            or package.get("dependencies") != expected
            or (rows.get("") or {}).get("dependencies") != expected):
        raise RuntimeError(_FAILED)
    installed = {}
    files = {}
    for relative, row in rows.items():
        if not relative:
            continue
        target = _path(config, relative)
        if not relative.startswith("node_modules/") or row.get("link"):
            raise RuntimeError(_FAILED)
        if not target.exists() and row.get("optional"):
            continue
        manifest_path = target / "package.json"
        manifest = _json(manifest_path)
        if (not row.get("version") or manifest.get("version") != row["version"]
                or not re.fullmatch(r"sha(?:256|384|512)-[A-Za-z0-9+/]+=*", str(row.get("integrity") or ""))):
            raise RuntimeError(_FAILED)
        installed[relative] = row
        files[relative + "/package.json"] = _digest(manifest_path)
        if relative in {"node_modules/@opencode-ai/plugin", "node_modules/@opencode-ai/sdk"}:
            if manifest.get("name") != relative.removeprefix("node_modules/") or row["version"] != version:
                raise RuntimeError(_FAILED)
            entries = set(_entries(manifest.get("exports")))
            if manifest.get("main"):
                entries.add("./" + manifest["main"].removeprefix("./"))
            if not entries:
                raise RuntimeError(_FAILED)
            for entry in entries:
                path = _path(target, entry)
                if not path.is_file() or path.stat().st_size == 0:
                    raise RuntimeError(_FAILED)
                files[path.relative_to(config).as_posix()] = _digest(path)
    for name in ("@opencode-ai/plugin", "@opencode-ai/sdk"):
        if "node_modules/" + name not in installed:
            raise RuntimeError(_FAILED)
    # npm hoists most dependencies but can also use nested node_modules trees.
    for relative, row in installed.items():
        for dependency in (row.get("dependencies") or {}):
            if dependency in (row.get("optionalDependencies") or {}):
                continue
            cursor = config / relative
            found = False
            while cursor.is_relative_to(config):
                candidate = (cursor / "node_modules" / dependency).relative_to(config).as_posix()
                if candidate in installed:
                    found = True
                    break
                if cursor == config:
                    break
                cursor = cursor.parent
            if not found:
                raise RuntimeError(_FAILED)
    return {"version": version, "lock": _digest(config / "package-lock.json"), "files": files}


def issue(data_root, version: str) -> str:
    """Read only: a native load receipt and its dependency tree must still match."""
    try:
        config = _config(data_root)
        receipt = _json(config / "node_modules" / _RECEIPT)
        return "" if receipt == _validate(config, version) else _MISSING
    except (OSError, ValueError, TypeError, AttributeError, RuntimeError, KeyError):
        return _MISSING


def _environment(stage: Path) -> dict:
    allowed = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE"}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    paths = {
        "HOME": "home", "USERPROFILE": "home", "APPDATA": "appdata",
        "LOCALAPPDATA": "localappdata", "XDG_CONFIG_HOME": "config",
        "XDG_DATA_HOME": "data", "XDG_CACHE_HOME": "cache",
        "XDG_STATE_HOME": "state", "TEMP": "temp", "TMP": "temp",
        "NPM_CONFIG_CACHE": "npm-cache",
    }
    for key, name in paths.items():
        target = stage / name
        target.mkdir(parents=True, exist_ok=True)
        env[key] = str(target)
    for kind in ("USER", "GLOBAL"):
        path = stage / (kind.lower() + ".npmrc")
        path.write_text("", encoding="utf-8")
        env["NPM_CONFIG_" + kind + "CONFIG"] = str(path)
    env.update({
        "OPENCODE_DB": str(stage / "native.db"),
        "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_MODELS_FETCH": "1",
        "OPENCODE_DISABLE_PROJECT_CONFIG": "1", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1", "OPENCODE_DISABLE_CLAUDE_CODE": "1",
        "NPM_CONFIG_FETCH_RETRIES": "1", "NPM_CONFIG_FETCH_TIMEOUT": "20000",
        "NPM_CONFIG_STRICT_SSL": "true",
        "OPENCODE_CONFIG_CONTENT": "{}",
    })
    # Honor explicitly configured registry and trusted CA locations, without
    # importing personal npmrc, npm credentials or disabled TLS verification.
    source = {key.lower(): value for key, value in os.environ.items()}
    for key in ("NPM_CONFIG_REGISTRY", "NPM_CONFIG_CAFILE", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"):
        if source.get(key.lower()):
            env[key] = source[key.lower()]
    proxies = managed_agent_network._proxies()
    registry = urlsplit(env.get("NPM_CONFIG_REGISTRY") or "https://registry.npmjs.org")
    if registry.scheme not in {"http", "https"} or not registry.hostname:
        raise RuntimeError(_FAILED)
    # Native npm has one effective proxy (httpsProxy || proxy), not a protocol
    # map. Select the configured registry's route once for this installation;
    # importing the other protocol's proxy would undo explicit empty overrides.
    proxy = proxies.get(registry.scheme)
    if proxy:
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "NPM_CONFIG_PROXY", "NPM_CONFIG_HTTPS_PROXY"):
            env[key] = proxy
    env["NO_PROXY"] = proxies.get("no", "")
    env["NPM_CONFIG_NOPROXY"] = proxies.get("no", "")
    return env


def _stop(proc, readers, ownership):
    try:
        if proc.poll() is None:
            if sys.platform.startswith("linux"):
                from .linux_process_tree import kill_owned_tree
                kill_owned_tree(proc.pid, proc)
            elif sys.platform == "darwin":
                from .darwin_process_tree import kill_owned_tree
                kill_owned_tree(proc.pid, proc)
    finally:
        close_process(proc, readers, ownership)


def _bootstrap(binary, version, stage: Path, say) -> Path:
    env = _environment(stage)
    config = stage / "config" / "opencode"
    plugin = stage / "verify.mjs"
    marker = "soduwork-dependencies-" + uuid.uuid4().hex
    entry = config / "node_modules" / "@opencode-ai" / "plugin" / "dist" / "index.js"
    # Import the real installed SDK after native waitForDependencies. A warning
    # swallowed by native npm or plugin loading cannot create this marker.
    plugin.write_text(
        "export default async () => { await import(" + json.dumps(entry.as_uri()) + ");"
        "return { config: async config => { config.agent ||= {}; config.agent["
        + json.dumps(marker) + "] = {mode:'primary',description:'SoduWork dependency verification'};"
        "}};};", encoding="utf-8")
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps({"plugin": [plugin.as_uri()]})
    flags = ({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if os.name == "nt"
             else {"start_new_session": True})
    say("正在准备 OpenCode 原生执行依赖（不调用模型）")
    with (stage / "stdout.json").open("w+b") as output:
        proc = subprocess.Popen(
            [str(binary), "debug", "config"], cwd=stage, env=env, stdin=subprocess.DEVNULL,
            stdout=output, stderr=subprocess.DEVNULL, **flags)
        ownership = OwnedProcessGroup(proc.pid) if os.name != "nt" else None
        try:
            deadline = time.monotonic() + TIMEOUT
            while proc.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                try:
                    proc.wait(timeout=min(remaining, 1))
                except subprocess.TimeoutExpired:
                    pass
            output.seek(0)
            value = json.loads(output.read(2 * 1024 * 1024 + 1))
            if proc.returncode != 0 or not (value.get("agent") or {}).get(marker):
                raise RuntimeError(_FAILED)
        finally:
            _stop(proc, [], ownership)
    return config


class _RollbackError(RuntimeError):
    pass


def _restore(staged, config, backup, new, old):
    try:
        for name in reversed(new):
            if (config / name).exists():
                os.replace(config / name, staged / name)
        for name in reversed(old):
            os.replace(backup / name, config / name)
    except OSError:
        # Keep the staging backup for recovery; do not delete the only old copy.
        raise _RollbackError(_FAILED) from None


def _publish(staged: Path, config: Path, stage: Path) -> list[str]:
    config.mkdir(parents=True, exist_ok=True)
    backup = stage / "backup"
    backup.mkdir()
    old, new = [], []
    try:
        for name in _NAMES:
            target = _path(config, name)
            if target.exists():
                os.replace(target, backup / name)
                old.append(name)
        for name in _NAMES:
            os.replace(staged / name, config / name)
            new.append(name)
    except BaseException:
        _restore(staged, config, backup, new, old)
        raise
    return old


@contextmanager
def transaction(binary, version: str, data_root, say):
    """Keep old dependencies until the caller also commits binary activation."""
    stage = None
    preserve = False
    try:
        try:
            if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", version):
                raise RuntimeError(_FAILED)
            if not Path(binary).is_file():
                raise RuntimeError(_FAILED)
            ready = not issue(data_root, version)
            if not ready:
                config = _config(data_root)
                parent = config.parent.parent
                parent.mkdir(parents=True, exist_ok=True)
                stage = Path(tempfile.mkdtemp(prefix="dependency-prepare-", dir=parent))
                staged = _bootstrap(binary, version, stage, say)
                receipt = _validate(staged, version)
                (staged / "node_modules" / _RECEIPT).write_text(
                    json.dumps(receipt, sort_keys=True), encoding="utf-8")
                old = _publish(staged, config, stage)
        except (TimeoutError, subprocess.TimeoutExpired):
            raise RuntimeError(_TIMED_OUT) from None
        except Exception as exc:
            preserve = isinstance(exc, _RollbackError)
            raise RuntimeError(_FAILED) from None
        if ready:
            say("OpenCode 原生执行依赖已就绪")
            yield
            return
        try:
            yield
        except BaseException:
            try:
                _restore(staged, config, stage / "backup", _NAMES, old)
            except _RollbackError:
                preserve = True
                raise
            raise
        say("OpenCode 原生执行依赖准备完成")
    finally:
        if stage is not None and not preserve:
            # stage is a freshly generated directory under this explicit Runner.
            if stage.resolve().is_relative_to(Path(data_root).resolve()):
                try:
                    shutil.rmtree(stage)
                except OSError:
                    pass  # Do not turn a committed installation into a failure.


def prepare(binary, version: str, data_root, say) -> None:
    with transaction(binary, version, data_root, say):
        pass
