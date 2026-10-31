"""Device-side team overview scoped through the device owner's organization subtree. Aggregate
workload, recent completions, state, sources, devices, and appearance metadata. Unbound devices
see only their own tasks with assigned=False.
"""
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..config import get_settings
from ..schemas import _ms, task_to_api
from . import rbac, task_assignment

# Cycle member avatar colors, reserving the self color.
_PALETTE = ["#4f8ff5", "#1ec79b", "#ff9f2e", "#ef5f92", "#7c6cf0", "#12b5c9", "#f0973f"]
_ME_COLOR = "#7c6cf0"
_WEEKDAY = "一二三四五六日"  # weekday()=0(Mon)..6(Sun)

# Permissions that confer team-management capability.
_MANAGE_PERMS = {"task.dispatch", "user.manage"}

# Map character identifiers to display names.
_SKIN_NAMES = {"bear": "玻璃球", "box": "五彩盒子", "diamond": "钻石盒子"}
# Source icons and colors.
_SRC_ICON = {"gitlab": "GL", "ticket": "单", "generic": "源"}
_SRC_COLOR = {"gitlab": "#fc6d26", "ticket": "#ef5f92", "generic": "#4f8ff5"}


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _humanize(dt: datetime | None, now: datetime) -> str:
    dt = _aware(dt)
    if dt is None:
        return "—"
    sec = (now - dt).total_seconds()
    if sec < 60:
        return "刚刚"
    if sec < 3600:
        return f"{int(sec // 60)} 分钟前"
    if sec < 86400:
        return f"{int(sec // 3600)} 小时前"
    return f"{int(sec // 86400)} 天前"


def _online(dt: datetime | None, now: datetime, offline_after: int) -> bool:
    dt = _aware(dt)
    return dt is not None and (now - dt).total_seconds() <= offline_after


async def _can_manage(session: AsyncSession, user) -> bool:
    """Check whether the user can manage the team through assignment or subordinate-management
    permissions.
    """
    if user is None or not user.is_active:
        return False
    if user.is_super:
        return True
    if not user.role_id:
        return False
    role = await session.get(models.Role, user.role_id)
    if role is None:
        return False
    return bool(set(role.permissions or []) & _MANAGE_PERMS)


async def direct_leaders(session: AsyncSession, user_id: str | None) -> list[str]:
    """Find other managers in the user's department, otherwise the nearest ancestor department with
    managers. Stop at that level instead of notifying every ancestor.
    """
    if not user_id:
        return []
    u = await session.get(models.User, user_id)
    if not (u and u.org_id):
        return []
    org_id = u.org_id
    for _ in range(10):                       # Guard against organization cycles.
        rows = (await session.execute(
            select(models.User).where(models.User.org_id == org_id, models.User.is_active.is_(True))
        )).scalars().all()
        leads = []
        for x in rows:
            if x.id != user_id and await _can_manage(session, x):
                leads.append(x.id)
        if leads:
            return leads
        org = await session.get(models.OrgUnit, org_id)
        org_id = org.parent_id if org else None
        if not org_id:
            break
    return []


async def team_capability(session: AsyncSession, client: models.Client) -> dict:
    """Check team-module availability without loading full workload data."""
    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if me is not None and not me.is_active:
        me = None
    org_name = ""
    if me and me.org_id:
        org = await session.get(models.OrgUnit, me.org_id)
        org_name = org.name if org else ""
    from . import inbox as inbox_svc   # Defer the import to avoid the inbox/team dependency cycle.
    inbox_n = await inbox_svc.inbox_count(session, client)
    can_manage = await _can_manage(session, me)
    return {
        "assigned": bool(me and me.org_id),
        "canManage": can_manage,
        "orgName": org_name,
        "meName": (me.display_name or me.username) if me else "",
        "meId": me.id if me else None,
        "inboxCount": inbox_n,   # Count unclaimed inbox items so the rail can expose the team entry to regular members.


        "teamModuleVisible": can_manage or (await team_module_scope(session)) == "everyone",
    }


async def team_module_scope(session: AsyncSession) -> str:
    """Read team-module visibility: managers by default, or everyone."""
    row = await session.get(models.AppSetting, "team_module_scope")
    value = str((row.value if row else "") or "").strip().lower()
    return "everyone" if value == "everyone" else "managers"


