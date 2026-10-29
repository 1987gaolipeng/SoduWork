"""Authoritative maintenance guard over existing execution records, not task labels."""
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func, select

from .. import automation_models as am, models
from . import dispatch_attempts, execution_sessions

# Only confirmed terminal receipts unlock destructive maintenance. Preparation,
# human/external waits, pauses and unfamiliar future states remain protected.
WORKFLOW_TERMINAL = {"succeeded", "failed", "cancelled"}
WORKFLOW_REASON = "关联流程尚未结束，请先结束流程，再归档或删除需求"
EXECUTION_REASON = "需求仍在执行、准备或等待中，请先停止执行，再归档或删除需求"
STAGE_REASON = "只有收集箱、待开始和已验收完成的需求可以归档或删除；已归档需求可以直接删除"


async def blocked_reasons(session, tasks):
    """Batch reads keep list/detail/push and mutation decisions on the same facts."""
    rows = list(tasks)
    ids = [task.id for task in rows]
    if not ids:
        return {}
    reasons = {}
    receipts = {task.id: dict(task.work_routing or {}).get("conversationTurn") or {} for task in rows}
    pending = {tid: receipt for tid, receipt in receipts.items()
               if receipt and not execution_sessions.is_terminal(receipt.get("state"))}
    settled = set()
    if pending:
        # A stale routing snapshot must not revive the exact turn's durable
        # terminal event. Another conversation/turn or an unknown state cannot
        # release this receipt, and live execution/dispatch facts still win below.
        ranked = select(models.TaskEvent.id, func.dense_rank().over(
            partition_by=models.TaskEvent.task_id,
            order_by=models.TaskEvent.at.desc()).label("position")
        ).where(models.TaskEvent.task_id.in_(pending), models.TaskEvent.kind == "conversation.turn").subquery()
        events = await session.scalars(select(models.TaskEvent).join(
            ranked, models.TaskEvent.id == ranked.c.id).where(ranked.c.position == 1))
        latest = {}
        for event in events:
            latest.setdefault(event.task_id, []).append(dict(event.detail or {}))
        for tid, terminals in latest.items():
            receipt = pending[tid]
            # Older databases only recorded whole seconds. UUID order cannot
            # prove which tied event came last: every tied fact must agree.
            if (receipt.get("state") in {"queued", "running", "waiting"}
                    and all(all(receipt.get(key) and receipt.get(key) == terminal.get(key)
                                for key in ("conversationId", "turnId"))
                            and receipt.get("executor") == terminal.get("executor")
                            and execution_sessions.is_terminal(terminal.get("state"))
                            for terminal in terminals)):
                settled.add(tid)
    reasons.update({tid: EXECUTION_REASON for tid in pending if tid not in settled})
    executions = await session.execute(select(
        am.ExecutionSession.task_id, am.ExecutionSession.ref, am.ExecutionSession.state,
    ).where(am.ExecutionSession.task_id.in_(ids)))
    execution_states = {}
    for tid, ref, state in executions:
        execution_states[tid, ref] = state
        if not execution_sessions.is_terminal(state):
            reasons[tid] = EXECUTION_REASON
    dispatches = await dispatch_attempts.existing_many(
        session, {task.id: task.status for task in rows}, execution_states=execution_states)
    for tid in dispatches:
        reasons[tid] = EXECUTION_REASON
    leases = await session.scalars(select(am.ResourceLease.resource_key).where(
        am.ResourceLease.resource_kind == "workflow-start",
        am.ResourceLease.resource_key.in_(ids),
        am.ResourceLease.token != "",
        am.ResourceLease.lease_until > datetime.now(timezone.utc)))
    for tid in leases:
        reasons[tid] = WORKFLOW_REASON
    workflows = await session.scalars(select(am.WorkflowRun.task_id).where(
        am.WorkflowRun.task_id.in_(ids), am.WorkflowRun.state.not_in(WORKFLOW_TERMINAL)))
    for tid in workflows:
        reasons[tid] = WORKFLOW_REASON
    return reasons


async def ensure_allowed(session, tasks, *, action=None, client=None):
    """Caller holds each Task row lock until the maintenance transaction commits."""
    rows = list(tasks)
    if action in {"archive", "delete"}:
        if client is not None:
            from . import task_requirements
            for task in rows:
                if not await task_requirements.can_maintain(session, client, task):
                    raise HTTPException(403, "只有创建人可以归档或删除未开始的需求")
        # Reuse the board's latest delivery/review projection. A stopped workflow
        # or a todo task with a pending delivery review is not an allowed stage.
        from . import task_requirement_projection
        apis = [{} for _task in rows]
        await task_requirement_projection.decorate_many(session, rows, apis)
        reasons = {task.id: api["maintenanceBlockReason"] for task, api in zip(rows, apis)
                   if api["maintenanceBlocked"]}
    else:
        reasons = await blocked_reasons(session, rows)
    if reasons:
        raise HTTPException(409, next(iter(reasons.values())))
    if action in {"archive", "delete"}:
        for task, api in zip(rows, apis):
            if action == "delete" and api["requirementStage"] == "closed":
                continue
            if (api["requirementStage"] not in {"intake", "clarifying", "ready", "delivered"}
                    or (task.status == "done" and not task.reviewed_at)):
                raise HTTPException(409, STAGE_REASON)


async def decorate_many(session, tasks, apis):
    pairs = list(zip(tasks, apis))
    reasons = await blocked_reasons(session, [task for task, _ in pairs])
    for task, api in pairs:
        reason = reasons.get(task.id, "")
        api.update(maintenanceBlocked=bool(reason), maintenanceBlockReason=reason)
    return apis
