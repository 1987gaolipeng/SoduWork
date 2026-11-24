"""Read-only usage APIs for Runner load, tokens, duration, and task accounting. Administrators
follow visibility scope; clients see only their own tasks.
"""
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import authenticated_client, current_client, require_perm
from ..models import Client, Task, User
from ..services import (
    client_access,
    quota_usage,
    rbac,
    task_access,
    usage_analytics,
    usage_ledger,
    usage_stats,
)
from ..services import (
    device_connections as device_connections,
)

router = APIRouter(prefix="/api/v1", tags=["usage"])


def _validate_event_time(event: dict) -> dict:
    if "occurredAt" not in event:
        return event
    try:
        instant = datetime.fromisoformat(event["occurredAt"])
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=timezone.utc)
        instant = instant.astimezone(timezone.utc)
        # Both the stored instant and the ledger's calendar day must be representable.
        instant.astimezone(quota_usage.CHINA_TZ)
    except (TypeError, ValueError, OverflowError) as exc:
        raise HTTPException(422, "occurredAt must be a valid ISO 8601 timestamp") from exc
    return {**event, "occurredAt": instant}


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
    incoming = [_validate_event_time(item) for item in incoming]
    receipts = []
    try:
        prepared = [await usage_ledger.prepare_client_event(session, client, item) for item in incoming]
        for key, values in prepared:
            row, status = await usage_ledger.record_cumulative(session, key, values)
            receipts.append({**usage_ledger.to_api(row), "status": status})
    except usage_ledger.InvalidUsageSource as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await session.commit()
    client_access.invalidate_quota(str(client.user_ref or ""))
    quota = await client_access.quota_status(
        session, str(client.user_ref or ""))
    # Exhaustion changes AI admission, not identity or business connectivity.
    return {"ok": True, "accepted": len(receipts), "events": receipts,
            "quota": quota}


@router.get("/usage/me")
async def my_usage(
    days: Annotated[int, Query(ge=1, le=365)] = 30,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    return await usage_analytics.consistent_overview(
        session, days=days, user_id=str(client.user_ref or ""),
        client_id=client.id)


@router.get("/admin/usage/overview")
async def admin_usage_overview(
    days: Annotated[int, Query(ge=1, le=365)] = 30,
    user_id: str = "",
    source: str = "",
    agent: str = "",
    detail: Literal["all", "anomalous", "unpriced"] = "all",
    page: Annotated[int, Query(ge=1)] = 1,
    exclude_anomalies: bool = False,
    user: User = Depends(require_perm("client.view")),
    session: AsyncSession = Depends(get_session),
):
    scope = await rbac.scope_org_ids(session, user)
    visible_users = await rbac.scoped_user_ids(session, scope)
    if user_id and visible_users is not None and user_id not in visible_users:
        raise HTTPException(status_code=404, detail="用户不在可见范围")
    return await usage_analytics.consistent_overview(
        session, days=days, user_ids=visible_users, user_id=user_id,
        source_type=str(source or ""), agent_key=str(agent or ""), detail=detail,
        page=page, exclude_anomalies=exclude_anomalies)


@router.get("/admin/usage/runners")
async def admin_runner_usage(
    days: int = 30,
    user: User = Depends(require_perm("client.view")),
    session: AsyncSession = Depends(get_session),
):
    """Return per-Runner availability, active sessions, and windowed session, token, and duration
    totals by CLI.
    """
    from ..services import runner_admin_scope
    from .admin import _visible_client_ids
    window = max(1, min(365, int(days or 30)))
    return {"days": window,
            "runners": await usage_stats.runner_usage(
                session, days=window,
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
