"""Knowledge storage supporting local, MinIO, and remote NFS backends. Select the first fully
configured remote protocol in order; report outages instead of silently changing write
destinations. Persist the actual backend in metadata.
"""

from functools import lru_cache
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from ..config import get_settings


class LibraryStorageError(RuntimeError):
    """Safe, machine-readable failure for the independent library store."""

    def __init__(self, code="LIBRARY_STORAGE_UNAVAILABLE", message="请配置资料库存储环境", retryable=True):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = bool(retryable)


def _storage_error(exc, *, code="LIBRARY_STORAGE_UNAVAILABLE"):
    if isinstance(exc, LibraryStorageError):
        return exc
    return LibraryStorageError(code)


def _minio_values():
    """Return effective MinIO values and whether any MinIO setting was given."""
    s = get_settings()
    values = (
        (s.library_minio_endpoint or s.minio_endpoint or "").strip(),
        (s.library_minio_access_key or s.minio_access_key or "").strip(),
        (s.library_minio_secret_key or s.minio_secret_key or "").strip(),
        (s.library_minio_bucket or s.minio_bucket or "").strip(),
    )
    # The generic MINIO_* defaults include a bucket name, so only count an
    # endpoint or credential as an operator intent. A bucket-only example value
    # must not disable the local default.
    supplied = any(values[:3])
    return values, supplied


def remote_order() -> list[str]:
    """Return the operator's ordered protocol list, with no network access."""
    value = str(get_settings().library_remote_order or "minio,nfs")
    result = []
    for entry in value.split(","):
        name = entry.strip().lower()
        if name == "s3":
            name = "minio"
        if name not in {"minio", "nfs"}:
            raise LibraryStorageError("LIBRARY_STORAGE_NOT_CONFIGURED",
                                      "LIBRARY_REMOTE_ORDER 仅支持 minio、nfs", retryable=False)
        if name not in result:
            result.append(name)
    return result


def _remote_configuration(backend):
    if backend == "nfs":
        from . import library_nfs
        return library_nfs.configuration()
    return configuration("minio")


def _remote_supplied(backend):
    if backend == "minio":
        return _minio_values()[1]
    s = get_settings()
    return bool(s.library_nfs_host or s.library_nfs_export)


def remote_backend() -> str:
    """Pick first fully configured provider, never fail over based on health."""
    problem = None
    for backend in remote_order():
        try:
            _remote_configuration(backend)
        except LibraryStorageError as exc:
            if problem is None and _remote_supplied(backend):
                problem = exc
            continue
        return backend
    if problem:
        raise problem
    raise LibraryStorageError("LIBRARY_STORAGE_NOT_CONFIGURED", "请配置至少一个远程存储服务", retryable=False)


def storage_backend() -> str:
    """Resolve the configured backend without probing external services."""
    setting = str(get_settings().library_storage_backend or "auto").strip().lower()
    if setting in {"local", "filesystem", "file", "fs"}:
        return "local"
    if setting in {"minio", "s3"}:
        return "minio"
    if setting == "nfs":
        return "nfs"
    if setting == "remote":
        return remote_backend()
    if setting not in {"", "auto"}:
        raise LibraryStorageError("LIBRARY_STORAGE_NOT_CONFIGURED", retryable=False)
    try:
        return remote_backend()
    except LibraryStorageError:
        # An incomplete/invalid configuration is an operator error, not an
        # instruction to silently store new files on the local disk.
        order = remote_order()
        if any(_remote_supplied(name) for name in order):
            raise
        return "local"


def _local_root() -> Path:
    configured = str(get_settings().library_storage_dir or "uploads/library").strip()
    path = Path(configured).expanduser()
    # Relative paths are rooted at the Hub package directory, independent of
    # the process working directory used by a supervisor.
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[2] / path
    return path


def _local_path(key: str) -> Path:
    key = str(key)
    # Keys are POSIX object names on both platforms. Reject drive/ADS syntax
    # and alternate separators even when the current OS would treat them as
    # ordinary filename characters.
    if not key or "\\" in key or ":" in key or any(part in {"", ".", ".."} for part in key.split("/")):
        raise LibraryStorageError("LIBRARY_STORAGE_UNAVAILABLE")
    root = _local_root().resolve()
    candidate = (root / key).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise LibraryStorageError("LIBRARY_STORAGE_UNAVAILABLE") from exc
    return candidate


def _ensure_local_ready() -> bool:
    root = _local_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
        probe = root / (".soduwork-library-probe-" + uuid4().hex)
        probe.write_bytes(b"ok")
        probe.unlink(missing_ok=True)
    except Exception as exc:
        raise _storage_error(exc) from exc
    return True


def _resolve_backend(backend=None) -> str:
    """Normalize an explicit backend or use the deployment default."""
    if backend is None or str(backend).strip() == "":
        return storage_backend()
    value = str(backend).strip().lower()
    if value in {"local", "filesystem", "file", "fs"}:
        return "local"
    if value in {"minio", "s3"}:
        return "minio"
    if value == "nfs":
        return "nfs"
    if value == "remote":
        return remote_backend()
    raise LibraryStorageError("LIBRARY_STORAGE_NOT_CONFIGURED", retryable=False)


