"""Immediate teardown for every long-lived channel owned by one SoduWork device."""
from __future__ import annotations

import asyncio
from collections import defaultdict
from contextlib import asynccontextmanager

from ..realtime import hub as realtime_hub
from . import live_view_cache, runner_hub


_terminals: dict[str, set[object]] = defaultdict(set)
_lock = asyncio.Lock()


async def register_terminal(client_id: str, websocket) -> None:
    async with _lock:
        _terminals[str(client_id or "")].add(websocket)


async def unregister_terminal(client_id: str, websocket) -> None:
    key = str(client_id or "")
    async with _lock:
        current = _terminals.get(key)
        if current is None:
            return
        current.discard(websocket)
        if not current:
            _terminals.pop(key, None)


@asynccontextmanager
async def terminal_channel(client_id: str, websocket):
    """Keep terminal registration balanced across every early return/error."""
    await register_terminal(client_id, websocket)
    try:
        yield
    finally:
        await unregister_terminal(client_id, websocket)


async def disconnect(client_id: str, code: int = 4403, *, _local: bool = False) -> None:
    """Close event, terminal and built-in Runner channels for a device."""
    key = str(client_id or "")
    live_view_cache.invalidate(key)
    from .cluster_bus import bus
    async with _lock:
        terminals = list(_terminals.pop(key, set()))

    async def broadcast():
        if bus.enabled and not _local:
            try:
                await bus.broadcast({"kind": "revoke", "device": key, "code": code})
            except Exception:
                # Peer readiness fails closed; REST auth reads the revoked DB state.
                pass

    async def close_terminals():
        # One dead terminal must not keep the account's other terminals active.
        await asyncio.gather(*(ws.close(code=code) for ws in terminals), return_exceptions=True)

    # Start every local teardown alongside cluster delivery. The caller may
    # bound cleanup time, so a stalled peer must never prevent local revocation.
    results = await asyncio.gather(realtime_hub.close_device(key, code, _local=True),
        runner_hub.disconnect_client(key, code, _local=True), close_terminals(), broadcast(),
        return_exceptions=True)
    for result in results:
        if isinstance(result, BaseException):
            raise result


async def disconnect_many(client_ids) -> None:
    for client_id in dict.fromkeys(str(item or "") for item in client_ids):
        if client_id:
            await disconnect(client_id)
