"""Account-scoped, read-only cloud reconciliation from durable Hub records.

The directory cursor is a position within one scan, never a commit watermark.
Clients restart at the beginning after each scan, including after a crash. A
late commit behind the current position is therefore discovered next time.
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select

from .. import automation_models as am, models
from ..conversation_handoff_models import ConversationHandoff, ConversationMessageReceipt
from ..schemas import attachment_to_api
from . import conversation_handoffs, execution_sessions


async def _owned_task(session, client, row):
    user = await conversation_handoffs.owner(session, client)
    task = await session.get(models.Task, row.task_id)
    if (not task or row.owner_user_id != user.id or
            task.owner_client_id != row.owner_client_id):
        raise HTTPException(404, "云端会话不存在或不属于当前账号")
    frozen_owner = str(task.owner_user_id or "")
    if not frozen_owner:
        # Legacy rows need both the durable handoff and its original device.
        # Never infer ownership from a new caller's device or request fields.
        original = await session.get(models.Client, row.owner_client_id)
        if (not original or original.user_ref != row.owner_user_id or
                task.created_by not in (None, "", row.owner_user_id)):
            raise HTTPException(404, "云端会话的原账号关联无法确认")
    elif frozen_owner != row.owner_user_id:
        raise HTTPException(404, "云端会话的账号关联不一致")
    return task


async def require_account_cloud_task(session, client, task_id, *, optional=False):
    """Authorize only a recorded cloud execution, without impersonating a device."""
    row = await conversation_handoffs.dispatch_record(session, task_id)
    if row is None:
        if optional:
            return None
        raise HTTPException(404, "云端会话不存在")
    task = await _owned_task(session, client, row)
    ref = str((row.receipt or {}).get("ref") or (row.receipt or {}).get("issueId") or "")
    if row.phase != "committed" or not ref:
        raise HTTPException(409, "请先确认会话已由当前账号的云端接管")
    from . import ai_exec
    event = await ai_exec.last_dispatch_event(session, task_id)
    dispatch = event.detail or {} if event else {}
    if str(dispatch.get("ref") or dispatch.get("issueId") or "") != ref:
        raise HTTPException(409, "云端执行关联已变化，请重新同步会话")
    expected = str(((row.options or {}).get("targetSnapshot") or {}).get("runnerId") or
                   (row.receipt or {}).get("runnerId") or "")
    execution = await _execution(session, row)
    actual = str(execution.runner_id if execution else dispatch.get("runnerId") or "")
    if not expected or actual != expected or (dispatch.get("runnerId") and dispatch["runnerId"] != expected):
        raise HTTPException(409, "云端执行机关联无法确认")
    return task


async def _execution(session, row):
    ref = str((row.receipt or {}).get("ref") or (row.receipt or {}).get("issueId") or "")
    query = select(am.ExecutionSession).where(am.ExecutionSession.task_id == row.task_id)
    if ref:
        query = query.where(am.ExecutionSession.ref == ref)
    return await session.scalar(query.order_by(
        am.ExecutionSession.created_at.desc(), am.ExecutionSession.id.desc()).limit(1))


def _public(row, task, execution):
    receipt = conversation_handoffs.public(row)
    state = execution_sessions.session_api(execution) if execution else None
    return {"id": row.id, "receipt": receipt,
            "title": task.title or (row.source or {}).get("title") or "云端会话",
            "createdAt": row.created_at.isoformat() if row.created_at else "",
            "execution": state, "artifactUrl": task.artifact_url or ""}


async def directory(session, client, *, after="", limit=50):
    user = await conversation_handoffs.owner(session, client)
    count = min(100, max(1, int(limit)))
    rows = (await session.execute(select(ConversationHandoff, models.Task)
        .join(models.Task, models.Task.id == ConversationHandoff.task_id)
        .where(ConversationHandoff.owner_user_id == user.id,
               ConversationHandoff.id > after)
        .order_by(ConversationHandoff.id).limit(count + 1))).all()
    page, more = rows[:count], len(rows) > count
    items = []
    for row, task in page:
        try:
            await _owned_task(session, client, row)
            items.append(_public(row, task, await _execution(session, row)))
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
    return {"ok": True, "mode": "reconcile", "items": items,
            "next": page[-1][0].id if more else "", "hasMore": more}


async def detail(session, client, handoff_id, *, ref="", since=0, limit=400):
    user = await conversation_handoffs.owner(session, client)
    row = await session.scalar(select(ConversationHandoff).where(
        ConversationHandoff.id == handoff_id,
        ConversationHandoff.owner_user_id == user.id))
    if row is None:
        raise HTTPException(404, "云端会话不存在或不属于当前账号")
    task = await _owned_task(session, client, row)
    execution = await _execution(session, row)
    # A client must not carry the previous execution's cursor into a new ref.
    current_ref = execution.ref if execution else ""
    if ref and ref != current_ref:
        raise HTTPException(409, "云端执行已变化，请重新同步会话")
    page = (await execution_sessions.read_task(session, task.id, current_ref, since,
                                               limit=limit, contiguous=True)
            if execution else None)
    attachments = (await session.scalars(select(models.Attachment).where(
        models.Attachment.task_id == task.id).order_by(models.Attachment.id))).all()
    approvals = (await session.scalars(select(am.ApprovalRequest).where(
        am.ApprovalRequest.task_id == task.id, am.ApprovalRequest.status == "pending")
        .order_by(am.ApprovalRequest.created_at, am.ApprovalRequest.id))).all()
    messages = (await session.scalars(select(ConversationMessageReceipt).where(
        ConversationMessageReceipt.task_id == task.id,
        ConversationMessageReceipt.phase.in_(("queued", "sending", "uncertain")))
        .order_by(ConversationMessageReceipt.created_at, ConversationMessageReceipt.id))).all()
    return {"ok": True, "conversation": _public(row, task, execution),
            "page": page, "attachments": [attachment_to_api(item) for item in attachments],
            "messages": [{"id": item.id, "messageId": item.message_id, "phase": item.phase,
                "receipt": {key: value for key, value in (item.receipt or {}).items()
                    if key in {"ok", "queued", "delivery", "note", "error", "messageId", "turnId", "round"}}}
                for item in messages],
            "approvals": [{"id": item.id, "taskId": task.id, "action": item.action,
                "status": item.status, "required": item.required_count,
                "createdAt": item.created_at.isoformat() if item.created_at else ""}
                for item in approvals]}