async def set_team_module_scope(session: AsyncSession, scope: str) -> str:
    value = "everyone" if str(scope or "").strip().lower() == "everyone" else "managers"
    row = await session.get(models.AppSetting, "team_module_scope")
    if row is None:
        row = models.AppSetting(key="team_module_scope", value=value)
        session.add(row)
    else:
        row.value = value
    await session.commit()
    return value


def _blank_counts() -> dict:
    return {"doing": 0, "todo": 0, "done": 0, "cancel": 0, "stuck": 0}


async def _team_members(session: AsyncSession, me):
    """Return subtree members with self first and maps of colors and display names."""
    if not (me and me.is_active and me.org_id):
        return [], {}, {}
    scope = await rbac.subtree_org_ids(session, me.org_id)
    res = await session.execute(select(models.User).where(
        models.User.org_id.in_(scope or {"__none__"}),
        models.User.is_active.is_(True),
    ))
    members_u = list(res.scalars().all())
    members_u.sort(key=lambda u: (u.id != me.id, u.display_name or u.username))
    color_by, name_by = {}, {}
    for idx, u in enumerate(members_u):
        color_by[u.id] = _ME_COLOR if u.id == me.id else _PALETTE[idx % len(_PALETTE)]
        name_by[u.id] = u.display_name or u.username
    return members_u, color_by, name_by


async def _company_members(session: AsyncSession, me) -> list:
    """Return the active organization-bound collaboration directory with self first. Team boards
    remain scoped, while authorized interpersonal handoffs and mentions use the organization
    directory.
    """
    if not (me and me.is_active):
        return []
    res = await session.execute(select(models.User).where(
        models.User.is_active.is_(True),
        models.User.org_id.is_not(None),
    ))
    members = list(res.scalars().all())
    members.sort(key=lambda u: (
        u.id != me.id, str(u.org_id or ""), u.display_name or u.username,
    ))
    return members


async def team_tasks(session: AsyncSession, client: models.Client) -> dict:
    """List team-subtree tasks with assignee metadata for managers and administrators."""
    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    can = await _can_manage(session, me)
    if not can:
        return {"canManage": False, "tasks": [], "members": []}
    members_u, color_by, name_by = await _team_members(session, me)
    member_ids = {u.id for u in members_u}
    # Map members to clients.
    all_clients = list((await session.execute(select(models.Client))).scalars().all())
    user_by_box = {c.id: c.user_ref for c in all_clients if c.user_ref in member_ids}
    box_ids = set(user_by_box.keys())
    boxes_by_user: dict[str, list] = {}
    for bid, uid in user_by_box.items():
        boxes_by_user.setdefault(uid, []).append(bid)
    tasks_out = []
    if box_ids:
        res = await session.execute(
            select(models.Task).where(models.Task.owner_user_id.in_(member_ids)).order_by(models.Task.created_at.desc())
        )
        rows = list(res.scalars().all())
        for t in rows:
            uid = t.owner_user_id
            tasks_out.append({
                "id": t.id, "title": t.title, "status": t.status,
                "priority": getattr(t, "priority", None) or "normal",
                "start": _ms(getattr(t, "start_at", None)),
                "due": _ms(getattr(t, "due_at", None)),
                "actualStart": _ms(getattr(t, "actual_start_at", None)),
                "actualEnd": _ms(getattr(t, "actual_end_at", None)),
                "tags": list(getattr(t, "tags", None) or []),
                "assigneeUserId": uid or "",   # Include member identity for frontend filtering and reassignment.
                "assigneeName": name_by.get(uid, ""), "assigneeColor": color_by.get(uid, "#7c6cf0"),
                "origin": t.origin,
                # Include notes, source, creator, and up to five recent progress entries for task details.
                "note": t.note or "",
                "source": t.source or "",
                "createdByName": getattr(t, "created_by_name", None) or "",
                "createdAt": _ms(t.created_at),
                "progress": list(reversed((getattr(t, "progress", None) or [])[-5:])),
            })
    members = [{"userId": u.id, "name": name_by[u.id], "color": color_by[u.id],
                "hasBox": bool(boxes_by_user.get(u.id))} for u in members_u]
    return {"canManage": True, "tasks": tasks_out, "members": members, "orgName": ""}


