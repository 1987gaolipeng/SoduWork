"""Transaction-scoped version serialization and conservative duplicate repair."""
from datetime import datetime, timezone

from sqlalchemy import select, update

from .. import automation_models as am, models
from . import task_events, task_requirements


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
