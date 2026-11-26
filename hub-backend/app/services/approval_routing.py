"""Resolve configurable approval policies into explicit, auditable user-assignment snapshots."""
from __future__ import annotations

from sqlalchemy import and_, delete, inspect as sa_inspect, select
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

    if kind not in {"role", "position", "permission"}:
        return []
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


def _human_producer(artifact):
    if artifact is not None and artifact.created_by_kind == "user":
        return artifact.created_by_id
    return None


async def _implementer_ids(session: AsyncSession, task: models.Task,
                           artifact: am.ArtifactVersion | None) -> set[str]:
    """Identify users who actually produced the artifact. AI-task owners normally remain eligible
    reviewers; treat a user as implementer only with explicit human provenance or a legacy
    manual task without AI evidence.
    """
    out: set[str] = set()
    producer = _human_producer(artifact)
    if producer:
        out.add(producer)
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
    if action == "review":
        return await _review_candidates(session, task, rules, artifact)
    excluded = await _implementer_ids(session, task, artifact) if rules.get("separationOfDuties") else set()
    candidates = await _selected_candidates(session, task, effective_selectors(action, rules),
                                            await _task_org_id(session, task), excluded)
    return candidates, excluded


def _review_excluded(task, artifact):
    """Fallback responsibility must be independent of the current executor and human producer."""
    return {task.assignee_user_id or task.owner_user_id, _human_producer(artifact)} - {None, ""}


async def _review_org(session, task):
    org = await _task_org_id(session, task) or task.shared_org_id
    if not org and task.created_by:
        creator = await session.get(models.User, task.created_by)
        org = creator.org_id if creator else None
    return org


async def _in_review_scope(session, user, org):
    # An account with no organization cannot designate arbitrary members of other organizations.
    return await _in_scope(session, user, org) if org else bool(user.is_super or not user.org_id)


async def can_designate_reviewer(session, task, user):
    from . import release_control
    if user is None or not user.is_active:
        return False
    artifact = await release_control.latest_artifact(session, task.id)
    org = await _review_org(session, task)
    return user.id not in _review_excluded(task, artifact) and await _in_review_scope(session, user, org)


async def _review_candidates(session, task, rules, artifact):
    excluded = _review_excluded(task, artifact)
    designated = task.review_recipient_user_id
    creator = task.created_by
    if not designated and creator:
        user = await session.get(models.User, creator)
        # In a single-account AI workflow the human creator can accept AI output.
        if user is not None and user.is_active and _human_producer(artifact) != creator:
            return {creator: {"user": user, "sources": _DEFAULT_SELECTORS["review"]}}, set()
    org = await _review_org(session, task)
    if designated:
        user = await session.get(models.User, designated)
        if user and user.is_active and designated not in excluded and await _in_review_scope(session, user, org):
            return {designated: {"user": user, "sources": [{"type": "designated_reviewer", "label": "指定验收人"}]}}, excluded
        return {}, excluded
    tiers = [
        [{"type": "requester", "label": "需求提出人"}],
        [{"type": "project_owner", "label": "项目负责人"}],
        [s for s in effective_selectors("review", rules)
         if s.get("type") not in {"requester", "project_owner", "task_creator", "task_assignee", "owner_client"}],
    ]
    required = max(1, int(rules.get("required") or 1))
    candidates = {}
    for selectors in tiers:
        tier = await _selected_candidates(session, task, selectors, org, excluded, review=True)
        for uid, item in tier.items():
            candidates.setdefault(uid, item)
        if len(candidates) >= required:
            break
    return candidates, excluded


async def _selected_candidates(session, task, selectors, task_org_id, excluded, *, review=False):
    candidates: dict[str, dict] = {}
    for selector in selectors:
        label = str(selector.get("label") or "流程指定审批人")
        for user in await _selector_users(session, task, selector, task_org_id):
            if str(user.id) in excluded or (review and not await _in_review_scope(session, user, task_org_id)):
                continue
            item = candidates.setdefault(user.id, {"user": user, "sources": []})
            source = {"type": str(selector.get("type") or ""), "label": label}
            source_id = selector.get("id") or selector.get("key")
            if source_id:
                source["id"] = str(source_id)
            if source not in item["sources"]:
                item["sources"].append(source)
    return candidates


async def review_block_reason(session, task, required, available):
    if task.review_recipient_user_id:
        user = await session.get(models.User, task.review_recipient_user_id)
        if user is None:
            why = "指定的验收人账号不存在"
        else:
            name = user.display_name or user.username
            if not user.is_active:
                why = f"指定的验收人「{name}」已停用"
            elif not available:
                why = f"指定的验收人「{name}」不符合本次验收的组织范围或职责分离要求"
            else:
                why = f"验收策略要求 {required} 人会签，目前仅指定了「{name}」"
    elif not task.created_by:
        why = "本条需求未记录创建人"
    else:
        creator = await session.get(models.User, task.created_by)
        name = (creator.display_name or creator.username) if creator else task.created_by_name or task.created_by
        if creator is None:
            why = f"需求创建人「{name}」的账号不存在"
        elif not creator.is_active:
            why = f"需求创建人「{name}」的账号已停用"
        elif not available:
            why = f"需求创建人「{name}」不能验收自己的产出"
        else:
            why = f"验收策略要求 {required} 人会签，当前只有 {available} 名合适的验收人"
    return why + "。请联系有权查看本需求的管理员指定验收人，或请管理员调整验收策略。"


