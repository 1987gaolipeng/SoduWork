"""Repository issue participants: public requirements, single-device claiming and start outbox.

GitLab uses verified repository members; GitHub uses active company users.
Participation never grants execution access before claiming the requirement.
"""
from datetime import datetime, timezone

from sqlalchemy import and_, false, or_, select, update

from .. import automation_models, models  # noqa: F401 - register the catalog foreign-key target
from ..repository_issue_models import RepositoryIssueLink as Link, RepositoryIssueMember as Member, RepositoryIssueSync as Sync

ISSUE_ORIGINS = frozenset({"gitlab_issue", "github_issue"})


def member_user_ids(catalog_id):
    return select(Member.user_id).join(models.User, models.User.id == Member.user_id).where(
        Member.catalog_id == catalog_id, Member.active.is_(True), models.User.is_active.is_(True))


def _github_catalog_users():
    """Anchor company visibility to the catalog, never editable task sharing.

    Only organization nodes reachable from a real root participate. Missing or
    dangling organizations and rootless cycles cannot widen access.
    """
    org = models.OrgUnit
    tree = select(org.id.label("org_id"), org.id.label("company_id")).where(
        or_(org.parent_id.is_(None), org.parent_id == "")).cte(recursive=True)
    tree = tree.union_all(select(org.id, tree.c.company_id).join(tree, org.parent_id == tree.c.org_id))
    repository_org, user_org = tree.alias(), tree.alias()
    repo = automation_models.ScmRepository
    return select(repo.id.label("catalog_id"), models.User.id.label("user_id"),
        models.User.username, models.User.display_name).select_from(repo).join(
            repository_org, repository_org.c.org_id == repo.org_id).join(
            user_org, user_org.c.company_id == repository_org.c.company_id).join(
            models.User, models.User.org_id == user_org.c.org_id).where(
                repo.provider == "github", models.User.is_active.is_(True))


def github_user_ids(catalog_id):
    return _github_catalog_users().with_only_columns(models.User.id).where(
        automation_models.ScmRepository.id == catalog_id)


def visible_clause(client):
    uid = getattr(client, "user_ref", None)
    if not uid:
        return false()
    gitlab = models.Task.id.in_(select(Link.task_id).join(Member, Member.catalog_id == Link.catalog_id)
        .join(models.User, models.User.id == Member.user_id).where(
            Member.user_id == uid, Member.active.is_(True), models.User.is_active.is_(True)))
    github_catalogs = _github_catalog_users().with_only_columns(
        automation_models.ScmRepository.id).where(models.User.id == uid)
    github = models.Task.id.in_(select(Link.task_id).where(Link.catalog_id.in_(github_catalogs)))
    return or_(and_(models.Task.origin == "gitlab_issue", gitlab),
               and_(models.Task.origin == "github_issue", github))


def linked_clause():
    """Exclude repository requirements from broader team-pool visibility."""
    return select(Link.id).where(Link.task_id == models.Task.id).exists()


def claimable_clause():
    return and_(models.Task.owner_client_id.is_(None), models.Task.status == "todo",
                models.Task.archived_at.is_(None),
                models.Task.triage_stage.in_(("intake", "clarifying", "ready")))


def _claimable(task):
    return (task.owner_client_id is None and task.status == "todo" and not task.archived_at
            and (task.triage_stage or "ready") in {"intake", "clarifying", "ready"})


async def linked(session, tid):
    return bool(await session.scalar(select(Link.id).where(Link.task_id == tid)))


async def is_member(session, client, task):
    if getattr(task, "origin", None) not in ISSUE_ORIGINS:
        return False
    return bool(await session.scalar(select(models.Task.id).where(
        models.Task.id == task.id, visible_clause(client))))


