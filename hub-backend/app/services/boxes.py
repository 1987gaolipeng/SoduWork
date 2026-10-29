"""Shared user-to-client lookup helpers, independent of the retired workflow engine."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models


async def box_of_user(session: AsyncSession, uid: str | None) -> str | None:
    """Return one client owned by the user for notification or dispatch routing."""
    if not uid:
        return None
    c = (await session.execute(
        select(models.Client).where(models.Client.user_ref == uid).limit(1)
    )).scalar_one_or_none()
    return c.id if c else None


async def box_owner_names(session: AsyncSession, box_ids: list) -> dict[str, str]:
    """Batch-resolve client IDs to owner display names, falling back to machine names for unowned
    clients.
    """
    ids = [b for b in set(box_ids or []) if b]
    if not ids:
        return {}
    clients = (await session.execute(
        select(models.Client).where(models.Client.id.in_(ids))
    )).scalars().all()
    user_ids = [c.user_ref for c in clients if c.user_ref]
    users = {}
    if user_ids:
        users = {u.id: u for u in (await session.execute(
            select(models.User).where(models.User.id.in_(user_ids))
        )).scalars().all()}
    out = {}
    for c in clients:
        u = users.get(c.user_ref) if c.user_ref else None
        out[c.id] = (u.display_name or u.username) if u else (c.name or c.id[:8])
    return out
