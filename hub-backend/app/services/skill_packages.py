"""Safe, content-addressed Agent Skill creation and import.

Imported packages stay outside the repository and are immutable. A small
atomic index decides which version is active for a company or one SoduWork device;
the immutable payload can then be transferred to any remote Runner.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import stat
import threading
import time
import uuid
import zipfile
from contextlib import contextmanager

from .immutable_cache import publish_immutable_tree
from .local_base import _data_root
from .skill_frontmatter import quote_scalar

_MAX_PACKAGE = 10 * 1024 * 1024
_MAX_UNPACKED = 30 * 1024 * 1024
_MAX_FILES = 300
_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_INDEX_LOCK = threading.Lock()


def root() -> str:
    return os.path.join(_data_root(), "capability-skills")


@contextmanager
def write_index_lock():
    """Serialize index publication across Hub workers sharing the data volume."""
    with _INDEX_LOCK:
        os.makedirs(root(), exist_ok=True)
        with open(os.path.join(root(), ".index.lock"), "a+b") as handle:
            handle.seek(0, os.SEEK_END)
            if not handle.tell():
                handle.write(b"0")
                handle.flush()
            acquired = False
            deadline = time.monotonic() + 10
            try:
                while not acquired:
                    try:
                        handle.seek(0)
                        if os.name == "nt":
                            import msvcrt
                            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                        else:
                            import fcntl
                            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        acquired = True
                    except (OSError, BlockingIOError):
                        if time.monotonic() >= deadline:
                            raise ValueError("Skill 目录正在更新，请稍后重试")
                        time.sleep(0.02)
                yield
            finally:
                if acquired:
                    handle.seek(0)
                    if os.name == "nt":
                        import msvcrt
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _index_path() -> str:
    return os.path.join(root(), "index.json")


def _safe_info(info: zipfile.ZipInfo) -> bool:
    from .skill_content import safe_path
    name = info.filename.replace("\\", "/")
    try:
        safe_path(name.rstrip("/"))
    except ValueError:
        return False
    mode = (info.external_attr >> 16) & 0xFFFF
    return bool(name) and not name.startswith("/") and not re.match(r"^[A-Za-z]:", name) \
        and all(x not in ("", ".", "..") for x in name.rstrip("/").split("/")) \
        and not stat.S_ISLNK(mode)


def _frontmatter(text: str | bytes, *, source: str = "SKILL.md") -> dict:
    from .skill_frontmatter import parse as parse_frontmatter
    # Packaged Skills are materialized under generated folder names on Runners.
    # Their identity must come from the file, never an archive folder fallback.
    fields = parse_frontmatter(text, source=source)
    name = fields["name"]
    if not _NAME.fullmatch(name):
        raise ValueError(f"{source}: 技能 name 只允许小写字母、数字和单个短横线，最长 64 位")
    return {key: fields[key] for key in ("name", "description", "compatibility")}


def _canonical_digest(files: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(files[name])
        digest.update(b"\0")
    return digest.hexdigest()


def read_package_files(data: bytes) -> tuple[dict[str, bytes], str]:
    """Validate archive boundaries and return bytes plus the original root prefix."""
    if not data or len(data) > _MAX_PACKAGE:
        raise ValueError("技能包为空或超过 10MB")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError("技能包必须是 zip 文件（可以使用 .zip 或 .skill 扩展名）") from exc
    infos = archive.infolist()
    if len(infos) > _MAX_FILES or sum(x.file_size for x in infos) > _MAX_UNPACKED:
        raise ValueError("技能包文件过多或解压后超过 30MB")
    if any(not _safe_info(x) for x in infos):
        raise ValueError("技能包包含越界路径或符号链接")
    file_infos = [x for x in infos if not x.is_dir()]
    names = {x.filename.replace("\\", "/"): x for x in file_infos}
    if len({name.casefold() for name in names}) != len(file_infos):
        raise ValueError("技能包包含重复文件路径")
    skill_files = [name for name in names if name == "SKILL.md" or name.endswith("/SKILL.md")]
    if len(skill_files) != 1:
        raise ValueError("一个技能包必须且只能包含一个 SKILL.md")
    skill_md = skill_files[0]
    prefix = skill_md[:-len("SKILL.md")].rstrip("/")
    relative: dict[str, bytes] = {}
    for name, info in names.items():
        if prefix:
            if not name.startswith(prefix + "/"):
                raise ValueError("技能包根目录之外还有文件，请只打包一个完整技能目录")
            rel = name[len(prefix) + 1:]
        else:
            rel = name
        if rel:
            from .skill_content import safe_path
            safe_path(rel)
            try:
                relative[rel] = archive.read(info)
            except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
                raise ValueError("技能包损坏、加密或压缩格式不支持") from exc
    # A package must describe the same tree on Windows and case-sensitive hosts.
    casing = {}
    file_keys = {name.casefold() for name in relative}
    for name in relative:
        parts = name.split("/")
        for length in range(1, len(parts) + 1):
            prefix_path = "/".join(parts[:length])
            key = prefix_path.casefold()
            if (key in casing and casing[key] != prefix_path) or (
                    length < len(parts) and key in file_keys):
                raise ValueError("技能包包含大小写冲突或文件与目录重名")
            casing[key] = prefix_path
    return relative, prefix


def parse(data: bytes, filename: str = "") -> dict:
    relative, prefix = read_package_files(data)
    source = (prefix + "/" if prefix else "") + "SKILL.md"
    meta = _frontmatter(relative["SKILL.md"], source=source)
    checksum = _canonical_digest(relative)
    return {
        **meta, "checksum": checksum, "filename": str(filename or "")[:180],
        "files": relative, "fileCount": len(relative),
        "unpackedBytes": sum(len(x) for x in relative.values()),
        "hasScripts": any(name.startswith("scripts/") for name in relative),
        "resourceKinds": [kind for kind in ("scripts", "references", "assets", "agents")
                          if any(name.startswith(kind + "/") for name in relative)],
    }


def create(name: str, description: str, instructions: str) -> dict:
    clean_name = str(name or "").strip().lower()
    clean_desc = str(description or "").strip()
    body = str(instructions or "").strip()
    if not body:
        raise ValueError("请写清楚这个 Skill 的工作方法和完成标准")
    if len(body) > 100_000:
        raise ValueError("Skill 正文不能超过 10 万字")
    skill_md = ("---\nname: %s\ndescription: %s\n---\n\n%s\n" %
                (quote_scalar(clean_name), quote_scalar(clean_desc), body)).encode("utf-8")
    buffer = io.BytesIO()
    info = zipfile.ZipInfo("SKILL.md", date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(info, skill_md)
    return parse(buffer.getvalue(), clean_name + ".skill")


def public_summary(parsed: dict) -> dict:
    return {key: parsed[key] for key in (
        "name", "description", "compatibility", "checksum", "filename",
        "fileCount", "unpackedBytes", "hasScripts", "resourceKinds")}


def _load_index() -> dict:
    try:
        with open(_index_path(), "r", encoding="utf-8") as stream:
            value = json.load(stream)
        if isinstance(value, dict) and isinstance(value.get("items"), list):
            return value
    except (OSError, ValueError, TypeError):
        pass
    return {"schemaVersion": 1, "items": []}


def index_revision() -> str:
    """Fingerprint the shared atomic index; never reuse packages on read failure.

    Do not rely on inode/mtime: network volumes and successive publications can
    report identical file metadata. Async callers must run this file I/O off-loop.
    """
    try:
        with open(_index_path(), "rb") as stream:
            content = stream.read()
    except FileNotFoundError:
        return "missing"
    value = json.loads(content)
    if not isinstance(value, dict) or not isinstance(value.get("items"), list):
        raise ValueError("Skill 索引格式无效")
    return hashlib.sha256(content).hexdigest()


def _save_index(index: dict) -> None:
    os.makedirs(root(), exist_ok=True)
    path = _index_path()
    temp = path + ".tmp-" + uuid.uuid4().hex[:8]
    try:
        with open(temp, "w", encoding="utf-8") as stream:
            json.dump(index, stream, ensure_ascii=False, indent=2)
        os.replace(temp, path)
    finally:
        if os.path.isfile(temp):
            os.remove(temp)


def install(parsed: dict, scope: str, owner_client_id: str = "") -> dict:
    """Publish one immutable version and make it active within its scope."""
    scope = "personal" if scope == "personal" else "company"
    owner = str(owner_client_id or "")[:64] if scope == "personal" else ""
    if scope == "personal" and not owner:
        raise ValueError("个人 Skill 必须绑定一台 SoduWork")
    checksum, name = str(parsed["checksum"]), str(parsed["name"])
    from . import skills as skill_service
    if any(item.get("name") == name for item in skill_service.scan_root(
            skill_service.bundled_root())):
        raise ValueError("不能用导入包覆盖 SoduWork 内置 Skill「%s」，请换一个名称" % name)
    target = os.path.join(root(), "packages", checksum, name)
    ready = os.path.join(target, ".ready")
    if not os.path.isfile(ready):
        temp = target + ".tmp-" + uuid.uuid4().hex[:8]
        try:
            os.makedirs(temp, exist_ok=False)
            for relative, data in parsed["files"].items():
                destination = os.path.abspath(os.path.join(temp, *relative.split("/")))
                if os.path.commonpath([os.path.abspath(temp), destination]) != os.path.abspath(temp):
                    raise ValueError("技能包包含越界路径")
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                with open(destination, "wb") as stream:
                    stream.write(data)
            with open(os.path.join(temp, ".ready"), "w", encoding="utf-8") as marker:
                marker.write(checksum)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            publish_immutable_tree(temp, target, ready)
        finally:
            if os.path.isdir(temp):
                shutil.rmtree(temp, ignore_errors=True)
    row = {
        "name": name, "description": parsed["description"],
        "compatibility": parsed.get("compatibility") or "", "scope": scope,
        "ownerClientId": owner, "packageChecksum": checksum, "path": target,
        "root": os.path.dirname(target), "dir": name, "bundled": True,
        "hasScripts": bool(parsed.get("hasScripts")),
        "resourceKinds": list(parsed.get("resourceKinds") or []),
        "fileCount": int(parsed.get("fileCount") or 0),
        "createdAt": int(time.time()),
    }
    with write_index_lock():
        index = _load_index()
        key = (scope, owner, name)
        conflicts = [
            item for item in index["items"]
            if item.get("name") == name and (
                (scope == "company" and item.get("scope") != "company") or
                (scope == "personal" and item.get("scope") == "company" and
                 item.get("publisherClientId") != owner))
        ]
        if conflicts:
            raise ValueError("能力库已存在其他作用域的同名 Skill「%s」，请换一个名称" % name)
        index["items"] = [
            item for item in index["items"]
            if (item.get("scope"), item.get("ownerClientId") or "", item.get("name")) != key
        ]
        index["items"].append(row)
        _save_index(index)
    skill_service.clear_scan_cache()
    return row


def remove_personal(name: str, owner: str, checksum: str) -> dict:
    """Remove only an owned active pointer; preserve immutable/shared evidence."""
    from . import skills, skill_sharing
    if not owner or not _NAME.fullmatch(name):
        raise FileNotFoundError("个人 Skill 不存在")
    if any(row["name"] == name for row in skills.scan_root(skills.bundled_root())):
        raise PermissionError("SoduWork 内置技能只能启用或停用，不能删除")
    with write_index_lock():
        index = _load_index()
        row = next((item for item in index["items"] if item.get("name") == name
                    and item.get("scope") == "personal"
                    and item.get("ownerClientId") == owner), None)
        if row is None:
            raise FileNotFoundError("只能删除自己创建或导入的 Skill")
        if not checksum or row.get("packageChecksum") != checksum:
            raise skill_sharing.Conflict("Skill 内容已变化，请刷新后重新确认删除")
        index.setdefault("deletedItems", []).append({**row, "deletedAt": int(time.time())})
        index["items"] = [item for item in index["items"] if item is not row]
        _save_index(index)
    skills.clear_scan_cache()
    return row


def active(*, owner_client_id: str = "", include_company: bool = True,
           include_all_personal: bool = False) -> list[dict]:
    """Return active packages visible to one device (or all for admin review)."""
    rows = []
    with _INDEX_LOCK:
        items = list(_load_index().get("items") or [])
    for item in items:
        scope = str(item.get("scope") or "company")
        if scope == "company" and not include_company:
            continue
        if scope == "personal" and not (
                include_all_personal or
                (owner_client_id and item.get("ownerClientId") == owner_client_id)):
            continue
        path = str(item.get("path") or "")
        if path and os.path.isfile(os.path.join(path, "SKILL.md")):
            rows.append(dict(item))
    return sorted(rows, key=lambda item: (
        item.get("name") or "", item.get("scope") or "", item.get("ownerClientId") or ""))
