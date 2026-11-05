"""Durable video retries using the existing attachment ledger.

A deterministic attachment id prevents concurrent create calls across Hub
workers. Short database transactions claim a job and release the connection
before provider IO. Only plain snapshots are retained across rollback/commit.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
import uuid

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

from ..models import Attachment
from . import resource_access


def conversation_ref(value):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(value or "").strip()[:120]).strip("._-") or "conversation"


def fingerprint(conf, payload, generation_id=""):
    request = {"base": conf.get("base"), "provider": conf.get("provider"),
               "user": conf.get("user"), "keyHash": hashlib.sha256(
                   str(conf.get("key") or "").encode()).hexdigest(),
               "config": conf.get("config"), "payload": payload,
               "generationId": generation_id}
    return hashlib.sha256(json.dumps(request, sort_keys=True, ensure_ascii=False,
                                    allow_nan=False).encode()).hexdigest()


def snapshot(row):
    return {key: getattr(row, key) for key in (
        "id", "task_id", "filename", "content_type", "size", "storage_key", "backend",
        "uploaded_by", "source_ref", "evidence_meta")}


def artifact(row):
    meta = row["evidence_meta"] or {}
    kind = "image" if str(row["content_type"]).startswith("image/") else "video"
    return {"kind": kind, "attachmentId": row["id"],
            "filename": row["filename"], "mimeType": row["content_type"],
            "size": row["size"], "url": resource_access.attachment_url(row["id"]),
            **{key: meta.get(key) for key in ("duration", "aspectRatio", "resolution", "fps")}}


async def claim(session, client_id, ref, digest, filename, meta, timeout, *, kind="video", user_id):
    if kind not in {"image", "video"}:
        raise ValueError("不支持的媒体类型")
    label = "图片" if kind == "image" else "视频"
    user_id = str(user_id or "")
    if not user_id:
        raise ValueError("媒体生成需要有效的账号归属")
    aid = str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(
        ["soduwork-account-media", kind, client_id, user_id, ref, digest], ensure_ascii=False)))
    owner = str(uuid.uuid4())
    row = await session.get(Attachment, aid)
    if row is None:
        legacy_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"soduwork-{kind}:{client_id}:{ref}:{digest}"))
        legacy = await session.get(Attachment, legacy_id)
        if legacy is not None:
            legacy_owner = str(dict(legacy.evidence_meta or {}).get("ownerUserId") or "")
            if legacy_owner == user_id:
                row, aid = legacy, legacy_id
            elif not legacy_owner:
                raise ValueError("历史媒体的账号归属尚未确认，请先核对原成果；重新生成请使用新的 generationId")
    if row is None:
        metadata = dict(meta, ownerUserId=user_id, requestFingerprint=digest, status="submitting",
                        leaseOwner=owner, leaseUntil=time.time() + timeout + 60)
        row = Attachment(id=aid, task_id="", filename=filename,
                         content_type="image/png" if kind == "image" else "video/mp4",
                         size=0, storage_key="", backend="", uploaded_by=client_id,
                         role="output", source_ref=f"conversation-{kind}:" + ref,
                         evidence_meta=metadata)
        saved = snapshot(row)
        session.add(row)
        try:
            await session.commit()
            return saved, True
        except IntegrityError:
            await session.rollback()
            row = await session.get(Attachment, aid)
            if row is None:
                raise
    saved = snapshot(row)
    metadata = dict(saved["evidence_meta"] or {})
    if str(metadata.get("ownerUserId") or "") != user_id:
        raise ValueError("媒体不属于当前账号")
    await session.rollback()
    if saved["storage_key"] and int(saved["size"] or 0) > 0:
        return saved, False
    if float(metadata.get("leaseUntil") or 0) > time.time():
        raise ValueError(f"这个{label}正在生成，请等待当前调用完成后再继续")
    if metadata.get("status") == "failed":
        raise ValueError(f"上次{label}任务已失败；如需重新生成，请使用新的 generationId")
    if not metadata.get("jobId"):
        raise ValueError(f"上次提交结果尚不确定，请先核对{label}服务的任务记录；重新生成请使用新的 generationId")
    previous_owner = str(metadata.get("leaseOwner") or "")
    renewed = dict(metadata, leaseOwner=owner, leaseUntil=time.time() + timeout + 60,
                   status="pending")
    changed = await session.execute(update(Attachment).where(
        Attachment.id == aid,
        Attachment.evidence_meta["leaseOwner"].as_string() == previous_owner,
    ).values(evidence_meta=renewed).execution_options(synchronize_session=False))
    if changed.rowcount:
        from .cloud_sync_notifications import mark
        mark(session, saved.get("task_id"))
    await session.commit()
    if changed.rowcount != 1:
        raise ValueError("这个视频已由另一请求接续，请稍后查看成果")
    saved["evidence_meta"] = renewed
    return saved, False


async def change(session, job, *, meta=None, **values):
    current = dict(job["evidence_meta"] or {})
    updated = dict(current, **(meta or {}))
    result = await session.execute(update(Attachment).where(
        Attachment.id == job["id"],
        Attachment.evidence_meta["leaseOwner"].as_string() == current["leaseOwner"],
    ).values(evidence_meta=updated, **values).execution_options(synchronize_session=False))
    if result.rowcount:
        from .cloud_sync_notifications import mark
        mark(session, job.get("task_id"))
    await session.commit()
    if result.rowcount != 1:
        raise ValueError("视频任务已变化，请重新打开会话查看成果")
    job.update(values, evidence_meta=updated)


async def save_job_id(session, job, job_id):
    # Finish this small commit even if the HTTP client disconnects in the same
    # event-loop tick as the provider returns its billable job id.
    task = asyncio.create_task(change(session, job, meta={"jobId": job_id, "status": "pending"}))
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise
