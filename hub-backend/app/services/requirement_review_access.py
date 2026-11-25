"""Read current, personally actionable delivery reviews for task projections."""
from datetime import datetime, timezone

from sqlalchemy import and_, case, func, or_, select

from .. import automation_models as am, models


async def pending_task_ids(session, user_id, task_ids):
    if not user_id or not task_ids:
        return set()
    return {tid for tid, _ in await pending_assignments(session, task_ids, user_id)}


async def pending_assignments(session, task_ids, user_id=None, *, artifact_id=None):
    """Look up current assigned reviewers in bulk, keeping creator-only legacy gates restricted."""
    task, artifact, request = models.Task, am.ArtifactVersion, am.ApprovalRequest
    assignment, decision = am.ApprovalAssignment, am.ApprovalDecision
    latest_artifact = select(artifact.id).where(
        artifact.task_id == task.id, artifact.kind != "requirement",
    ).order_by(artifact.seq.desc(), artifact.created_at.desc(), artifact.id.desc()).limit(1).correlate(task).scalar_subquery()
    latest_review = select(request.id).where(
        request.task_id == task.id, request.artifact_version_id == artifact.id,
        request.action == "review",
    ).order_by(request.created_at.desc(), request.id.desc()).limit(1).correlate(task, artifact).scalar_subquery()
    legacy = request.policy_snapshot["reviewRoutingVersion"].as_integer().is_distinct_from(2)
    recipient = case((legacy, task.created_by), else_=assignment.user_id)
    query = select(task.id, recipient).select_from(task).join(artifact, artifact.id == latest_artifact).join(
        request, request.id == latest_review,
    ).join(assignment, assignment.request_id == request.id).join(
        models.User, models.User.id == recipient,
    ).where(
        or_(artifact.created_by_kind != "user", artifact.created_by_id.is_distinct_from(recipient)),
        or_(legacy, func.coalesce(task.assignee_user_id, task.owner_user_id).is_distinct_from(recipient),
            and_(task.created_by == recipient, assignment.sources[0]["type"].as_string() == "task_creator")),
        models.User.is_active.is_(True), task.archived_at.is_(None),
        task.status != "cancel", request.status == "pending",
        artifact.state.not_in({"rejected", "superseded"}),
        or_(request.expires_at.is_(None), request.expires_at > datetime.now(timezone.utc)),
        ~select(decision.id).where(
            decision.request_id == request.id, decision.user_id == recipient,
        ).exists(),
    )
    if user_id is not None:
        query = query.where(recipient == user_id)
    if artifact_id is not None:
        query = query.where(artifact.id == artifact_id)
    ids = list(dict.fromkeys(task_ids))
    found = set()
    for offset in range(0, len(ids), 500):
        found.update((await session.execute(query.where(task.id.in_(ids[offset:offset + 500])))).all())
    return found


def review_summary(task):
    """Only requirement and review identity are exposed through an assignment."""
    from .task_requirements import public_content
    return {"id": task.id, **public_content(task), "status": task.status,
            "requirementVersion": task.requirement_version, "kind": task.kind,
            "canViewExecution": False, "canEditRequirement": False, "readOnly": True}
