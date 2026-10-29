"""Immutable, account-scoped delivery collections backed by the material library.

One final result is one LibraryItem: original bytes for a file, or one archive
for related files. Only a verified manifest is persisted; caller paths never
become object-store keys or filesystem paths.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import mimetypes
import re
import stat
import unicodedata
import uuid
import zipfile
from datetime import datetime, timezone
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..config import get_settings
from ..library_models import LibraryItem
from . import library_conversation_save, library_storage, delivery_manifest

NAMESPACE = uuid.UUID("414c1107-f59a-4685-99ea-eac3a2edc403")
META_KEY = "soduWorkDelivery"
MAX_BYTES = 96 * 1024 * 1024
MAX_FILES = 1000
MAX_UNPACKED = 192 * 1024 * 1024
MAX_RATIO = 200


@dataclass(frozen=True)
class ValidationLimits:
    """Server-owned limits; download and library policies may differ."""
    max_bytes: int
    max_files: int = MAX_FILES
    max_unpacked: int = MAX_UNPACKED
    max_ratio: int = MAX_RATIO
    ratio_grace: int = 8 * 1024 * 1024
    max_file_bytes: int = 0

    @property
    def file_bytes(self):
        return self.max_file_bytes or self.max_bytes


def owner_key(client):
    return str(client.user_ref or client.id).strip()[:128]


def byte_limit():
    configured = int(get_settings().library_max_mb or 0) * 1024 * 1024
    return min(MAX_BYTES, configured) if configured > 0 else MAX_BYTES


def validation_limits():
    return ValidationLimits(byte_limit(), max_files=MAX_FILES,
        max_unpacked=MAX_UNPACKED, max_ratio=MAX_RATIO)


def safe_path(value):
    if not isinstance(value, str) or not value or len(value) > 500:
        raise HTTPException(400, "成果文件路径无效")
    name = unicodedata.normalize("NFC", value)
    parts = name.split("/")
    if (name != value or any(not part or part in {".", ".."} or part != part.strip()
            or part.endswith(".") or len(part) > 200 for part in parts)
            or re.search(r'[\\:*?"<>|\x00-\x1f\x7f]', name)
            or any(re.fullmatch(r"(?i)(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part)
                   for part in parts)):
        raise HTTPException(400, "成果文件路径不安全或不能跨设备使用")
    return name


def _text(value, name, limit=160, required=False):
    if not isinstance(value, str) or len(value) > limit or re.search(r"[\x00-\x1f\x7f]", value):
        raise HTTPException(400, "成果字段不正确：" + name)
    value = value.strip()
    if required and not value:
        raise HTTPException(400, "缺少成果字段：" + name)
    return value


def clean_manifest(raw, *, limits=None):
    limits = limits or validation_limits()
    if not isinstance(raw, dict) or set(raw) - {
            "schemaVersion", "source", "sessionId", "revision", "title", "conversationTitle", "entryPath", "kind", "files", "externalDependencies"}:
        raise HTTPException(400, "成果清单格式不正确")
    if raw.get("schemaVersion", 1) not in (1, "1", "1.0"):
        raise HTTPException(400, "成果清单版本不支持")
    source = raw.get("source")
    if not isinstance(source, str) or source not in {"local", "cloud"}:
        raise HTTPException(400, "成果执行位置不正确")
    session_id = _text(raw.get("sessionId", ""), "sessionId", required=True)
    revision = _text(raw.get("revision", ""), "revision", required=True)
    if not re.fullmatch(r"[A-Za-z0-9._:-]+", session_id) or not re.fullmatch(r"[A-Za-z0-9._:-]+", revision):
        raise HTTPException(400, "成果来源标识不能包含本地路径")
    title = _text(raw.get("title", ""), "title", 240) or "本轮成果"
    conversation_title = raw.get("conversationTitle", "")
    if not isinstance(conversation_title, str):
        raise HTTPException(400, "会话标题格式不正确")
    conversation_title = re.sub(r"[\x00-\x1f\x7f]", " ", conversation_title).strip()[:240]
    dependencies = raw.get("externalDependencies", [])
    if not isinstance(dependencies, list) or len(dependencies) > 50:
        raise HTTPException(400, "在线依赖说明不正确")
    dependencies = list(dict.fromkeys(_text(value, "externalDependencies", 500, required=True)
                                      for value in dependencies))
    rows = raw.get("files")
    if not isinstance(rows, list) or not 1 <= len(rows) <= limits.max_files:
        raise HTTPException(400, f"成果清单必须包含 1 至 {limits.max_files} 个文件")
    names, files, total = set(), [], 0
    for row in rows:
        if not isinstance(row, dict) or set(row) - {"path", "size", "sha256", "contentType", "role"}:
            raise HTTPException(400, "成果文件清单不正确")
        name = safe_path(row.get("path"))
        if name.casefold() in names:
            raise HTTPException(400, "成果清单含重复或仅大小写不同的路径")
        names.add(name.casefold())
        size = row.get("size")
        if type(size) is not int or size < 0 or size > limits.file_bytes:
            raise HTTPException(413, "成果文件超过大小限制")
        total += size
        digest = str(row.get("sha256") or "").lower()
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise HTTPException(400, "成果文件缺少有效的 SHA-256")
        content_type = row.get("contentType") or mimetypes.guess_type(name)[0] or "application/octet-stream"
        if not isinstance(content_type, str) or not re.fullmatch(r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+", content_type):
            raise HTTPException(400, "成果文件类型不正确")
        role = row.get("role", "supporting")
        if not isinstance(role, str) or role not in {"primary", "supporting"}:
            raise HTTPException(400, "成果包仅包含最终文件与其支撑文件")
        files.append({"path": name, "size": size, "sha256": digest,
                      "contentType": content_type, "role": role})
    if total > limits.max_unpacked:
        raise HTTPException(413, "成果解包后的总大小超过限制")
    for name in names:
        if any("/".join(name.split("/")[:end]) in names for end in range(1, len(name.split("/")))):
            raise HTTPException(400, "成果文件与文件夹的路径冲突")
    kind = raw.get("kind") or ("file" if len(files) == 1 else "bundle")
    if not isinstance(kind, str) or kind not in {"file", "bundle"} or (kind == "file" and len(files) != 1):
        raise HTTPException(400, "单文件成果必须恰好包含一个文件")
    entry = safe_path(raw.get("entryPath") or files[0]["path"])
    if entry not in {row["path"] for row in files}:
        raise HTTPException(400, "成果入口不在文件清单中")
    return {"schemaVersion": 1, "source": source, "sessionId": session_id,
            "revision": revision, "title": title, "conversationTitle": conversation_title, "entryPath": entry,
            "kind": kind, "files": sorted(files, key=lambda row: row["path"]),
            "externalDependencies": dependencies}


def _check_bytes(row, data):
    if len(data) != row["size"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
        raise HTTPException(422, "成果文件的大小或校验值不匹配：" + row["path"])
    # Empty supporting assets can be intentional (e.g. a source marker).
    # Primary deliverables must still pass the existing content validator.
    if row["role"] == "primary":
        result = delivery_manifest.validate_bytes(row["path"], data, row["contentType"])
        if result.get("state") != "passed":
            reason = str(result.get("reason") or "未通过文件结构校验")
            raise HTTPException(422, "成果文件结构无效：" + row["path"] + "（" + reason + "）")


def validate_payload(manifest, data, *, limits=None):
    limits = limits or validation_limits()
    if not data or len(data) > limits.max_bytes:
        raise HTTPException(413, "成果文件为空或超过大小限制")
    if manifest["kind"] == "file":
        _check_bytes(manifest["files"][0], data)
        return
    expected = {row["path"]: row for row in manifest["files"]}
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            if len(infos) > limits.max_files * 2:
                raise HTTPException(413, "成果包内的项目过多")
            names, actual, total = set(), {}, 0
            for info in infos:
                if info.orig_filename != info.filename:
                    raise HTTPException(400, "成果包包含被截断的文件路径")
                name = safe_path(info.filename[:-1] if info.is_dir() else info.filename)
                if name.casefold() in names:
                    raise HTTPException(400, "成果包包含重名路径")
                names.add(name.casefold())
                mode = (info.external_attr >> 16) & 0o170000
                if (mode not in (0, stat.S_IFREG, stat.S_IFDIR)
                        or stat.S_ISLNK(info.external_attr >> 16) or info.flag_bits & 1):
                    raise HTTPException(400, "成果包不支持链接、特殊文件或加密文件")
                if info.is_dir():
                    continue
                if mode == stat.S_IFDIR:
                    raise HTTPException(400, "成果包文件类型不一致")
                if name not in expected or info.file_size != expected[name]["size"]:
                    raise HTTPException(422, "成果包与清单不一致：" + name)
                total += info.file_size
                if (info.file_size > limits.file_bytes or total > limits.max_unpacked
                        or total > max(limits.ratio_grace, len(data) * limits.max_ratio)):
                    raise HTTPException(413, "成果包解压大小或压缩倍率超过限制")
                actual[name] = info
            if set(actual) != set(expected):
                raise HTTPException(422, "成果包缺少清单中的文件，不能保存不完整成果")
            for name, info in actual.items():
                with archive.open(info) as member:
                    content = member.read(expected[name]["size"] + 1)
                _check_bytes(expected[name], content)
    except HTTPException:
        raise
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, NotImplementedError) as exc:
        raise HTTPException(422, "成果包损坏或使用了不支持的压缩格式") from exc


def identity(owner, manifest):
    value = json.dumps([owner, manifest["source"], manifest["sessionId"], manifest["revision"]],
                       ensure_ascii=False, separators=(",", ":"))
    return str(uuid.uuid5(NAMESPACE, value))


def content_digest(manifest):
    data = {key: manifest[key] for key in ("kind", "entryPath", "files", "externalDependencies")}
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":")).encode()).hexdigest()


def metadata(row):
    value = (row.extra or {}).get(META_KEY)
    return value if isinstance(value, dict) and value.get("schemaVersion") == 1 else None


def public(row):
    info = metadata(row) or {}
    at = row.created_at
    return {"id": row.id, "title": row.title, "filename": row.filename, "size": row.size,
            "storage": row.backend, "kind": info.get("kind", "file"),
            "files": info.get("files", []), "entryPath": info.get("entryPath", ""),
            "fileCount": len(info.get("files", [])), "source": info.get("source", ""),
            "sessionId": info.get("sessionId", ""), "revision": info.get("revision", ""),
            "externalDependencies": info.get("externalDependencies", []),
            "createdAt": (at if at.tzinfo else at.replace(tzinfo=timezone.utc)).isoformat() if at else None}


async def get(session, owner, delivery_id):
    row = await session.get(LibraryItem, delivery_id, populate_existing=True)
    if row is None or row.owner_key != owner or row.deleted_at or not metadata(row):
        raise HTTPException(404, "成果不存在")
    return row


def _existing(row, owner, digest):
    if row is None or row.owner_key != owner or not metadata(row):
        raise HTTPException(409, "成果标识已经被占用")
    if metadata(row).get("contentDigest") != digest:
        raise HTTPException(409, "同一成果版本的内容不同，请重新生成版本后保存")
    if row.deleted_at:
        raise HTTPException(409, "此成果已在资料库回收站，请先恢复后再保存")
    return row, True


async def persist(session, owner, manifest, data):
    manifest = clean_manifest(manifest)
    await asyncio.to_thread(validate_payload, manifest, data)
    async with library_conversation_save.save_lock(session, owner, manifest["sessionId"]):
        return await _persist_locked(session, owner, manifest, data)


async def _identity_row(session, owner, item_id):
    row = await session.get(LibraryItem, item_id, populate_existing=True)
    if row is not None:
        return row
    # A manually saved file may have been promoted in place. Keep its original
    # library ID valid, while retries still resolve the immutable delivery ID.
    return await session.scalar(select(LibraryItem).where(
        LibraryItem.owner_key == owner,
        LibraryItem.extra[META_KEY]["identity"].as_string() == item_id,
    ).execution_options(populate_existing=True))


def _source(manifest):
    return {"type": "conversation", "sessionId": manifest["sessionId"],
            "conversationTitle": manifest.get("conversationTitle", ""),
            "savedAt": datetime.now(timezone.utc).isoformat()}


async def _persist_locked(session, owner, manifest, data):
    item_id, digest = identity(owner, manifest), content_digest(manifest)
    old = await _identity_row(session, owner, item_id)
    if old is not None:
        result = _existing(old, owner, digest)
        library_conversation_save.enrich_source(old, _source(manifest))
        await session.commit()
        await session.refresh(old)
        return result
    filename = manifest["files"][0]["path"].rsplit("/", 1)[-1]
    content_type = manifest["files"][0]["contentType"]
    if manifest["kind"] == "bundle":
        filename = re.sub(r'[\\/:*?"<>|]', "_", manifest["title"]).strip(" .")[:120] or "成果"
        filename += ".zip"
        content_type = "application/zip"
    key = library_storage.object_key(owner, item_id, filename)
    backend = library_storage.storage_backend()
    info = {**manifest, "identity": item_id, "contentDigest": digest,
            "objectSha256": hashlib.sha256(data).hexdigest()}
    reusable = await library_conversation_save.find_exact(session, owner, backend, None,
        manifest["sessionId"], filename, len(data), info["objectSha256"], include_deliveries=False)
    if reusable is not None:
        reusable.extra = {**(reusable.extra or {}), META_KEY: info}
        library_conversation_save.enrich_source(reusable, _source(manifest))
        try:
            await session.commit()
        except BaseException:
            await session.rollback()
            existing = await _identity_row(session, owner, item_id)
            if existing is not None:
                return _existing(existing, owner, digest)
            raise
        await session.refresh(reusable)
        return reusable, False
    committing = False
    try:
        await asyncio.to_thread(library_storage.put_bytes, key, data, content_type, backend=backend)
        row = LibraryItem(id=item_id, owner_key=owner, kind="file", title=manifest["title"],
                          filename=filename, content_type=content_type, size=len(data),
                          storage_key=key, backend=backend, extra={META_KEY: info})
        library_conversation_save.enrich_source(row, _source(manifest))
        session.add(row)
        committing = True
        await session.commit()
    except BaseException as exc:
        await session.rollback()
        # A lost commit acknowledgement is not proof that the object is unused.
        existing = await session.get(LibraryItem, item_id, populate_existing=True) if committing else None
        if existing is None or existing.storage_key != key:
            try:
                await asyncio.to_thread(library_storage.delete, key, backend=backend)
            except Exception:
                pass
        if isinstance(exc, IntegrityError) or (existing is not None and existing.storage_key == key):
            return _existing(existing, owner, digest)
        raise
    await session.refresh(row)
    return row, False


async def read_payload(row):
    try:
        data = await asyncio.to_thread(library_storage.read_bytes, row.storage_key,
                                      limit=MAX_BYTES, backend=row.backend)
    except FileNotFoundError as exc:
        raise HTTPException(404, "成果文件已不存在") from exc
    except ValueError as exc:
        raise HTTPException(502, "成果文件大小异常，不能下载不完整内容") from exc
    info = metadata(row) or {}
    if len(data) != row.size or hashlib.sha256(data).hexdigest() != info.get("objectSha256"):
        raise HTTPException(502, "成果文件校验失败，不能下载不完整内容")
    return data


def _extract_member(data, name, size):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            with archive.open(name) as member:
                return member.read(size + 1)
    except (ValueError, RuntimeError, zipfile.BadZipFile, KeyError) as exc:
        raise HTTPException(502, "成果包中的文件读取失败") from exc


async def read_file(row, name):
    name = safe_path(name)
    info = metadata(row) or {}
    entry = next((item for item in info.get("files", []) if item.get("path") == name), None)
    if entry is None:
        raise HTTPException(404, "成果中没有这个文件")
    data = await read_payload(row)
    if info.get("kind") == "bundle":
        data = await asyncio.to_thread(_extract_member, data, name, entry["size"])
    _check_bytes(entry, data)
    return entry, data


async def list_items(session, owner, *, session_id="", source="", limit=50, offset=0):
    query = select(LibraryItem).where(LibraryItem.owner_key == owner,
                                    LibraryItem.deleted_at.is_(None),
                                    LibraryItem.extra[META_KEY]["schemaVersion"].as_integer() == 1)
    if session_id:
        query = query.where(LibraryItem.extra[META_KEY]["sessionId"].as_string() == session_id)
    if source:
        query = query.where(LibraryItem.extra[META_KEY]["source"].as_string() == source)
    return list((await session.scalars(query.order_by(LibraryItem.created_at.desc(), LibraryItem.id)
                                      .offset(offset).limit(limit))).all())
