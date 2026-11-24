"""Task attachment storage abstraction. Use configured MinIO or the local uploads directory; APIs
use put/get/delete without storing binary data in the database. Persist the selected backend
with each object.
"""
import hashlib
import os
import re
import shutil
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


def _native_name_ok(name: str, path: str) -> bool:
    if os.name == "nt":
        return _windows_component_ok(name) and _utf16_units(os.path.abspath(path)) <= _WINDOWS_PATH_LIMIT
    return len(os.fsencode(name)) <= _NAME_LIMIT


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


def _local_path(key: str) -> str:
    os.makedirs(_extended(_LOCAL_DIR, directory=True), exist_ok=True)
    safe = key.replace("/", "__").replace("\\", "__")
    legacy = os.path.join(_LOCAL_DIR, safe)
    readable, compact = (os.path.join(_LOCAL_DIR, name) for name in _hashed_names(key, safe))
    # An object that already exists keeps the name it was written under, even
    # if the uploads directory has since moved to a shorter or longer path.
    for path in (legacy, readable, compact):
        if os.name == "nt" and not _windows_component_ok(os.path.basename(path)):
            continue
        path = _extended(path)
        if os.path.exists(path):
            return path
    # New objects: the original mapping when the filesystem can store it,
    # otherwise the longest hashed form that fits the complete path.
    if _native_name_ok(safe, legacy):
        return legacy
    if _native_name_ok(os.path.basename(readable), readable):
        return readable
    return _extended(compact)


def put(key: str, data: bytes, content_type: str) -> str:
    """Store an object and return the backend actually used: minio or local."""
    if backend_name() == "minio":
        s = get_settings()
        _client().put_object(s.minio_bucket, key, BytesIO(data), length=len(data), content_type=content_type)
        return "minio"
    with open(_local_path(key), "wb") as f:
        f.write(data)
    return "local"


def put_stream(key: str, handle, size: int, content_type: str) -> str:
    """Store a seekable video stream without allocating the complete file."""
    handle.seek(0)
    if backend_name() == "minio":
        _client().put_object(get_settings().minio_bucket, key, handle,
                             length=size, content_type=content_type,
                             part_size=5 * 1024 * 1024, num_parallel_uploads=1)
        return "minio"
    with open(_local_path(key), "wb") as destination:
        shutil.copyfileobj(handle, destination, 1024 * 1024)
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
    path = _local_path(key)
    if not os.path.exists(path):
        raise FileNotFoundError(key)
    with open(path, "rb") as f:
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
    if not os.path.exists(path):
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
            p = _local_path(key)
            if os.path.exists(p):
                os.remove(p)
    except Exception:
        pass  # Storage deletion failure must not block metadata removal.
