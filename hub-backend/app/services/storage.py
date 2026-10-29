"""Task attachment storage abstraction. Use configured MinIO or the local uploads directory; APIs
use put/get/delete without storing binary data in the database. Persist the selected backend
with each object.
"""
import os
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


def _local_path(key: str) -> str:
    os.makedirs(_LOCAL_DIR, exist_ok=True)
    safe = key.replace("/", "__").replace("\\", "__")
    return os.path.join(_LOCAL_DIR, safe)


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
