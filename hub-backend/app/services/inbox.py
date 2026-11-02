"""Team inbox for unassigned tasks scoped by organization and optional responsibility domain.
Members claim work and may return it; defaults do not force assignment. Shared visibility,
claims, returns, and escalation support recovery from incorrect routing.
"""
from datetime import datetime, timezone
from types import SimpleNamespace

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..realtime import hub
from ..schemas import _ms, task_to_api
from . import rbac, repository_issue_access, task_assignment, task_events
from .team import _humanize


async def _ancestor_org_ids(session: AsyncSession, org_id: str) -> set[str]:
    """Return an organization and its ancestors up to the root, representing the member's
    organizational lineage.
    """
    rows = (await session.execute(select(models.OrgUnit.id, models.OrgUnit.parent_id))).all()
    parent = {oid: pid for oid, pid in rows}
    out, cur, guard = set(), org_id, 0
    while cur and cur not in out and guard < 100:
        out.add(cur)
        cur = parent.get(cur)
        guard += 1
    return out


async def scope_for_user(session: AsyncSession, me: models.User | None) -> set[str]:
    """Behavior and constraints for this operation."""
    if not (me and me.is_active and me.org_id):
        return set()
    ancestors = await _ancestor_org_ids(session, me.org_id)
    subtree = await rbac.subtree_org_ids(session, me.org_id) or set()
    return ancestors | subtree


async def _me_scope(session: AsyncSession, client: models.Client):
    """Return the device owner and inbox scope, or None and an empty set for an unowned device."""
    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    return me, await scope_for_user(session, me)


def _pool_clauses(org_ids: set[str], client=None):
    from . import repository_issue_access
    clauses = []
    if org_ids:
        clauses.append(and_(
            models.Task.owner_client_id.is_(None),
            models.Task.pool_org_id.in_(org_ids),
            models.Task.status.in_(("todo", "doing")),
            ~repository_issue_access.linked_clause(),
        ))
    if client is not None and getattr(client, "user_ref", None):
        clauses.append(and_(repository_issue_access.visible_clause(client),
                            repository_issue_access.claimable_clause()))
    return clauses


def _inbox_clause(scope: set[str], client):
    """Repository membership never inherits the broader organization inbox scope."""
    team = and_(models.Task.owner_client_id.is_(None),
                models.Task.pool_org_id.in_(scope),
                models.Task.status.in_(("todo", "doing")),
                ~repository_issue_access.linked_clause())
    repository = and_(repository_issue_access.claimable_clause(),
                      repository_issue_access.visible_clause(client))
    return or_(team, repository)


async def inbox_count(session: AsyncSession, client: models.Client) -> int:
    me, scope = await _me_scope(session, client)
    if not me or not me.is_active:
        return 0
    # The badge needs only a scalar; never fetch/sort full task payloads here.
    return int(await session.scalar(select(func.count()).select_from(models.Task).where(
        _inbox_clause(scope, client),
    )) or 0)


async def _enrich(session: AsyncSession, rows, client=None) -> list[dict]:
    """Serialize inbox tasks with domain, organization, priority, creator, and waiting duration."""
    # Resolve domain and organization display names.
    dom_ids = {t.domain_id for t in rows if t.domain_id}
    dom_names: dict[str, str] = {}
    if dom_ids:
        dr = await session.execute(select(models.Domain).where(models.Domain.id.in_(dom_ids)))
        dom_names = {d.id: d.name for d in dr.scalars().all()}
    org_ids = {t.pool_org_id for t in rows if t.pool_org_id}
    org_names: dict[str, str] = {}
    if org_ids:
        orr = await session.execute(select(models.OrgUnit).where(models.OrgUnit.id.in_(org_ids)))
        org_names = {o.id: o.name for o in orr.scalars().all()}
    projected = {}
    repository_rows = [task for task in rows if task.origin in {"gitlab_issue", "github_issue"}]
    if client is not None and repository_rows:
        from . import task_access, task_requirements
        apis = await task_access.decorate_many(
            session, repository_rows, [task_to_api(task) for task in repository_rows], client)
        apis = await task_requirements.decorate_many(session, client, repository_rows, apis)
        projected = {task.id: api for task, api in zip(repository_rows, apis)
                     if api.get("repositoryIssue")}
    now = datetime.now(timezone.utc)
    items = []
    for t in rows:
        item = projected.get(t.id, {
            "id": t.id, "title": t.title, "note": t.note,
            "priority": getattr(t, "priority", None) or "normal",
            "start": _ms(getattr(t, "start_at", None)),
            "due": _ms(getattr(t, "due_at", None)),
            "tags": list(getattr(t, "tags", None) or []),
            "urgent": t.urgent, "important": t.important,
            "domainId": t.domain_id or "", "domainName": dom_names.get(t.domain_id, ""),
            "teamId": t.pool_org_id, "teamName": org_names.get(t.pool_org_id, ""),
        })
        item.update({
            "domainId": t.domain_id or "", "domainName": dom_names.get(t.domain_id, ""),
            "teamId": t.pool_org_id, "teamName": org_names.get(t.pool_org_id, ""),
            "createdByName": getattr(t, "created_by_name", None) or "",
            "source": t.source,
            "waiting": _humanize(t.created_at, now),
        })
        items.append(item)
    return items


