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
import io
import json
import zipfile
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import inspect as sa_inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..library_models import LibraryFolder, LibraryItem
from ..realtime import hub
from . import library_storage, mate_message_files, mate_messages, storage, task_assignment
from .library_conversation_save import save_lock

MAX_RECIPIENTS = 50
MAX_BYTES = 24 * 1024 * 1024
MAX_ITEMS = 20


async def _company_scope(session: AsyncSession, user: models.User) -> set[str]:
    try:
        has_org_tree = await session.run_sync(lambda sync: sa_inspect(sync.bind).has_table(models.OrgUnit.__tablename__))
        if not has_org_tree:
            return {str(user.org_id)}
        from . import rbac
        scope = await rbac.company_org_ids(session, user)
    except Exception:
        await session.rollback()
        scope = set()
    return set(scope or {str(user.org_id)})


def _archive_name(item: LibraryItem) -> str:
    stem = _name(item)
    if "." in stem:
        stem = stem.rsplit(".", 1)[0]
    return ((stem.strip(" .") or "materials")[:180] + "-bundle.zip")[:200]


def _archive_bytes(items: list[tuple[LibraryItem, bytes]]) -> tuple[str, bytes, dict]:
    output = io.BytesIO(); used = set(); manifest = []
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item, data in items:
            original = _archive_entry_name(item); candidate = original
            stem, dot, suffix = candidate.rpartition(".")
            stem = stem if dot else candidate; suffix = (dot + suffix) if dot else ""; index = 2
            while candidate.casefold() in used:
                candidate = f"{stem} ({index}){suffix}"; index += 1
            used.add(candidate.casefold()); archive.writestr(candidate, data)
            manifest.append({"filename": candidate, "size": len(data), "contentType": item.content_type or "application/octet-stream"})
    return _archive_name(items[0][0]), output.getvalue(), {"files": manifest}


def _name(item: LibraryItem) -> str:
    value = str(item.filename or item.title or "library-file").replace("\\", "/").rsplit("/", 1)[-1]
    value = "".join(ch for ch in value if ord(ch) >= 32 and ch not in {"/", "\\"})
    return value[:200] or "library-file"


def _safe_archive_path(value: str) -> str:
    """Normalize a client-provided relative path before putting it in a ZIP."""
    raw = str(value or "").strip().replace("\\", "/")
    if not raw or raw.startswith("/") or (len(raw) > 1 and raw[1] == ":"):
        raise HTTPException(400, "文件路径无效")
    parts: list[str] = []
    for part in raw.split("/"):
        if part in {"", "."}:
            continue
        if part == ".." or any(ord(ch) < 32 for ch in part):
            raise HTTPException(400, "文件路径无效")
        cleaned = "".join(ch for ch in part if ch not in {"/", "\\"}).strip(" .")
        if cleaned:
            parts.append(cleaned[:200])
    if not parts:
        raise HTTPException(400, "文件名称无效")
    return "/".join(parts)[:200]


def _archive_entry_name(item: LibraryItem) -> str:
    raw = str(item.filename or item.title or "library-file").strip()
    if "/" not in raw and "\\" not in raw:
        return _name(item)
    try:
        return _safe_archive_path(raw)
    except HTTPException:
        return _name(item)


async def members(session: AsyncSession, client: models.Client) -> dict:
    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if me is None or not me.is_active or not me.org_id:
        return {"ok": True, "members": [], "meId": me.id if me else None}
    scope = await _company_scope(session, me)
    rows = (await session.execute(
        select(models.User).where(
            models.User.org_id.in_(scope),
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
        models.User.id.in_(ids), models.User.org_id.in_(await _company_scope(session, me)),
        models.User.is_active.is_(True),
    ))).scalars().all())
    by_id = {row.id: row for row in recipients}
    missing = [uid for uid in ids if uid not in by_id]
    if missing:
        raise HTTPException(403, "只能分享给企业内的在职成员")
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