async def set_team_task_status(session: AsyncSession, client: models.Client, tid: str, status: str) -> dict:
    """Let an authorized manager update a task on a team member's client, including completion
    through shared gates.
    """
    from ..realtime import hub
    from ..schemas import task_to_api

    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if not await _can_manage(session, me):
        return {"ok": False, "reason": "forbidden"}
    if status not in ("todo", "doing", "done", "cancel"):
        return {"ok": False, "reason": "bad_status"}
    t = await session.get(models.Task, tid, with_for_update=True, populate_existing=True)
    if t is None:
        return {"ok": False, "reason": "not_found"}
    members_u, _c, _n = await _team_members(session, me)
    member_ids = {u.id for u in members_u}
    box = await session.get(models.Client, t.owner_client_id)
    if not box or t.owner_user_id not in member_ids:
        return {"ok": False, "reason": "out_of_scope"}
    prev = t.status
    if status == "cancel" and prev != "cancel":
        from . import task_maintenance
        await task_maintenance.ensure_allowed(session, [t], action="archive", client=client)
    from . import task_status
    if not await task_status.mark(session, t, status, why="团队面板代改状态"):
        return {"ok": False, "reason": "engine_managed"}
    await session.commit()
    await session.refresh(t)
    from .tasks import task_to_api_live
    api = await task_to_api_live(session, t)   # Include AI state so the update preserves execution indicators.
    from . import task_access
    await task_access.publish_task(session, t, "task.updated", api)
    # Manager completion sends the same requester receipt as owner completion.
    if status == "done" and prev != "done":
        from . import receipts
        await receipts.notify_on_close(session, t, t.owner_client_id)
    return {"ok": True, "task": api}


async def nudge_team_task(session: AsyncSession, client: models.Client, tid: str, note: str = "") -> dict:
    """Send a team-task reminder or message to its current holder without changing task state."""
    from ..realtime import hub

    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if not await _can_manage(session, me):
        return {"ok": False, "reason": "forbidden"}
    t = await session.get(models.Task, tid)
    if t is None:
        return {"ok": False, "reason": "not_found"}
    if t.status == "done":
        return {"ok": False, "reason": "already_done"}
    members_u, _c, _n = await _team_members(session, me)
    member_ids = {u.id for u in members_u}
    box = await session.get(models.Client, t.owner_client_id) if t.owner_client_id else None
    if not box or t.owner_user_id not in member_ids:
        return {"ok": False, "reason": "out_of_scope"}
    from . import task_access
    if not task_access.is_owner(t, box):
        return {"ok": False, "reason": "out_of_scope"}
    if box.id == client.id:
        return {"ok": False, "reason": "self"}
    who = (me.display_name or me.username) if me else "负责人"
    note = str(note or "").strip()[:120]
    text = f"⏰ {who} 催办：「{t.title}」" + (f"——{note}" if note else "，抽空推进一下~")
    await task_access.publish_owner(session, t, {"type": "notice", "text": text, "taskId": t.id})
    from . import audit
    await audit.log(session, me, "task.nudge", "task", t.id, t.title, {"note": note, "via": "pet"})
    return {"ok": True, "delivered": hub.is_online(t.owner_client_id)}


