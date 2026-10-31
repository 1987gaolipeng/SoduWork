"""Resolve configurable approval policies into explicit, auditable user-assignment snapshots."""
from __future__ import annotations

from sqlalchemy import delete, inspect as sa_inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from ..permissions import ALL_KEYS
from . import rbac


_DEFAULT_SELECTORS = {
    "baseline": [
        {"type": "requester", "label": "需求提出人"},
        {"type": "task_creator", "label": "需求创建人"},
        {"type": "project_owner", "label": "项目负责人"},
    ],
    "review": [
        {"type": "task_creator", "label": "需求创建人"},
    ],
    "merge": [
        {"type": "project_owner", "label": "项目负责人"},
        {"type": "permission", "key": "delivery.merge", "label": "代码合并授权人"},
    ],
    "uat": [
        {"type": "requester", "label": "需求提出人"},
        {"type": "task_creator", "label": "需求创建人"},
        {"type": "project_owner", "label": "项目负责人"},
        {"type": "permission", "key": "delivery.accept", "label": "业务验收人"},
    ],
    "deploy": [
        {"type": "permission", "key": "delivery.deploy", "label": "环境发布授权人"},
    ],
}

_AI_EXECUTION_EVENTS = {"ai.dispatched", "multica.dispatched", "ai.artifacts"}
# ai.artifacts also identifies AI conversation outputs that have no dispatched event.
# Without it, AI-produced work could be classified as manual work.
# That would incorrectly exclude the human reviewer through separation-of-duties checks.


def actor_id(actor) -> str:
    """Read ORM primary-key identity safely even when approval objects expire across transactions.

    """
    try:
        identity = sa_inspect(actor).identity
        if identity:
            return str(identity[0] or "")
    except Exception:  # Plain DTOs and test doubles have no SQLAlchemy state.
        pass
    return str(getattr(actor, "id", "") or "")


def default_rules(action: str) -> dict:
    rules = {
        "actions": [action], "mode": "any", "required": 1,
        "approvers": [dict(x) for x in _DEFAULT_SELECTORS.get(action, [])],
        "invalidateOnNewVersion": True,
    }
    if action in {"review", "merge", "uat", "deploy"}:
        rules.update({"separationOfDuties": True})
    return rules


def effective_selectors(action: str, rules: dict | None) -> list[dict]:
    """Use approvers for current policies; map legacy action policies to equivalent business
    responsibilities.
    """
    rules = dict(rules or {})
    configured = rules.get("approvers")
    if isinstance(configured, list) and configured:
        return [dict(x) for x in configured if isinstance(x, dict)]
    # Interpret legacy creator and permission selectors using the action's default responsibilities.
    return [dict(x) for x in _DEFAULT_SELECTORS.get(action, [])]


async def _task_org_id(session: AsyncSession, task: models.Task) -> str:
    if task.repo_id:
        repo = await session.get(models.Repo, task.repo_id)
        if repo is not None and repo.org_id:
            return str(repo.org_id)
    if task.project_id:
        project = await session.get(models.Project, task.project_id)
        if project is not None and project.org_id:
            return str(project.org_id)
    if task.owner_user_id:
        user = await session.get(models.User, task.owner_user_id)
        if user is not None and user.org_id:
            return str(user.org_id)
    return ""


async def _in_scope(session: AsyncSession, user: models.User, task_org_id: str) -> bool:
    if user.is_super or not task_org_id:
        return True
    if not user.org_id:
        return False
    return task_org_id in await rbac.subtree_org_ids(session, user.org_id)


async def _active_users(session: AsyncSession, ids: set[str]) -> list[models.User]:
    if not ids:
        return []
    return list((await session.execute(select(models.User).where(
        models.User.id.in_(ids), models.User.is_active.is_(True)
    ))).scalars().all())