def parse_local_snapshots(raw_files):
    if not isinstance(raw_files, list) or not raw_files or len(raw_files) > MAX_ITEMS:
        raise HTTPException(400, f"一次最多分享 {MAX_ITEMS} 个本机资料")
    snapshots, ids, total = [], [], 0
    for index, raw in enumerate(raw_files):
        if not isinstance(raw, dict): raise HTTPException(400, "本机资料信息不完整")
        item_id = str(raw.get("localItemId") or f"local-{index}").strip()[:128]
        filename = str(raw.get("filename") or "").strip()
        filename = _safe_archive_path(filename)
        encoded = raw.get("data")
        if not isinstance(encoded, str) or len(encoded) > ((MAX_BYTES + 2) // 3) * 4:
            raise HTTPException(413, "文件超过 24 MB，暂不支持直接分享")
        try: data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc: raise HTTPException(400, "文件内容无效，请重新读取后分享") from exc
        if not data: raise HTTPException(400, "空文件不能分享")
        total += len(data)
        if total > MAX_BYTES: raise HTTPException(413, "选中资料合计超过 24 MB，暂不支持直接分享")
        if item_id in ids: raise HTTPException(400, "不能重复选择同一份本机资料")
        ids.append(item_id)
        snapshots.append((LibraryItem(id=item_id, filename=filename, title=filename,
                                      content_type=str(raw.get("contentType") or "application/octet-stream")[:200], size=len(data)), data))
    return snapshots, ids


async def share_local_batch(session: AsyncSession, client: models.Client, body: dict) -> dict:
    try: request_id = str(uuid.UUID(str(body.get("requestId") or "")))
    except ValueError as exc: raise HTTPException(400, "分享请求标识无效，请重新打开分享窗口") from exc
    snapshots, ids = parse_local_snapshots(body.get("files"))
    recipients = body.get("recipientUserIds") if body.get("recipientUserIds") is not None else body.get("recipientIds")
    if not isinstance(recipients, list): raise HTTPException(400, "recipientUserIds must be a list")
    note = str(body.get("note") or "").strip()[:500]; owner = str(client.user_ref or client.id)
    request_key = "library-local-batch-share:" + str(uuid.uuid5(uuid.NAMESPACE_URL, owner + ":" + request_id))
    async with save_lock(session, owner, request_key):
        return await share_items(session, client, ids, recipients, note, request_key=request_key, package=len(ids) > 1, snapshots=snapshots)


async def folder_items(session: AsyncSession, client: models.Client, folder_ids: list[str]) -> list[LibraryItem]:
    """Return all live files below the selected folders in stable order.

    Folders are metadata only, so sharing a folder must resolve its contents at
    share time.  Walking the complete owned folder tree also supports nested
    folders and prevents a caller from smuggling another user's folder into a
    package through a child id.
    """
    owner = str(client.user_ref or client.id).strip()[:128]
    selected = list(dict.fromkeys(str(value or "").strip() for value in folder_ids if str(value or "").strip()))
    if not selected or len(selected) > MAX_ITEMS:
        raise HTTPException(400, f"一次最多选择 {MAX_ITEMS} 个文件夹")
    folders = list((await session.execute(select(LibraryFolder).where(
        LibraryFolder.owner_key == owner,
        LibraryFolder.id.in_(selected),
    ).order_by(LibraryFolder.id.asc()))).scalars().all())
    by_id = {str(row.id): row for row in folders}
    if len(by_id) != len(selected):
        raise HTTPException(404, "文件夹不存在或不属于当前账户")

    # Fetch the full owned tree once.  A defensive visited set makes malformed
    # parent cycles harmless instead of looping during a share request.
    tree = list((await session.execute(select(LibraryFolder).where(
        LibraryFolder.owner_key == owner,
    ).order_by(LibraryFolder.name.asc(), LibraryFolder.id.asc()))).scalars().all())
    children: dict[str | None, list[str]] = {}
    for row in tree:
        children.setdefault(str(row.parent_id) if row.parent_id else None, []).append(str(row.id))
    descendant_ids: list[str] = []
    visited: set[str] = set()
    stack = list(selected)
    while stack:
        current = stack.pop()
        if current in visited:
            continue
        visited.add(current)
        descendant_ids.append(current)
        stack.extend(reversed(children.get(current, [])))

    rows = list((await session.execute(select(LibraryItem).where(
        LibraryItem.owner_key == owner,
        LibraryItem.folder_id.in_(descendant_ids),
        LibraryItem.deleted_at.is_(None),
    ).order_by(LibraryItem.folder_id.asc(), LibraryItem.filename.asc(), LibraryItem.id.asc()))).scalars().all())
    # Selecting a parent and one of its children must not duplicate files in
    # the resulting archive.
    unique: list[LibraryItem] = []
    seen: set[str] = set()
    for row in rows:
        if str(row.id) in seen:
            continue
        seen.add(str(row.id))
        unique.append(row)
    if not unique:
        raise HTTPException(400, "文件夹内没有可分享的资料")
    if len(unique) > MAX_ITEMS:
        raise HTTPException(400, f"文件夹内资料超过单次分享上限 {MAX_ITEMS} 项")
    return unique


async def share_folders(session: AsyncSession, client: models.Client, folder_ids: list[str],
                        recipient_ids: list[str], note: str = "", *, request_key: str = "") -> dict:
    """Share one or more folders as a ZIP attachment, even for one file."""
    rows = await folder_items(session, client, folder_ids)
    result = await share_items(
        session, client, [str(row.id) for row in rows], recipient_ids, note,
        request_key=request_key, package=True, force_package=True,
    )
    return {**result, "folderIds": list(dict.fromkeys(str(value) for value in folder_ids))}


async def share_items(session: AsyncSession, client: models.Client, item_ids: list[str], recipient_ids: list[str],
                      note: str = "", *, request_key: str = "", package: bool = True, snapshots=None,
                      force_package: bool = False) -> dict:
    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if me is None or not me.is_active or not me.org_id: raise HTTPException(403, "当前设备还没有绑定组织账号")
    ids = list(dict.fromkeys(str(value or "").strip() for value in item_ids if str(value or "").strip()))
    if not ids or len(ids) > MAX_ITEMS: raise HTTPException(400, "请选择 1-20 份资料")
    recipient_ids = list(dict.fromkeys(str(value or "").strip() for value in recipient_ids if str(value or "").strip()))
    if not recipient_ids or len(recipient_ids) > MAX_RECIPIENTS: raise HTTPException(400, "请选择有效的接收成员")
    if me.id in recipient_ids: raise HTTPException(400, "不能把文件分享给自己")
    scope = await _company_scope(session, me)
    recipients = list((await session.execute(select(models.User).where(
        models.User.id.in_(recipient_ids), models.User.org_id.in_(scope), models.User.is_active.is_(True)))).scalars().all())
    by_id = {row.id: row for row in recipients}
    if any(value not in by_id for value in recipient_ids): raise HTTPException(403, "只能分享给企业内的在职成员")
    owner = str(client.user_ref or client.id).strip()[:128]
    snapshot_by_id = {str(row.id): (row, data) for row, data in (snapshots or [])}
    remote_ids = [item_id for item_id in ids if item_id not in snapshot_by_id]
    remote_rows = list((await session.execute(select(LibraryItem).where(
        LibraryItem.owner_key == owner, LibraryItem.id.in_(remote_ids), LibraryItem.deleted_at.is_(None)))).scalars().all()) if remote_ids else []
    remote_by_id = {str(row.id): row for row in remote_rows}
    if any(item_id not in snapshot_by_id and item_id not in remote_by_id for item_id in ids):
        raise HTTPException(400 if snapshots is not None else 404, "本机资料信息不完整" if snapshots is not None else "资料不存在或已移入回收站")
    ordered = [snapshot_by_id[item_id][0] if item_id in snapshot_by_id else remote_by_id[item_id] for item_id in ids]
    payloads, total = [], 0
    for item_id, row in zip(ids, ordered):
        data = snapshot_by_id[item_id][1] if item_id in snapshot_by_id else await _read_item(row)
        total += len(data)
        if len(ids) > 1 and total > MAX_BYTES: raise HTTPException(413, "选中资料合计超过 24 MB")
        payloads.append((row, data))
    if (len(ids) > 1 or force_package) and package:
        filename, data, manifest = _archive_bytes(payloads)
        if len(data) > MAX_BYTES: raise HTTPException(413, "打包后的资料超过 24 MB")
        packaged, content_type = True, "application/zip"
    else:
        filename, data = _name(ordered[0]), payloads[0][1]
        manifest = {"files": [{"filename": filename, "size": len(data), "contentType": ordered[0].content_type or "application/octet-stream"}]}
        packaged, content_type = False, ordered[0].content_type or "application/octet-stream"
    fingerprint = hashlib.sha256(json.dumps([ids, recipient_ids, str(note or "").strip()[:500], packaged,
        [(entry["filename"], entry["size"], hashlib.sha256(payloads[index][1]).hexdigest()) for index, entry in enumerate(manifest["files"])]],
        ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    source_ref = request_key or "library-batch-share:" + str(uuid.uuid4())
    if request_key:
        previous = list((await session.scalars(select(models.Attachment).where(models.Attachment.source_ref == source_ref))).all())
        if previous:
            if (len(previous) != len(recipient_ids) or {row.evidence_meta.get("recipientId") for row in previous} != set(recipient_ids)
                    or any(row.evidence_meta.get("requestFingerprint") != fingerprint for row in previous)):
                raise HTTPException(409, "这次分享已发送，内容或成员已变化，请重新打开分享窗口")
            results = []
            for target in recipients:
                msg_id = str(uuid.uuid5(uuid.NAMESPACE_URL, source_ref + ":" + target.id))
                message = await session.scalar(select(models.MateMessage).where(models.MateMessage.sender_id == me.id,
                    models.MateMessage.recipient_id == target.id, models.MateMessage.client_message_id == msg_id))
                if message is None: raise HTTPException(409, "分享记录暂不完整，请稍后重试")
                results.append({"id": target.id, "name": target.display_name or target.username,
                                "delivered": message.delivered_at is not None, "messageId": message.id})
            return {"ok": True, "itemIds": ids, "filename": filename, "packaged": packaged, "files": manifest["files"],
                    "shared": len(results), "recipients": results, "reused": True}
    text = (f"分享了 {len(ids)} 份资料" if len(ids) > 1 else f"分享了资料库文件「{str(ordered[0].title or filename)[:200]}」")
    if str(note or "").strip(): text += "：" + str(note).strip()[:500]
    shared, created = [], []
    try:
        for target in recipients:
            msg_id = str(uuid.uuid5(uuid.NAMESPACE_URL, source_ref + ":" + target.id)) if request_key else str(uuid.uuid4())
            key = f"mate-messages/{uuid.uuid4()}/{filename}"; backend = await asyncio.to_thread(storage.put, key, data, content_type); created.append((key, backend))
            attachment = models.Attachment(id=str(uuid.uuid4()), task_id="", filename=filename, content_type=content_type, size=len(data),
                storage_key=key, backend=backend, uploaded_by=client.id, role="output", source_ref=source_ref,
                evidence_meta={"kind": "mate_message", "shareKind": "library", "libraryItemIds": ids, "senderId": me.id,
                    "recipientId": target.id, "packaged": packaged, "packageManifest": manifest["files"], "requestFingerprint": fingerprint,
                    "sharedAt": datetime.now(timezone.utc).isoformat()})
            session.add(attachment)
            message = await mate_messages.create(session, me, target,
                {"messageId": msg_id, "conversationId": "library-share:" + (ids[0] if len(ids) == 1 else fingerprint)},
                text, [mate_message_files.public(attachment)])
            shared.append((message, target, attachment))
        await session.commit()
    except Exception:
        await session.rollback()
        for key, backend in created:
            try: await asyncio.to_thread(storage.delete, key, backend)
            except Exception: pass
        raise
    results = []
    for message, target, attachment in shared:
        try: boxes = await task_assignment.active_devices(session, target.id)
        except Exception: boxes = []
        payload = {"type": "notice", "kind": "mate_message", "text": text, "attachments": [mate_message_files.public(attachment)],
            "messageId": message.client_message_id, "serverMessageId": message.id, "senderId": me.id,
            "senderName": me.display_name or me.username, "recipientId": target.id, "recipientName": target.display_name or target.username,
            "sentAt": message.created_at.timestamp() * 1000 if message.created_at else None,
            "libraryShare": {"itemIds": ids, "filename": filename, "packaged": packaged}}
        published = False
        for box in boxes:
            if not hub.is_online(box.id): continue
            try: await hub.publish(box.id, payload, user_id=target.id); published = True
            except Exception: continue
        if published and message.delivered_at is None: message.delivered_at = datetime.now(timezone.utc); message.status = "delivered"
        results.append({"id": target.id, "name": target.display_name or target.username, "delivered": published, "messageId": message.id})
    await session.commit()
    return {"ok": True, "itemIds": ids, "filename": filename, "packaged": packaged,
            "files": manifest["files"], "shared": len(results), "recipients": results}