async def projection(session, client, tasks):
    """Batch the source and membership projection once for each list response."""
    providers = {task.id: task.origin.removesuffix("_issue") for task in tasks
                 if getattr(task, "origin", None) in ISSUE_ORIGINS}
    ids = list(providers)
    if not ids:
        return {}
    out = {}
    uid = getattr(client, "user_ref", None)
    from ..schemas import _ms
    for offset in range(0, len(ids), 500):
        rows = list(await session.scalars(select(Link).where(Link.task_id.in_(ids[offset:offset + 500]))))
        catalogs = {row.catalog_id for row in rows if providers[row.task_id] == "gitlab"}
        github_catalogs = {row.catalog_id for row in rows if providers[row.task_id] == "github"}
        mine = set(await session.scalars(select(Member.catalog_id).join(models.User,
            models.User.id == Member.user_id).where(Member.catalog_id.in_(catalogs),
                Member.user_id == uid, Member.active.is_(True), models.User.is_active.is_(True)))) if uid and catalogs else set()
        related = {}
        if catalogs:
            members = (await session.execute(select(Member.catalog_id, models.User.id,
                models.User.username, models.User.display_name).join(models.User, models.User.id == Member.user_id)
                .where(Member.catalog_id.in_(catalogs), Member.active.is_(True), models.User.is_active.is_(True)))).all()
            for catalog, user_id, username, name in members:
                related.setdefault(catalog, {})[user_id] = {"id": user_id, "name": name or username}
        if github_catalogs:
            company_users = (await session.execute(_github_catalog_users().where(
                automation_models.ScmRepository.id.in_(github_catalogs)))).all()
            for catalog, user_id, username, name in company_users:
                related.setdefault(catalog, {})[user_id] = {"id": user_id, "name": name or username}
                if uid and user_id == uid:
                    mine.add(catalog)
        for row in rows:
            out[row.task_id] = {"member": row.catalog_id in mine, "source": {
                "catalogId": row.catalog_id, "provider": providers[row.task_id],
                "visibilityScope": "organization" if providers[row.task_id] == "github" else "repository",
                "issueIid": row.issue_iid, "url": row.issue_url,
                "startedAt": _ms(row.started_at), "writebackState": row.writeback_state,
                "relatedUsers": list(related.get(row.catalog_id, {}).values()),
            }}
    return out


async def decorate(session, client, task, api, *, prepared=None):
    data = (prepared if prepared is not None else await projection(session, client, [task])).get(task.id)
    if not data:
        return api
    api["repositoryIssue"] = data["source"]
    api["canClaim"] = bool(data["member"] and _claimable(task))
    if data["member"]:
        role = "organization_member" if data["source"]["provider"] == "github" else "repository_member"
        api["myRoles"] = list(dict.fromkeys(list(api.get("myRoles") or []) + [role]))
    return api


async def claim(session, client, tid):
    """Claim using both a row lock and a conditional update (including SQLite)."""
    uid = getattr(client, "user_ref", None)
    user = await session.get(models.User, uid) if uid else None
    if not user or not user.is_active or client.auth_state != "active" or client.revoked_at:
        return {"ok": False, "reason": "inactive"}
    task = await session.scalar(select(models.Task).where(models.Task.id == tid)
        .with_for_update().execution_options(populate_existing=True))
    if task is None or not await linked(session, tid):
        return {"ok": False, "reason": "not_found"}
    if not await is_member(session, client, task):
        return {"ok": False, "reason": "out_of_scope"}
    if task.owner_client_id is not None:
        return {"ok": False, "reason": "already_claimed"}
    if not _claimable(task):
        return {"ok": False, "reason": "not_claimable"}
    claimed = await session.execute(update(models.Task).where(models.Task.id == tid,
        claimable_clause(), visible_clause(client)).values(owner_client_id=client.id, owner_user_id=uid,
            assignee_user_id=uid, pool_org_id=None, triage_stage="ready")
        .returning(models.Task.id).execution_options(synchronize_session=False))
    # SQLite reports rowcount=-1 for WITH ... UPDATE; RETURNING also keeps the
    # conditional ownership result reliable on PostgreSQL.
    if claimed.scalar_one_or_none() is None:
        return {"ok": False, "reason": "already_claimed"}
    await session.refresh(task)
    from . import inbox
    api = await inbox._take(session, task, client.id, uid,
        event=("claim", {"source": "repository_issue"}, user.display_name or user.username), arrival="self")
    from . import task_access, task_requirements
    api = (await task_access.decorate_many(session, [task], [api], client))[0]
    api = await task_requirements.decorate(session, client, task, api)
    return {"ok": True, "task": api}


async def record_started(session, task):
    """First execution only; the worker sends it after this transaction commits.

    Disabling synchronization pauses delivery. Retain the first start and frozen
    label so reenabling can retry that same action without rewriting later states.
    """
    if getattr(task, "origin", None) not in ISSUE_ORIGINS:
        return False
    link = await session.scalar(select(Link).where(Link.task_id == task.id))
    if link is None or link.started_at is not None:
        return False
    config = await session.get(Sync, link.catalog_id)
    if config is None:
        return False
    now = datetime.now(timezone.utc)
    changed = await session.execute(update(Link).where(Link.id == link.id, Link.started_at.is_(None))
        .values(started_at=now, writeback_state="pending", writeback_label=config.started_label,
                next_retry_at=now, last_error="").execution_options(synchronize_session=False))
    await session.refresh(link)
    return changed.rowcount == 1
