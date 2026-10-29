"""Shared data-scope checks for administrative APIs."""
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Client, Task, User
from ..services import rbac


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
