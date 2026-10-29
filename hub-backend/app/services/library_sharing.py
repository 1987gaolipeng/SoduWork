"""Organization-scoped sharing for library files.

Sharing deliberately snapshots the bytes into the existing mate-message
attachment store.  A recipient therefore keeps access even if the sender
later renames or removes the source library item, and the existing durable
notification center can present the file without a second sharing protocol.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..library_models import LibraryItem
from ..realtime import hub
from . import library_storage, mate_message_files, mate_messages, storage, task_assignment
from .library_conversation_save import save_lock

MAX_RECIPIENTS = 50
MAX_BYTES = 24 * 1024 * 1024


def _name(item: LibraryItem) -> str:
    value = str(item.filename or item.title or "library-file").replace("\\", "/").rsplit("/", 1)[-1]
    value = "".join(ch for ch in value if ord(ch) >= 32 and ch not in {"/", "\\"})
    return value[:200] or "library-file"


async def members(session: AsyncSession, client: models.Client) -> dict:
    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if me is None or not me.is_active or not me.org_id:
        return {"ok": True, "members": [], "meId": me.id if me else None}
    rows = (await session.execute(
        select(models.User).where(
            models.User.org_id == me.org_id,
            models.User.is_active.is_(True),
        ).order_by(models.User.display_name.asc(), models.User.username.asc(), models.User.id.asc())
    )).scalars().all()
    return {
        "ok": True,
        "meId": me.id,
        "members": [
            {"id": row.id, "name": row.display_name or row.username,
             "username": row.username, "isMe": row.id == me.id}
            for row in rows
        ],
    }


async def _read_item(item: LibraryItem) -> bytes:
    if int(item.size or 0) > MAX_BYTES:
        raise HTTPException(413, "文件超过 24 MB，暂不支持直接分享")
    try:
        if isinstance((item.extra or {}).get("soduWorkDelivery"), dict):
            # Delivery collections expose immutable payloads through their own
            # service. Import lazily to avoid making the ordinary library path
            # depend on delivery modules.
            from . import delivery_collections
            data = await delivery_collections.read_payload(item)
        else:
            data = await asyncio.to_thread(
                library_storage.read_bytes, item.storage_key, limit=MAX_BYTES, backend=item.backend
            )
    except HTTPException:
        raise
    except Exception as exc:  # storage adapters use several error classes
        raise HTTPException(404, "资料库文件暂时无法读取，请稍后重试") from exc
    if not data:
        raise HTTPException(400, "空文件不能分享")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "文件超过 24 MB，暂不支持直接分享")
    return data


async def share_local(session: AsyncSession, client: models.Client, body: dict) -> dict:
    """Send local bytes through the existing notification snapshot protocol."""
    try:
        request_id = str(uuid.UUID(str(body.get("requestId") or "")))
    except ValueError as exc:
        raise HTTPException(400, "分享请求标识无效，请重新打开分享窗口") from exc
    filename = str(body.get("filename") or "").strip()
    if (not filename or len(filename) > 200 or filename in {".", ".."}
            or any(ord(ch) < 32 or ch in "/\\" for ch in filename)):
        raise HTTPException(400, "文件名称无效")
    encoded = body.get("data")
    if not isinstance(encoded, str) or len(encoded) > ((MAX_BYTES + 2) // 3) * 4:
        raise HTTPException(413, "文件超过 24 MB，暂不支持直接分享")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(400, "文件内容无效，请重新读取后分享") from exc
    if not data:
        raise HTTPException(400, "空文件不能分享")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "文件超过 24 MB，暂不支持直接分享")
    recipients = body.get("recipientUserIds")
    if not isinstance(recipients, list):
        raise HTTPException(400, "recipientUserIds must be a list")
    item_id = str(body.get("localItemId") or "")[:128]
    content_type = str(body.get("contentType") or "application/octet-stream")[:200]
    note = str(body.get("note") or "").strip()[:500]
    ids = sorted({str(value or "").strip() for value in recipients if str(value or "").strip()})
    fingerprint = hashlib.sha256(json.dumps(
        [item_id, filename, content_type, hashlib.sha256(data).hexdigest(), ids, note],
        ensure_ascii=False, separators=(",", ":"),
    ).encode()).hexdigest()
    owner = str(client.user_ref or client.id)
    request_key = "library-local-share:" + str(uuid.uuid5(uuid.NAMESPACE_URL, owner + ":" + request_id))
    # This is an in-memory descriptor only; sharing never inserts a LibraryItem.
    item = LibraryItem(id=item_id, filename=filename, title=filename, content_type=content_type)
    async with save_lock(session, owner, request_key):
        return await share(session, client, item_id, ids, note,
                           snapshot=(item, data), request_key=request_key, fingerprint=fingerprint)


async def share(session: AsyncSession, client: models.Client, item_id: str,
                recipient_ids: list[str], note: str = "", *, snapshot=None,
                request_key: str = "", fingerprint: str = "") -> dict:
    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if me is None or not me.is_active or not me.org_id:
        raise HTTPException(403, "当前设备还没有绑定组织账号")
    ids = [str(value or "").strip() for value in recipient_ids if str(value or "").strip()]
    ids = list(dict.fromkeys(ids))
    if not ids:
        raise HTTPException(400, "请选择至少一位组织成员")
    if len(ids) > MAX_RECIPIENTS:
        raise HTTPException(400, f"一次最多分享给 {MAX_RECIPIENTS} 位成员")
    if me.id in ids:
        raise HTTPException(400, "不能把文件分享给自己")
    recipients = list((await session.execute(select(models.User).where(
        models.User.id.in_(ids), models.User.org_id == me.org_id,
        models.User.is_active.is_(True),
    ))).scalars().all())
    by_id = {row.id: row for row in recipients}
    missing = [uid for uid in ids if uid not in by_id]
    if missing:
        raise HTTPException(403, "只能分享给当前组织内的在职成员")
    owner = str(client.user_ref or client.id).strip()[:128]
    if snapshot is not None:
        item, data = snapshot
    else:
        item = (await session.execute(select(LibraryItem).where(
            LibraryItem.id == str(item_id), LibraryItem.owner_key == owner,
            LibraryItem.deleted_at.is_(None),
        ))).scalar_one_or_none()
        if item is None:
            raise HTTPException(404, "资料不存在或已移入回收站")
        data = await _read_item(item)
    filename = _name(item)
    if request_key:
        previous = list((await session.scalars(select(models.Attachment).where(
            models.Attachment.source_ref == request_key))).all())
        if previous:
            if (len(previous) != len(ids) or
                    {row.evidence_meta.get("recipientId") for row in previous} != set(ids) or
                    any(row.evidence_meta.get("requestFingerprint") != fingerprint for row in previous)):
                raise HTTPException(409, "这次分享已发送，内容或成员已变化，请重新打开分享窗口")
            results = []
            for target in recipients:
                row = await session.scalar(select(models.MateMessage).where(
                    models.MateMessage.sender_id == me.id, models.MateMessage.recipient_id == target.id,
                    models.MateMessage.client_message_id == str(uuid.uuid5(uuid.NAMESPACE_URL, request_key + ":" + target.id))))
                if row is None:
                    raise HTTPException(409, "分享记录暂不完整，请稍后重试")
                results.append({"id": target.id, "name": target.display_name or target.username,
                                "delivered": row.delivered_at is not None, "messageId": row.id})
            return {"ok": True, "itemId": str(item.id), "filename": filename,
                    "shared": len(results), "recipients": results, "reused": True}
    text = f"分享了资料库文件「{str(item.title or filename)[:200]}」"
    if str(note or "").strip():
        text += "：" + str(note).strip()[:500]
    shared, created = [], []
    try:
        for target in recipients:
            message_id = str(uuid.uuid5(uuid.NAMESPACE_URL, request_key + ":" + target.id)) if request_key else str(uuid.uuid4())
            key = f"mate-messages/{uuid.uuid4()}/{filename}"
            backend = await asyncio.to_thread(
                storage.put, key, data, item.content_type or "application/octet-stream"
            )
            # Track a written snapshot before creating its database records so
            # any subsequent failure also cleans up this recipient's bytes.
            created.append((key, backend))
            attachment = models.Attachment(
                id=str(uuid.uuid4()), task_id="", filename=filename,
                content_type=item.content_type or "application/octet-stream", size=len(data),
                storage_key=key, backend=backend, uploaded_by=client.id, role="output",
                source_ref=request_key or "library-share:" + str(item.id),
                evidence_meta={"kind": "mate_message", "shareKind": "library",
                    "libraryItemId": str(item.id), "senderId": me.id,
                    "recipientId": target.id, "sharedAt": datetime.now(timezone.utc).isoformat(),
                    **({"requestFingerprint": fingerprint} if request_key else {})},
            )
            session.add(attachment)
            row = await mate_messages.create(
                session, me, target,
                {"messageId": message_id, "conversationId": "library-share:" + str(item.id)},
                text, [mate_message_files.public(attachment)]
            )
            shared.append((row, target, attachment))
        await session.commit()
    except Exception:
        await session.rollback()
        for key, backend in created:
            try:
                await asyncio.to_thread(storage.delete, key, backend)
            except Exception:
                pass
        raise

    results = []
    for row, target, attachment in shared:
        try:
            boxes = await task_assignment.active_devices(session, target.id)
        except Exception:
            # The message and attachment are already durable. If the device
            # registry is temporarily unavailable, leave delivery as
            # accepted and let the recipient pick it up from the inbox.
            boxes = []
        payload = {
            "type": "notice", "kind": "mate_message", "text": text,
            "attachments": [mate_message_files.public(attachment)],
            "messageId": row.client_message_id, "serverMessageId": row.id,
            "senderId": me.id, "senderName": me.display_name or me.username,
            # Include the intended recipient with each share so delayed events cannot appear under another account.
            "recipientId": target.id, "recipientName": target.display_name or target.username,
            "sentAt": row.created_at.timestamp() * 1000 if row.created_at else None,
            "libraryShare": {"itemId": str(item.id), "filename": filename},
        }
        published = False
        for box in boxes:
            if not hub.is_online(box.id):
                continue
            try:
                await hub.publish(box.id, payload, user_id=target.id)
                published = True
            except Exception:
                # The durable MateMessage was committed above. A disconnected
                # or failing realtime socket must not turn a successful share
                # into a 500; the recipient will see it on the next sync.
                continue
        if published and row.delivered_at is None:
            row.delivered_at = datetime.now(timezone.utc)
            row.status = "delivered"
        results.append({"id": target.id, "name": target.display_name or target.username,
                        "delivered": published, "messageId": row.id})
    await session.commit()
    return {"ok": True, "itemId": str(item.id), "filename": filename,
            "shared": len(results), "recipients": results}
