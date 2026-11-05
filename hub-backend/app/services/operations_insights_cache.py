"""Short-lived global operations snapshots, isolated by database engine and event loop.

Only the operations.view-protected, unscoped admin endpoint uses this cache. Each
worker builds at most one snapshot at a time; workers do not share a global lock.
The build owns its session, so a disconnected reader cannot close its transaction.
"""
from __future__ import annotations

import asyncio
import copy
import time
from dataclasses import dataclass
from weakref import WeakKeyDictionary

from sqlalchemy.ext.asyncio import AsyncSession

from .operations_insights import insights

TTL_SECONDS = 10
_monotonic = time.monotonic


@dataclass
class _Snapshot:
    loop: object
    value: dict | None = None
    expires: float = 0
    task: asyncio.Task | None = None


_snapshots = WeakKeyDictionary()


async def get_insights(bind):
    loop = asyncio.get_running_loop()
    state = _snapshots.get(bind)
    if state is None or state.loop is not loop:
        state = _Snapshot(loop=loop)
        _snapshots[bind] = state
    if state.value is not None and _monotonic() < state.expires:
        return copy.deepcopy(state.value)
    if state.task is None:
        state.task = loop.create_task(_build(bind, state))
        # Retrieve failures even if every reader disconnected while building.
        state.task.add_done_callback(lambda task: None if task.cancelled() else task.exception())
    return copy.deepcopy(await asyncio.shield(state.task))


async def _build(bind, state):
    try:
        async with AsyncSession(bind=bind, expire_on_commit=False) as session:
            value = await insights(session)
        state.value = value
        state.expires = _monotonic() + TTL_SECONDS
        return value
    finally:
        state.task = None