async def _move_task_to_user(session: AsyncSession, t, target_uid: str, members_u: list,
                             actor_name: str, from_name: str, note: str = "",
                             self_handoff: bool = False, actor_user_id: str = "") -> dict:
    """Move a task to another user's client, recording history and notifying both sides. The caller
    validates authorization and scope.
    """
    from ..realtime import hub
    from .tasks import task_to_api_live

    from . import task_assignment_notifications
    target_box = await task_assignment.pick_device(
        session, target_uid, project_id=t.project_id)
    if target_box is None:
        return {"ok": False, "reason": "no_box"}
    new_owner = target_box.id
    old_owner = t.owner_client_id
    old_owner_user = t.owner_user_id
    if new_owner == old_owner and t.owner_user_id == target_uid:
        return {"ok": True, "task": await task_to_api_live(session, t)}
    _names = {u.id: (u.display_name or u.username) for u in members_u}
    to_name = _names.get(target_uid, "")
    moved = await session.execute(update(models.Task).where(
        models.Task.id == t.id, models.Task.owner_client_id == old_owner,
        models.Task.owner_user_id == t.owner_user_id
    ).values(owner_client_id=new_owner, owner_user_id=target_uid,
             assignee_user_id=target_uid).execution_options(synchronize_session=False))
    if not moved.rowcount:
        await session.rollback()
        return {"ok": False, "reason": "not_found"}
    await session.refresh(t)
    # The transfer note is part of the requirement context, not only an audit
    # event.  Persist it on the task before publishing the updated projection
    # so the new owner can see it in the detail panel and the execution prompt
    # (task-turn renders Task.note for both native and Runner dispatch).
    transfer_note = str(note or "").strip()
    if transfer_note:
        label = actor_name or "转交人"
        addition = "转交补充说明（" + label + "）：\n" + transfer_note
        existing_note = str(t.note or "").rstrip()
        t.note = (existing_note + "\n\n" + addition).strip() if existing_note else addition
        # Migrated or shared requirements expose a frozen public projection from
        # requirement_content rather than Task.note. Keep that projection in sync
        # without dropping the original note, so the recipient sees the same
        # supplement in the detail drawer.
        frozen = dict(getattr(t, "requirement_content", None) or {})
        if frozen:
            frozen_note = str(frozen.get("note") or "").rstrip()
            frozen["note"] = (frozen_note + "\n\n" + addition).strip() if frozen_note else addition
            t.requirement_content = frozen
    assignment_notice = await task_assignment_notifications.transition(
        session, t, actor_user_id, "reassign",
        {"from": from_name, "to": to_name, "note": note}, actor_name)
    await session.commit()
    await session.refresh(t)
    previous_client = await session.get(models.Client, old_owner) if old_owner else None
    if previous_client and str(previous_client.user_ref or "") == str(old_owner_user or ""):
        await hub.publish(old_owner, {"type": "task.deleted", "id": t.id}, user_id=old_owner_user or "")
        if not self_handoff:
            await hub.publish(old_owner, {"type": "notice",
                                          "text": f"「{t.title}」已由 {actor_name} 转派给 {to_name}"},
                              user_id=old_owner_user or "")
    # An AI-running task can transfer to a colleague. Include execution state in the first created event
    # so the recipient immediately sees that execution is still in progress.
    api = await task_to_api_live(session, t)
    from . import task_access
    await task_access.publish_task(session, t, "task.updated", api,
                                    arrival="assign", by=actor_name,
                                    notification_id=assignment_notice.id if assignment_notice else "")
    await task_assignment_notifications.publish(session, assignment_notice)
    return {"ok": True, "task": api}


async def reassign_team_task(session: AsyncSession, client: models.Client, tid: str, target_uid: str) -> dict:
    """Reassign a task between team members only when both task and target are in scope and the
    target has a client.
    """
    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if not await _can_manage(session, me):
        return {"ok": False, "reason": "forbidden"}
    t = await session.get(models.Task, tid)
    if t is None:
        return {"ok": False, "reason": "not_found"}
    if t.status == "done":
        return {"ok": False, "reason": "already_done"}   # Do not reassign completed tasks.
    members_u, _c, _n = await _team_members(session, me)
    member_ids = {u.id for u in members_u}
    box = await session.get(models.Client, t.owner_client_id)
    if not box or t.owner_user_id not in member_ids:
        return {"ok": False, "reason": "out_of_scope"}
    if target_uid not in member_ids:
        return {"ok": False, "reason": "target_out_of_scope"}
    return await _move_task_to_user(session, t, target_uid, members_u,
                                    (me.display_name or me.username) if me else "",
                                    {u.id: (u.display_name or u.username) for u in members_u}.get(t.owner_user_id, ""),
                                    actor_user_id=me.id)


async def handoff_my_task(session: AsyncSession, client: models.Client, tid: str,
                          target_uid: str, note: str = "") -> dict:
    """Allow users to transfer their own tasks to an eligible colleague without management
    permission. Team-management views retain their separate organization scope.
    """
    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    t = await session.get(models.Task, tid)
    from . import task_access
    if t is None or not task_access.is_owner(t, client):
        return {"ok": False, "reason": "not_found"}
    if t.status == "done":
        return {"ok": False, "reason": "already_done"}
    if me is None or not me.is_active:
        return {"ok": False, "reason": "no_user"}
    members_u = await _company_members(session, me)
    if target_uid not in {u.id for u in members_u} or target_uid == me.id:
        return {"ok": False, "reason": "target_out_of_scope"}
    who = me.display_name or me.username
    return await _move_task_to_user(session, t, target_uid, members_u, who, who, note, self_handoff=True, actor_user_id=me.id)