async def _selector_users(session: AsyncSession, task: models.Task, selector: dict,
                          task_org_id: str) -> list[models.User]:
    kind = str(selector.get("type") or "").strip()
    direct: set[str] = set()
    if kind == "requester" and task.requester_user_id:
        direct.add(str(task.requester_user_id))
    elif kind == "task_creator" and task.created_by:
        direct.add(str(task.created_by))
    elif kind == "task_assignee" and task.assignee_user_id:
        direct.add(str(task.assignee_user_id))
    elif kind == "owner_client" and task.owner_user_id:
        direct.add(str(task.owner_user_id))
    elif kind == "project_owner" and task.project_id:
        project = await session.get(models.Project, task.project_id)
        if project is not None:
            owner = project.owner_user_id or project.created_by
            if owner:
                direct.add(str(owner))
    elif kind == "user":
        direct.update(str(x) for x in (selector.get("ids") or [selector.get("id")]) if x)
    if direct:
        return await _active_users(session, direct)

    users = list((await session.execute(select(models.User).where(
        models.User.is_active.is_(True)
    ))).scalars().all())
    roles = {r.id: r for r in (await session.execute(select(models.Role))).scalars().all()}
    wanted = set(str(x) for x in (selector.get("ids") or [selector.get("id")]) if x)
    key = str(selector.get("key") or "")
    out = []
    for user in users:
        matches = False
        if kind == "role":
            matches = bool(user.role_id and str(user.role_id) in wanted)
        elif kind == "position":
            matches = bool(wanted.intersection(str(x) for x in (user.positions or [])))
        elif kind == "permission":
            permissions = set(ALL_KEYS) if user.is_super else set(
                (roles.get(user.role_id).permissions if user.role_id in roles else []) or [])
            # Preserve release.approve as a legacy aggregate permission.
            # New roles can authorize review, merge, acceptance, and release separately.
            matches = key in permissions or (
                key.startswith("delivery.") and "release.approve" in permissions)
        if matches and await _in_scope(session, user, task_org_id):
            out.append(user)
    return out


async def _implementer_ids(session: AsyncSession, task: models.Task,
                           artifact: am.ArtifactVersion | None) -> set[str]:
    """Identify users who actually produced the artifact. AI-task owners normally remain eligible
    reviewers; treat a user as implementer only with explicit human provenance or a legacy
    manual task without AI evidence.
    """
    out: set[str] = set()
    if artifact is not None and str(artifact.created_by_kind or "") == "user":
        if artifact.created_by_id:
            out.add(str(artifact.created_by_id))
    ai_executed = bool(await session.scalar(select(models.TaskEvent.id).where(
        models.TaskEvent.task_id == task.id,
        models.TaskEvent.kind.in_(_AI_EXECUTION_EVENTS),
    ).limit(1)))
    if not ai_executed and task.assignee_user_id:
        out.add(str(task.assignee_user_id))
    return out


async def _candidate_map(session: AsyncSession, task: models.Task, action: str,
                         rules: dict, artifact: am.ArtifactVersion | None = None
                         ) -> tuple[dict[str, dict], set[str]]:
    # Requirement-pool delivery review is a business acceptance owned by the
    # person who created the requirement.  Do not let a custom policy, a legacy
    # snapshot, or a delivery.review permission turn the executor into an
    # approver.  Other gates (baseline/merge/uat/deploy) retain their routed
    # responsibilities.
    if action == "review":
        creator_id = str(getattr(task, "created_by", None) or "").strip()
        if not creator_id:
            return {}, set()
        users = await _active_users(session, {creator_id})
        if not users:
            return {}, set()
        user = users[0]
        return {creator_id: {
            "user": user,
            "sources": [{"type": "task_creator", "label": "需求创建人"}],
        }}, set()
    task_org_id = await _task_org_id(session, task)
    excluded: set[str] = set()
    if rules.get("separationOfDuties"):
        excluded = await _implementer_ids(session, task, artifact)
    candidates: dict[str, dict] = {}
    for selector in effective_selectors(action, rules):
        label = str(selector.get("label") or "流程指定审批人")
        for user in await _selector_users(session, task, selector, task_org_id):
            if str(user.id) in excluded:
                continue
            item = candidates.setdefault(user.id, {"user": user, "sources": []})
            source = {"type": str(selector.get("type") or ""), "label": label}
            source_id = selector.get("id") or selector.get("key")
            if source_id:
                source["id"] = str(source_id)
            if source not in item["sources"]:
                item["sources"].append(source)
    return candidates, excluded


