"""Direct remote NFS object storage; version-pinned with no local fallback."""
from contextlib import contextmanager
import ipaddress
import io
import re
from uuid import uuid4

from ..config import get_settings


def _error(code="UNAVAILABLE", message="NFS 连接或文件操作失败，请检查地址、端口和导出访问权限", retryable=True):
    from .library_storage import LibraryStorageError
    return LibraryStorageError("LIBRARY_NFS_" + code, message, retryable)


def _host(value):
    try:
        if not value or any(ch in value for ch in "/\\@?#") or re.search(r"\s|[\x00-\x1f\x7f]", value):
            raise ValueError("invalid host")
        if ":" in value or "[" in value or "]" in value:
            candidate = value[1:-1] if value.startswith("[") and value.endswith("]") else value
            return str(ipaddress.IPv6Address(candidate))
        if re.fullmatch(r"[0-9.]+", value):
            return str(ipaddress.IPv4Address(value))
        hostname = value.rstrip(".").encode("idna").decode("ascii")
        if len(hostname) > 253 or any(not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                                      for label in hostname.split(".")):
            raise ValueError("invalid hostname")
        return hostname + ("." if value.endswith(".") else "")
    except (ValueError, UnicodeError) as exc:
        raise _error("NOT_CONFIGURED", "NFS 服务器地址无效，请填写 IP 或主机名，端口请单独配置", False) from exc


def configuration():
    settings = get_settings()
    host = _host(str(getattr(settings, "library_nfs_host", "") or "").strip())
    export = str(getattr(settings, "library_nfs_export", "") or "").strip()
    if (not export.startswith("/") or "\\" in export or re.search(r"[\x00-\x1f]", export)
            or any(part in {".", ".."} for part in export.split("/")) or len(export.encode("utf-8")) > 1024):
        raise _error("NOT_CONFIGURED", "请配置 NFS 服务器地址和远程导出目录", False)
    try:
        values = {key: int(getattr(settings, "library_nfs_" + key, default))
                  for key, default in (("port", 2049), ("mount_port", 0), ("uid", 65534), ("gid", 65534))}
        values["timeout"] = float(getattr(settings, "library_nfs_timeout", 10))
        version = str(getattr(settings, "library_nfs_version", "3")).strip()
        if version not in {"3", "4.1"}:
            raise _error("UNSUPPORTED_VERSION", "直连客户端支持 NFSv3 或 NFSv4.1，请明确配置 3 或 4.1", False)
        values["version"] = 3 if version == "3" else "4.1"
        values["reserved_port"] = bool(getattr(settings, "library_nfs_reserved_port", True))
        if (not 1 <= values["port"] <= 65535 or not 0 <= values["mount_port"] <= 65535
                or not 0 <= values["uid"] <= 0xffffffff or not 0 <= values["gid"] <= 0xffffffff
                or not .01 <= values["timeout"] <= 120):
            raise ValueError("NFS configuration bounds")
    except (TypeError, ValueError) as exc:
        raise _error("NOT_CONFIGURED", "NFS 端口、身份或连接超时配置无效", False) from exc
    return {"host": host, "export": export.rstrip("/") or "/", **values}


def _key_parts(key):
    value = str(key)
    parts = value.split("/")
    if (not re.match(r"^library/users/[a-f0-9]{64}/", value) or "\\" in value or ":" in value
            or re.search(r"[\x00-\x1f\x7f]", value) or len(parts) > 32
            or any(part in {"", ".", ".."} or len(part.encode("utf-8")) > 255 for part in parts)):
        raise _error("INVALID_KEY", "NFS 资料对象路径无效", False)
    return parts


def _checked(result):
    status = result.get("status")
    if status == 2:
        raise FileNotFoundError("NFS object does not exist")
    if status in (1, 13, 30):
        raise _error("ACCESS_DENIED", "NFS 导出拒绝访问，请检查客户端地址及 UID/GID 读写权限", False)
    if status != 0:
        raise _error()
    return result


def _attributes(connection, handle, kind):
    attrs = _checked(connection.nfs.getattr(handle))["attributes"]
    if attrs.get("type") != kind:
        raise _error("UNSAFE_OBJECT", "NFS 对象不是普通文件或目录，拒绝跟随符号链接", False)
    return attrs


