"""Read the executing Codex CLI's model catalog without using a login or opening a session."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time

from .acp_process import OwnedProcessGroup, close_process

_TIMEOUT = 3.0
_MAX_OUTPUT = 24 * 1024 * 1024


def _environment(home: str) -> dict[str, str]:
    env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR") if key in os.environ}
    for key in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP",
                "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
                "CODEX_HOME", "CODEX_SQLITE_HOME"):
        env[key] = home
    # The native command can normally refresh from the network. This local
    # enumeration may only combine bundled models with previously observed metadata.
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        env[key] = "http://127.0.0.1:1"
    return env


def _run(executable: str, args: list[str], env: dict, deadline: float, limit: int) -> bytes:
    if time.monotonic() >= deadline:
        raise TimeoutError
    flags = ({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True})
    proc = subprocess.Popen([executable, *args], cwd=env["CODEX_HOME"], env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **flags)
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
        if proc.wait(timeout=max(0, deadline - time.monotonic())):
            raise ValueError("Codex catalog command failed")
        return output[0]
    finally:
        close_process(proc, [reader], ownership)


def discover(executable: str, cached: dict) -> tuple[list | None, str]:
    """Prefer Codex's merged menu; older CLIs may only support a verified account cache."""
    matching = None
    if not executable or (os.name == "nt" and not executable.lower().endswith(".exe")):
        return None, ""
    try:
        with tempfile.TemporaryDirectory(prefix="soduwork-codex-models-") as home:
            env = _environment(home)
            deadline = time.monotonic() + _TIMEOUT
            version = cached.get("client_version") or cached.get("clientVersion")
            if isinstance(version, str) and version and isinstance(cached.get("models"), list):
                try:
                    reported = _run(executable, ["--version"], env, deadline, 1024).decode().strip()
                except (OSError, ValueError, subprocess.SubprocessError):
                    reported = ""
                if reported.removeprefix("codex-cli ") == version:
                    matching = cached["models"]
                    copy = {k: cached[k] for k in ("models", "fetched_at", "etag") if k in cached}
                    copy["client_version"] = version
                    (Path(home) / "models_cache.json").write_text(json.dumps(copy), encoding="utf-8")
            args = ["-c", 'cli_auth_credentials_store="file"', "debug", "models"]
            if matching is None:
                args.append("--bundled")
            data = json.loads(_run(executable, args, env, deadline, _MAX_OUTPUT))
            if isinstance(data, dict) and isinstance(data.get("models"), list):
                return data["models"], "codex-native"
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        pass
    return matching, "codex-account-cache" if matching is not None else ""
