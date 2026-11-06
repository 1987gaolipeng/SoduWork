"""Transaction-scoped version serialization and conservative duplicate repair."""
from datetime import datetime, timezone

from sqlalchemy import select, update

from .. import automation_models as am, models
from . import task_events, task_requirements


class OutputAwaitingRework(ValueError):
    """An automatic receipt cannot supersede a rejected delivery."""


def _round(value):
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


async def require_rework_execution(session, task, source_ref, round_no):
    """Fence automatic collection by the accepted execution after the last rejection.

    Call under the task lock used by candidate creation and review decisions.
    New files, changed classification, and transport round numbers are not user intent.
    Explicit manual submission remains governed by its own authorized API.
    """
    from . import ai_exec

    if task.status in {"done", "cancel"} or task.archived_at:
        raise OutputAwaitingRework("需求已结束，旧执行结果不再自动提交")
    rejected = (await session.execute(select(am.ApprovalRequest, am.ArtifactVersion).join(
        am.ArtifactVersion, am.ArtifactVersion.id == am.ApprovalRequest.artifact_version_id,
    ).where(am.ApprovalRequest.task_id == task.id, am.ApprovalRequest.action == "review",
            am.ApprovalRequest.status == "rejected")
        .order_by(am.ApprovalRequest.resolved_at.desc(), am.ArtifactVersion.seq.desc())
        .limit(1).execution_options(populate_existing=True))).first()
    if rejected is None:
        return
    request, artifact = rejected
    boundary = request.resolved_at or request.created_at
    events = list((await session.scalars(select(models.TaskEvent).where(
        models.TaskEvent.task_id == task.id, models.TaskEvent.at >= boundary,
        models.TaskEvent.kind.in_((*ai_exec.KINDS_DISPATCHED, "ai.rework", "conversation.turn")),
    ).order_by(models.TaskEvent.at.desc(), models.TaskEvent.id.desc()))).all())
    started = False
    for event in events:
        detail = dict(event.detail or {})
        if event.kind == "conversation.turn":
            # Only a newly prepared turn proves continuation. An old turn can
            # report start or completion after the review has already rejected it.
            if detail.get("state") != "queued":
                continue
            ref = str(detail.get("continuationRef") or "")
            if ref:
                # A queued Runner continuation is not proof of admission. Keep
                # old output fenced until this exact turn has an accepted send.
                if not any(row.kind == "ai.rework" and
                           (row.detail or {}).get("conversationId") == detail.get("conversationId") and
                           (row.detail or {}).get("turnId") == detail.get("turnId") and
                           (row.detail or {}).get("ref") == ref for row in events):
                    break
            else:
                ref = "conversation:" + str(detail.get("conversationId") or "")
        else:
            ref = str(detail.get("ref") or detail.get("issueId") or "")
        # The latest authorized execution owns delivery; older sources cannot
        # win a race by reporting additional files after a replacement starts.
        started = ref == source_ref
        break
    previous_round = 0
    for item in dict(artifact.manifest or {}).get("files") or []:
        if item.get("sourceRef") == source_ref:
            previous_round = max(previous_round, _round(item.get("round")))
    if not previous_round:
        receipts = (await session.scalars(select(models.TaskEvent).where(
            models.TaskEvent.task_id == task.id, models.TaskEvent.at <= boundary,
            models.TaskEvent.kind.in_(ai_exec.KINDS_ARTIFACTS),
        ))).all()
        previous_round = max((_round((row.detail or {}).get("round")) for row in receipts
                              if (row.detail or {}).get("ref") == source_ref), default=0)
    same_source = artifact.source_ref == source_ref or previous_round > 0
    if (not started or (same_source and _round(round_no) <= previous_round)
            or (task.work_routing or {}).get("reworkPending")):
        raise OutputAwaitingRework("交付已退回，等待执行人继续修改后重新提交")


