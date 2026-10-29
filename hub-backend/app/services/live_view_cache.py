"""Short-lived, event-invalidated cache for expensive read-only live views.

The task trace and AI desk endpoints are assembled from many durable tables.  A
single renderer already coalesces refreshes, but several desktop windows can
still ask for the same immutable JSON snapshot at once.  This cache serializes
builders per scope, reuses a recent snapshot, and invalidates it whenever the
realtime hub publishes a task event.
"""
from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from weakref import WeakValueDictionary
from collections.abc import Awaitable, Callable
from typing import Any


_ENTRIES: dict[tuple[str, str, str, str, int], tuple[int, float, Any]] = {}
_LOCKS: WeakValueDictionary = WeakValueDictionary()
_DEVICE_GENERATION: dict[str, int] = defaultdict(int)
_TASK_GENERATION: dict[tuple[str, str], int] = defaultdict(int)
_MAX_ENTRIES = 512


def _generation(client_id: str, task_id: str) -> int:
    return (_DEVICE_GENERATION[client_id] * 1_000_003 +
            (_TASK_GENERATION[(client_id, task_id)] if task_id else 0))


def invalidate(client_id: str, event: dict | None = None) -> None:
    """Invalidate a device view and, when present, the affected task view."""
    client_id = str(client_id or "")
    if not client_id:
        return
    _DEVICE_GENERATION[client_id] += 1
    task_id = str((event or {}).get("taskId") or (event or {}).get("task_id") or "")
    if task_id:
        _TASK_GENERATION[(client_id, task_id)] += 1


def _prune(now: float) -> None:
    if len(_ENTRIES) <= _MAX_ENTRIES:
        return
    expired = [key for key, value in _ENTRIES.items() if value[1] <= now]
    for key in expired:
        _ENTRIES.pop(key, None)
        if len(_ENTRIES) <= _MAX_ENTRIES:
            return
    for key in list(_ENTRIES)[:max(0, len(_ENTRIES) - _MAX_ENTRIES)]:
        _ENTRIES.pop(key, None)


async def get_or_build(namespace: str, client_id: str, task_id: str,
                       builder: Callable[[], Awaitable[Any]],
                       ttl: float = 3.0, *, actor: Any = None) -> Any:
    """Return one current snapshot; builders for the same scope never overlap.

    The builder deliberately runs in the calling request while holding a keyed
    lock.  It may therefore use that request's ``AsyncSession`` safely.  Waiting
    requests keep their own sessions idle and consume the completed cache entry.
    """
    key = (str(namespace or "live"), str(client_id or ""), str(task_id or ""),
           str(getattr(actor, "user_ref", None) or ""),
           int(getattr(actor, "auth_version", 0) or 0))
    now = time.monotonic()
    generation = _generation(key[1], key[2])
    cached = _ENTRIES.get(key)
    if cached and cached[0] == generation and cached[1] > now:
        return cached[2]

    lock = _LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        now = time.monotonic()
        generation = _generation(key[1], key[2])
        cached = _ENTRIES.get(key)
        if cached and cached[0] == generation and cached[1] > now:
            return cached[2]
        value = await builder()
        # A realtime event may arrive while the expensive snapshot is building.
        # Return that snapshot to the caller, but never publish it as a fresh hit.
        if _generation(key[1], key[2]) == generation:
            _ENTRIES[key] = (generation, time.monotonic() + max(0.1, float(ttl)), value)
            _prune(time.monotonic())
        return value


def clear() -> None:
    """Invalidate snapshots without dropping locks held by in-flight builders."""
    _ENTRIES.clear()
    for client_id in _DEVICE_GENERATION:
        _DEVICE_GENERATION[client_id] += 1


def reset_for_tests() -> None:
    _ENTRIES.clear()
    _LOCKS.clear()
    _DEVICE_GENERATION.clear()
    _TASK_GENERATION.clear()
