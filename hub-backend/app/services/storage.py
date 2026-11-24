"""Task attachment storage abstraction. Use configured MinIO or the local uploads directory; APIs
use put/get/delete without storing binary data in the database. Persist the selected backend
with each object.
"""
import asyncio
import errno
import hashlib
import os
import re
import shutil
import stat
import tempfile
import time
from contextlib import contextmanager
from io import BytesIO

from ..config import get_settings

# Local fallback directory: hub-backend/uploads/.
_LOCAL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "uploads")

_minio_client = None


def backend_name() -> str:
    return "minio" if get_settings().minio_endpoint else "local"


def _client():
    """Create the MinIO client lazily only when configured, keeping local storage independent of
    that dependency.
    """
    global _minio_client
    if _minio_client is None:
        from minio import Minio  # Import the optional dependency lazily.
        s = get_settings()
        _minio_client = Minio(
            s.minio_endpoint, access_key=s.minio_access_key,
            secret_key=s.minio_secret_key, secure=s.minio_secure,
        )
        # Ensure the bucket exists idempotently.
        try:
            if not _minio_client.bucket_exists(s.minio_bucket):
                _minio_client.make_bucket(s.minio_bucket)
        except Exception:
            pass  # Tolerate read-only credentials or an already-existing bucket.
    return _minio_client


_NAME_LIMIT = 255  # Per-component limit: bytes on POSIX filesystems, UTF-16 units on NTFS.
_WINDOWS_PATH_LIMIT = 259
_WINDOWS_INVALID = re.compile(r'[<>:"|?*\x00-\x1f]')
_WINDOWS_RESERVED = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)
_SAFE_SUFFIX = re.compile(r"\.[A-Za-z0-9]{1,16}")


def _utf16_units(value: str) -> int:
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _windows_component_ok(name: str) -> bool:
    return (_utf16_units(name) <= _NAME_LIMIT and not _WINDOWS_INVALID.search(name)
            and not name.endswith((" ", ".")) and not _WINDOWS_RESERVED.match(name))


def _hashed_names(key: str, safe: str) -> tuple[str, str]:
    # Object keys embed the uploaded filename, which can exceed native limits
    # (long or multibyte names) or contain characters Windows rejects. The
    # readable form keeps an ASCII prefix and extension; the compact form keeps
    # only the digest and extension for deep upload directories. Neither
    # depends on the directory, so a moved or restored uploads directory still
    # maps every key to the name it was written under.
    head, _, tail = safe.rpartition("__")
    suffix = os.path.splitext(tail or safe)[1]
    suffix = suffix if _SAFE_SUFFIX.fullmatch(suffix) else ""
    head = re.sub(r"[^A-Za-z0-9._-]", "_", head)[:120]
    compact = "h-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:40] + suffix
    return (head + "__" + compact if head else compact), compact


def _extended(path: str, *, directory: bool = False) -> str:
    if os.name != "nt":
        return path
    path = os.path.abspath(path)
    # Windows directory creation can hit its legacy limit before a complete file path does.
    if path.startswith("\\\\?\\") or (not directory and _utf16_units(path) <= _WINDOWS_PATH_LIMIT):
        return path
    return "\\\\?\\UNC\\" + path[2:] if path.startswith("\\\\") else "\\\\?\\" + path


