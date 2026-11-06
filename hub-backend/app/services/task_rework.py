"""Retain rejected delivery for executor-owned continuation; workflow tasks use graph rework.
Explicitly authorized automatic continuation retains bounded retries and a deterministic
rework:<requestId> message ID. Ordinary rejection waits for the executor without model calls.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models

log = logging.getLogger("uvicorn.error")

# Retry delays: five minutes, thirty minutes, then two hours; exhausted retries require manual handling.
_MAX_ATTEMPTS = 3
_BACKOFF_SECONDS = (5 * 60, 30 * 60, 2 * 3600)
# The scan lookback covers the full bounded retry horizon.
_SWEEP_SECONDS = 60
_SCAN_WINDOW_DAYS = 3
# Retry only declared transient delivery failures.
# Missing archives, client-only sessions, and disabled local execution require terminal remediation.
_RETRYABLE_CODES = {"RUNNER_OFFLINE"}
# Later successful dispatch, manual takeover, pool return, or terminal events settle the pending card.
# The scan uses the latest relevant event as its anchor.
# ai.rework_failed updates the card without settling it.
_SETTLED_KINDS = ("ai.rework", "ai.rework_taken", "review.returned_to_backlog",
                  "ai.rework_exhausted")


def _unsettled_exists():
    """Build the predicate excluding rework anchors superseded by later settlement events."""
    ev = models.TaskEvent
    newer = aliased(models.TaskEvent)
    return exists(select(newer.id).where(
        newer.task_id == ev.task_id,
        newer.kind.in_(_SETTLED_KINDS),
        or_(newer.at > ev.at, and_(newer.at == ev.at, newer.id > ev.id)),
    ))


def _message_id(request_id: str) -> str:
    """Use one deterministic message ID across every retry of a request for Runner turnId
    deduplication.
    """
    return f"rework:{request_id}" if request_id else ""


async def pending_cards(session: AsyncSession, *, now: datetime | None = None) -> int:
    """Count all eligible unresolved rework cards for health monitoring without a scan limit. Use
    the same active-task and lookback rules as retry_once.
    """
    now = now or datetime.now(timezone.utc)
    ev = models.TaskEvent
    total = (await session.execute(
        select(func.count()).select_from(ev)
        .join(models.Task, models.Task.id == ev.task_id).where(
            ev.kind == "ai.rework_pending",
            ev.at >= now - timedelta(days=_SCAN_WINDOW_DAYS),
            models.Task.status.in_(("doing", "done")),
            ~_unsettled_exists(),
        )
    )).scalar_one()
    return int(total)


# Expose retry-loop heartbeat through health diagnostics.
# Track successful ticks, pending backlog, and consecutive scan errors.
# These values describe the current worker process in multi-worker deployments.
loop_health: dict = {
    "lastSweepAt": None, "lastOkAt": None, "pending": None,
    "lastCounts": None, "consecutiveErrors": 0, "lastError": None,
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _instruction(feedback: str) -> str:
    return (
        "返工要求（以本条为准）：人工验收没有通过，意见是：" + feedback.strip() +
        "。请在原来的工作目录里接着修改，不要从零重做；完成后重新提交完整主成果和"
        "可复核证据。如果交付物是网站或服务，同时给出可访问地址。"
    )


async def _record_pending(
    session: AsyncSession,
    task: models.Task,
    ref: str,
    feedback: str,
    *,
    version_id: str,
    request_id: str,
    actor: str,
    error: str,
    retryable: bool,
) -> dict:
    """Persist feedback and retry schedule after failed continuation. Count attempts per request
    ID, resetting for a new rejection; notify only on initial failure and terminal exhaustion.
    """
    from . import task_events

    now = datetime.now(timezone.utc)
    prior = dict((dict(task.work_routing or {}).get("reworkPending") or {}))
    # Increment attempts only for the same request ID.
    # A new rejection must receive its own retry budget and initial notification.
    same_request = bool(request_id) and str(prior.get("requestId") or "") == request_id
    attempts = (int(prior.get("attempts") or 0) + 1) if same_request else 1
    message_id = _message_id(request_id)
    card = {
        "feedback": feedback[:1000], "ref": ref, "requestId": request_id,
        "versionId": version_id, "actor": actor,
        "error": error, "at": now.isoformat(),
        "attempts": attempts, "maxAttempts": _MAX_ATTEMPTS,
        "messageId": message_id,
    }
    if retryable and attempts < _MAX_ATTEMPTS:
        delay = _BACKOFF_SECONDS[min(attempts - 1, len(_BACKOFF_SECONDS) - 1)]
        card["state"] = "pending"
        card["nextAttemptAt"] = (now + timedelta(seconds=delay)).isoformat()
    else:
        # Mark permanent or exhausted failures terminal rather than implying ongoing execution.
        card["state"] = "failed"
    routing = dict(task.work_routing or {})
    routing["reworkPending"] = card
    task.work_routing = routing
    task_events.record(session, task.id, "ai.rework_failed", {
        "ref": ref, "requestId": request_id, "versionId": version_id,
        "feedback": feedback[:500], "error": error,
        "attempts": attempts, "retryable": retryable,
    }, actor=actor)
    if card.get("state") == "pending":
        if attempts <= 1:
            # Write the anchor only on initial creation; later settled events determine whether the card remains active.
            task_events.record(session, task.id, "ai.rework_pending", {
                "ref": ref, "requestId": request_id,
                "feedback": feedback[:500], "error": error,
            }, actor=actor)
    else:
        # Immediately terminal cards receive a settlement anchor so scans skip them.
        task_events.record(session, task.id, "ai.rework_exhausted", {
            "requestId": request_id, "ref": ref, "attempts": attempts,
            "reason": "not_retryable", "error": error[:300],
        }, actor=actor)
    await session.commit()
    if attempts <= 1:
        text = (f"「{task.title}」验收被退回，自动返修未启动：{error[:80]}。"
                f"返修意见已留在需求详情，可重新发起执行。")
    elif card.get("state") == "failed":
        text = (f"「{task.title}」自动返修已重试 {attempts} 次仍未成功：{error[:80]}。"
                f"请在需求详情重新安排执行，返修意见会自动带上。")
    else:
        text = ""
    if text:
        try:
            from . import task_access
            if task.owner_client_id:
                await task_access.publish_owner(session, task, {
                    "type": "notice", "taskId": task.id, "text": text,
                })
        except Exception:  # Notification failure must not affect the rejection transaction.
            pass
    return {"mode": "direct_ai", "started": False, "ref": ref, "error": error,
            "fallback": "rework_pending", "retryable": retryable,
            "exhausted": card.get("state") == "failed"}


async def acknowledge_continuation(session, task_id, ref, submitted_at, *, actor="SoduWork",
                                  conversation_id="", turn_id="", message_id=""):
    """Consume feedback only for an accepted executor message submitted after rejection.

    Keep this in the caller's receipt transaction. A delayed ACK or duplicate
    message from a previous review must never consume a newer rejection.
    """
    from . import artifact_version_guard, task_events

    await artifact_version_guard.lock_task(session, task_id)
    task = await session.get(models.Task, task_id, populate_existing=True)
    routing = dict(task.work_routing or {})
    pending = dict(routing.get("reworkPending") or {})
    turn = dict(routing.get("conversationTurn") or {})
    # Earlier clients switched a Runner transcript to native execution. Permit
    # its rejected local receipt only when the current controlled turn proves
    # that this same conversation is resuming the original Runner.
    controlled = (conversation_id and turn.get("conversationId") == conversation_id
                  and turn.get("turnId") == turn_id and turn.get("state") == "running"
                  and turn.get("continuationRef") == ref and turn.get("executor") == "dispatch")
    restored = controlled and pending.get("ref") in {conversation_id, "conversation:" + conversation_id}
    if not pending and controlled:
        # Older native follow-ups consumed the marker without collecting their
        # files. The rejected review remains authoritative for explicit recovery.
        request = await session.scalar(select(am.ApprovalRequest).where(
            am.ApprovalRequest.task_id == task_id, am.ApprovalRequest.action == "review",
            am.ApprovalRequest.status == "rejected").order_by(
                am.ApprovalRequest.resolved_at.desc()).limit(1))
    elif pending and (pending.get("ref") == ref or restored):
        request = await session.get(am.ApprovalRequest, pending.get("requestId"))
    else:
        return False
    if request is None or request.task_id != task_id or request.status != "rejected":
        return False
    boundary = request.resolved_at or request.created_at
    def utc(value):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    if submitted_at is None or utc(submitted_at) <= utc(boundary):
        return False
    if task.status in {"done", "cancel"} or task.archived_at:
        return False
    if controlled:
        previous = (await session.scalars(select(models.TaskEvent).where(
            models.TaskEvent.task_id == task_id, models.TaskEvent.kind == "ai.rework",
            models.TaskEvent.at >= boundary))).all()
        if any((row.detail or {}).get("messageId") == message_id and
               (row.detail or {}).get("turnId") == turn_id for row in previous):
            return False
    routing.pop("reworkPending", None)
    task.work_routing = routing
    task_events.record(session, task.id, "ai.rework", {
        "ref": ref, "requestId": request.id, "versionId": request.artifact_version_id,
        "feedback": str(pending.get("feedback") or "")[:500], "by": "executor",
        **({"conversationId": conversation_id, "turnId": turn_id, "messageId": message_id}
           if controlled else {}),
    }, actor=actor)
    return True


async def resume_after_rejection(
    session: AsyncSession,
    task: models.Task,
    feedback: str,
    *,
    artifact_version_id: str = "",
    request_id: str = "",
    actor: str = "SoduWork",
    fallback_on_missing_ref: bool = False,
    wait_for_executor: bool = False,
) -> dict:
    """Retain executor-owned feedback or resume the exact authorized AI run."""
    from . import ai_exec, task_status

    feedback = str(feedback or "").strip()
    if not feedback:
        return {"mode": "human", "started": False, "error": "没有可执行的返修意见"}
    if await task_status.engine_owns(session, [task.id]):
        return {"mode": "workflow", "started": True, "automatic": True,
                "message": "工作流会按退回意见回到指定阶段"}

    artifact = await session.get(am.ArtifactVersion, artifact_version_id) if artifact_version_id else None
    if artifact is not None and artifact.task_id != task.id:
        return {"mode": "human", "started": False,
                "error": "当前退回版本不属于这条需求，未启动自动返修"}
    # The immutable artifact is the authority for which exact execution produced it.
    # Older manual candidates omitted their top-level source, but their frozen
    # verified file manifest still identifies it. Read that proof without rewriting
    # the accepted/rejected version. Ambiguous file lineage must not borrow a newer run.
    from . import delivery_manifest
    manifest = dict(artifact.manifest or {}) if artifact is not None else {}
    ref = str(artifact.source_ref or "") if artifact is not None else ""
    ref = ref or delivery_manifest.unique_output_source(manifest)
    files = manifest.get("files")
    has_lineage = isinstance(files, list) and any(
        isinstance(row, dict) and row.get("sourceRef") for row in files)
    if not ref and not has_lineage:
        dispatch = await ai_exec.last_dispatch_event(session, task.id)
        detail = dict(dispatch.detail or {}) if dispatch is not None else {}
        ref = str(detail.get("ref") or detail.get("issueId") or "")
    execution = (await session.execute(select(am.ExecutionSession).where(
        am.ExecutionSession.ref == ref
    ).limit(1))).scalar_one_or_none() if ref else None
    if execution is not None and execution.workflow_run_id:
        return {"mode": "workflow", "started": False,
                "error": "原执行属于已经结束的工作流，请从失败阶段重试"}
    if wait_for_executor:
        # Rejecting delivery requests revision; it does not authorize another
        # model run on the executor's behalf. The existing continuation action
        # consumes this marker, while background retry scans leave it untouched.
        if task.status in ("todo", "done"):
            await task_status.mark(session, task, "doing", why="验收退回待返修")
        task.work_routing = {**dict(task.work_routing or {}), "reworkPending": {
            "state": "awaiting_executor", "feedback": feedback[:1000], "ref": ref,
            "requestId": request_id, "versionId": artifact_version_id, "actor": actor,
            "at": datetime.now(timezone.utc).isoformat(), "attempts": 0,
            "messageId": _message_id(request_id),
        }}
        await session.commit()
        return {"mode": "executor", "started": False, "ref": ref,
                "fallback": "rework_pending",
                "waitingForExecutor": True, "message": "已退回，等待执行人继续修正"}
    if not ref:
        if fallback_on_missing_ref:
            # Preserve every reviewer's rework decision without a resumable session ref.
            # Create terminal evidence rather than blindly retrying a missing session.
            # A later manually arranged execution receives the retained review feedback.
            if task.status in ("todo", "done"):
                await task_status.mark(session, task, "doing", why="验收退回待返修")
            return await _record_pending(
                session, task, "", feedback, version_id=artifact_version_id,
                request_id=request_id, actor=actor,
                error="这条需求没有可续跑的 AI 会话，请重新安排执行",
                retryable=False)
        return {"mode": "human", "started": False, "error": "这条需求没有可续跑的 AI 会话"}

    if ref.startswith("conversation:"):
        # Do not send an RPC to a client-only conversation that Hub cannot resume.
        # Persisted feedback enters the client's later execution or follow-up through taskPrompt.
        # A client conversation cannot be resumed by the hub, but the task must
        # become executable so the owner can continue in the old chat or start a new one.
        if task.status in ("todo", "done"):
            await task_status.mark(session, task, "doing", why="验收退回待返修")
        return await _record_pending(
            session, task, ref, feedback, version_id=artifact_version_id,
            request_id=request_id, actor=actor,
            error="原执行在你的客户端会话里，可在原会话按意见继续，或重新发起执行（意见会自动带上）",
            retryable=False)
    from . import task_continuation
    try:
        ctx = await task_continuation.prepare(session, task, await ai_exec.load(session), ref)
    except task_continuation.ContinuationError as exc:
        return await _record_pending(
            session, task, ref, feedback, version_id=artifact_version_id,
            request_id=request_id, actor=actor, error=str(exc),
            retryable=exc.code in _RETRYABLE_CODES)
    result = await asyncio.to_thread(
        ai_exec.say_sync, ctx, ref, _instruction(feedback),
        message_id=_message_id(request_id))
    if not result.get("ok"):
        error = str(result.get("error") or "执行机没有接收返修要求")[:500]
        # Persist retryable delivery failures with backoff.
        # Notify the execution owner and rejecting reviewer visibly.
        # Uncertain RPC outcomes can be retried with the same deterministic message ID.
        # Runner turnId deduplication prevents duplicate delivery from becoming duplicate execution.
        retryable = (str(result.get("code") or "") in _RETRYABLE_CODES
                     or bool(result.get("uncertain")))
        return await _record_pending(
            session, task, ref, feedback, version_id=artifact_version_id,
            request_id=request_id, actor=actor, error=error,
            retryable=retryable)

    now = datetime.now(timezone.utc)
    if execution is not None:
        execution.state, execution.finished_at = "running", None
        meta = dict(execution.metadata_ or {})
        rework = dict(meta.get("rework") or {})
        rework.update({"count": int(rework.get("count") or 0) + 1,
                       "feedback": feedback[:1000], "actor": actor, "at": now.isoformat()})
        meta["rework"] = rework
        meta["round"] = int(meta.get("round") or 1) + 1
        execution.metadata_ = meta
    if task.status in ("todo", "done"):
        # Starting rework after rejected completed output returns the task to progress.
        await task_status.mark(session, task, "doing", why="人工退回后自动返修")
    # Clear the pending-rework marker once continuation actually starts.
    routing = dict(task.work_routing or {})
    if routing.pop("reworkPending", None) is not None:
        task.work_routing = routing
    from . import task_events
    task_events.record(session, task.id, "ai.rework", {
        "ref": ref, "requestId": request_id, "versionId": artifact_version_id,
        "feedback": feedback[:500], "queued": bool(result.get("queued")),
    }, actor=actor)
    await session.commit()
    return {"mode": "direct_ai", "started": True, "automatic": True, "ref": ref,
            "queued": bool(result.get("queued")), "message": "原 AI 已按意见继续修改"}


async def return_to_backlog(
    session: AsyncSession,
    task: models.Task,
    feedback: str,
    *,
    request_id: str = "",
    actor: str = "SoduWork",
) -> dict:
    """Return a rejected requirement to unstarted status for manual scheduling without resuming the
    original AI. Workflow-owned tasks retain graph rollback semantics; preserve feedback rather
    than forcing them out of the engine.
    """
    from . import task_events, task_status

    if await task_status.engine_owns(session, [task.id]):
        task_events.record(session, task.id, "review.backlog_skipped_engine", {
            "requestId": request_id, "feedback": (feedback or "")[:500],
        }, actor=actor)
        return {"mode": "workflow", "started": False,
                "message": "任务由工作流接管，退回意见已记录；请从失败阶段重试"}
    applied = await task_status.mark(session, task, "todo", why="验收退回：退回待开始等人工重新安排")
    if not applied and task.status != "todo":
        task_events.record(session, task.id, "review.backlog_skipped", {
            "requestId": request_id, "feedback": (feedback or "")[:500],
            "status": task.status,
        }, actor=actor)
        return {"mode": "workflow", "started": False,
                "message": "任务状态未能退回（引擎接管或状态限制），退回意见已记录"}
    task.triage_stage = "ready"
    routing = dict(task.work_routing or {})
    if routing.pop("reworkPending", None) is not None:
        task.work_routing = routing
    task_events.record(session, task.id, "review.returned_to_backlog", {
        "requestId": request_id, "feedback": (feedback or "")[:500],
    }, actor=actor)
    await session.commit()
    return {"mode": "backlog", "started": True, "automatic": False,
            "message": "已退回待开始，需求回到需求池等待重新安排"}


async def _finalize_pending(
    session: AsyncSession,
    task: models.Task,
    pending: dict,
    error: str,
    *,
    reason: str,
) -> None:
    """Explicitly terminate a pending rework card with state, audit event, and notification."""
    from . import task_events

    routing = dict(task.work_routing or {})
    card = dict(routing.get("reworkPending") or {})
    card.update({"state": "failed", "failReason": reason,
                 "error": str(error)[:500],
                 "attempts": int(card.get("attempts") or 0),
                 "finalizedAt": datetime.now(timezone.utc).isoformat()})
    routing["reworkPending"] = card
    task.work_routing = routing
    task_events.record(session, task.id, "ai.rework_exhausted", {
        "requestId": str(card.get("requestId") or ""),
        "ref": str(card.get("ref") or ""),
        "attempts": card["attempts"], "reason": reason, "error": str(error)[:300],
    }, actor=str(card.get("actor") or "SoduWork"))
    await session.commit()
    try:
        from . import task_access
        if task.owner_client_id:
            await task_access.publish_owner(session, task, {
                "type": "notice", "taskId": task.id,
                "text": f"「{task.title}」自动返修未成功（{reason}）：{str(error)[:80]}。"
                        f"请在需求详情重新安排执行，返修意见会自动带上。",
            })
    except Exception:  # Notification failure must not interrupt the retry loop.
        pass


async def _retry_one(session: AsyncSession, event_row: models.TaskEvent, *,
                     now: datetime) -> str:
    """Retry one card and return sent, backoff, exhausted, or stale."""
    task = await session.get(models.Task, event_row.task_id)
    if task is None:
        return "stale"
    routing = dict(task.work_routing or {})
    pending = dict(routing.get("reworkPending") or {})
    if not pending or str(pending.get("state") or "pending") != "pending":
        return "stale"  # Skip cards already handled by manual takeover, successful dispatch, or terminal settlement.
    next_at = pending.get("nextAttemptAt")
    if next_at:
        try:
            due = datetime.fromisoformat(str(next_at))
        except ValueError:
            due = None
        if due is not None and due > now:
            return "backoff"
    if int(pending.get("attempts") or 0) >= int(pending.get("maxAttempts") or _MAX_ATTEMPTS):
        await _finalize_pending(session, task, pending,
                                str(pending.get("error") or "重试次数已用完"), reason="max_attempts")
        return "exhausted"
    # Recheck card validity within the transaction before sending to minimize races with manual redispatch.
    result = await resume_after_rejection(
        session, task, str(pending.get("feedback") or ""),
        artifact_version_id=str(pending.get("versionId") or ""),
        request_id=str(pending.get("requestId") or ""),
        actor=str(pending.get("actor") or "SoduWork"))
    if result.get("started"):
        return "sent"
    if result.get("fallback") == "rework_pending":
        # resume already updates attempts, backoff, and terminal state after another failure.
        return "exhausted" if result.get("exhausted") else "backoff"
    if result.get("mode") == "workflow":
        # Yield to graph rework when a workflow owns the task or original execution.
        routing = dict(task.work_routing or {})
        if routing.pop("reworkPending", None) is not None:
            task.work_routing = routing
            from . import task_events
            task_events.record(session, task.id, "ai.rework_taken", {
                "requestId": str(pending.get("requestId") or ""), "by": "workflow_owns",
            }, actor=str(pending.get("actor") or "SoduWork"))
            await session.commit()
        return "sent"
    # Permanent human-mode failures terminate without consuming additional retries.
    await _finalize_pending(session, task, pending,
                            str(result.get("error") or "无法续跑原会话"), reason="not_retryable")
    return "exhausted"


async def retry_once(session: AsyncSession, *, now: datetime | None = None) -> dict:
    """Scan a bounded set of due unresolved rework cards anchored to each task's latest rework
    event and restricted to recent active tasks.
    """
    now = now or datetime.now(timezone.utc)
    ev = models.TaskEvent
    newer_settled = _unsettled_exists()
    rows = list((await session.execute(
        select(ev).join(models.Task, models.Task.id == ev.task_id).where(
            ev.kind == "ai.rework_pending",
            ev.at >= now - timedelta(days=_SCAN_WINDOW_DAYS),
            models.Task.status.in_(("doing", "done")),
            ~newer_settled,
        ).order_by(ev.at.desc(), ev.id.desc()).limit(20)
    )).scalars().all())
    counts = {"candidates": len(rows), "sent": 0, "backoff": 0,
              "exhausted": 0, "stale": 0, "errors": 0}
    for row in rows:
        try:
            outcome = await _retry_one(session, row, now=now)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - One card failure must not abort the scan.
            counts["errors"] += 1
            log.warning("返修补投失败 task=%s: %s", str(row.task_id)[:8], type(error).__name__)
            continue
        counts[outcome] = counts.get(outcome, 0) + 1
    return counts


async def retry_loop() -> None:
    """Run the supervised background retry loop with per-iteration failure isolation and health
    heartbeats. Expose last successful tick and backlog so stalled retries remain observable.
    """
    from ..db import SessionLocal

    while True:
        try:
            async with SessionLocal() as session:
                out = await retry_once(session)
                loop_health["pending"] = await pending_cards(session)
            loop_health["lastOkAt"] = _now_iso()
            loop_health["consecutiveErrors"] = 0
            loop_health["lastError"] = None
            loop_health["lastCounts"] = out
            if out.get("sent") or out.get("exhausted") or out.get("errors"):
                log.info("返修补投：候选 %s，送达 %s，退避 %s，终态 %s",
                         out.get("candidates"), out.get("sent"),
                         out.get("backoff"), out.get("exhausted"))
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - Keep the loop alive after one failed iteration.
            loop_health["consecutiveErrors"] += 1
            # Unauthenticated health output includes exception class names only.
            # Keep SQL, internal topology, and parameter details in local diagnostics.
            loop_health["lastError"] = type(error).__name__
            log.warning("返修补投循环异常：%s: %s", type(error).__name__, error)
        loop_health["lastSweepAt"] = _now_iso()
        await asyncio.sleep(_SWEEP_SECONDS)