async def preview_assignments(session: AsyncSession, task: models.Task, action: str,
                              rules: dict | None) -> dict:
    """Resolve a policy without creating a request, assignment, event or notification."""
    normalized = dict(rules or {})
    required = max(1, int(normalized.get("required") or 1))
    candidates, excluded = await _candidate_map(
        session, task, action, normalized, artifact=None)
    people = [{"userId": uid,
               "userName": item["user"].display_name or item["user"].username,
               "reasons": list(item["sources"])}
              for uid, item in candidates.items()]
    return {"action": action, "required": required, "available": len(people),
            "ok": len(people) >= required, "candidates": people,
            "excluded": sorted(excluded)}


async def ensure_assignments(session: AsyncSession, task: models.Task,
                             request: am.ApprovalRequest) -> list[am.ApprovalAssignment]:
    existing = list((await session.execute(select(am.ApprovalAssignment).where(
        am.ApprovalAssignment.request_id == request.id
    ).order_by(am.ApprovalAssignment.created_at))).scalars().all())
    if request.action == "review" and request.status == "pending":
        # Review has exactly one eligible person (the creator). Reconcile old
        # pending requests that were materialized with executor/permission
        # assignments before this rule existed, so inbox and detail reads do
        # not keep exposing the old approver.
        rules = dict(request.policy_snapshot or {})
        candidates, excluded = await _candidate_map(
            session, task, request.action, rules,
            await session.get(am.ArtifactVersion, request.artifact_version_id))
        desired = set(candidates)
        if {str(row.user_id) for row in existing} != desired:
            if existing:
                await session.execute(delete(am.ApprovalAssignment).where(
                    am.ApprovalAssignment.request_id == request.id))
            existing = []
        if existing:
            return existing
        rows = []
        for uid, item in candidates.items():
            user = item["user"]
            rows.append(am.ApprovalAssignment(
                request_id=request.id, user_id=uid,
                user_name=user.display_name or user.username,
                sources=item["sources"],
            ))
        for row in rows:
            session.add(row)
        await session.flush()
        if not rows:
            await _record_unassigned(session, task, request, excluded)
        return rows
    if existing:
        if not dict(request.policy_snapshot or {}).get("separationOfDuties"):
            return existing
        artifact = await session.get(am.ArtifactVersion, request.artifact_version_id)
        excluded = await _implementer_ids(session, task, artifact)
        return [row for row in existing if str(row.user_id) not in excluded]
    rules = dict(request.policy_snapshot or {})
    artifact = await session.get(am.ArtifactVersion, request.artifact_version_id)
    candidates, excluded = await _candidate_map(
        session, task, request.action, rules, artifact)
    rows = []
    for uid, item in candidates.items():
        user = item["user"]
        row = am.ApprovalAssignment(
            request_id=request.id, user_id=uid,
            user_name=user.display_name or user.username,
            sources=item["sources"],
        )
        session.add(row)
        rows.append(row)
    await session.flush()
    if not rows:
        await _record_unassigned(session, task, request, excluded)
    return rows


