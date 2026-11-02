"""Read current, personally actionable delivery reviews for task projections."""
from datetime import datetime, timezone

from sqlalchemy import or_, select

from .. import automation_models as am, models


async def pending_task_ids(session, user_id, task_ids):
    """Use the latest delivery and review, without creating or rerouting approvals."""
    if not user_id or not task_ids:
        return set()
    task, artifact, request = models.Task, am.ArtifactVersion, am.ApprovalRequest
    assignment, decision = am.ApprovalAssignment, am.ApprovalDecision
    latest_artifact = select(artifact.id).where(
        artifact.task_id == task.id, artifact.kind != "requirement",
    ).order_by(artifact.seq.desc(), artifact.created_at.desc(), artifact.id.desc()).limit(1).correlate(task).scalar_subquery()
    latest_review = select(request.id).where(
        request.task_id == task.id, request.artifact_version_id == artifact.id,
        request.action == "review",
    ).order_by(request.created_at.desc(), request.id.desc()).limit(1).correlate(task, artifact).scalar_subquery()
    query = select(task.id).join(artifact, artifact.id == latest_artifact).join(
        request, request.id == latest_review,
    ).join(assignment, assignment.request_id == request.id).join(
        models.User, models.User.id == assignment.user_id,
    ).where(
        task.created_by == user_id, assignment.user_id == user_id,
        models.User.is_active.is_(True), task.archived_at.is_(None),
        task.status != "cancel", request.status == "pending",
        artifact.state.not_in({"rejected", "superseded"}),
        or_(request.expires_at.is_(None), request.expires_at > datetime.now(timezone.utc)),
        ~select(decision.id).where(
            decision.request_id == request.id, decision.user_id == user_id,
        ).exists(),
    )
    ids = list(dict.fromkeys(task_ids))
    found = set()
    for offset in range(0, len(ids), 500):
        found.update((await session.scalars(query.where(task.id.in_(ids[offset:offset + 500])))).all())
    return found