async def create_assigned_task(session: AsyncSession, client: models.Client,
                               data: dict) -> dict:
    """Create one task directly on a coworker's device.

    Every active employee may hand work to a coworker. taskId is a
    client-generated idempotency key, so retries never create duplicates.
    """
    from . import task_access
    from . import tasks as task_service

    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if me is None or not me.is_active:
        return {"ok": False, "reason": "no_user"}
    title = str(data.get("title") or "").strip()
    if not title:
        return {"ok": False, "reason": "no_title"}
    target_uid = str(data.get("assigneeUserId") or "").strip()
    members = await _company_members(session, me)
    target = next((row for row in members
                   if row.id == target_uid and row.id != me.id), None)
    if target is None:
        return {"ok": False, "reason": "target_out_of_scope"}
    sender_id, sender_client_id = me.id, client.id
    target_name = target.display_name or target.username

    task_id = str(data.get("taskId") or "").strip()
    if task_id and (len(task_id) > 36 or
                    any(not (char.isalnum() or char in "-_") for char in task_id)):
        return {"ok": False, "reason": "bad_task_id"}

    def same_request(row: models.Task | None) -> bool:
        return bool(row and row.origin == "dispatch" and
                    row.created_by == sender_id and
                    row.assignee_user_id == target_uid)

    existing = await session.get(models.Task, task_id) if task_id else None
    if existing is not None and not same_request(existing):
        return {"ok": False, "reason": "id_conflict"}

    reused = existing is not None
    if existing is None:
        box = await task_assignment.pick_device(
            session, target_uid, project_id=data.get("projectId"))
        if box is None:
            return {"ok": False, "reason": "no_box"}
        creator_name = me.display_name or me.username
        payload = dict(data or {})
        payload.pop("taskId", None)
        payload.update({
            "title": title,
            "status": payload.get("status") or "todo",
            "assigneeUserId": target_uid,
            "source": payload.get("source") or ("同事交办 · " + creator_name),
        })
        try:
            api = await task_service.create_task(
                session, box.id, payload, origin="dispatch",
                creator=(me.id, creator_name), task_id=task_id or None,
                arrival="assign", by=creator_name)
        except IntegrityError:
            await session.rollback()
            existing = await session.get(models.Task, task_id) if task_id else None
            if not same_request(existing):
                return {"ok": False, "reason": "id_conflict"}
            client = await session.get(models.Client, sender_client_id)
            reused = True
        else:
            existing = await session.get(models.Task, api["id"])

    base = task_to_api(existing)
    tracking = (await task_access.decorate_many(
        session, [existing], [base], client))[0]
    return {
        "ok": True,
        "task": tracking,
        "targetName": target_name,
        "reused": reused,
    }


async def my_teammates(session: AsyncSession, client: models.Client) -> dict:
    """Return colleague display and delivery-readiness metadata, excluding self and sensitive
    fields.
    """
    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if me is None or not me.is_active:
        return {"mates": [], "reason": "本 SoduWork 还没绑定用户，请让管理员分配归属"}
    members_u = await _company_members(session, me)
    unit_ids = {u.org_id for u in members_u if u.org_id}
    units = (await session.execute(select(models.OrgUnit).where(models.OrgUnit.id.in_(unit_ids)))).scalars().all() if unit_ids else []
    org_units = [{"id": row.id, "name": row.name, "parentId": row.parent_id or ""} for row in units]
    org_units.sort(key=lambda row: (row['name'], row['id']))
    ids = {u.id for u in members_u if u.id != me.id}
    if not ids:
        return {"mates": [], "orgUnits": org_units, "reason": "当前企业还没有其他已启用同事"}
    boxes = (await session.execute(
        select(models.Client).where(
            models.Client.user_ref.in_(ids),
            models.Client.auth_state == "active",
            models.Client.revoked_at.is_(None),
        ))).scalars().all()
    boxes_by_user = {}
    for box in boxes:
        boxes_by_user[box.user_ref] = boxes_by_user.get(box.user_ref, 0) + 1
    has_box = set(boxes_by_user)
    orgs = {}
    for u in members_u:
        if u.org_id and u.org_id not in orgs:
            o = await session.get(models.OrgUnit, u.org_id)
            orgs[u.org_id] = o.name if o else ""
    mates = [{"id": u.id, "name": u.display_name or u.username,
              "orgId": u.org_id or "", "org": orgs.get(u.org_id, ""), "hasBox": u.id in has_box,
              "canReceive": u.id in has_box, "deviceCount": boxes_by_user.get(u.id, 0)}
             for u in members_u if u.id != me.id]
    mates.sort(key=lambda m: (not m["canReceive"], m["org"] or "未分组",
                              m["name"] or "", m["id"]))
    return {"mates": mates, "orgUnits": org_units, "reason": "" if any(m["hasBox"] for m in mates) else "其他同事尚无可接收需求的 SoduWork"}


