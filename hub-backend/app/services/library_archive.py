"""Read-only ZIP folders. Entries never become filesystem or storage paths."""
import asyncio
import hashlib
import io
import mimetypes
import re
import stat
import struct
import unicodedata
import zipfile
import zlib
from pathlib import PurePosixPath

from fastapi import HTTPException

from . import library_preview

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_ENTRIES = 2000
MAX_INDEX_BYTES = 4 * 1024 * 1024
MAX_RATIO = 200


def _error(status, code, message):
    return HTTPException(status, {"code": "LIBRARY_ARCHIVE_" + code,
                                  "message": message, "retryable": False})


def _too_large():
    return _error(413, "TOO_LARGE", "ZIP 超过预览限制（压缩包或单文件 64MB、解压后 256MB、2000 个文件及文件夹），请下载后打开")


def safe_path(value, directory=False):
    value = unicodedata.normalize("NFC", str(value or "").replace("\\", "/"))
    if directory and value.endswith("/"):
        value = value[:-1]
    parts = value.split("/")
    if (not value or len(value.encode("utf-8")) > 1024 or len(parts) > 32
            or re.search(r"[\x00-\x1f\x7f:]", value)
            or any(part in {"", ".", ".."} or part.endswith((".", " ")) for part in parts)):
        raise _error(400, "UNSAFE_PATH", "ZIP 中含有不安全的文件路径，无法预览")
    return value


def _central_directory_budget(data):
    """Bound metadata *before* ZipFile constructs one Python object per entry.

    A 64MB ZIP can otherwise expand to hundreds of thousands of ZipInfo objects.
    ZIP64/multi-volume directories are outside this intentionally small viewer.
    """
    end = data.rfind(b"PK\x05\x06", max(0, len(data) - 65557))
    if end < 0 or len(data) - end < 22:
        raise _error(415, "INVALID", "文件不是完整的 ZIP 压缩包")
    _, disk, cd_disk, disk_count, count, size, offset, comment = struct.unpack_from("<4s4H2LH", data, end)
    if (disk or cd_disk or disk_count != count or count == 0xffff
            or size == 0xffffffff or offset == 0xffffffff):
        raise _error(415, "UNSUPPORTED", "此 ZIP 使用分卷或 ZIP64 目录，请下载后使用系统应用打开")
    if count > MAX_ENTRIES or size > MAX_INDEX_BYTES:
        raise _too_large()
    start = end - size
    if end + 22 + comment != len(data) or start < 0:
        raise _error(415, "INVALID", "ZIP 文件目录已损坏")
    position, actual_count = start, 0
    while position < end:
        if position + 46 > end or data[position:position + 4] != b"PK\x01\x02":
            raise _error(415, "INVALID", "ZIP 文件目录已损坏")
        name_size, extra_size, comment_size = struct.unpack_from("<3H", data, position + 28)
        position += 46 + name_size + extra_size + comment_size
        actual_count += 1
        if actual_count > MAX_ENTRIES:
            raise _too_large()
    if position != end or actual_count != count:
        raise _error(415, "INVALID", "ZIP 文件目录不完整")


def _entry(path, size=0, directory=False):
    return {"path": path, "filename": path.rsplit("/", 1)[-1], "size": size,
            "contentType": "inode/directory" if directory else (
                mimetypes.guess_type(path)[0] or "application/octet-stream"),
            "isDirectory": directory}


def _display_name(info):
    """Honor Unicode ZIP names and recover common Windows Chinese filenames.

    The ZipInfo object retains the original name for CRC/local-header checks;
    only the logical path shown to the user is decoded here.
    """
    if "\x00" in info.orig_filename:
        raise _error(400, "UNSAFE_PATH", "ZIP 中含有不安全的文件路径，无法预览")
    if info.flag_bits & 0x800:
        return info.orig_filename
    raw = info.orig_filename.encode("cp437")
    extra, position = info.extra, 0
    while position + 4 <= len(extra):
        kind, size = struct.unpack_from("<HH", extra, position)
        field = extra[position + 4:position + 4 + size]
        position += 4 + size
        # Info-ZIP Unicode Path extra field: version + original-name CRC32.
        if (kind == 0x7075 and len(field) > 5 and field[0] == 1
                and struct.unpack_from("<I", field, 1)[0] == zlib.crc32(raw)):
            try:
                return field[5:].decode("utf-8")
            except UnicodeError:
                pass
    for encoding in ("utf-8", "gb18030"):
        try:
            decoded = raw.decode(encoding)
        except UnicodeError:
            continue
        if encoding == "utf-8" or re.search(r"[\u3400-\u9fff\uf900-\ufaff]", decoded):
            return decoded
    return info.orig_filename


