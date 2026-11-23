"""Scoped monitoring projection of the same immutable requests used by delivery gates."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import load_only

from .. import automation_models as am, models
from ..deps import has_perm
from ..pagination import Page
from . import approval_routing, rbac, release_control


REMIND_AFTER = timedelta(hours=24)
GATE_PERMISSIONS = {"review": "delivery.review", "merge": "delivery.merge",
                    "uat": "delivery.accept", "deploy": "delivery.deploy"}


def has_gate_permission(user, action):
    return has_perm(user, "release.approve") or has_perm(user, GATE_PERMISSIONS.get(action, ""))


def _pending(visible_client_ids):
    query = select(am.ApprovalRequest).join(
        models.Task, models.Task.id == am.ApprovalRequest.task_id
    ).where(am.ApprovalRequest.status == "pending")
    if visible_client_ids is not None:
        query = query.where(models.Task.owner_client_id.in_(visible_client_ids))
    return query


def can_withdraw(user, request, task):
    return has_gate_permission(user, request.action) and (
        user.is_super or user.id in {task.created_by, request.created_by})


def can_transfer(user, request, source):
    return (has_gate_permission(user, request.action) and request.action != "review"
            and (user.is_super or user.id == source))


class TransferConflict(ValueError):
    """The selected assignment or the version it applies to is no longer available."""


async def transfer_candidates(session, user, request, task, from_id, *, materialize=False):
    version = await session.get(am.ArtifactVersion, request.artifact_version_id)
    if version is None or version.task_id != task.id:
        raise TransferConflict("审批版本已失效")
    assignments = {a.user_id: a for a in await session.scalars(select(am.ApprovalAssignment).where(
        am.ApprovalAssignment.request_id == request.id))}
    candidates, excluded = await approval_routing._candidate_map(
        session, task, request.action, request.policy_snapshot or {}, version)
    if not assignments:
        if materialize:
            assignments = {a.user_id: a for a in await approval_routing.ensure_assignments(session, task, request)}
        else:
            assignments = dict.fromkeys(candidates)
    votes = set(await session.scalars(select(am.ApprovalDecision.user_id).where(
        am.ApprovalDecision.request_id == request.id)))
    if from_id not in assignments or from_id in votes or from_id in excluded:
        raise TransferConflict("原处理人已变化或已经投票")
    scope = await rbac.scope_org_ids(session, user)
    task_org = await approval_routing._task_org_id(session, task)
    others = set(assignments) - {from_id} - votes - excluded
    # A disabled account cannot supply a remaining countersignature.
    others = {u.id for u in await approval_routing._active_users(session, others)}
    options = {}
    for uid, candidate in candidates.items():
        target = candidate["user"]
        if (uid == from_id or uid in votes or scope is not None and target.org_id not in scope
                or len(others | votes | {uid}) < request.required_count
                or not await approval_routing._in_scope(session, target, task_org)):
            continue
        options[uid] = target
    return assignments, options


async def counts(session, visible_client_ids):
    rows = _pending(visible_client_ids).with_only_columns(
        am.ApprovalRequest.created_at, am.ApprovalRequest.expires_at).subquery()
    now = datetime.now(timezone.utc)
    overdue = or_(rows.c.expires_at <= now, and_(rows.c.expires_at.is_(None),
                                                 rows.c.created_at <= now - REMIND_AFTER))
    total, overdue_count = (await session.execute(select(
        func.count(), func.count(case((overdue, 1)))).select_from(rows))).one()
    return total, overdue_count


async def _reviewers(session, ids):
    assigned = {}
    decisions = {}
    if ids:
        assignment = am.ApprovalAssignment
        for rid, uid, name, active in await session.execute(
            select(assignment.request_id, assignment.user_id, assignment.user_name, models.User.is_active)
            .outerjoin(models.User, models.User.id == assignment.user_id).where(assignment.request_id.in_(ids))
        ):
            assigned.setdefault(rid, {})[uid] = (name, bool(active))
        decision = am.ApprovalDecision
        for rid, uid in await session.execute(
            select(decision.request_id, decision.user_id).where(decision.request_id.in_(ids))
        ):
            decisions.setdefault(rid, set()).add(uid)
    return assigned, decisions


async def queue(session, user, visible_client_ids, page: Page):
    request, task_model, version_model = am.ApprovalRequest, models.Task, am.ArtifactVersion
    query = _pending(visible_client_ids)
    total = await page.total(session, query)
    query = (query.add_columns(task_model, version_model)
        .outerjoin(version_model, and_(version_model.id == request.artifact_version_id,
                                      version_model.task_id == task_model.id))
        .options(load_only(request.id, request.action, request.created_at, request.expires_at,
                           request.created_by, request.policy_snapshot, request.artifact_version_id, request.environment_id),
                 load_only(task_model.id, task_model.title, task_model.created_by, task_model.owner_user_id,
                           task_model.repo_id, task_model.project_id, task_model.assignee_user_id, task_model.requester_user_id,
                           task_model.review_recipient_user_id, task_model.shared_org_id),
                 load_only(version_model.id, version_model.seq, version_model.created_by_kind, version_model.created_by_id))
        .order_by(request.created_at, request.id))
    rows = (await session.execute(page.window(query))).all()
    read_all = has_perm(user, "release.approve") or has_perm(user, "task.view")
    assigned, decisions = await _reviewers(session, [req.id for req, _, _ in rows
                                                     if read_all or has_gate_permission(user, req.action)])
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    items = []
    for req, task, version in rows:
        due = release_control._ms(req.expires_at or req.created_at + REMIND_AFTER)
        manage = has_gate_permission(user, req.action)
        snapshot = assigned.get(req.id, {})
        legacy_review = req.action == "review" and (req.policy_snapshot or {}).get("reviewRoutingVersion") != 2
        if (read_all or manage) and (not snapshot or legacy_review):
            # Preview the same assignment repair used when a legacy request is opened or voted on.
            candidates, _ = await approval_routing._candidate_map(
                session, task, req.action, req.policy_snapshot or {}, version)
            snapshot = {uid: (c["user"].display_name or c["user"].username, True) for uid, c in candidates.items()}
        elif (req.policy_snapshot or {}).get("separationOfDuties") and req.action != "review" and snapshot:
            excluded = await approval_routing._implementer_ids(session, task, version)
            snapshot = {uid: value for uid, value in snapshot.items() if uid not in excluded}
        withdraw = can_withdraw(user, req, task)
        show_details = read_all or withdraw or (manage and user.id in snapshot)
        people = [{"userId": uid, "userName": name, "inactive": not active,
                   "canTransfer": bool(version and can_transfer(user, req, uid))}
                  for uid, (name, active) in sorted(snapshot.items())
                  if show_details and uid not in decisions.get(req.id, ())]
        items.append({"id": req.id, "action": req.action, "createdAt": release_control._ms(req.created_at),
            "dueAt": due, "overdue": now >= due, "canViewDetails": show_details,
            "taskId": task.id if show_details else "", "taskTitle": task.title if show_details else "",
            "artifactVersionId": req.artifact_version_id if show_details else "",
            "artifactLabel": f"v{version.seq}" if show_details and version else "",
            "environmentId": req.environment_id if show_details else "",
            "assignees": people,
            "canDecide": bool(manage and version and any(p["userId"] == user.id and not p["inactive"] for p in people)),
            "canWithdraw": withdraw,
            "canTransfer": any(p["canTransfer"] for p in people)})
    return {"total": total, "items": items}