async def message_mate(session: AsyncSession, client: models.Client,
                       target_uid: str, text: str, payload: dict | None = None) -> dict:
    """Persist an @ teammate notification and its delivery/read state."""
    from ..realtime import hub
    from . import mate_message_files, mate_messages

    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if me is None or not me.is_active:
        return {"ok": False, "reason": "no_user"}
    body = str(text or "").strip()[:500]
    if not body:
        return {"ok": False, "reason": "empty"}
    members_u = await _company_members(session, me)
    target = next((u for u in members_u if u.id == str(target_uid or "") and u.id != me.id), None)
    if target is None:
        return {"ok": False, "reason": "target_out_of_scope"}
    boxes = await task_assignment.active_devices(session, target.id)
    if not boxes:
        return {"ok": False, "reason": "no_box"}
    shared = await mate_message_files.save(session, client, me, target, payload or {}, body)
    row = await mate_messages.create(session, me, target, payload or {}, body, shared)
    who = me.display_name or me.username
    await session.commit()
    public_website = mate_messages.public(row, me, target).get("website") or {}
    message = "\U0001f4ac %s\uff1a%s" % (who, body)
    for box in boxes:
        await mate_messages.publish_event(box.id, {"type": "notice", "text": message, "kind": "mate_message",
            "attachments": shared, "messageId": row.client_message_id,
            "serverMessageId": row.id, "senderId": me.id, "senderName": who,
            # Include recipient identity so account switches can discard delayed notices for another user.
            "recipientId": target.id, "recipientName": target.display_name or target.username,
            "website": public_website, "sentAt": row.created_at.timestamp() * 1000 if row.created_at else None}, user_id=target.id)
    from . import audit
    await audit.log(session, me, "team.message", "user", target.id,
                    target.display_name or target.username,
                    {"chars": len(body), "files": len(shared), "messageId": row.id})
    await mate_messages.publish_state(session, row, "mate_message_accepted", recipients=False)
    return {"ok": True, "delivered": bool(row.delivered_at), "messageId": row.id,
            "status": row.status, "targetName": target.display_name or target.username,
            "attachments": shared, "website": public_website}


async def create_team_task(session: AsyncSession, client: models.Client, data: dict) -> dict:
    """Dispatch tasks from a manager to one or more members, creating one task each. Support plural
    and legacy singular assignee fields and report out-of-scope or unavailable recipients as
    skipped.
    """
    from . import tasks as tsvc

    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if not await _can_manage(session, me):
        return {"ok": False, "reason": "forbidden"}
    title = (data.get("title") or "").strip()
    if not title:
        return {"ok": False, "reason": "no_title"}
    # Inbox mode creates an unassigned task in the selected team pool.
    if data.get("toInbox"):
        from . import inbox as inbox_svc
        org_id = data.get("teamOrgId") or (me.org_id if me else None)
        if not org_id:
            return {"ok": False, "reason": "out_of_scope"}
        me_name = me.display_name or me.username
        payload = {
            "title": title, "note": data.get("note") or "",
            "priority": data.get("priority") or "normal",
            "start": data.get("start"), "due": data.get("due"),
            "tags": data.get("tags") or [], "urgent": data.get("urgent"), "important": data.get("important"),
            "domainId": data.get("domainId") or "", "source": "团队收件箱 · " + me_name,
        }
        r = await inbox_svc.create_pool_task(session, org_id, payload, creator=(me.id, me_name))
        return {"ok": True, "toInbox": True, "created": 1, "tasks": [r.get("task")]}
    # Prefer multiple selection, with singular compatibility, removing empty and duplicate IDs.
    uids = list(data.get("assigneeUserIds") or [])
    if not uids and data.get("assigneeUserId"):
        uids = [data.get("assigneeUserId")]
    uids = [u for u in dict.fromkeys(uids) if u]
    if not uids:
        return {"ok": False, "reason": "no_assignee"}

    scope = await rbac.subtree_org_ids(session, me.org_id) if me.org_id else set()
    me_name = me.display_name or me.username
    creator = (me.id, me_name)
    # Use ordinary tasks and requester receipts instead of the retired FlowTemplate assignment flow.
    # The creator receives completion receipts; inbox return handles reassignment needs.
    src = "团队指派 · " + me_name
    base = {
        "title": title, "note": data.get("note") or "", "status": "todo",
        "priority": data.get("priority") or "normal",
        "start": data.get("start"), "due": data.get("due"),
        "tags": data.get("tags") or [], "urgent": data.get("urgent"), "important": data.get("important"),
        "recur": data.get("recur"), "recurAt": data.get("recurAt"), "source": src,
        # Honor explicit external requesters, otherwise default to the dispatching manager.
        "requesterName": data.get("requesterName") or "", "requesterContact": data.get("requesterContact") or "",
        "projectId": data.get("projectId") or None,   # Associate the selected project for project-level reporting.
        "repoId": data.get("repoId") or "",
        "workScenarioKey": data.get("workScenarioKey") or "",
    }

    created, skipped, assigned_users = [], [], 0
    for uid in uids:
        target = await session.get(models.User, uid)
        if target is None or target.org_id not in (scope or set()):
            skipped.append({"userId": uid, "reason": "out_of_scope"})
            continue
        if not target.is_active:
            skipped.append({"userId": uid, "name": target.display_name or target.username,
                            "reason": "inactive"})
            continue
        box = await task_assignment.pick_device(
            session, uid, project_id=base.get("projectId"))
        if box is None:
            skipped.append({"userId": uid, "name": target.display_name or target.username, "reason": "no_box"})
            continue
        payload = {**base, "assigneeUserId": uid}
        assigned_users += 1
        created.append(await tsvc.create_task(
            session, box.id, payload, origin="dispatch", creator=creator,
            arrival="assign", by=me_name))

    if not created:
        reason = ("no_box" if any(x["reason"] == "no_box" for x in skipped)
                  else "inactive" if any(x["reason"] == "inactive" for x in skipped)
                  else "out_of_scope")
        return {"ok": False, "reason": reason, "skipped": skipped}
    return {"ok": True, "created": len(created), "assignees": assigned_users, "skipped": skipped, "tasks": created}