def _index(archive):
    entries, members, explicit, folded = {}, {}, set(), {}
    total = 0

    def register(path, directory, size=0, is_explicit=False):
        key = path.casefold()
        previous = entries.get(path)
        if ((key in folded and folded[key] != path)
                or (previous and previous["isDirectory"] != directory)
                or (is_explicit and path in explicit)):
            raise _error(400, "AMBIGUOUS_PATH", "ZIP 中存在重复或冲突的文件路径，无法预览")
        folded[key] = path
        entries[path] = _entry(path, size, directory)
        if is_explicit:
            explicit.add(path)
        if len(entries) > MAX_ENTRIES:
            raise _too_large()

    for info in archive.infolist():
        # ZipInfo truncates filename at NUL; the original must be validated too.
        mode = (info.external_attr >> 16) & 0xffff
        kind = stat.S_IFMT(mode)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise _error(415, "UNSUPPORTED_ENTRY", "ZIP 含符号链接或特殊文件，请下载后使用系统应用打开")
        directory = info.is_dir() or kind == stat.S_IFDIR
        path = safe_path(_display_name(info), directory)
        if info.flag_bits & 1:
            raise _error(415, "ENCRYPTED", "加密 ZIP 暂不支持预览，请下载后使用系统应用打开")
        if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise _error(415, "UNSUPPORTED_ENTRY", "ZIP 中的压缩算法暂不支持预览，请使用系统应用打开")
        size = info.file_size
        total += size
        if (size > MAX_MEMBER_BYTES or total > MAX_TOTAL_BYTES
                or (size > 1024 * 1024 and size > max(1, info.compress_size) * MAX_RATIO)):
            raise _too_large()
        if directory and size:
            raise _error(415, "INVALID", "ZIP 文件夹条目包含异常内容")
        register(path, directory, size, True)
        parts = path.split("/")
        for index in range(1, len(parts)):
            register("/".join(parts[:index]), True)
        if not directory:
            members[path] = info
    files = sorted(entries.values(), key=lambda item: (not item["isDirectory"], item["path"].casefold()))
    return {"files": files, "fileCount": len(members),
            "directoryCount": len(entries) - len(members), "totalSize": total}, members


def inspect(data, member=None, preview=False):
    _central_directory_budget(data)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            manifest, members = _index(archive)
            if member is None:
                return manifest
            info = members.get(member)
            if info is None:
                raise _error(404, "MEMBER_NOT_FOUND", "ZIP 中没有这个文件")
            if preview and info.file_size > library_preview.MAX_BYTES:
                raise _error(413, "TOO_LARGE", "文件超过 16MB 内容预览限制，请使用系统应用打开")
            try:
                with archive.open(info) as handle:
                    content = handle.read(min(info.file_size, MAX_MEMBER_BYTES) + 1)
                if len(content) != info.file_size:
                    raise _error(422, "CORRUPT_MEMBER", "ZIP 中的文件大小不一致，无法读取完整内容")
            except (ValueError, RuntimeError, KeyError, OSError, EOFError, zipfile.BadZipFile, zlib.error) as exc:
                raise _error(422, "CORRUPT_MEMBER", "ZIP 中的文件已损坏，无法读取完整内容") from exc
            entry = _entry(member, len(content))
            if preview:
                try:
                    return library_preview.read(entry["filename"], entry["contentType"], content)
                except ValueError as exc:
                    raise _error(415, "PREVIEW_UNSUPPORTED", str(exc)) from exc
            return entry, content
    except (zipfile.BadZipFile, UnicodeError, ValueError, EOFError, NotImplementedError) as exc:
        raise _error(415, "INVALID", "ZIP 文件目录已损坏或格式不受支持") from exc


async def read_item(row, storage_call, backend, *, member=None, preview=False):
    # Explicitly keep Office packages on the Office/system-open route.
    extension = PurePosixPath(row.filename or "").suffix.lower()
    mime = str(row.content_type or "").split(";", 1)[0].strip().lower()
    if extension != ".zip" and not (not extension and mime in {"application/zip", "application/x-zip-compressed"}):
        raise _error(415, "UNSUPPORTED", "仅支持 ZIP 文件夹预览")
    if member is not None:
        member = safe_path(member)
    if int(row.size or 0) > MAX_ARCHIVE_BYTES:
        raise _too_large()
    try:
        data = await asyncio.to_thread(storage_call, "read_bytes", row.storage_key,
                                       MAX_ARCHIVE_BYTES, backend=backend)
    except FileNotFoundError as exc:
        raise _error(404, "OBJECT_NOT_FOUND", "ZIP 文件已不存在") from exc
    except ValueError as exc:
        raise _too_large() from exc
    if len(data) != int(row.size or 0):
        raise _error(502, "INTEGRITY", "ZIP 文件大小不一致，无法读取完整内容")
    delivery = (row.extra or {}).get("soduWorkDelivery")
    if isinstance(delivery, dict) and hashlib.sha256(data).hexdigest() != delivery.get("objectSha256"):
        raise _error(502, "INTEGRITY", "ZIP 成果文件校验失败，无法读取完整内容")
    return await asyncio.to_thread(inspect, data, member, preview)
