"""Read-only usage APIs for Runner load, tokens, duration, and task accounting. Administrators
follow visibility scope; clients see only their own tasks.
"""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import authenticated_client, current_client, require_perm
from ..models import Client, Task, User
from ..services import client_access, device_connections, rbac, task_access, usage_analytics, usage_ledger, usage_stats

router = APIRouter(prefix="/api/v1", tags=["usage"])


@router.post("/usage/events")
async def report_usage(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(authenticated_client),
    session: AsyncSession = Depends(get_session),
):
    """Accept final accounting even at quota; identity is never client supplied."""
    incoming = body.get("events") if isinstance(body.get("events"), list) else [body]
    if not incoming or len(incoming) > 100 or any(not isinstance(item, dict) for item in incoming):
        raise HTTPException(status_code=400, detail="没有可上报的用量")
    rows = []
    try:
        for item in incoming:
            rows.append(await usage_ledger.from_client(session, client, item))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await session.commit()
    client_access.invalidate_quota(str(client.user_ref or ""))
    quota = await client_access.quota_status(
        session, str(client.user_ref or ""))
    if quota["exceeded"]:
        await device_connections.disconnect(client.id, 4403)
    return {"ok": True, "accepted": len(rows),
            "events": [usage_ledger.to_api(row) for row in rows],
            "quota": quota}


@router.get("/usage/me")
async def my_usage(
    days: int = 30,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    return await usage_analytics.consistent_overview(
        session, days=days, user_id=str(client.user_ref or ""),
        client_id=client.id)


@router.get("/admin/usage/overview")
async def admin_usage_overview(
    days: int = 30,
    user_id: str = "",
    source: str = "",
    agent: str = "",
    user: User = Depends(require_perm("client.view")),
    session: AsyncSession = Depends(get_session),
):
    scope = await rbac.scope_org_ids(session, user)
    visible_users = await rbac.scoped_user_ids(session, scope)
    if user_id and visible_users is not None and user_id not in visible_users:
        raise HTTPException(status_code=404, detail="用户不在可见范围")
    return await usage_analytics.consistent_overview(
        session, days=days, user_ids=visible_users, user_id=user_id,
        source_type=str(source or ""), agent_key=str(agent or ""))


@router.get("/admin/usage/runners")
async def admin_runner_usage(
    days: int = 30,
    user: User = Depends(require_perm("client.view")),
    session: AsyncSession = Depends(get_session),
):
    """Return per-Runner availability, active sessions, and windowed session, token, and duration
    totals by CLI.
    """
    from .admin import _visible_client_ids
    from ..services import runner_admin_scope
    return {"days": max(1, min(365, int(days or 30))),
            "runners": await usage_stats.runner_usage(
                session, days=days,
                task_client_ids=await _visible_client_ids(session, user),
                runner_client_ids=await runner_admin_scope.admin_allowed(session, user),
                runner_org_ids=await runner_admin_scope.admin_orgs(session, user))}


@router.get("/admin/usage/tasks/{tid}")
async def admin_task_usage(
    tid: str,
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    from .admin import _assert_task_in_scope
    await _assert_task_in_scope(session, user, tid)
    return await usage_stats.task_usage(session, tid)


@router.get("/tasks/{tid}/usage")
async def my_task_usage(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return usage details for this client's tasks, with separate execution sessions for
    follow-ups, agent switches, and redispatches.
    """
    t = await session.get(Task, tid)
    if t is None or not task_access.is_owner(t, client):
        raise HTTPException(status_code=404, detail="需求不存在")
    return await usage_stats.task_usage(session, tid)