def _tally(counts: dict, t: models.Task) -> None:
    st = t.status if t.status in ("doing", "todo", "done", "cancel") else "todo"
    counts[st] += 1
    # Flag unfinished urgent-and-important work for follow-up.
    if t.urgent and t.important and st in ("doing", "todo"):
        counts["stuck"] += 1


async def team_overview(session: AsyncSession, client: models.Client) -> dict:
    now = datetime.now(timezone.utc)
    offline_after = get_settings().offline_after_seconds

    me = await session.get(models.User, client.user_ref) if client.user_ref else None
    if me is not None and not me.is_active:
        me = None

    # Use organization-subtree members, or one virtual local member for an unbound device.
    members_u: list[models.User] = []
    org_name = ""
    if me and me.org_id:
        scope = await rbac.subtree_org_ids(session, me.org_id)
        res = await session.execute(select(models.User).where(
            models.User.org_id.in_(scope or {"__none__"}),
            models.User.is_active.is_(True),
        ))
        members_u = list(res.scalars().all())
        org = await session.get(models.OrgUnit, me.org_id)
        org_name = org.name if org else ""

    # Resolve each member's department display name.
    org_names: dict[str, str] = {}
    if members_u:
        oids = {u.org_id for u in members_u if u.org_id}
        if oids:
            r = await session.execute(select(models.OrgUnit).where(models.OrgUnit.id.in_(oids)))
            org_names = {o.id: o.name for o in r.scalars().all()}

    # Map users to clients and clients to tasks.
    all_clients = list((await session.execute(select(models.Client))).scalars().all())
    boxes_by_user: dict[str, list[models.Client]] = {}
    for c in all_clients:
        if c.user_ref:
            boxes_by_user.setdefault(c.user_ref, []).append(c)
    all_tasks = list((await session.execute(select(models.Task))).scalars().all())
    from . import task_access
    clients_by_id = {item.id: item for item in all_clients}
    tasks_by_client: dict[str, list[models.Task]] = {}
    for t in all_tasks:
        if task_access.is_owner(t, clients_by_id.get(t.owner_client_id)):
            tasks_by_client.setdefault(t.owner_client_id, []).append(t)

    # Aggregate per-member facts.
    members: list[dict] = []
    week_done = [0] * 7  # Indices 0 through 6 represent six days ago through today.
    my_ids = {b.id for b in boxes_by_user.get(me.id, [])} if me else {client.id}

    def bucket_week(tasks: list[models.Task]) -> None:
        for t in tasks:
            if t.status != "done":
                continue
            dt = _aware(t.updated_at)
            if dt is None:
                continue
            days = (now.date() - dt.date()).days
            if 0 <= days <= 6:
                week_done[6 - days] += 1

    if members_u:
        # Place self first, then sort by display name.
        members_u.sort(key=lambda u: (u.id != (me.id if me else None), u.display_name or u.username))
        for u in members_u:
            counts = _blank_counts()
            box_ids = [b.id for b in boxes_by_user.get(u.id, [])]
            utasks: list[models.Task] = []
            for bid in box_ids:
                utasks.extend(tasks_by_client.get(bid, []))
            for t in utasks:
                _tally(counts, t)
            bucket_week(utasks)
            is_me = bool(me and u.id == me.id)
            members.append({
                "userId": u.id,
                "name": u.display_name or u.username,
                "role": org_names.get(u.org_id) or "未分派部门",
                "isMe": is_me,
                "hasBox": bool(box_ids),
                **counts,
                "cap": 0,  # Fill the relative-load denominator after finding the busiest member.
                "color": _ME_COLOR if is_me else _PALETTE[len(members) % len(_PALETTE)],
            })
    else:
        # Unbound devices fall back to local tasks only.
        counts = _blank_counts()
        mine = tasks_by_client.get(client.id, [])
        for t in mine:
            _tally(counts, t)
        bucket_week(mine)
        members.append({
            "name": client.name or "本机", "role": "未归属组织", "isMe": True,
            **counts, "cap": 0, "color": _ME_COLOR,
        })

    # Normalize workload by the largest active-task count, with a minimum denominator of one.
    team_max_active = max([m["doing"] + m["todo"] for m in members] + [1])
    for m in members:
        m["cap"] = team_max_active

    # Label the seven-day completion axis from oldest to today.
    labels = [_WEEKDAY[(now.date().weekday() - (6 - i)) % 7] for i in range(7)]

    # Aggregate enabled integrations, task counts, and latest updates.
    src_res = await session.execute(
        select(models.Integration).where(models.Integration.enabled == True)  # noqa: E712
    )
    integs = list(src_res.scalars().all())
    count_by_integ: dict[str, int] = {}
    latest_by_integ: dict[str, datetime] = {}
    for t in all_tasks:
        if t.integration_id:
            count_by_integ[t.integration_id] = count_by_integ.get(t.integration_id, 0) + 1
            dt = _aware(t.updated_at)
            if dt and (t.integration_id not in latest_by_integ or dt > latest_by_integ[t.integration_id]):
                latest_by_integ[t.integration_id] = dt
    sources = [{
        "name": ig.name,
        "type": ig.type,
        "icon": _SRC_ICON.get(ig.type, (ig.name or "源")[:1]),
        "color": _SRC_COLOR.get(ig.type, "#4f8ff5"),
        "count": count_by_integ.get(ig.id, 0),
        "sync": _humanize(latest_by_integ.get(ig.id) or _aware(ig.updated_at), now),
    } for ig in integs]

    # List member clients with online and version state.
    member_ids = {u.id for u in members_u} if members_u else set()
    fleet_clients = [c for c in all_clients if c.user_ref in member_ids] if member_ids else [client]
    name_by_user = {u.id: (u.display_name or u.username) for u in members_u}
    clients_out = []
    skin_tally: dict[str, int] = {}
    for c in fleet_clients:
        owner = name_by_user.get(c.user_ref, "") if c.user_ref else ""
        label = (owner + " · " if owner else "") + (c.platform or c.id)
        clients_out.append({
            "name": label,
            "ver": ("v" + c.app_version) if c.app_version else "—",
            "online": _online(c.last_seen_at, now, offline_after),
        })
        ch = (c.config or {}).get("character") or (c.config or {}).get("skin")
        if ch:
            key = _SKIN_NAMES.get(ch, ch)
            skin_tally[key] = skin_tally.get(key, 0) + 1
    skins = [{"name": k, "count": v} for k, v in sorted(skin_tally.items(), key=lambda kv: -kv[1])]

    return {
        "assigned": bool(members_u),
        "canManage": await _can_manage(session, me),
        "orgName": org_name,
        "meName": (me.display_name or me.username) if me else (client.name or ""),
        "members": members,
        "week": {"labels": labels, "done": week_done},
        "sources": sources,
        "clients": clients_out,
        "skins": skins,
    }