def _entry(path, *, directory=False):
    """Inspect entries without following links inside the configured uploads mount."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ValueError(f"Refusing symlink or reparse point in attachment storage: {path!r}")
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError(f"Unexpected attachment storage entry type: {path!r}")
    return info


def _v2_root():
    # Administrators can mount uploads on another disk using a symlink or a
    # Windows junction. Pin that configured root; entries below it must be plain.
    uploads = _extended(_LOCAL_DIR, directory=True)
    try:
        uploads = os.path.realpath(uploads, strict=True)
    except FileNotFoundError:
        if os.path.lexists(uploads):
            raise  # Do not turn a broken mount into a fresh empty store.
    root = os.path.join(uploads, "objects-v2")
    _entry(_extended(root, directory=True), directory=True)
    return root


def _local_path(key: str) -> str:
    return _extended(os.path.join(_v2_root(), hashlib.sha256(key.encode("utf-8")).hexdigest()))


def _legacy_paths(uploads, key, existing_names):
    safe = key.replace("/", "__").replace("\\", "__")
    for name in dict.fromkeys((safe, *_hashed_names(key, safe))):
        if name in ("", ".", "..") or "\x00" in name:
            continue
        if os.name == "nt" and not _windows_component_ok(name):
            continue
        if os.name != "nt" and len(os.fsencode(name)) > _NAME_LIMIT:
            continue
        path = _extended(os.path.join(uploads, name))
        try:
            info = _entry(path)
        except OSError as exc:
            # Some Windows filesystem filters fail metadata queries for a
            # nonexistent long name. Confirm absence from the actual directory.
            if getattr(exc, "winerror", None) != 1450:
                raise
            if not existing_names:
                with os.scandir(uploads) as entries:
                    existing_names.update(entry.name.upper() for entry in entries)
            if name.upper() in existing_names:
                raise
            continue
        if info is not None:
            yield path, info


class AmbiguousLocalKeys(ValueError):
    """The inventory contains keys sharing a legacy file; no migration occurred."""

    def __init__(self, collisions):
        self.collisions = collisions
        super().__init__("Ambiguous legacy local objects; retain originals and resolve keys: "
                         + repr(collisions))


def _migration_complete(root=None):
    if root is None:
        root = _v2_root()
    marker = _entry(_extended(os.path.join(root, ".migration-complete")))
    if marker is not None and marker.st_size:
        raise ValueError("Invalid local attachment migration marker; check the paired database/uploads backup")
    return marker is not None


def _sync_directory(directory):
    if os.name != "nt":
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


@contextmanager
def _migration_lock(root):
    # The PostgreSQL bootstrap lock is optional. Two local Hub processes must
    # still serialize preflight and moves on the same volume. Closing the file
    # releases the kernel lock after an interrupted migration.
    path = _extended(os.path.join(root, ".migration-lock"))
    _entry(path)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags, 0o600), "r+b") as handle:
        if os.name == "nt":
            import msvcrt
            while True:
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as exc:
                    if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    time.sleep(0.2)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def _plan_migration(root, live, pending, evidence):
    owners = {}
    moves = []
    missing = []
    files = {}
    existing_names = set()
    for key in sorted(live | pending):
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        destination = _extended(os.path.join(root, digest))
        current = _entry(destination)
        deleted = _entry(_extended(os.path.join(root, digest + ".deleted")))
        if deleted is not None and current is None:
            if key in live:
                missing.append(f"{key!r} (deleted by a preview release)")
            continue
        candidates = list(_legacy_paths(os.path.dirname(root), key, existing_names))
        if len(candidates) > 1:
            raise ValueError(f"Multiple legacy objects match one key; retain all: {key!r}")
        if current is not None and candidates:
            raise FileExistsError(f"Both legacy and v2 objects exist; retain both: {key!r}")
        if current is not None:
            source = destination
            info = current
        elif candidates:
            source, info = candidates[0]
            moves.append((source, destination))
        else:
            if key in live:
                detail = " (possible historical NTFS named stream)" if os.name == "nt" and ":" in key else ""
                missing.append(repr(key) + detail)
            continue
        if not info.st_ino:
            raise ValueError(f"Filesystem cannot establish a stable attachment file identity: {key!r}")
        owners.setdefault((info.st_dev, info.st_ino), []).append(key)
        files[key] = (source, info)
    collisions = [group for group in owners.values() if len(group) > 1]
    if collisions:
        raise AmbiguousLocalKeys(collisions)
    if missing:
        raise FileNotFoundError("Missing local attachment objects. Restore verified bytes from a trusted "
                                "database/uploads backup before retrying: " + ", ".join(missing))
    for key, (source, info) in files.items():
        size, digest = evidence.get(key, (None, None))
        if size is not None and info.st_size != size:
            raise ValueError(f"Attachment size mismatch; retain original and check backup: {key!r}")
        with open(source, "rb") as handle:
            if digest and hashlib.file_digest(handle, "sha256").hexdigest() != digest:
                raise ValueError(f"Attachment SHA-256 mismatch; retain original and check backup: {key!r}")
    return moves


def migrate_local_objects(keys, *, pending_cleanup=(), evidence=None):
    """One-time cutover with the complete inventory and all old writers stopped.

    Each same-volume rename is atomic. Until the completion marker exists, a
    restart preflights both the already moved files and all remaining sources.
    """
    root = _v2_root()
    if _migration_complete(root):
        return 0
    os.makedirs(_extended(root, directory=True), exist_ok=True)
    with _migration_lock(root):
        if _migration_complete(root):
            return 0
        moves = _plan_migration(root, set(keys), set(pending_cleanup), evidence or {})
        for source, destination in moves:
            os.rename(source, destination)
        # Persist both sides of the moves before recording completion. This
        # also covers moves made by an earlier interrupted migration.
        _sync_directory(os.path.dirname(root))
        _sync_directory(root)
        # Exclusive creation publishes the empty marker in a single operation.
        with open(_extended(os.path.join(root, ".migration-complete")), "xb"):
            pass
        _sync_directory(root)
        return len(moves)


def _record_evidence(inventory, key, size, digest):
    # Older rows may carry only the logical key and the default size of zero.
    size = size if size and size > 0 else None
    digest = digest.lower() if isinstance(digest, str) and re.fullmatch(r"[a-fA-F0-9]{64}", digest) else None
    old_size, old_digest = inventory.get(key, (None, None))
    if (size and old_size and size != old_size) or (digest and old_digest and digest != old_digest):
        raise ValueError(f"Conflicting attachment integrity metadata; retain original and check backup: {key!r}")
    inventory[key] = (size or old_size, digest or old_digest)


async def migrate_local_attachments(session):
    """Inventory both kinds of local references before Hub accepts requests."""
    from sqlalchemy import select

    from ..conversation_handoff_models import ConversationHandoff
    from ..models import Attachment, Task

    attachments = select(
        Attachment.storage_key, Attachment.size, Attachment.evidence_meta["sha256"].as_string()
    ).where(Attachment.backend == "local", Attachment.storage_key != "")
    handoffs = select(ConversationHandoff.storage_key, ConversationHandoff.sha256, Task.id).outerjoin(
        Task, Task.id == ConversationHandoff.task_id
    ).where(ConversationHandoff.backend == "local", ConversationHandoff.storage_key != "")
    legacy = ConversationHandoff.options["legacyBlob"]
    cleanup = select(legacy["key"].as_string()).where(
        legacy["backend"].as_string() == "local", legacy["key"].as_string() != "")
    if backend_name() == "minio":
        has_local = select(attachments.exists() | handoffs.exists() | cleanup.exists())
        if not await session.scalar(has_local):
            return 0  # Remote-only deployments need no access to an uploads volume.
    if await asyncio.to_thread(_migration_complete):
        return 0
    inventory = {}
    for key, size, digest in await session.execute(attachments):
        _record_evidence(inventory, key, size, digest)
    live = set(inventory)
    pending = set(await session.scalars(cleanup))
    for key, digest, task_id in await session.execute(handoffs):
        _record_evidence(inventory, key, None, digest)
        # Older Hubs could delete a task and its archive but leave the handoff row.
        if task_id is None:
            pending.add(key)
        else:
            live.add(key)
    return await asyncio.to_thread(migrate_local_objects, live, pending_cleanup=pending, evidence=inventory)


async def delete_unreferenced(session, key, backend):
    """Clean up only after the caller commits removal of its logical reference."""
    return bool(await delete_unreferenced_objects(session, [(key, backend)]))


async def delete_unreferenced_objects(session, refs):
    """Filter shared references in bounded SQL batches before removing bytes."""
    from sqlalchemy import select, tuple_

    from ..conversation_handoff_models import ConversationHandoff
    from ..models import Attachment

    candidates = list(dict.fromkeys((key, backend) for key, backend in refs if key))
    attempted = 0
    for start in range(0, len(candidates), 400):
        batch = candidates[start:start + 400]
        available = set(batch)
        for model in (Attachment, ConversationHandoff):
            columns = (model.storage_key, model.backend)
            rows = await session.execute(select(*columns).where(tuple_(*columns).in_(batch)))
            available.difference_update(rows)
        if available:
            await asyncio.to_thread(_delete_objects, available)
            attempted += len(available)
    return attempted


def _delete_objects(refs):
    for key, backend in refs:
        delete(key, backend)


def _put_local(key: str, source) -> None:
    destination = _local_path(key)
    os.makedirs(_extended(os.path.dirname(destination), directory=True), exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".upload-", dir=os.path.dirname(destination))
    try:
        with os.fdopen(descriptor, "wb") as output:
            shutil.copyfileobj(source, output, 1024 * 1024)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def put(key: str, data: bytes, content_type: str) -> str:
    """Store an object and return the backend actually used: minio or local."""
    if backend_name() == "minio":
        s = get_settings()
        _client().put_object(s.minio_bucket, key, BytesIO(data), length=len(data), content_type=content_type)
        return "minio"
    _put_local(key, BytesIO(data))
    return "local"


def put_stream(key: str, handle, size: int, content_type: str) -> str:
    """Store a seekable video stream without allocating the complete file."""
    handle.seek(0)
    if backend_name() == "minio":
        _client().put_object(get_settings().minio_bucket, key, handle,
                             length=size, content_type=content_type,
                             part_size=5 * 1024 * 1024, num_parallel_uploads=1)
        return "minio"
    _put_local(key, handle)
    return "local"


def get(key: str, backend: str) -> bytes:
    """Read object bytes from the backend recorded at write time, supporting storage migration."""
    if backend == "minio":
        s = get_settings()
        resp = _client().get_object(s.minio_bucket, key)
        try:
            return resp.read()
        finally:
            resp.close(); resp.release_conn()
    with open_stream(key, backend) as f:
        return f.read()


def open_stream(key: str, backend: str):
    """Open an attachment for bounded chunked delivery.

    The caller must pass the returned handle to ``iter_stream`` so network and
    file resources are closed after the response, including client disconnects.
    This function is synchronous by design and should be opened via
    ``asyncio.to_thread`` from async routes.
    """
    if backend == "minio":
        s = get_settings()
        return _client().get_object(s.minio_bucket, key)
    path = _local_path(key)
    if _entry(path) is None:
        raise FileNotFoundError(key)
    return open(path, "rb")


def iter_stream(handle, chunk_size: int = 1024 * 1024):
    """Yield an already-open storage object without loading it into memory."""
    try:
        while True:
            chunk = handle.read(max(64 * 1024, min(int(chunk_size), 4 * 1024 * 1024)))
            if not chunk:
                break
            yield chunk
    finally:
        try:
            handle.close()
        finally:
            release = getattr(handle, "release_conn", None)
            if callable(release):
                release()


def delete(key: str, backend: str) -> None:
    try:
        if backend == "minio":
            s = get_settings()
            _client().remove_object(s.minio_bucket, key)
        else:
            os.remove(_local_path(key))
    except Exception:
        pass  # Storage deletion failure must not block metadata removal.
