"""Serialize task upload admission across workers until the attachment commits."""
import asyncio
import hashlib
import os
import uuid
from contextlib import asynccontextmanager
from weakref import WeakValueDictionary

from fastapi import HTTPException
from sqlalchemy import and_, case, func, select, text, update

from ..models import Attachment, User
from . import artifact_staging, file_io, storage
from .library_conversation_save import stream_digest

_locks = WeakValueDictionary()


@asynccontextmanager
async def _upload_lock(session, scopes):
    bind = session.get_bind()
    if bind.dialect.name == "sqlite":
        lock = _locks.setdefault((id(asyncio.get_running_loop()), id(bind)), asyncio.Lock())
        async with lock:
            # Reserve the database writer even when the caller already read the task.
            await session.execute(update(Attachment).where(False).values(size=Attachment.size)
                                  .execution_options(synchronize_session=False))
            try:
                yield
            except BaseException:
                await session.rollback()
                raise
        return
    for scope in sorted(scopes):
        digest = hashlib.sha256(("attachment-quota:" + scope).encode()).digest()[:8]
        await session.execute(text("SELECT pg_advisory_xact_lock(:key)"),
                              {"key": int.from_bytes(digest, "big", signed=True)})
    yield


@asynccontextmanager
async def _reserve(session, user, uploader, size, settings):
    owner_limit = settings.attach_owner_quota_bytes
    org_limit = settings.attach_org_quota_bytes
    if owner_limit is None and org_limit is None:
        yield
        return
    owner = "user:" + user if user else "device:" + uploader
    # Use the owner's current organization, including historical uploads. Users without
    # an organization and device-only uploads share the deployment's unassigned pool.
    org = (await session.scalar(select(User.org_id).where(User.id == user).with_for_update())
           if org_limit is not None and user else "") or ""
    scopes = (["owner:" + owner] if owner_limit is not None else []) + (
        ["org:" + org] if org_limit is not None else [])
    async with _upload_lock(session, scopes):
        used = select(func.coalesce(func.sum(Attachment.size), 0)).where(
            Attachment.role == "input", Attachment.storage_key.startswith("att/"))
        declared = func.coalesce(Attachment.evidence_meta["ownerUserId"].as_string(), "")
        account = case((declared != "", declared),
                       (Attachment.uploaded_by.startswith("user:"), func.substr(Attachment.uploaded_by, 6)),
                       (Attachment.uploaded_by.startswith("admin:"), func.substr(Attachment.uploaded_by, 7)),
                       else_="")
        if owner_limit is not None:
            owner_filter = account == user if user else and_(account == "", Attachment.uploaded_by == uploader)
            if size + await session.scalar(used.where(owner_filter)) > owner_limit:
                raise HTTPException(413, "attachment_owner_quota_exceeded")
        if org_limit is not None:
            # Legacy account uploads identify the owner in uploaded_by. Never charge
            # a device's older uploads to the user who happens to own it today.
            org_filter = func.coalesce(User.org_id, "") == org
            if size + await session.scalar(used.outerjoin(User, User.id == account).where(org_filter)) > org_limit:
                raise HTTPException(413, "attachment_org_quota_exceeded")
        yield


async def save(session, target_id, file, *, settings, account_id, uploader, metadata=None, source_ref=""):
    handle = file.file
    handle.seek(0, os.SEEK_END)
    size = handle.tell()
    if size > settings.attach_max_mb * 1024 * 1024:
        raise HTTPException(413, f"文件超过 {settings.attach_max_mb}MB 上限")
    if size <= 0:
        raise HTTPException(400, "空文件")
    handle.seek(0)
    name = (file.filename or "file").replace("/", "_").replace("\\", "_").strip()[:200] or "file"
    content_type = file.content_type or "application/octet-stream"
    row = Attachment(id=str(uuid.uuid4()), task_id=target_id, filename=name, content_type=content_type,
                     size=size, uploaded_by=uploader, role="input", source_ref=source_ref,
                     evidence_meta={**(metadata or {}), "sha256": await file_io.run(stream_digest, handle)})
    row.storage_key = f"att/{target_id}/{row.id}/{name}"
    async with artifact_staging.operation(session, target_id) as objects:
        async with _reserve(session, account_id, uploader, size, settings):
            row.backend = await file_io.run(objects.store, storage.put_stream, row.storage_key, handle, size, content_type)
            await objects.before_insert(session)
            session.add(row)
            await session.commit()
    await session.refresh(row)
    return row