def _directory(connection, parts, create=False):
    handle = connection.root
    _attributes(connection, handle, 2)
    for part in parts:
        result = connection.nfs.lookup(handle, part)
        if result.get("status") == 2 and create:
            created = connection.nfs.mkdir(handle, part, mode=0o700)
            if created.get("status") not in (0, 17):
                _checked(created)
            result = connection.nfs.lookup(handle, part)
        handle = _checked(result)["resok"]["object"]["data"]
        _attributes(connection, handle, 2)
    return handle


def _new_connection():
    config = configuration()
    try:
        from .library_nfs_rpc import AuthenticationError, Connection, MountError
    except ImportError as exc:
        raise _error("DEPENDENCY_MISSING", "NFS 客户端依赖未安装，请更新 Hub 服务依赖", False) from exc
    try:
        connection = Connection(config)
    except AuthenticationError as exc:
        raise _error("AUTH_UNSUPPORTED", "NFS 导出未启用 AUTH_SYS 认证，当前客户端不支持该认证方式", False) from exc
    except MountError as exc:
        failures = {
            1: ("ACCESS_DENIED", "NFS 导出拒绝访问，请检查客户端地址及 UID/GID 权限", False),
            13: ("ACCESS_DENIED", "NFS 导出拒绝访问，请检查客户端地址及 UID/GID 权限", False),
            2: ("EXPORT_NOT_FOUND", "NFS 远程导出目录不存在，请检查导出路径", False),
            20: ("NOT_CONFIGURED", "NFS 导出路径不是目录，请检查导出路径", False),
            22: ("NOT_CONFIGURED", "NFS 服务拒绝导出参数，请检查远程导出配置", False),
            63: ("NOT_CONFIGURED", "NFS 导出路径超过服务器长度限制", False),
            10004: ("PROTOCOL_UNSUPPORTED", "服务器未支持 NFSv3 挂载协议，请检查服务和导出配置", False),
        }
        raise _error(*failures.get(exc.status, ())) from exc
    except PermissionError as exc:
        raise _error("ACCESS_DENIED", "NFS 网络访问被拒绝，请检查客户端网络及导出访问权限", False) from exc
    try:
        info = connection.nfs.fsinfo(connection.root)
        if info.get("status") == 0:
            details = info["resok"]
            connection.read_size = max(1, min(65536, int(details["rtmax"])))
            connection.write_size = max(1, min(65536, int(details["wtmax"])))
        return connection
    except BaseException:
        connection.close()
        raise


@contextmanager
def _session():
    connection = None
    from .library_storage import LibraryStorageError
    try:
        connection = _new_connection()
        yield connection
    except (LibraryStorageError, FileNotFoundError):
        raise
    except Exception as exc:
        raise _error() from exc
    finally:
        if connection:
            connection.close()


def ensure_ready():
    config = configuration()
    if config["version"] == "4.1":
        from . import library_nfs4
        return library_nfs4.ensure_ready(config=config)
    with _session() as connection:
        _attributes(connection, connection.root, 2)
        rights = _checked(connection.nfs.access(connection.root, 0x1f))["resok"]["access"]
        if rights & 0x1f != 0x1f:
            raise _error("ACCESS_DENIED", "NFS 导出目录缺少资料读写权限，请检查 UID/GID", False)
    return True