async def list_for_user(session: AsyncSession, me: models.User | None, client=None) -> dict:
    """List a user's inbox tasks using shared desktop and administration rules."""
    scope = await scope_for_user(session, me)
    actor = client or (SimpleNamespace(id="", user_ref=me.id, auth_state="active", revoked_at=None)
                       if me and me.is_active else None)
    rows = await _pool_query(session, scope, actor)
    items = await _enrich(session, rows, actor)
    org_name = ""
    if me and me.org_id:
        og = await session.get(models.OrgUnit, me.org_id)
        org_name = og.name if og else ""
    return {"assigned": bool(me and me.org_id), "orgName": org_name, "count": len(items), "items": items}


async def list_inbox(session: AsyncSession, client: models.Client) -> dict:
    """List claimable tasks in the team's authorized inbox scope."""
    me, _scope = await _me_scope(session, client)
    return await list_for_user(session, me, client)


async def list_for_orgs(session: AsyncSession, org_ids: set[str] | None) -> dict:
    """List administration inbox tasks in scope; org_ids=None grants unrestricted
    super-administrator scope.
    """
    if org_ids is None:
        res = await session.execute(
            select(models.Task).where(
                models.Task.owner_client_id.is_(None),
                models.Task.pool_org_id.isnot(None),
                models.Task.status.in_(("todo", "doing")),
                ~repository_issue_access.linked_clause(),
            ).order_by(models.Task.created_at.desc())
        )
        rows = list(res.scalars().all())
    else:
        rows = await _pool_query(session, org_ids)
    items = await _enrich(session, rows)
    return {"count": len(items), "items": items}


async def pick_box(session: AsyncSession, user_id: str, *,
                   project_id: str | None = None) -> models.Client | None:
    """Compatibility entry point; task_assignment owns device selection."""
    return await task_assignment.pick_device(session, user_id, project_id=project_id)


async def _take(session: AsyncSession, t: models.Task, box_id: str, user_id: str,
                event: tuple | None = None, arrival: str = "", by: str = "", actor_id: str = "") -> dict:
    """Assign a pool task to a client, remove it from the inbox, record history, and push it.
    arrival distinguishes a self-claim from an external assignment for notification behavior.
    """
    t.owner_client_id = box_id
    t.owner_user_id = user_id
    t.assignee_user_id = user_id
    t.pool_org_id = None       # Remove the task from the inbox.
    if t.status not in ("todo", "doing"):
        from . import task_status
        await task_status.mark(session, t, "todo", why="收件箱认领/分配")
    assignment_notice = None
    if event and arrival == "assign":
        from . import task_assignment_notifications
        assignment_notice = await task_assignment_notifications.transition(session, t, actor_id, *event)
    elif event:                  # Record the actor and assignment details on the task timeline.
        task_events.record(session, t.id, event[0], event[1], event[2])
    await session.commit()
    await session.refresh(t)
    api = task_to_api(t)
    if arrival:
        api["arrival"] = arrival
    if by:
        api["by"] = by
    from . import task_access
    await task_access.publish_task(session, t, "task.created", api,
                                   arrival=arrival, by=by,
                                   notification_id=assignment_notice.id if assignment_notice else "")
    if assignment_notice is not None:
        await task_assignment_notifications.publish(session, assignment_notice)
    return api


async def _notify_user(session: AsyncSession, user_id: str | None, text: str) -> None:
    """Push a notice to the user's devices; silently skip users without an eligible device."""
    if not user_id:
        return
    box = await pick_box(session, user_id)
    if box:
        await hub.publish(box.id, {"type": "notice", "text": text}, user_id=user_id)


