"""Public module behavior and service contracts."""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from . import task_events, task_status
from .task_access import publish_owner

log = logging.getLogger("uvicorn.error")

_ACTIVE_RUN = ("queued", "running", "waiting_human", "waiting_external")
_ALLOWED = ("done", "cancel")


async def _end_runs(session: AsyncSession, task_id: str, actor: str, reason: str) -> list[dict]:
    """Stop all running workflows for the task, treating already-stopped or otherwise
    uninterruptible runs as nonfatal cleanup results.
    """
    from . import workflow_control
    rows = list((await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.task_id == task_id,
        am.WorkflowRun.state.in_(_ACTIVE_RUN)))).scalars().all())
    out = []
    for run in rows:
        try:
            result = await workflow_control.cancel_run(
                session, run, actor=actor, reason=reason)
            out.append({"runId": run.id, "ok": True,
                        "stoppedExecutors": result.get("stoppedExecutors") or []})
        except Exception as e:  # noqa: BLE001
            log.warning("转人工时结束流程 %s 失败：%s", run.id[:8], type(e).__name__)
            out.append({"runId": run.id, "ok": False, "error": str(e)[:200]})
    return out


async def _stop_direct_ai(session: AsyncSession, task_id: str) -> list[dict]:
    """Stop directly dispatched AI sessions best-effort. Offline Runners or missing sessions must
    not prevent manual handoff.
    """
    from . import ai_exec, ai_remote
    from .ai_exec import EV_DISPATCHED
    rows = list((await session.execute(select(models.TaskEvent).where(
        models.TaskEvent.task_id == task_id,
        models.TaskEvent.kind == EV_DISPATCHED
    ).order_by(models.TaskEvent.at.desc()).limit(5))).scalars().all())
    seen, out = set(), []
    ctx = None
    for row in rows:
        detail = dict(row.detail or {})
        if dict(detail.get("plugin") or {}):
            continue                      # Plugin execution is stopped together with its workflow.
        ref = str(detail.get("ref") or detail.get("issueId") or "")
        if not ref or ref in seen:
            continue
        seen.add(ref)
        if ctx is None:
            ctx = await ai_exec.load(session)
        runner_id = str(detail.get("runnerId") or "")
        if runner_id and str(detail.get("provider") or "") == "runner":
            ai_remote.remember(ref, runner_id)
        try:
            result = await asyncio.to_thread(ai_exec.stop_sync, ctx, ref)
            out.append({"ref": ref, "ok": bool(result.get("ok")),
                        "error": str(result.get("error") or "")[:200]})
        except Exception as e:  # noqa: BLE001
            out.append({"ref": ref, "ok": False, "error": type(e).__name__})
    return out


async def to_human(session: AsyncSession, task: models.Task, *, status: str = "done",
                   note: str = "", actor: str = "") -> dict:
    """Stop active execution, finalize as done or cancel for manual handling, record the reason,
    and notify stakeholders.
    """
    status = status if status in _ALLOWED else "done"
    actor = (str(actor or "").strip() or "system")[:100]
    note = str(note or "").strip()[:2000]
    reason = ("转人工线下处理：" + note) if note else "转人工线下处理"

    was = {"status": task.status,
           "runs": await _end_runs(session, task.id, actor, reason),
           "ai": await _stop_direct_ai(session, task.id)}
    task = await session.get(models.Task, task.id)      # Reload the task after workflow termination may have changed it.
    # Once every workflow stops, the engine no longer owns task-state writes.
    # If a workflow remains active, do not falsely report successful handoff.
    changed = await task_status.mark(
        session, task, status, why="转人工线下", allow_incomplete=True)
    if not changed:
        await session.rollback()
        raise ValueError("这条需求还被流程接管着，先结束流程再收尾（多半是刚起了一条新流程）")
    task.result = (note or "已转人工线下处理")[:2000]
    task_events.record(session, task.id, "task.handoff", {
        "status": status, "note": note[:500], "from": was["status"],
        "endedRuns": [x.get("runId") for x in was["runs"] if x.get("ok")],
        "stoppedAi": [x.get("ref") for x in was["ai"] if x.get("ok")],
    }, actor=actor)
    await session.commit()

    try:
        from . import notify
        await notify.notify_task(session, task, "「%s」已转人工线下处理%s" % (
            task.title or "需求", ("：" + note[:80]) if note else "。已完成的记录和证据都保留着。"))
    except Exception:  # noqa: BLE001 - Notification failure must not prevent handoff completion.
        pass
    # Return terminal state immediately and push it to other windows on the same device.
    # Push failure does not undo the committed action; the response still updates the initiating window.
    from .tasks import task_to_api_live
    task_api = await task_to_api_live(session, task)
    if task.owner_client_id:
        try:
            from ..realtime import hub
            await publish_owner(session, task, {"type": "task.updated", "task": task_api})
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "status": task.status, "endedRuns": was["runs"],
            "stoppedAi": was["ai"], "previousStatus": was["status"], "task": task_api}
