"""Shared TaskEvent writing and reading for creation, assignment, claims, handoffs, returns, and
completion receipts. Record each ownership transition on the task timeline. Writers add events
to the caller's transaction without committing independently.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..schemas import _ms


def to_api(e: models.TaskEvent) -> dict:
    return {"id": e.id, "kind": e.kind, "detail": e.detail or {}, "actor": e.actor, "at": _ms(e.at)}


def record(session: AsyncSession, task_id: str, kind: str,
           detail: dict | None = None, actor: str = "") -> None:
    """Add one timeline event synchronously; the caller commits it with the associated operation."""
    session.add(models.TaskEvent(task_id=task_id, kind=kind, detail=detail or {}, actor=actor or ""))


async def timeline(session: AsyncSession, task_id: str) -> list[dict]:
    rows = (await session.execute(
        select(models.TaskEvent).where(models.TaskEvent.task_id == task_id)
        .order_by(models.TaskEvent.at, models.TaskEvent.id)
    )).scalars().all()
    return [to_api(e) for e in rows]