async def _record_unassigned(session: AsyncSession, task: models.Task,
                             request: am.ApprovalRequest, excluded: set[str]) -> None:
    """Record an unassignable gate without turning routing failures into approvals."""
    from . import task_events
    task_events.record(session, task.id, "approval.unassigned", {
        "requestId": request.id, "action": request.action,
        "excluded": sorted(excluded)[:8],
    }, actor="SoduWork")
    if task.owner_client_id:
        try:
            from . import task_access
            await task_access.publish_owner(session, task, {
                "type": "notice",
                "text": "⚠️「%s」的「%s」审批派不出去：按当前规则算不出可用的审批人"
                        "（可能是负责人没配、或职责分离把唯一人选排除了）。"
                        "请调整项目负责人或审批策略。" % (
                            (task.title or "需求")[:40], request.action),
            })
        except Exception:  # noqa: BLE001 - Notification failure must not interrupt approval processing.
            pass


async def assignment_for_user(session: AsyncSession, request_id: str,
                              user_id: str) -> am.ApprovalAssignment | None:
    return (await session.execute(select(am.ApprovalAssignment).where(
        am.ApprovalAssignment.request_id == request_id,
        am.ApprovalAssignment.user_id == user_id,
    ).limit(1))).scalar_one_or_none()


async def assignments_for_user_bulk(session: AsyncSession, request_ids: list[str],
                                    user_id: str) -> dict:
    """Batch-load this user's assignments by request ID, avoiding one query per approval-list row.

    """
    if not request_ids or not user_id:
        return {}
    rows = list((await session.execute(select(am.ApprovalAssignment).where(
        am.ApprovalAssignment.request_id.in_(request_ids),
        am.ApprovalAssignment.user_id == user_id,
    ))).scalars().all())
    return {r.request_id: r for r in rows}


def assignment_api(row: am.ApprovalAssignment | None) -> dict | None:
    if row is None:
        return None
    return {
        "userId": row.user_id, "userName": row.user_name,
        "reasons": list(row.sources or []),
    }


async def can_decide(session: AsyncSession, task: models.Task, request: am.ApprovalRequest,
                     actor) -> tuple[bool, str]:
    uid = actor_id(actor)
    assignments = None
    if request.action == "review":
        # Reconcile a legacy pending assignment before checking the actor. This
        # lets the first post-deploy inbox read move the ticket to the creator
        # even when the service has not restarted through materialize_pending.
        assignments = await ensure_assignments(session, task, request)
        creator_id = str(getattr(task, "created_by", None) or "").strip()
        if not creator_id:
            return False, "这条需求没有记录创建人，无法判定审核权"
        if uid != creator_id:
            return False, "只有需求创建人可以审批交付成果"
    rules = dict(request.policy_snapshot or {})
    if request.action != "review" and rules.get("separationOfDuties"):
        artifact = await session.get(am.ArtifactVersion, request.artifact_version_id)
        implementers = await _implementer_ids(session, task, artifact)
        if uid in implementers:
            return False, "这项交付要求职责分离，需求执行负责人不能审阅或批准自己的产出"
    if assignments is None:
        assignments = await ensure_assignments(session, task, request)
    assigned = next((x for x in assignments if x.user_id == uid), None)
    if assigned is None:
        return False, "这项审批没有分配给你；请由流程指定的负责人处理"
    return True, ""


async def preview_can_decide(session: AsyncSession, task: models.Task,
                             request: am.ApprovalRequest, actor,
                             artifact: am.ArtifactVersion) -> bool:
    """Check approval eligibility without creating assignments or sending notifications when
    opening a review panel.
    """
    uid = actor_id(actor)
    if request.action == "review":
        creator_id = str(getattr(task, "created_by", None) or "").strip()
        return bool(creator_id and uid == creator_id)
    rules = dict(request.policy_snapshot or {})
    if rules.get("separationOfDuties"):
        if uid in await _implementer_ids(session, task, artifact):
            return False
    rows = list((await session.execute(select(am.ApprovalAssignment).where(
        am.ApprovalAssignment.request_id == request.id))).scalars().all())
    if rows:
        return any(row.user_id == uid for row in rows)
    candidates, _ = await _candidate_map(session, task, request.action, rules, artifact)
    return uid in candidates