def put_stream(key, handle, size, content_type):
    parts = _key_parts(key)
    if type(size) is not int or size < 0:
        raise _error("INVALID_SIZE", "资料大小无效", False)
    config = configuration()
    if config["version"] == "4.1":
        from . import library_nfs4
        return library_nfs4.put_stream(key, handle, size, content_type, config=config)
    with _session() as connection:
        parent = _directory(connection, parts[:-1], create=True)
        temporary = ".soduwork-upload-" + uuid4().hex
        created = False
        try:
            _checked(connection.nfs.create(parent, temporary, 1, mode=0o600, size=0))
            created = True
            target = _checked(connection.nfs.lookup(parent, temporary))["resok"]["object"]["data"]
            _attributes(connection, target, 1)
            handle.seek(0)
            offset, verifier = 0, None
            while offset < size:
                content = handle.read(min(connection.write_size, size - offset))
                if not content or len(content) > size - offset:
                    raise _error("INCOMPLETE_UPLOAD", "上传内容与声明的文件大小不一致")
                position = 0
                while position < len(content):
                    remaining = content[position:]
                    result = _checked(connection.nfs.write(target, offset, len(remaining), remaining, 2))["resok"]
                    written = result["count"]
                    if written <= 0 or written > len(remaining):
                        raise _error("INCOMPLETE_UPLOAD", "NFS 未完整写入文件")
                    if verifier is not None and verifier != result["verf"]:
                        raise _error("INCOMPLETE_UPLOAD", "NFS 写入期间服务发生变化，请重试上传")
                    verifier = result["verf"]
                    position += written
                    offset += written
            if handle.read(1):
                raise _error("INCOMPLETE_UPLOAD", "上传内容与声明的文件大小不一致")
            committed = _checked(connection.nfs.commit(target))["resok"]["verf"]
            if verifier is not None and committed != verifier:
                raise _error("INCOMPLETE_UPLOAD", "NFS 写入未持久化，请重试上传")
            if int(_attributes(connection, target, 1)["size"]) != size:
                raise _error("INCOMPLETE_UPLOAD", "NFS 写入文件大小不一致")
            _checked(connection.nfs.rename(parent, temporary, parent, parts[-1]))
            created = False
        finally:
            if created:
                try:
                    connection.nfs.remove(parent, temporary)
                except Exception:
                    pass
    return "nfs"


class NfsStream(io.RawIOBase):
    def __init__(self, connection, handle, size):
        super().__init__()
        self.connection, self.handle, self.size, self.offset = connection, handle, size, 0

    def readable(self):
        return True

    def read(self, size=-1):
        if self.closed:
            raise ValueError("I/O operation on closed NFS stream")
        remaining = self.size - self.offset if size is None or size < 0 else min(size, self.size - self.offset)
        output = bytearray()
        from .library_storage import LibraryStorageError
        try:
            while remaining > 0:
                count = min(remaining, self.connection.read_size)
                result = _checked(self.connection.nfs.read(self.handle, self.offset, count))["resok"]
                content = result["data"]
                if (not content or len(content) > count or result["count"] != len(content)
                        or (result["eof"] and self.offset + len(content) != self.size)):
                    raise _error("INCOMPLETE_READ", "NFS 文件读取不完整，请重新下载")
                output.extend(content)
                self.offset += len(content)
                remaining -= len(content)
            return bytes(output)
        except Exception as exc:
            self.close()
            if isinstance(exc, LibraryStorageError):
                raise
            raise _error() from exc

    def close(self):
        if not self.closed:
            self.connection.close()
        super().close()


def open_stream(key):
    parts = _key_parts(key)
    config = configuration()
    if config["version"] == "4.1":
        from . import library_nfs4
        return library_nfs4.open_stream(key, config=config)
    connection = None
    from .library_storage import LibraryStorageError
    try:
        connection = _new_connection()
        parent = _directory(connection, parts[:-1])
        target = _checked(connection.nfs.lookup(parent, parts[-1]))["resok"]["object"]["data"]
        attributes = _attributes(connection, target, 1)
        return NfsStream(connection, target, int(attributes["size"]))
    except BaseException as exc:
        if connection:
            connection.close()
        if isinstance(exc, (LibraryStorageError, FileNotFoundError)) or not isinstance(exc, Exception):
            raise
        raise _error() from exc


def delete(key):
    parts = _key_parts(key)
    config = configuration()
    if config["version"] == "4.1":
        from . import library_nfs4
        return library_nfs4.delete(key, config=config)
    try:
        with _session() as connection:
            parent = _directory(connection, parts[:-1])
            target = _checked(connection.nfs.lookup(parent, parts[-1]))["resok"]["object"]["data"]
            _attributes(connection, target, 1)
            _checked(connection.nfs.remove(parent, parts[-1]))
    except FileNotFoundError:
        pass