def resolve_backend(backend=None) -> str:
    """Public backend selector used by the HTTP layer and health checks."""
    return _resolve_backend(backend)


def configuration(backend=None):
    """Return the validated MinIO tuple for callers using the MinIO backend."""
    if _resolve_backend(backend) != "minio":
        raise LibraryStorageError("LIBRARY_STORAGE_NOT_CONFIGURED", retryable=False)
    (endpoint, access_key, secret_key, bucket), _ = _minio_values()
    if not endpoint or not access_key or not secret_key or not bucket:
        raise LibraryStorageError("LIBRARY_STORAGE_NOT_CONFIGURED", retryable=False)
    try:
        parsed = urlsplit(endpoint if "://" in endpoint else "//" + endpoint)
        if (not parsed.hostname or not (parsed.port is None or 1 <= parsed.port <= 65535)
                or parsed.netloc.endswith(":") or any(ch.isspace() or ord(ch) < 32 for ch in endpoint)):
            raise ValueError("invalid MinIO host/port")
    except ValueError as exc:
        raise LibraryStorageError("LIBRARY_STORAGE_NOT_CONFIGURED", retryable=False) from exc
    if parsed.scheme not in ("", "http", "https") or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise LibraryStorageError("LIBRARY_STORAGE_NOT_CONFIGURED", retryable=False)
    host = parsed.netloc
    if not host:
        raise LibraryStorageError("LIBRARY_STORAGE_NOT_CONFIGURED", retryable=False)
    s = get_settings()
    secure = parsed.scheme == "https" if parsed.scheme else (
        s.library_minio_secure if s.library_minio_endpoint else s.minio_secure
    )
    return host, access_key, secret_key, bucket, secure


@lru_cache(maxsize=4)
def _connect(host, access, secret, bucket, secure):
    try:
        from minio import Minio
        from minio.error import S3Error
        from urllib3 import PoolManager, Timeout

        client = Minio(
            host,
            access_key=access,
            secret_key=secret,
            secure=secure,
            http_client=PoolManager(timeout=Timeout(connect=5, read=30), retries=0),
        )
        if not client.bucket_exists(bucket):
            try:
                client.make_bucket(bucket)
            except S3Error as exc:
                if exc.code not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
                    raise
        return client
    except LibraryStorageError:
        raise
    except Exception as exc:
        raise _storage_error(exc) from exc


def _client(backend=None):
    return _connect(*configuration(backend))


def ensure_ready(backend=None):
    """Validate the selected storage backend before showing library content."""
    selected = _resolve_backend(backend)
    if selected == "local":
        return _ensure_local_ready()
    if selected == "nfs":
        from . import library_nfs
        return library_nfs.ensure_ready()
    try:
        client = _client(selected)
        # The endpoint can go offline after the client is cached, so always
        # probe the bucket when the library is opened.
        if not client.bucket_exists(bucket_name(selected)):
            raise LibraryStorageError("LIBRARY_STORAGE_UNAVAILABLE")
    except LibraryStorageError:
        raise
    except Exception as exc:
        raise _storage_error(exc) from exc
    return True


def status_plan():
    """Build capabilities without I/O; callers must resolve the listed probes."""
    def record(backend, *, state, configured, available, code="", message=""):
        return {
            "backend": backend,
            "state": state,
            "configured": bool(configured),
            "available": bool(available),
            "enabled": bool(available),
            "connected": bool(available),
            "code": str(code or ""),
            "message": str(message or ""),
        }

    local = record("local", state="available", configured=True, available=True)
    storage = {"local": local}
    for backend in ("minio", "nfs"):
        try:
            _remote_configuration(backend)
        except Exception as exc:
            error = _storage_error(exc, code="LIBRARY_STORAGE_NOT_CONFIGURED")
            storage[backend] = record(backend, state="disabled", configured=False, available=False,
                                      code=error.code, message=error.message)
        else:
            storage[backend] = record(backend, state="standby", configured=True, available=False,
                                      message="已配置，未按当前顺序启用")

    selected = ""
    order = []
    try:
        order = remote_order()
        selected = next((name for name in order if storage[name]["configured"]), "")
        if not selected:
            for name in order:
                if _remote_supplied(name):
                    raise LibraryStorageError(storage[name]["code"], storage[name]["message"], False)
            raise LibraryStorageError("LIBRARY_STORAGE_NOT_CONFIGURED", "请配置至少一个远程存储服务", retryable=False)
    except LibraryStorageError as exc:
        remote = record("", state="disabled", configured=False, available=False,
                        code=exc.code, message=exc.message)
    else:
        remote = record(selected, state="available", configured=True, available=True)
        storage[selected] = remote
    storage["remote"] = remote

    try:
        default = storage_backend()
    except LibraryStorageError:
        default = "local"
    # Keep the capability map nested for new clients while retaining the flat
    # aliases consumed by older desktop builds during a rolling upgrade.
    payload = {"ok": True, "default": default, "storage": storage,
               "remoteOrder": order, "remoteBackend": selected, **storage}
    return payload, ["local", selected] if selected else ["local"]