async def can_read_task_evidence(session: AsyncSession, task: models.Task,
                                 client: models.Client,
                                 artifact_version_id: str = "") -> bool:
    """Keep task evidence readable by its owner and legitimate human reviewers.

    Approval detail already grants access to the assigned reviewer and to someone
    who made an immutable decision.  Artifact downloads must use the same domain
    rule and the same artifact version.  Existing assignment snapshots are queried
    directly, so this read path never creates or reroutes approval work.
    """
    from . import task_access
    if task_access.is_owner(task, client):
        return True
    if not artifact_version_id or not client.user_ref:
        return False
    user = await session.get(models.User, client.user_ref)
    if user is None or not user.is_active:
        return False

    decided = await session.scalar(
        select(am.ApprovalDecision.id)
        .join(am.ApprovalRequest,
              am.ApprovalRequest.id == am.ApprovalDecision.request_id)
        .where(am.ApprovalRequest.task_id == task.id,
               am.ApprovalRequest.artifact_version_id == artifact_version_id,
               am.ApprovalDecision.user_id == user.id)
        .limit(1)
    )
    if decided:
        return True

    requests = list((await session.execute(
        select(am.ApprovalRequest)
        .join(am.ApprovalAssignment,
              am.ApprovalAssignment.request_id == am.ApprovalRequest.id)
        .where(am.ApprovalRequest.task_id == task.id,
               am.ApprovalRequest.artifact_version_id == artifact_version_id,
               am.ApprovalAssignment.user_id == user.id)
        .order_by(am.ApprovalRequest.created_at.desc())
    )).scalars().unique().all())
    for request in requests:
        allowed, _ = await can_decide(session, task, request, user)
        if allowed:
            return True
    return False


async def reroute_pending_for_project(session: AsyncSession, project_id: str,
                                      actor: str = "SoduWork") -> dict:
    """Explicitly reissue undecided approvals after project responsibilities change. Preserve any
    countersignature snapshot with an existing decision and audit all reassignment.
    """
    task_ids = set((await session.execute(select(models.Task.id).where(
        models.Task.project_id == project_id
    ))).scalars().all())
    if not task_ids:
        return {"requests": 0, "assignments": 0, "skipped": 0}
    requests = list((await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.task_id.in_(task_ids),
        am.ApprovalRequest.status == "pending",
    ))).scalars().all())
    tasks = {row.id: row for row in (await session.execute(select(models.Task).where(
        models.Task.id.in_(task_ids)
    ))).scalars().all()}
    changed = assignments = skipped = 0
    for request in requests:
        decided = await session.scalar(select(am.ApprovalDecision.id).where(
            am.ApprovalDecision.request_id == request.id
        ).limit(1))
        if decided:
            skipped += 1
            continue
        await session.execute(delete(am.ApprovalAssignment).where(
            am.ApprovalAssignment.request_id == request.id
        ))
        rows = await ensure_assignments(session, tasks[request.task_id], request)
        assignments += len(rows)
        changed += 1
        session.add(models.TaskEvent(
            task_id=request.task_id, kind="release.approval_rerouted",
            detail={"requestId": request.id, "action": request.action,
                    "assignees": [row.user_id for row in rows]},
            actor=actor,
        ))
    await session.flush()
    return {"requests": changed, "assignments": assignments, "skipped": skipped}


async def materialize_pending(session: AsyncSession) -> None:
    requests = list((await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.status == "pending"
    ))).scalars().all())
    if not requests:
        return
    tasks = {t.id: t for t in (await session.execute(select(models.Task).where(
        models.Task.id.in_({x.task_id for x in requests})
    ))).scalars().all()}
    for request in requests:
        task = tasks.get(request.task_id)
        if task is not None:
            await ensure_assignments(session, task, request)
    await session.commit()
