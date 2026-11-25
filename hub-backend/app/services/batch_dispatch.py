"""Durable admission receipts for the ordered source tasks in one batch request."""
import hashlib
import json

from fastapi import HTTPException
from sqlalchemy import select

from ..models import Task, TaskEvent
from . import ai_exec, dispatch_attempts, execution_sessions, task_access, task_events, task_status
from .requirement_edit_policy import STARTED_EVENT


async def lock_members(session, ids, client):
    locked = {}
    for tid in sorted(set(ids)):
        await task_access.reserve_task_write(session, tid, client.id)
        task = await session.get(Task, tid, with_for_update=True, populate_existing=True)
        if task is None or not task_access.is_owner(task, client):
            raise HTTPException(404, "Task is not owned by this account: " + tid)
        locked[tid] = task
    return [locked[tid] for tid in ids]


def request_key(client, ids, body, repo):
    # Hash the effective execution inputs. An old client can repeat the same
    # request after a disconnect without retaining a new client-generated key.
    inputs = [str(client.id), str(client.user_ref or ""), ids, repo, str(body.get("title") or "").strip()[:200],
              str(body.get("brief") or "")[:2000], str(body.get("assigneeId") or "").strip(),
              str(body.get("assigneeType") or "").strip().lower(),
              str(body.get("model") or ""), str(body.get("reasoningEffort") or "")]
    return hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()


async def _members_reopened(session, batch, rows):
    if batch.status not in {"done", "cancel"} or any(t.status in {"done", "cancel"} for t in rows):
        return False
    # An identical HTTP retry after completion still owns the original receipt.
    # A later explicit reopen starts a new business round for legacy callers.
    closed_at = await session.scalar(select(TaskEvent.at).where(
        TaskEvent.task_id == batch.id, TaskEvent.kind == STARTED_EVENT,
        TaskEvent.detail["to"].as_string() == batch.status,
    ).order_by(TaskEvent.at.desc()).limit(1))
    if closed_at is None:
        return False
    return bool(await session.scalar(select(TaskEvent.id).where(
        TaskEvent.task_id.in_([task.id for task in rows]), TaskEvent.kind == STARTED_EVENT,
        TaskEvent.at > closed_at,
        TaskEvent.detail["from"].as_string().in_(("done", "cancel")),
        TaskEvent.detail["to"].as_string().in_(("todo", "doing", "paused")),
    ).limit(1)))


async def receipt(session, client, rows, key):
    # All callers hold the source locks before this lookup and through the
    # admission commit. Concurrent requests therefore observe the same intent.
    admission = await session.scalar(select(TaskEvent).where(
        TaskEvent.task_id == rows[0].id, TaskEvent.kind == "ai.batch_requested",
        TaskEvent.detail["requestKey"].as_string() == key,
    ).order_by(TaskEvent.at.desc(), TaskEvent.id.desc()).limit(1))
    if admission is None:
        return None
    detail = admission.detail
    batch = await session.get(Task, detail["batchId"])
    if batch is None or not task_access.is_owner(batch, client):
        raise HTTPException(409, "原批次已无法访问，请核对原派发记录")
    if await _members_reopened(session, batch, rows):
        return None
    event = await session.scalar(select(TaskEvent).where(
        TaskEvent.task_id == batch.id, TaskEvent.kind.in_(ai_exec.KINDS_DISPATCH_STATE),
    ).order_by(TaskEvent.at.desc(), TaskEvent.id.desc()).limit(1))
    if (event and event.kind == ai_exec.EV_DISPATCH_FAILED
            and event.detail.get("attemptId") == detail["attemptId"]):
        # Only a definite rejection releases the sources for another admission.
        return None
    active = await dispatch_attempts.existing(session, batch.id, batch.status)
    if active is None:
        dispatched = await ai_exec.last_dispatch_event(session, batch.id)
        active = {"pending": dispatched is None, "state": batch.status,
                  "identifier": (dispatched.detail or {}).get("identifier", "") if dispatched else ""}
    return {**active, "ok": True, "already": True, "batchId": batch.id, "count": len(rows),
            "attemptId": detail["attemptId"]}


async def reserve(session, batch, ids, key, who, aid, atype, model, picked):
    attempt_id = batch.id
    for tid in ids:
        task_events.record(session, tid, "ai.batch_requested", {
            "requestKey": key, "batchId": batch.id, "attemptId": attempt_id}, actor=who)
    return await dispatch_attempts.start(session, batch.id, who, aid, atype, model,
                                         stable_id=attempt_id, recovery_route=picked or {})


async def settle(session, batch, count, who, aid, picked, result):
    """Record the transport outcome under the batch row lock; return whether confirmation is pending."""
    attempt_id = batch.id
    previous = await ai_exec.last_dispatch_event(session, batch.id)
    if previous is not None:
        # A heartbeat or reconciliation probe already confirmed this delivery.
        return False
    if result.get("ok"):
        task_events.record(session, batch.id, ai_exec.EV_DISPATCHED, {
            **dispatch_attempts.success_detail(attempt_id, aid, picked),
            "ref": result.get("issueId", ""), "issueId": result.get("issueId", ""),
            "identifier": result.get("identifier", ""), "url": result.get("url", ""), "by": who,
            "provider": result.get("provider", ""), "batch": count,
            "runnerId": result.get("runnerId", ""), "host": result.get("host", ""),
            "assigneeId": result.get("assigneeId") or aid, "assigneeType": result.get("assigneeType", "agent"),
            "assigneeName": result.get("assigneeName", ""), "assigneeCli": result.get("assigneeCli", ""),
        }, actor=who)
        await execution_sessions.record_dispatch(session, batch, result)
        return False
    if result.get("uncertain"):
        route = dict(picked or {})
        for field in ("runnerId", "runnerBootId", "host"):
            if result.get(field):
                route[field] = result[field]
        detail = dispatch_attempts.uncertain(session, batch.id, who, attempt_id, result.get("error"), aid, route)
        confirmed = await execution_sessions.confirm_uncertain_dispatch(
            session, batch, detail["expectedRef"], str(detail.get("runnerId") or ""))
        return not bool(confirmed)
    await task_status.mark(session, batch, "cancel", why="执行机拒绝批次")
    failure = dispatch_attempts.record_failure(session, batch.id, who, attempt_id, "dispatch",
                                               result.get("error"), aid, picked)
    await session.commit()
    raise HTTPException(502, {"message": failure["error"], "batchId": batch.id,
                              "attemptId": attempt_id, "retryable": True})
