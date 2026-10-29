"""Database-backed leases for work that must be single-owner across Hub instances."""
from __future__ import annotations

import os
import socket
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am


class LeaseBusy(RuntimeError):
    """The resource is currently owned by another live process."""


@dataclass(frozen=True)
class LeaseHandle:
    kind: str
    key: str
    owner: str
    token: str
    lease_until: datetime


def _now() -> datetime:
    return datetime.now(timezone.utc)


def default_owner(prefix: str = "hub") -> str:
    return f"{prefix}:{socket.gethostname()}:{os.getpid()}"[:120]


async def acquire(session: AsyncSession, kind: str, key: str, *,
                  owner: str = "", ttl_seconds: int = 90,
                  detail: dict | None = None) -> LeaseHandle:
    kind = str(kind or "").strip()[:40]
    key = str(key or "").strip()[:300]
    if not kind or not key:
        raise ValueError("lease kind and key are required")
    owner = str(owner or default_owner())[:120]
    ttl = max(10, min(3600, int(ttl_seconds or 90)))
    now, token = _now(), uuid.uuid4().hex
    until = now + timedelta(seconds=ttl)
    values = {
        "id": str(uuid.uuid4()), "resource_kind": kind, "resource_key": key,
        "owner_id": "", "token": "", "detail": {},
    }
    dialect = session.get_bind().dialect.name
    factory = pg_insert if dialect == "postgresql" else sqlite_insert
    statement = factory(am.ResourceLease).values(**values).on_conflict_do_nothing(
        index_elements=["resource_kind", "resource_key"])
    await session.execute(statement)
    await session.commit()

    claimed = await session.execute(
        update(am.ResourceLease).where(
            am.ResourceLease.resource_kind == kind,
            am.ResourceLease.resource_key == key,
            or_(am.ResourceLease.lease_until.is_(None),
                am.ResourceLease.lease_until <= now,
                am.ResourceLease.token == ""),
        ).values(
            owner_id=owner, token=token, lease_until=until,
            heartbeat_at=now, acquired_at=now, released_at=None,
            detail=dict(detail or {}),
        ))
    await session.commit()
    if int(claimed.rowcount or 0) != 1:
        raise LeaseBusy(f"{kind}:{key} is busy")
    return LeaseHandle(kind, key, owner, token, until)


async def heartbeat(session: AsyncSession, lease: LeaseHandle,
                    ttl_seconds: int = 90) -> bool:
    now = _now()
    until = now + timedelta(seconds=max(10, min(3600, int(ttl_seconds or 90))))
    result = await session.execute(
        update(am.ResourceLease).where(
            am.ResourceLease.resource_kind == lease.kind,
            am.ResourceLease.resource_key == lease.key,
            am.ResourceLease.token == lease.token,
            am.ResourceLease.lease_until > now,
        ).values(heartbeat_at=now, lease_until=until))
    await session.commit()
    return int(result.rowcount or 0) == 1


async def release(session: AsyncSession, lease: LeaseHandle) -> bool:
    now = _now()
    result = await session.execute(
        update(am.ResourceLease).where(
            am.ResourceLease.resource_kind == lease.kind,
            am.ResourceLease.resource_key == lease.key,
            am.ResourceLease.token == lease.token,
        ).values(owner_id="", token="", lease_until=None,
                 heartbeat_at=now, released_at=now))
    await session.commit()
    return int(result.rowcount or 0) == 1