def apply_status_failure(payload, backend, exc):
    """Keep public health errors safe without changing readiness error semantics."""
    error = _storage_error(exc)
    record = {**payload["storage"][backend], "state": "unavailable",
              "available": False, "enabled": False, "connected": False,
              "code": error.code,
              "message": ("本地存储暂不可用" if backend == "local" else
                          error.message if error.code.startswith("LIBRARY_NFS_") else "远程存储暂不可用")}
    payload["storage"][backend] = payload[backend] = record
    if backend == payload["remoteBackend"]:
        payload["storage"]["remote"] = payload["remote"] = record


def status():
    """Return safe capabilities; only the selected remote provider is probed."""
    payload, backends = status_plan()
    for backend in backends:
        try:
            ensure_ready(backend)
        except Exception as exc:  # noqa: BLE001 - health is a safe boundary
            apply_status_failure(payload, backend, exc)
    return payload

def bucket_name(backend=None):
    return configuration(backend)[3]


def owner_prefix(owner: str) -> str:
    # S3/MinIO has no physical directories. The first PUT under this prefix
    # materializes the user's private "folder". The local adapter maps the
    # same key to a directory, preserving identical tenant isolation.
    return "library/users/" + sha256(owner.encode("utf-8")).hexdigest() + "/"


def object_key(owner: str, item_id: str, filename: str = "") -> str:
    # Immutable objects prevent concurrent edits from overwriting each other.
    return owner_prefix(owner) + item_id + "/" + uuid4().hex


def put_bytes(key, data, content_type, backend=None):
    return put_stream(key, BytesIO(data), len(data), content_type, backend=backend)


def _put_local(key, handle, size):
    target = _local_path(key)
    temporary = target.with_name(target.name + ".part-" + uuid4().hex)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        handle.seek(0)
        remaining = int(size)
        with temporary.open("wb") as output:
            while remaining > 0:
                chunk = handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise OSError("storage stream ended before declared size")
                output.write(chunk)
                remaining -= len(chunk)
        temporary.replace(target)
    except LibraryStorageError:
        raise
    except Exception as exc:
        try:
            temporary.unlink(missing_ok=True)
        except Exception:
            pass
        raise _storage_error(exc) from exc


def put_stream(key, handle, size, content_type, backend=None):
    selected = _resolve_backend(backend)
    if selected == "local":
        _put_local(key, handle, size)
        return "local"
    if selected == "nfs":
        from . import library_nfs
        library_nfs.put_stream(key, handle, size, content_type)
        return "nfs"
    try:
        handle.seek(0)
        _client(selected).put_object(
            bucket_name(selected), key, handle, length=size, content_type=content_type,
            part_size=5 * 1024 * 1024, num_parallel_uploads=1,
        )
    except LibraryStorageError:
        raise
    except Exception as exc:
        raise _storage_error(exc) from exc
    return "minio"


def open_stream(key, backend=None):
    selected = _resolve_backend(backend)
    if selected == "local":
        try:
            return _local_path(key).open("rb")
        except FileNotFoundError:
            raise
        except Exception as exc:
            raise _storage_error(exc) from exc
    if selected == "nfs":
        from . import library_nfs
        return library_nfs.open_stream(key)
    try:
        return _client(selected).get_object(bucket_name(selected), key)
    except LibraryStorageError:
        raise
    except Exception as exc:
        if getattr(exc, "code", None) in {"NoSuchKey", "NoSuchObject"}:
            raise FileNotFoundError(key) from exc
        raise _storage_error(exc) from exc


def iter_stream(handle, chunk_size=1024 * 1024):
    try:
        while chunk := handle.read(chunk_size):
            yield chunk
    finally:
        try:
            handle.close()
        finally:
            release = getattr(handle, "release_conn", None)
            if release:
                release()


def read_bytes(key, limit=16 * 1024 * 1024, backend=None):
    stream = open_stream(key, backend=backend)
    try:
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Editable content exceeds limit")
        return data
    finally:
        try:
            stream.close()
        finally:
            release = getattr(stream, "release_conn", None)
            if release:
                release()


def delete(key, backend=None):
    selected = _resolve_backend(backend)
    if selected == "local":
        try:
            _local_path(key).unlink(missing_ok=True)
        except Exception as exc:
            raise _storage_error(exc) from exc
        return
    if selected == "nfs":
        from . import library_nfs
        library_nfs.delete(key)
        return
    try:
        _client(selected).remove_object(bucket_name(selected), key)
    except LibraryStorageError:
        raise
    except Exception as exc:
        raise _storage_error(exc) from exc
