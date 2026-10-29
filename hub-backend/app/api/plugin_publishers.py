"""Trusted publisher keys for signed enterprise plugin packages."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..db import get_session
from ..deps import require_perm
from ..models import User
from ..services import audit, plugin_signatures, rbac


router = APIRouter(prefix="/api/v1/admin/plugin-publishers",
                   tags=["plugin-publishers"])


async def _scope(session: AsyncSession, user: User) -> set[str] | None:
    return await rbac.scope_org_ids(session, user)


async def _row(session: AsyncSession, user: User, row_id: str) -> am.PluginPublisherKey:
    row = await session.get(am.PluginPublisherKey, row_id)
    if row is None:
        raise HTTPException(status_code=404, detail="可信发布者不存在")
    scope = await _scope(session, user)
    if scope is not None and row.org_id is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="可信发布者不在你的组织范围内")
    if row.org_id is None and not user.is_super:
        raise HTTPException(status_code=403, detail="平台级可信发布者只允许超级管理员管理")
    return row


@router.get("")
async def list_publishers(
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    scope = await _scope(session, user)
    query = select(am.PluginPublisherKey).order_by(
        am.PluginPublisherKey.status, am.PluginPublisherKey.created_at.desc())
    if scope is not None:
        query = query.where(or_(
            am.PluginPublisherKey.org_id.is_(None),
            am.PluginPublisherKey.org_id.in_(scope or {"__none__"})))
    rows = list((await session.execute(query)).scalars().all())
    return {"items": [plugin_signatures.key_api(row) for row in rows]}


@router.post("")
async def add_publisher(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    requested = str(body.get("orgId") or "").strip() or None
    org_id = requested if user.is_super else user.org_id
    if requested and not user.is_super:
        scope = await _scope(session, user)
        if scope is not None and requested not in scope:
            raise HTTPException(status_code=403, detail="不能为组织范围外登记发布者")
        org_id = requested
    if org_id is None and not user.is_super:
        raise HTTPException(status_code=403, detail="当前账号没有可管理的组织")
    try:
        row = await plugin_signatures.create_key(session, body, user, org_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await audit.log(
        session, user, "plugin.publisher_add", "plugin_publisher_key",
        row.id, row.publisher_name,
        {"keyId": row.key_id, "fingerprint": row.fingerprint, "orgId": row.org_id})
    return plugin_signatures.key_api(row)


@router.post("/{row_id}/revoke")
async def revoke_publisher(
    row_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await _row(session, user, row_id)
    if row.status == "revoked":
        return plugin_signatures.key_api(row)
    note = str(body.get("note") or "").strip()[:1200]
    await plugin_signatures.revoke_key(session, row)
    await audit.log(
        session, user, "plugin.publisher_revoke", "plugin_publisher_key",
        row.id, row.publisher_name,
        {"keyId": row.key_id, "fingerprint": row.fingerprint, "note": note,
         "existingVersions": "unchanged"})
    return plugin_signatures.key_api(row)
