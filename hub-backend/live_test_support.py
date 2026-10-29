"""Shared helpers for production-shaped, self-cleaning live test identities.

Live checks intentionally exercise the same device authentication boundary as a
real SoduWork client. They therefore must not revive the retired plaintext-secret
shortcut or create an unowned device. The caller owns the transaction and the
cleanup order because each check may create different dependent rows.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import models
from app.services import device_auth


async def active_owner(session: AsyncSession) -> models.User:
    """Return a stable active owner without creating production user data."""
    owner = (await session.execute(
        select(models.User)
        .where(models.User.is_active.is_(True))
        .order_by(models.User.is_super.desc(), models.User.created_at.asc())
    )).scalars().first()
    if owner is None:
        raise RuntimeError("Live gate requires at least one active SoduWork user")
    return owner


async def seed_active_device(
    session: AsyncSession,
    client_id: str,
    secret: str,
    *,
    name: str,
    platform: str = "smoke",
    app_version: str = "live-smoke",
    work_root: str = "",
) -> tuple[models.Client, models.User]:
    """Create/update one dedicated test device using the production auth shape."""
    device_auth.validate_device_id(client_id)
    device_auth.validate_secret(secret)
    owner = await active_owner(session)
    client = await session.get(models.Client, client_id)
    if client is None:
        client = models.Client(id=client_id)
        session.add(client)
    client.name = name
    client.platform = platform
    client.app_version = app_version
    if work_root:
        client.work_root = work_root
    client.secret = None
    client.secret_hash = device_auth.hash_secret(secret)
    device_auth.activate(client, owner)
    await session.flush()
    return client, owner