async def _claim_to(session: AsyncSession, me: models.User, box_id: str,
                    scope: set[str], tid: str) -> dict:
    # Lock the task row because claiming is an exclusive operation.
    # Without a lock, concurrent users could both observe an unowned task.
    # The second PostgreSQL claimant waits, then detects ownership and receives a conflict.
    t = (await session.execute(
        select(models.Task).where(models.Task.id == tid).with_for_update()
        .execution_options(populate_existing=True)
    )).scalar_one_or_none()
    if t is None:
        return {"ok": False, "reason": "not_found"}
    if await repository_issue_access.linked(session, tid):
        return {"ok": False, "reason": "out_of_scope"}
    if t.owner_client_id is not None:
        return {"ok": False, "reason": "already_claimed"}   # Reject tasks already claimed or assigned.
    if not t.pool_org_id or t.pool_org_id not in scope:
        return {"ok": False, "reason": "out_of_scope"}
    who = me.display_name or me.username or ""
    # Avoid repeating the claimant in detail when the event actor already identifies them.
    # arrival=self avoids unnecessary notification noise for a user's own claim.
    api = await _take(session, t, box_id, me.id, event=("claim", {}, who), arrival="self")
    # Notify the person who placed the task in the pool when it is claimed.
    if t.created_by and t.created_by != me.id:
        await _notify_user(session, t.created_by, f"📥 {who} 认领了你派的「{t.title}」")
    return {"ok": True, "task": api}


async def claim(session: AsyncSession, client: models.Client, tid: str) -> dict:
    """Claim an in-scope, still-unowned inbox task for the user's client, preventing competing
    claims.
    """
    if await repository_issue_access.linked(session, tid):
        return await repository_issue_access.claim(session, client, tid)
    me, scope = await _me_scope(session, client)
    if not me or not me.is_active:
        return {"ok": False, "reason": "unassigned"}
    return await _claim_to(session, me, client.id, scope, tid)


async def claim_for_user(session: AsyncSession, me: models.User, tid: str) -> dict:
    """Allow a signed-in administration user to claim work for their client without an open desktop
    application.
    """
    if not (me and me.is_active):
        return {"ok": False, "reason": "unassigned"}
    repository = await repository_issue_access.linked(session, tid)
    if not repository and not me.org_id:
        return {"ok": False, "reason": "unassigned"}
    box = await pick_box(session, me.id)
    if box is None:
        return {"ok": False, "reason": "no_box"}
    if repository:
        return await repository_issue_access.claim(session, box, tid)
    return await _claim_to(session, me, box.id, await scope_for_user(session, me), tid)


async def assign_to_user(session: AsyncSession, tid: str, target: models.User,
                         actor_scope: set[str], actor_name: str = "",
                         actor_id: str | None = None) -> dict:
    """Assign an inbox task to an employee. actor_scope limits source inboxes; the caller validates
    authority over the target employee.
    """
    if not target.is_active:
        return {"ok": False, "reason": "inactive"}
    if await repository_issue_access.linked(session, tid):
        return {"ok": False, "reason": "out_of_scope"}
    t = await session.get(models.Task, tid)
    if t is None:
        return {"ok": False, "reason": "not_found"}
    if t.owner_client_id is not None:
        return {"ok": False, "reason": "already_claimed"}
    if not t.pool_org_id:
        return {"ok": False, "reason": "not_in_inbox"}
    if t.pool_org_id not in actor_scope:
        return {"ok": False, "reason": "out_of_scope"}
    box = await pick_box(session, target.id, project_id=t.project_id)
    if box is None:
        return {"ok": False, "reason": "no_box"}
    to = target.display_name or target.username or ""
    # Include the assigning actor so the recipient knows who assigned the task.
    api = await _take(session, t, box.id, target.id,
                      event=("assign", {"to": to}, actor_name or ""),
                      arrival="assign", by=actor_name or "", actor_id=actor_id or "")
    # Notify the pool-task creator too when another manager makes the assignment.
    if t.created_by and t.created_by not in (target.id, actor_id):
        await _notify_user(session, t.created_by, f"📤 {actor_name} 把你派的「{t.title}」分给了 {to}")
    return {"ok": True, "task": api, "boxId": box.id}


