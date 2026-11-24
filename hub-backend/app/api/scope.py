"""Shared data-scope checks for administrative APIs."""
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Client, OrgUnit, Task, User
from ..services import rbac


def require_integration_org(scope: set[str] | None, org_id: object) -> str:
    owner = org_id.strip() if isinstance(org_id, str) else ""
    if scope is not None and (not owner or owner not in scope):
        raise HTTPException(status_code=403, detail="Integration is outside your organization scope")
    return owner


async def require_existing_org(session: AsyncSession, org_id: str) -> None:
    if not org_id:
        return
    org = await session.get(OrgUnit, org_id, populate_existing=True)
    if org is None:
        raise HTTPException(status_code=400, detail="部门不存在")
    if org.is_archived:
        raise HTTPException(status_code=409, detail="该部门已归档")


async def integration_target_org(session: AsyncSession, scope: set[str] | None,
                                 requested: object, current: str = "") -> str:
    if requested is not None and not isinstance(requested, str):
        raise HTTPException(status_code=400, detail="orgId must be a string")
    org_id = require_integration_org(scope, requested)
    if org_id != current:
        await require_existing_org(session, org_id)
    return org_id


async def visible_clients(session: AsyncSession, user: User) -> set[str] | None:
    scope = await rbac.scope_org_ids(session, user)
    if scope is None:
        return None
    user_ids = await rbac.scoped_user_ids(session, scope) or set()
    rows = (await session.execute(select(Client.id, Client.user_ref))).all()
    return {client_id for client_id, uid in rows if uid in user_ids or uid is None}


async def task_or_404(session: AsyncSession, user: User, task_id: str) -> Task:
    task = await session.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    visible = await visible_clients(session, user)
    if visible is not None and task.owner_client_id not in visible:
        raise HTTPException(status_code=403, detail="无权查看这条需求")
    return task
