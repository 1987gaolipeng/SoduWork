"""Scope checks shared by existing Runner administration endpoints."""
from fastapi import HTTPException
from sqlalchemy import select

from .. import automation_models as am
from ..models import Client, OrgUnit, User
from . import rbac


async def admin_allowed(session, user):
    scope = await rbac.scope_org_ids(session, user)
    if scope is None:
        return None
    user_ids = set((await session.scalars(select(User.id).where(
        User.org_id.in_(scope or {"__none__"})))).all())
    return set((await session.scalars(select(Client.id).where(
        Client.user_ref.in_(user_ids or {"__none__"})))).all())


async def admin_orgs(session, user):
    return await rbac.scope_org_ids(session, user)


async def org_options(session, allowed_orgs):
    query = select(OrgUnit).order_by(OrgUnit.sort, OrgUnit.name)
    if allowed_orgs is not None:
        query = query.where(OrgUnit.id.in_(allowed_orgs or {"__none__"}))
    rows = list((await session.scalars(query)).all())
    return [{"id": row.id, "name": row.name, "parentId": row.parent_id or ""} for row in rows]


def row_in_scope(row, allowed_clients, allowed_orgs, owner_user_id=""):
    """Client scope: personal nodes never inherit organization-wide access."""
    if row.owner_user_id:
        return bool(owner_user_id and str(row.owner_user_id) == str(owner_user_id))
    if allowed_clients is None and allowed_orgs is None:
        return True
    if str(row.client_id or ""):
        return allowed_clients is not None and row.client_id in allowed_clients
    return bool(row.org_id and allowed_orgs is not None and row.org_id in allowed_orgs)


async def admin_runner(session, user, runner_id, *, lock=False):
    allowed, orgs = await admin_allowed(session, user), await admin_orgs(session, user)
    if lock:
        from .runner_access_policy import acquire_runner_policy_lock
        await acquire_runner_policy_lock(session, runner_id)
    query = select(am.RunnerNode).where(am.RunnerNode.id == runner_id).execution_options(populate_existing=True)
    row = await session.scalar(query.with_for_update() if lock else query)
    visible = bool(row and (row_in_scope(row, allowed, orgs) or
        (row.owner_user_id and (orgs is None or row.org_id in orgs))))
    if not visible or getattr(row, "management_state", "") == "retired":
        raise HTTPException(404, "执行节点不存在")
    return row


async def assigned_org(session, user, requested="", existing=None):
    org_id = str(requested or (existing.org_id if existing else "") or user.org_id or "")
    if not org_id:
        raise HTTPException(422, "Independent Runner requires an organization scope")
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None and org_id not in scope:
        raise HTTPException(403, "Runner organization is outside your management scope")
    if await session.get(OrgUnit, org_id) is None:
        raise HTTPException(422, "Runner organization does not exist")
    return org_id