async def release(session: AsyncSession, client: models.Client, tid: str, note: str = "") -> dict:
    """Return an owned task to its team inbox for another claimant. Workflow tasks use their own
    return-to-previous-step semantics.
    """
    me, _scope = await _me_scope(session, client)
    from . import repository_issue_access, task_access
    await task_access.reserve_task_write(session, tid, client.id)
    t = await session.get(models.Task, tid, with_for_update=True, populate_existing=True)
    if t is None:
        return {"ok": False, "reason": "not_found"}
    repository_issue = await repository_issue_access.linked(session, tid)
    if not task_access.is_owner(t, client):
        return {"ok": False, "reason": "not_owner"}
    if t.status == "done":
        return {"ok": False, "reason": "already_done"}   # Completed tasks cannot be returned to the claim pool.
    target_org = None if repository_issue else (me.org_id if (me and me.org_id) else None)
    if not repository_issue and not target_org:
        return {"ok": False, "reason": "unassigned"}   # A device without organizational ownership has no team inbox destination.
    from fastapi import HTTPException
    from . import task_maintenance, task_status
    if await task_maintenance.blocked_reasons(session, [t]):
        raise HTTPException(409, "需求仍在执行、准备或等待中，请先停止执行，再退回需求池")
    # A rejected state transition must leave the execution owner intact.
    if not await task_status.mark(session, t, "todo", why="退回需求池", refresh_memory=False):
        raise HTTPException(409, "需求状态暂不允许退回需求池，请刷新后重试")
    t.owner_client_id = None
    t.owner_user_id = None
    t.pool_org_id = target_org
    t.assignee_user_id = None
    if repository_issue:
        who = (me.display_name or me.username) if me else ""
        task_events.record(session, t.id, "release", {"note": note or "", "source": "repository_issue"}, who)
        await session.commit()
        await session.refresh(t)
        await hub.publish(client.id, {"type": "task.deleted", "id": tid},
                          user_id=client.user_ref or "")
        await task_access.publish_task(session, t, "task.updated")
        return {"ok": True, "id": tid, "teamId": None}
    from . import task_requirements
    await task_requirements.refresh_memory(session, t)
    # Record the return as a timeline event, not human progress used in work reports.
    who = (me.display_name or me.username) if me else ""
    task_events.record(session, t.id, "release", {"note": note or ""}, who)
    await session.commit()
    await hub.publish(client.id, {"type": "task.deleted", "id": tid},
                      user_id=client.user_ref or "")   # Remove the task from the current client and restore it to the team pool.
    # Notify the assigning person so they can clarify or reassign returned work.
    if t.created_by and me and t.created_by != me.id:
        await _notify_user(session, t.created_by,
                           f"⤺ {who} 把「{t.title}」退回了收件箱" + (f"：{note}" if note else ""))
    return {"ok": True, "id": tid, "teamId": target_org}


async def create_pool_task(session: AsyncSession, org_id: str, data: dict, creator: tuple | None) -> dict:
    """Create an unassigned inbox task with pool_org_id and dispatch origin, using supplied domain
    and priority fields.
    """
    from .tasks import apply_detail

    cid, cname = creator if creator else (None, "")
    from . import work_catalog
    creator_user = await session.get(models.User, cid) if cid else None
    data = await work_catalog.enrich_task_data(
        session, None, data, org_id=org_id,
        position_ids=(creator_user.positions or []) if creator_user else [],
    )
    t = models.Task(
        owner_client_id=None,
        pool_org_id=org_id,
        title=(data.get("title") or "未命名"),
        note=data.get("note") or "",
        source=data.get("source") or "团队收件箱",
        status="todo",
        urgent=data.get("urgent"),
        important=data.get("important"),
        origin="dispatch",
    )
    apply_detail(t, data)
    t.created_by, t.created_by_name = cid, cname
    # Default the requester to the person dispatching into the pool, matching task creation.
    # Completion receipts then return to that requester.
    from .tasks import default_requester
    default_requester(t, cid, cname)
    session.add(t)
    await session.flush()      # Obtain the task ID before attaching events.
    task_events.record(session, t.id, "created", {"source": t.source, "pool": True}, cname)
    await session.commit()
    await session.refresh(t)
    return {"ok": True, "task": task_to_api(t)}


async def _pool_query(session: AsyncSession, org_ids: set[str], client=None):
    clauses = _pool_clauses(org_ids, client)
    if not clauses:
        return []
    res = await session.execute(
        select(models.Task).where(or_(*clauses)).order_by(models.Task.created_at.desc())
    )
    return list(res.scalars().all())
