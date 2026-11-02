"""Freeze requirement definitions using durable execution facts, not board labels."""
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import aliased

from .. import automation_models as am, models
from . import ai_exec


DEFINITION_KEYS = {
    "title", "note", "description", "source", "kind", "acceptanceCriteria", "priority", "tags",
    "start", "due", "assigneeUserId", "requesterUserId", "requesterName", "requesterContact",
    "projectId", "repoId", "deps", "visibility", "domainId", "workScenarioKey",
    "urgent", "important",
}
STARTED_EVENT = "task.execution_started"
STARTED_REASON = "需求已进入执行，不能再编辑原需求"
PENDING_REASON = "需求正在准备执行或等待执行确认，暂不能编辑"
CLOSED_REASON = "请先恢复已归档或已取消的需求，再编辑"
_BATCH_SIZE = 750


def _facts_query(ids):
    task = models.Task
    event = models.TaskEvent
    attempt = aliased(models.TaskEvent)
    failure = aliased(models.TaskEvent)
    failed_attempt = exists(select(failure.id).where(
        failure.task_id == attempt.task_id, failure.kind == ai_exec.EV_DISPATCH_FAILED,
        failure.detail["attemptId"].as_string() == attempt.detail["attemptId"].as_string(),
        failure.at >= attempt.at,
    )).correlate(attempt)
    pending_attempt = exists(select(attempt.id).where(
        attempt.task_id == task.id,
        attempt.kind.in_((ai_exec.EV_DISPATCH_STARTED, ai_exec.EV_DISPATCH_UNCERTAIN)),
        ~failed_attempt,
    )).correlate(task)
    successful_event = or_(
        event.kind.in_((*ai_exec.KINDS_ARTIFACTS, STARTED_EVENT, "plugin.started",
                       "plugin.resumed_from_evidence", "artifact.submitted_for_review")),
        and_(event.kind.in_(ai_exec.KINDS_DISPATCHED),
             func.coalesce(event.detail["state"].as_string(), "") != "queued"),
        and_(event.kind == "conversation.turn",
             event.detail["state"].as_string().in_(("running", "waiting", "completed"))),
    )
    turn_state = task.work_routing["conversationTurn"]["state"].as_string()
    history = or_(
        task.status.in_(("doing", "paused", "done")), task.actual_start_at.is_not(None),
        task.actual_end_at.is_not(None), task.reviewed_at.is_not(None),
        turn_state.in_(("running", "waiting", "completed")),
        exists(select(am.ExecutionSession.id).where(am.ExecutionSession.task_id == task.id)),
        exists(select(am.WorkflowRun.id).where(am.WorkflowRun.task_id == task.id)),
        exists(select(am.ArtifactVersion.id).where(
            am.ArtifactVersion.task_id == task.id, am.ArtifactVersion.kind != "requirement")),
        exists(select(am.ApprovalRequest.id).where(
            am.ApprovalRequest.task_id == task.id, am.ApprovalRequest.action == "review")),
        exists(select(event.id).where(event.task_id == task.id, successful_event)),
    )
    pending = or_(
        turn_state.in_(("queued", "running", "waiting")), pending_attempt,
        exists(select(am.ResourceLease.id).where(
            am.ResourceLease.resource_kind == "workflow-start", am.ResourceLease.resource_key == task.id,
            am.ResourceLease.token != "", am.ResourceLease.lease_until > datetime.now(timezone.utc))),
    )
    closed = or_(task.archived_at.is_not(None), task.status == "cancel")
    return select(task.id, history.label("history"), pending.label("pending"),
                  closed.label("closed")).where(task.id.in_(ids))


async def facts_many(session, tasks):
    """Use fixed-size correlated queries rather than fetching every task's timeline."""
    ids = list(dict.fromkeys(task.id for task in tasks))
    result = {}
    # Leave room for the JSON/state predicates under legacy SQLite's
    # 999-variable limit while keeping permission queries batched.
    for offset in range(0, len(ids), _BATCH_SIZE):
        for row in (await session.execute(_facts_query(ids[offset:offset + _BATCH_SIZE]))).mappings():
            history = bool(row["history"])
            reason = (STARTED_REASON if history else PENDING_REASON if row["pending"]
                      else CLOSED_REASON if row["closed"] else "")
            result[row["id"]] = (history, reason)
    return result


async def decorate_many(session, tasks, apis, *, facts=None):
    pairs = list(zip(tasks, apis))
    if facts is None:
        facts = await facts_many(session, [task for task, _ in pairs])
    for task, api in pairs:
        history, reason = facts.get(task.id, (False, ""))
        api.update(hasExecutionHistory=history, requirementEditBlocked=bool(reason),
                   requirementEditBlockReason=reason)
    return apis


async def ensure_allowed(session, task):
    """The caller retains its Task write reservation until the edit commits."""
    facts = await facts_many(session, [task])
    _, reason = facts.get(task.id, (False, ""))
    if reason:
        raise HTTPException(409, reason)
    return facts


def preserve_manual_history(session, task, previous_status, next_status):
    # Actual timestamps can be corrected and status can return to todo. Keep
    # immutable audit evidence so those runtime updates cannot reopen editing.
    if (next_status in {"doing", "done"} or previous_status in {"doing", "paused", "done"}
            or task.actual_start_at or task.actual_end_at):
        from . import task_events
        task_events.record(session, task.id, STARTED_EVENT,
                           {"from": previous_status, "to": next_status}, actor="SoduWork")
