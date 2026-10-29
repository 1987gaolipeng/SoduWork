"""Recipient-bound snapshots of conversation outputs. Never grant access to the source task."""
import base64
import binascii
import hashlib
import json
import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .. import models
from ..config import get_settings
from ..schemas import attachment_to_api
from . import storage, task_access

MAX_FILES = 20
MAX_BYTES = 24 * 1024 * 1024
OUTPUT_ROLES = {"output", "evidence", "supporting", "verification"}


async def prepare(session, client, files):
    if not isinstance(files, list) or len(files) > MAX_FILES:
        raise HTTPException(400, "一次最多发送 20 份成果，请移除部分文件后再发送")
    ready, seen, total = [], set(), 0
    for item in files:
        if not isinstance(item, dict):
            raise HTTPException(400, "成果信息不完整")
        source_id = item.get("attachmentId")
        cap = min(MAX_BYTES, get_settings().attach_max_mb * 1024 * 1024)
        if source_id:
            original = await session.get(models.Attachment, str(source_id))
            if not original or original.role not in OUTPUT_ROLES:
                raise HTTPException(404, "成果不存在或不是可分享的输出")
            await task_access.view_task(session, client, original.task_id)
            if original.size > cap or total + original.size > MAX_BYTES:
                raise HTTPException(413, "成果过大：单文件最多 20 MB，合计最多 24 MB")
            try:
                data = storage.get(original.storage_key, original.backend)
            except FileNotFoundError:
                raise HTTPException(404, "成果文件已丢失，消息尚未发送")
            name, mime = original.filename, original.content_type
        else:
            encoded = item.get("data")
            if not isinstance(encoded, str) or len(encoded) > ((cap + 2) // 3) * 4:
                raise HTTPException(413, "成果文件过大或内容不完整")
            try:
                data = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                raise HTTPException(400, "成果文件编码不正确")
            name, mime = str(item.get("name") or ""), "application/octet-stream"
        name = name.replace("\\", "/").split("/")[-1]
        if not name or name in {".", ".."} or any(ord(c) < 32 for c in name):
            raise HTTPException(400, "成果文件名不正确")
        if len(name) > 200:
            raise HTTPException(400, "成果文件名过长")
        sha = hashlib.sha256(data).hexdigest()
        identity = (name, sha)
        if identity in seen:
            continue
        seen.add(identity)
        total += len(data)
        if len(data) > cap or total > MAX_BYTES:
            raise HTTPException(413, "成果过大：单文件最多 20 MB，合计最多 24 MB")
        ready.append(dict(name=name, data=data, mime=mime, sha=sha))
    return ready


def public(row):
    return {"id": row.id, "name": row.filename, "size": row.size}


async def save(session, client, sender, target, payload, text):
    raw_files = payload.get("files", [])
    if not raw_files:
        return []
    try:
        message_id = str(uuid.UUID(str(payload.get("messageId") or "")))
    except ValueError:
        raise HTTPException(400, "消息标识不正确，请重新打开发送卡")
    ref = str(payload.get("conversationId") or "")
    if not ref or len(ref) > 180:
        raise HTTPException(400, "请从当前会话重新选择同事")
    ready = await prepare(session, client, raw_files)
    source = "mate-message:" + str(uuid.uuid5(uuid.NAMESPACE_URL, sender.id + ":" + target.id + ":" + message_id))
    fingerprint = hashlib.sha256(json.dumps([ref, text, [(r["name"], r["sha"]) for r in ready]],
                                            ensure_ascii=False).encode()).hexdigest()

    async def existing():
        rows = list((await session.execute(select(models.Attachment).where(
            models.Attachment.source_ref == source).order_by(models.Attachment.id))).scalars().all())
        if rows and (len(rows) != len(ready) or any(
                (r.evidence_meta or {}).get("fingerprint") != fingerprint for r in rows)):
            raise HTTPException(409, "发送内容已改变，请重新打开发送卡后再发")
        return sorted(rows, key=lambda r: (r.evidence_meta or {}).get("index", 0))

    old = await existing()
    if old:
        return [public(r) for r in old]
    saved, blobs = [], []
    try:
        for index, item in enumerate(ready):
            aid = str(uuid.uuid5(uuid.NAMESPACE_URL, source + ":" + str(index)))
            key = "mate-messages/" + str(uuid.uuid4()) + "/" + item["name"]
            backend = storage.put(key, item["data"], item["mime"])
            blobs.append((key, backend))
            row = models.Attachment(id=aid, task_id="", filename=item["name"],
                content_type=item["mime"], size=len(item["data"]), storage_key=key, backend=backend,
                uploaded_by=client.id, role="output", source_ref=source,
                evidence_meta=dict(kind="mate_message", senderId=sender.id, recipientId=target.id,
                    conversationId=ref, fingerprint=fingerprint, index=index))
            session.add(row)
            saved.append(row)
        await session.commit()
    except Exception as error:
        await session.rollback()
        for key, backend in blobs:
            storage.delete(key, backend)
        if isinstance(error, IntegrityError):
            old = await existing()
            if old:
                return [public(r) for r in old]
        raise
    return [public(r) for r in saved]


async def access(session, client, aid):
    row = await session.get(models.Attachment, aid)
    meta = (row.evidence_meta or {}) if row else {}
    user = await session.get(models.User, client.user_ref) if client.user_ref else None
    if not user or not user.is_active or meta.get("kind") != "mate_message" or user.id not in {
            meta.get("senderId"), meta.get("recipientId")}:
        raise HTTPException(404, "成果不存在或无权查看")
    from .team import _company_members
    members = {u.id for u in await _company_members(session, user)}
    if not {meta["senderId"], meta["recipientId"]}.issubset(members | {user.id}):
        raise HTTPException(404, "成果不在当前企业的可见范围")
    return attachment_to_api(row)
