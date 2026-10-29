"""Short-lived, metadata-scoped cache for read-only CLI version processes.

Agent availability, authentication and access policy are deliberately not cached.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
from concurrent.futures import Future
from typing import Callable, Iterable

TTL_SECONDS = 60.0
MAX_ENTRIES = 128
_lock = threading.Lock()
_values: dict[tuple, tuple[float, str]] = {}
_pending: dict[tuple, Future[str]] = {}


def _file_identity(value: str) -> tuple:
    path = os.path.abspath(value)
    resolved = os.path.realpath(path)
    try:
        info = os.stat(resolved)
        return (os.path.normcase(path), os.path.normcase(resolved), info.st_size,
                info.st_mtime_ns, info.st_ctime_ns, info.st_dev, info.st_ino)
    except OSError:
        return (os.path.normcase(path), os.path.normcase(resolved), "missing")


def _key(executable: str, args: list[str], files: Iterable[str]) -> tuple:
    actual = executable if os.path.isabs(executable) else shutil.which(executable) or executable
    # CLI launchers may be Node/Python plus a script. Updating that script must
    # invalidate the probe even when its interpreter did not change.
    script_files = [arg for arg in args if arg and not arg.startswith("-")
                    and (os.path.isabs(arg) or os.path.isfile(arg))]
    identities = tuple(_file_identity(item) for item in [actual, *script_files, *files] if item)
    # Keep only a digest, never credential-bearing environment values. A custom
    # Agent can depend on its own variables, so a hard-coded subset is unsafe.
    environment = sorted((os.path.normcase(key), value) for key, value in os.environ.items())
    digest = hashlib.sha256(json.dumps(environment, ensure_ascii=True).encode()).digest()
    return identities, tuple(args), os.getcwd(), digest


def probe(executable: str, args: list[str], *, run: Callable,
          files: Iterable[str] = (), timeout: int = 15) -> str:
    """Coalesce concurrent checks; retry failures on the next independent call."""
    if not executable:
        return ""
    files = tuple(files)
    key = _key(executable, args, files)
    with _lock:
        cached = _values.get(key)
        if cached and cached[0] > time.monotonic():
            return cached[1]
        _values.pop(key, None)
        future = _pending.get(key)
        owner = future is None
        if owner:
            future = Future()
            _pending[key] = future
    if not owner:
        return future.result()

    value = ""
    unchanged = False
    try:
        value = str(run(executable, list(args), timeout=timeout) or "").strip()
        unchanged = bool(value) and key == _key(executable, args, files)
    except Exception:
        # Match the underlying bounded version helper's empty failure result.
        # Waiting callers are released and the next call can immediately retry.
        value = ""
    finally:
        with _lock:
            if unchanged:
                _values[key] = (time.monotonic() + TTL_SECONDS, value)
                while len(_values) > MAX_ENTRIES:
                    _values.pop(next(iter(_values)))
            future.set_result(value)
            _pending.pop(key, None)
    return value
