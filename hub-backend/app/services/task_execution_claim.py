"""Explicitly move idle assigned work to the assignee's authenticated device."""
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select, update

from .. import models
from . import task_access, task_events, task_requirements, tasks


def available(task, client, api):
    return bool(client.user_ref and str(client.user_ref) == str(task.assignee_user_id or "")
                and not task_access.is_owner(task, client) and task.status == "todo"
                and not task.archived_at and api.get("requirementStage") == "ready"
                and not api.get("maintenanceBlocked")
                and not task.reviewed_at
                and not (task.work_routing or {}).get("conversationTurn"))


async def prepare(session, client, tid):
    # Lock and re-read both device identity and the task; a rendered permission
    # flag or stale assignment never authorizes a transfer.
    authenticated = (client.user_ref, client.auth_version)
    # Match login's user-before-device lock order to avoid a concurrent-login deadlock.
    user = await session.get(models.User, authenticated[0], populate_existing=True,
                             with_for_update=True) if authenticated[0] else None
    device = await session.get(models.Client, client.id, populate_existing=True, with_for_update=True)
    if (not device or (device.user_ref, device.auth_version) != authenticated
            or device.auth_state != "active" or device.revoked_at or not user or not user.is_active):
        raise HTTPException(403, "请使用已登录的负责人账号接手需求")
    task = await session.get(models.Task, tid, with_for_update=True, populate_existing=True)
    if task is None or not await task_requirements.can_read(session, device, task):
        raise HTTPException(404, "需求不存在")
    own = task_access.is_owner(task, device)
    if not own and str(task.assignee_user_id or "") != str(user.id):
        raise HTTPException(403, "只有当前负责人可以接手这条需求")
    expected = {name: getattr(task, name) for name in (
        "owner_client_id", "owner_user_id", "assignee_user_id", "requirement_version", "status",
        "archived_at", "reviewed_at", "triage_stage")}
    expected_routing = dict(task.work_routing or {})
    api = await tasks.task_to_api_live(session, task)
    if (task.status != "todo" or task.archived_at or api.get("requirementStage") != "ready"
            or api.get("maintenanceBlocked") or task.reviewed_at):
        raise HTTPException(409, "需求尚未准备好或已进入执行，请刷新后确认")
    # A previous conversation belongs to its original device. Never move its
    # private session or resume a historical turn under a new executor.
    if not own and (task.work_routing or {}).get("conversationTurn"):
        raise HTTPException(409, "需求已有执行会话，请先由原执行人处理后再转交")
    if not own:
        previous, previous_account = task.owner_client_id, task.owner_user_id or ""
        # SQLite ignores FOR UPDATE. Compare scalar facts before taking its
        # write lock; JSON equality is not portable to PostgreSQL's JSON type.
        # Core UPDATE bypasses the ORM transfer hook, so freeze both ownership fields here.
        changed = await session.execute(update(models.Task).where(
            models.Task.id == tid,
            *(getattr(models.Task, name) == value for name, value in expected.items()),
            select(models.Client.id).where(
                models.Client.id == device.id, models.Client.user_ref == authenticated[0],
                models.Client.auth_version == authenticated[1], models.Client.auth_state == "active",
                models.Client.revoked_at.is_(None)).exists(),
            select(models.User.id).where(models.User.id == user.id,
                                         models.User.is_active.is_(True)).exists(),
        ).values(owner_client_id=device.id, owner_user_id=user.id, updated_at=datetime.now(timezone.utc),
                 requirement_version=int(expected["requirement_version"] or 1) + 1)
          .execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            raise HTTPException(409, "需求已被更新，请刷新后重新接手")
        # The successful UPDATE holds SQLite's write lock until commit. Recheck
        # separate execution/review records now so an insert after the first
        # projection cannot let an active dispatch move to another device.
        await session.refresh(task)
        latest = await tasks.task_to_api_live(session, task)
        if (dict(task.work_routing or {}) != expected_routing
                or latest.get("maintenanceBlocked") or latest.get("requirementStage") != "ready"):
            await session.rollback()
            raise HTTPException(409, "需求已进入执行或验收，请刷新后确认")
        task_events.record(session, tid, "claim", {"from": previous, "to": device.id,
                           "source": "requirement-assignee"}, user.display_name or user.username)
        await session.commit()
        await session.refresh(task)
        await task_access.publish_task(session, task, "task.updated")
        # The previous executor can lose all visibility after a transfer.
        if previous:
            previous_device = await session.get(models.Client, previous)
            if previous_device and not await task_requirements.can_read(session, previous_device, task):
                from ..realtime import hub
                await hub.publish(previous, {"type": "task.deleted", "id": tid}, user_id=previous_account)
    return await tasks.get_task(session, device.id, tid, include_related=True)