class ReviewAssignmentUnavailable(ValueError):
    """No eligible set of reviewers can accept this delivery."""


async def preview_assignments(session: AsyncSession, task: models.Task, action: str,
                              rules: dict | None, *, artifact: am.ArtifactVersion | None = None) -> dict:
    """Resolve a policy without creating a request, assignment, event or notification."""
    normalized = dict(rules or {})
    required = max(1, int(normalized.get("required") or 1))
    candidates, excluded = await _candidate_map(
        session, task, action, normalized, artifact)
    people = [{"userId": uid,
               "userName": item["user"].display_name or item["user"].username,
               "reasons": list(item["sources"])}
              for uid, item in candidates.items()]
    preview = {"action": action, "required": required, "available": len(people),
               "ok": len(people) >= required, "candidates": people, "excluded": sorted(excluded)}
    if action == "review":
        preview["reason"] = "" if preview["ok"] else await review_block_reason(session, task, required, len(people))
    return preview


async def _clear_restored_review_issue(session: AsyncSession, task: models.Task,
                                     request: am.ApprovalRequest,
                                     artifact: am.ArtifactVersion | None) -> None:
    current = (task.work_routing or {}).get("conversationTurn") or {}
    if (current.get("deliveryIssue") or {}).get("code") != "review_unassigned":
        return
    # Assignment reconciliation also runs on read paths. Refresh under the task
    # lock before replacing routing so a stale reader cannot undo a newer turn.
    # Normal autoflush retains this transaction's admitted routing changes.
    task = await session.scalar(select(models.Task).where(models.Task.id == task.id)
        .with_for_update().execution_options(populate_existing=True))
    if task is None:
        return
    routing = dict(task.work_routing or {})
    current = dict(routing.get("conversationTurn") or {})
    issue = current.get("deliveryIssue") or {}
    if (issue.get("code") != "review_unassigned"
            or issue.get("artifactVersionId") != request.artifact_version_id
            or not current.get("conversationId") or artifact is None
            or request.task_id != task.id or artifact.task_id != task.id
            or artifact.source_ref != "conversation:" + current["conversationId"]):
        return
    current.pop("deliveryIssue", None)
    routing["conversationTurn"] = current
    task.work_routing = routing


class ApprovalRerouteConflict(ValueError):
    """Replacing the assignments would leave an approval without its quorum."""


def unassigned_review(request_id, task_id):
    """An automatic submission recorded as blocked before anyone received or voted on it."""
    return and_(
        ~select(am.ApprovalAssignment.id).where(am.ApprovalAssignment.request_id == request_id).exists(),
        select(models.TaskEvent.id).where(models.TaskEvent.task_id == task_id,
            models.TaskEvent.kind == "approval.unassigned",
            models.TaskEvent.detail["requestId"].as_string() == request_id).exists(),
        ~select(am.ApprovalDecision.id).where(am.ApprovalDecision.request_id == request_id).exists(),
    )


async def _eligible_snapshot(session, task, artifact, existing):
    active = {user.id for user in await _active_users(session, {row.user_id for row in existing})}
    excluded = _review_excluded(task, artifact)
    producer = _human_producer(artifact)
    eligible = []
    for row in existing:
        if row.user_id not in active or row.user_id == producer:
            continue
        creator = row.user_id == task.created_by and any(
            source.get("type") == "task_creator" for source in row.sources or [])
        if creator or row.user_id not in excluded:
            eligible.append(row)
    return eligible


