"""Private durable storage for the existing Runner admission queue.

One atomic record per operation; no second scheduler or replay engine. Payloads
may contain provider credentials, so Windows seals them to the current user with
DPAPI; POSIX uses an owner-only directory and files. Corruption fails closed.
"""
import ctypes
import errno
import hashlib
import json
import os
import re
import uuid
from ctypes import wintypes
from dataclasses import asdict
from pathlib import Path

from . import durable_file


def _protect(data: bytes, decrypt=False) -> bytes:
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    # CRYPTPROTECT_UI_FORBIDDEN: background recovery must never display a prompt.
    call = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    call.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                     ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    call.restype = wintypes.BOOL
    if not call(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel.LocalFree(output.data)


def _storage_root(root):
    """Preserve directory identity while allowing long Windows queue paths."""
    if os.name != "nt":
        return Path(root)
    absolute = os.path.abspath(os.fspath(root))
    if absolute.startswith("\\\\?\\"):
        return Path(absolute)
    if absolute.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + absolute[2:])
    return Path("\\\\?\\" + absolute)


def acquire_owner_lock(path: Path, boot_id: str):
    """Keep the original Windows byte-zero/POSIX flock interoperable with old Runners."""
    if not re.fullmatch(r"[0-9a-f]{32}", boot_id):
        raise ValueError("Invalid Runner boot ID")
    if path.is_symlink():
        raise OSError("Runner lock must not be a symlink")
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    handle = os.fdopen(fd, "r+b", buffering=0)
    try:
        try:
            if os.name == "nt":
                import msvcrt
                # Windows can lock byte zero even when a legacy file is empty.
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise
            # Only report a bounded, well-formed registration after OS contention.
            # A crash may leave the last registration on disk until takeover.
            try:
                handle.seek(1)
                record = handle.read(128)
            except OSError:
                record = b""
            owner = re.fullmatch(rb"pid=[1-9][0-9]{0,9} bootId=[0-9a-f]{32}\n", record)
            detail = "; last registered " + record.decode("ascii").strip() if owner else ""
            raise BlockingIOError("Runner lock is already held" + detail) from exc
        handle.owner_pid = os.getpid()
        record = f" pid={handle.owner_pid} bootId={boot_id}\n".encode("ascii")
        if os.name != "nt":
            os.fchmod(fd, 0o600)  # Older per-Runner-ID locks used the process umask.
        handle.truncate(1)
        handle.seek(0)
        if handle.write(record) != len(record):
            raise OSError("Incomplete Runner lock registration")
        return handle
    except BaseException:
        handle.close()
        raise


def release_owner_lock(handle):
    try:
        # Clear our registration before releasing the OS lock. Never unlink the
        # inode: another process may already have it open for its next attempt.
        if os.getpid() == handle.owner_pid:
            handle.truncate(1)
    finally:
        handle.close()


class Journal:
    def __init__(self, root, identity: str, *, exclusive=False, boot_id: str = ""):
        self.root = _storage_root(root) / hashlib.sha256(identity.encode()).hexdigest()
        if self.root.is_symlink():
            raise OSError("Runner queue directory must not be a symlink")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.name != "nt":
            os.chmod(self.root, 0o700)
        self._lease = None
        if exclusive:
            self._lease = acquire_owner_lock(self.root / "owner.lock", boot_id or uuid.uuid4().hex)

    def close(self):
        if self._lease is not None:
            lease, self._lease = self._lease, None
            release_owner_lock(lease)

    def path(self, key):
        return self.root / (hashlib.sha256(key.encode()).hexdigest() + ".queue")

    def receipt_path(self, key):
        return self.root / (hashlib.sha256(key.encode()).hexdigest() + ".receipt")

    def last_sequence(self):
        try:
            value = json.loads(durable_file.read_bytes(self.root / "sequence"))
        except FileNotFoundError:
            return 0
        if type(value) is not int or value < 0:
            raise ValueError("Invalid Runner admission sequence")
        return value

    def _encode(self, item):
        data = json.dumps({"schema": 1, "item": asdict(item)}, ensure_ascii=False,
                          separators=(",", ":")).encode()
        return b"DPAPI\n" + _protect(data) if os.name == "nt" else b"JSON\n" + data

    def _decode(self, blob):
        if blob.startswith(b"DPAPI\n") and os.name == "nt":
            raw = _protect(blob[6:], decrypt=True)
        elif blob.startswith(b"JSON\n") and os.name != "nt":
            raw = blob[5:]
        else:
            raise OSError("Runner queue protection is not available for this account")
        value = json.loads(raw)
        if value.get("schema") != 1 or not isinstance(value.get("item"), dict):
            raise ValueError("Unsupported Runner queue journal")
        return value["item"]

    def write(self, item):
        data = self._encode(item)
        if item.sequence > self.last_sequence():
            durable_file.write_bytes(self.root / "sequence", str(item.sequence).encode())
        durable_file.write_bytes(self.path(item.key), data)

    def archive(self, item):
        """Prune hot storage only after a permanent, payload-free fence is durable."""
        if item.payload is not None or item.state not in {"completed", "failed", "cancelled"}:
            raise ValueError("Only terminal admission receipts can be archived")
        # Old installations have queue records but no sequence watermark yet.
        # Preserve their maximum before the last hot record can disappear.
        if item.sequence > self.last_sequence():
            durable_file.write_bytes(self.root / "sequence", str(item.sequence).encode())
        durable_file.write_bytes(self.receipt_path(item.key), self._encode(item))
        self.remove(item.key)

    def read_receipt(self, key):
        path = self.receipt_path(key)
        if path.is_symlink():
            raise OSError("Runner receipt must not be a symlink")
        try:
            row = self._decode(durable_file.read_bytes(path))
        except FileNotFoundError:
            return None
        if row.get("key") != key or row.get("payload") is not None or row.get("state") not in {
                "completed", "failed", "cancelled"}:
            raise ValueError("Invalid Runner admission receipt")
        return row

    def read(self):
        rows = []
        paths = {path for path in self.root.glob("*.queue") if not durable_file.is_temporary(path)}
        paths.update(Path(str(path)[:-4]) for path in self.root.glob("*.queue.wal"))
        for path in paths:
            if path.is_symlink():
                raise OSError("Runner queue record must not be a symlink")
            try:
                blob = durable_file.read_bytes(path)
            except FileNotFoundError:  # uncommitted first append or durable tombstone
                continue
            row = self._decode(blob)
            if self.path(row["key"]) != path:
                raise ValueError("Runner queue record identity mismatch")
            rows.append(row)
        return rows

    def remove(self, key):
        durable_file.remove(self.path(key))
