"""Single-writer durable records, including filesystems that reject rename.

Normal writes use an atomic replacement. EXDEV or a verified Windows rename
failure with an intact staging file enables an append-only WAL;
each complete line validates its length and bytes before it becomes visible.
An interrupted append cannot overwrite an acknowledged record. Callers must use
read_bytes/remove too, and retain their existing cross-process ownership lock.
This module does not encrypt data: the admission journal still seals it first.
"""
import base64
import errno
import hashlib
import json
import os
from pathlib import Path
import threading
import uuid

_HEADER = b"SODUWORK-DURABLE-1\n"
_LOCK = threading.RLock()
_TEMP_PREFIX = ".soduwork-write-"


def is_temporary(path):
    """Recognize only our private, uncommitted same-extension staging files."""
    stem = Path(path).stem
    token = stem[len(_TEMP_PREFIX):] if stem.startswith(_TEMP_PREFIX) else ""
    return len(token) == 16 and all(char in "0123456789abcdef" for char in token)


def _wal(path):
    return Path(str(path) + ".wal")


def _safe(path):
    if path.is_symlink():
        raise OSError("Durable record must not be a symlink")


def _sync_directory(path):
    if os.name != "nt":
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _scan(path):
    """Return (has committed value, value/tombstone, committed end offset)."""
    _safe(path)
    try:
        stream = path.open("rb")
    except FileNotFoundError:
        return False, None, 0
    with stream:
        header = stream.read(len(_HEADER))
        if header != _HEADER:
            if _HEADER.startswith(header):  # interrupted first append
                return False, None, 0
            raise ValueError("Invalid durable record header")
        found, value, end = False, None, len(_HEADER)
        while True:
            line = stream.readline()
            if not line or not line.endswith(b"\n"):
                return found, value, end
            try:
                record = json.loads(line)
                payload = base64.b64decode(record["data"], validate=True)
                deleted = record["deleted"]
                if (type(deleted) is not bool or type(record["size"]) is not int
                        or record["size"] != len(payload)
                        or record["sha256"] != hashlib.sha256(payload).hexdigest()
                        or (deleted and payload)):
                    raise ValueError("Invalid durable record checksum")
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError("Corrupt committed durable record") from exc
            found, value, end = True, None if deleted else payload, stream.tell()


def read_bytes(path):
    path = Path(path)
    with _LOCK:
        _safe(path)
        found, value, _ = _scan(_wal(path))
        if found:
            if value is None:
                raise FileNotFoundError(errno.ENOENT, "Record was removed", str(path))
            return value
        return path.read_bytes()


def _append(path, value):
    wal = _wal(path)
    _, _, end = _scan(wal)
    payload = value if value is not None else b""
    record = json.dumps({"size": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
                         "deleted": value is None, "data": base64.b64encode(payload).decode("ascii")},
                        separators=(",", ":")).encode("ascii") + b"\n"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(wal, flags, 0o600)
    with os.fdopen(fd, "r+b") as out:
        out.seek(end)
        out.truncate()  # Only an incomplete, never-acknowledged tail is removed.
        if not end:
            out.write(_HEADER)
        out.write(record)
        out.flush()
        os.fsync(out.fileno())
    found, actual, _ = _scan(wal)
    if not found or actual != value:
        raise OSError("Durable record verification failed")
    _sync_directory(path)


def _rename_fallback(error, temporary, value):
    if error.errno == errno.EXDEV or getattr(error, "winerror", None) == 17:
        return True
    # Some Windows file filters report FILE_NOT_FOUND even though the staging
    # file still exists. Do not treat real missing files or changed bytes as a
    # rename limitation; preserve those failures instead of acknowledging data.
    if getattr(error, "winerror", None) != 2 or temporary.is_symlink():
        return False
    try:
        return temporary.is_file() and temporary.read_bytes() == value
    except OSError:
        return False


def write_bytes(path, value):
    path, value = Path(path), bytes(value)
    with _LOCK:
        _safe(path)
        wal = _wal(path)
        if wal.exists() or wal.is_symlink():
            _append(path, value)
            return
        # Managed Windows filters can reject .tmp -> .queue/.status even on
        # the same volume. Preserve the extension and avoid repeating the
        # target's long hashed basename, while retaining O_EXCL uniqueness.
        temporary = path.with_name(_TEMP_PREFIX + uuid.uuid4().hex[:16] + path.suffix)
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as out:
                out.write(value)
                out.flush()
                os.fsync(out.fileno())
            try:
                os.replace(temporary, path)
            except OSError as exc:
                if not _rename_fallback(exc, temporary, value):
                    raise
                _append(path, value)
            else:
                _sync_directory(path)
        finally:
            temporary.unlink(missing_ok=True)


def remove(path):
    path = Path(path)
    with _LOCK:
        _safe(path)
        wal = _wal(path)
        if wal.exists() or wal.is_symlink():
            # Persist removal before deleting either representation. A crash
            # must not expose the obsolete pre-WAL queued state again.
            _append(path, None)
            path.unlink(missing_ok=True)
            _sync_directory(path)
            wal.unlink(missing_ok=True)
        else:
            path.unlink(missing_ok=True)
        _sync_directory(path)