async def ensure_assignments(session: AsyncSession, task: models.Task,
                             request: am.ApprovalRequest, *,
                             replace: bool = False) -> list[am.ApprovalAssignment]:
    existing = list((await session.execute(select(am.ApprovalAssignment).where(
        am.ApprovalAssignment.request_id == request.id
    ).order_by(am.ApprovalAssignment.created_at))).scalars().all())
    pending_review = request.action == "review" and request.status == "pending"
    rules = dict(request.policy_snapshot or {})
    if request.action == "review" and not pending_review and rules.get("reviewRoutingVersion") != 2:
        # Closed legacy gates never granted anyone except their original creator review rights.
        return [row for row in existing if row.user_id == task.created_by]
    if existing and not replace and rules.get("reviewRoutingVersion") == 2 and request.action == "review":
        artifact = await session.get(am.ArtifactVersion, request.artifact_version_id)
        eligible = await _eligible_snapshot(session, task, artifact, existing)
        if not pending_review:
            return eligible
        if len(eligible) >= request.required_count:
            await _clear_restored_review_issue(session, task, request, artifact)
            return eligible
        if await session.scalar(select(am.ApprovalDecision.id).where(
                am.ApprovalDecision.request_id == request.id).limit(1)):
            return eligible
    if existing and not replace and not pending_review:
        if not rules.get("separationOfDuties"):
            return existing
        artifact = await session.get(am.ArtifactVersion, request.artifact_version_id)
        excluded = await _implementer_ids(session, task, artifact)
        return [row for row in existing if str(row.user_id) not in excluded]

    artifact = await session.get(am.ArtifactVersion, request.artifact_version_id)
    candidates, excluded = await _candidate_map(
        session, task, request.action, rules, artifact)
    if replace and len(candidates) < request.required_count:
        raise ApprovalRerouteConflict(
            f"无法更换项目负责人：任务「{task.title}」的审批需要 {request.required_count} 人，"
            f"但当前只能分配给 {len(candidates)} 人；请先处理该审批单")
    if existing:
        # Upgrade legacy review assignments before trusting them as a routing snapshot.
        if not replace and {str(row.user_id) for row in existing} == set(candidates):
            if pending_review:
                for row in existing:
                    row.sources = candidates[row.user_id]["sources"]
                request.policy_snapshot = {**rules, "reviewRoutingVersion": 2}
            await _clear_restored_review_issue(session, task, request, artifact)
            return existing
        await session.execute(delete(am.ApprovalAssignment).where(
            am.ApprovalAssignment.request_id == request.id))

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
    elif pending_review:
        request.policy_snapshot = {**rules, "reviewRoutingVersion": 2}
        await _clear_restored_review_issue(session, task, request, artifact)
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
    rules = dict(request.policy_snapshot or {})
    if request.action != "review" and rules.get("separationOfDuties"):
        artifact = await session.get(am.ArtifactVersion, request.artifact_version_id)
        implementers = await _implementer_ids(session, task, artifact)
        if uid in implementers:
            return False, "这项交付要求职责分离，需求执行负责人不能审阅或批准自己的产出"
    assignments = await ensure_assignments(session, task, request)
    assigned = next((x for x in assignments if x.user_id == uid), None)
    if assigned is None:
        if request.action == "review":
            return False, "本次验收未分配给你，请由需求创建人或本次指定的验收人处理"
        return False, "这项审批没有分配给你；请由流程指定的负责人处理"
    return True, ""


async def preview_can_decide(session: AsyncSession, task: models.Task,
                             request: am.ApprovalRequest, actor,
                             artifact: am.ArtifactVersion) -> bool:
    """Check approval eligibility without creating assignments or sending notifications when
    opening a review panel.
    """
    uid = actor_id(actor)
    rules = dict(request.policy_snapshot or {})
    if request.action == "review":
        if rules.get("reviewRoutingVersion") == 2:
            rows = list(await session.scalars(select(am.ApprovalAssignment).where(
                am.ApprovalAssignment.request_id == request.id)))
            eligible = await _eligible_snapshot(session, task, artifact, rows)
            return any(row.user_id == uid for row in eligible)
        if request.status and request.status != "pending":
            return uid == task.created_by and bool(await assignment_for_user(session, request.id, uid))
        candidates, _ = await _candidate_map(session, task, "review", rules, artifact)
        return uid in candidates
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
    if requests:
        artifact = await session.get(am.ArtifactVersion, artifact_version_id)
        if artifact is not None and artifact.task_id == task.id:
            for request in requests:
                if await preview_can_decide(session, task, request, user, artifact):
                    return True
    return False


async def reroute_pending_for_project(session: AsyncSession, project_id: str,
                                      actor: str = "SoduWork") -> dict:
    """Explicitly reissue undecided approvals after project responsibilities change. Preserve any
    countersignature snapshot with an existing decision and audit all reassignment.
    """
    # Decisions take the task lock first. Wait for in-flight votes before
    # deciding which assignment snapshots can still be replaced.
    pending_tasks = select(am.ApprovalRequest.task_id).where(am.ApprovalRequest.status == "pending")
    task_rows = (await session.scalars(select(models.Task).where(
        models.Task.project_id == project_id, models.Task.id.in_(pending_tasks)
    ).order_by(models.Task.id).with_for_update())).all()
    tasks = {row.id: row for row in task_rows}
    if not tasks:
        return {"requests": 0, "assignments": 0, "skipped": 0}
    requests = list((await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.task_id.in_(tasks),
        am.ApprovalRequest.status == "pending",
    ))).scalars().all())
    changed = assignments = skipped = 0
    for request in requests:
        decided = await session.scalar(select(am.ApprovalDecision.id).where(
            am.ApprovalDecision.request_id == request.id
        ).limit(1))
        if decided:
            skipped += 1
            continue
        rows = await ensure_assignments(session, tasks[request.task_id], request, replace=True)
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