async def lock_task(session, task_id):
    # Hold through the caller's commit, not just through candidate construction.
    # SQLite ignores FOR UPDATE; a no-op write acquires its transaction writer lock.
    if session.bind.dialect.name == 'sqlite':
        result = await session.execute(update(models.Task).where(models.Task.id == task_id)
            .values(updated_at=models.Task.updated_at).execution_options(synchronize_session=False))
        exists = result.rowcount
    else:
        exists = await session.scalar(select(models.Task.id).where(models.Task.id == task_id).with_for_update())
    if not exists:
        raise ValueError('Task does not exist')


async def reconcile_identical_pending(session, task_id):
    """Retain every record; supersede only identical, undecided duplicate file gates.

    Call only from an authorized write/recovery operation. Never call from a read
    context or infer equivalence from a filename, a title, or a checksum alone.
    """
    await lock_task(session, task_id)
    task = await session.get(models.Task, task_id)
    if task.kind not in task_requirements.KINDS or task.archived_at or task.reviewed_at or task.status == 'cancel':
        return []
    if await session.scalar(select(am.WorkflowRun.id).where(am.WorkflowRun.task_id == task_id).limit(1)):
        return []
    versions = list((await session.scalars(select(am.ArtifactVersion).where(
        am.ArtifactVersion.task_id == task_id, am.ArtifactVersion.kind != 'requirement'
    ).order_by(am.ArtifactVersion.seq.desc(), am.ArtifactVersion.created_at.desc())
        .execution_options(populate_existing=True))).all())
    if not versions or versions[0].kind != 'files' or not versions[0].source_ref or not versions[0].checksum:
        return []
    latest, group = versions[0], []
    fields = ('kind', 'source_ref', 'checksum', 'manifest', 'commit_sha', 'branch', 'target', 'url')
    for version in versions:
        if version.state != 'candidate' or any(getattr(version, k) != getattr(latest, k) for k in fields):
            break
        group.append(version)
    if len(group) < 2:
        return []
    ids = [v.id for v in group]
    requests = list((await session.scalars(select(am.ApprovalRequest).where(
        am.ApprovalRequest.artifact_version_id.in_(ids)).with_for_update()
        .execution_options(populate_existing=True))).all())
    if (len(requests) != len(group) or len({r.artifact_version_id for r in requests}) != len(group)
            or any(r.task_id != task_id or r.action != 'review' or r.status != 'pending' for r in requests)):
        return []
    def signature(request):
        context = {k: v for k, v in (request.context or {}).items() if k != 'version'}
        return (request.policy_id, request.required_count, request.policy_snapshot,
                request.environment_id, request.expires_at, context)
    if any(signature(r) != signature(requests[0]) for r in requests):
        return []
    request_ids = [r.id for r in requests]
    if await session.scalar(select(am.ApprovalDecision.id).where(am.ApprovalDecision.request_id.in_(request_ids)).limit(1)):
        return []
    if await session.scalar(select(am.DeploymentRun.id).where(am.DeploymentRun.artifact_version_id.in_(ids)).limit(1)):
        return []
    assignments = list((await session.scalars(select(am.ApprovalAssignment).where(
        am.ApprovalAssignment.request_id.in_(request_ids)))).all())
    reviewers = {rid: {a.user_id for a in assignments if a.request_id == rid} for rid in request_ids}
    if any(reviewers[rid] != reviewers[request_ids[0]] for rid in request_ids):
        return []
    old_ids = ids[1:]
    for version in group[1:]:
        version.state = 'superseded'
    for request in requests:
        if request.artifact_version_id in old_ids:
            request.status = 'cancelled'
            request.resolved_at = datetime.now(timezone.utc)
    task_events.record(session, task_id, 'release.duplicate_reconciled', {
        'versionId': latest.id, 'supersededVersionIds': old_ids,
        'cancelledRequestIds': [r.id for r in requests if r.artifact_version_id in old_ids],
        'reason': 'identical-undecided-file-candidates',
    }, actor='SoduWork')
    await session.flush()
    return old_ids
