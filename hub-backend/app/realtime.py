"""WebSocket connections grouped by device for task update delivery."""
import asyncio
import logging
from collections import defaultdict

from fastapi import WebSocket

log = logging.getLogger("uvicorn.error")

_MAX_PER_DEVICE = 3   # Limit each device to three WebSocket connections.
_MAX_TOTAL = 500      # Global connection limit.


class Hub:
    def __init__(self) -> None:
        self._conns: dict[str, set[WebSocket]] = defaultdict(set)
        self._users: dict[WebSocket, str] = {}
        self._lock = asyncio.Lock()

    async def connect(self, device: str, ws: WebSocket, *, accept: bool = True,
                      user_id: str | None = None) -> bool:
        """Accept and register a connection, returning False when the caller should close it. With accept=False, authentication has already accepted the socket; register it without repeating the ASGI handshake."""
        from .services.cluster_bus import bus
        if not bus.healthy:
            return False
        async with self._lock:
            if len(self._conns.get(device, ())) >= _MAX_PER_DEVICE:
                return False
            if sum(len(s) for s in self._conns.values()) >= _MAX_TOTAL:
                log.warning("WS 连接总数已达上限 %d，拒绝新连接", _MAX_TOTAL)
                return False
            # Reserve the slot before awaiting accept. Otherwise concurrent
            # handshakes all pass the limit check and register afterwards.
            self._conns[device].add(ws)
            self._users[ws] = str(user_id or "")
        if accept:
            try:
                await ws.accept()
            except Exception:
                await self.disconnect(device, ws)
                raise
        return True

    async def disconnect(self, device: str, ws: WebSocket) -> None:
        async with self._lock:
            self._conns[device].discard(ws)
            self._users.pop(ws, None)
            if not self._conns[device]:
                self._conns.pop(device, None)

    async def close_device(self, device: str, code: int = 4403, *, _local: bool = False) -> None:
        """Revoke every live event channel for one device immediately."""
        from .services.cluster_bus import bus
        if bus.enabled and not _local:
            await bus.broadcast({"kind": "revoke", "device": device, "code": code})
        async with self._lock:
            conns = list(self._conns.pop(device, set()))
            for ws in conns:
                self._users.pop(ws, None)
        for ws in conns:
            try:
                await ws.close(code=code)
            except Exception:  # noqa: BLE001 - the socket may already be gone
                pass

    async def publish(self, device: str, event: dict, *, _local: bool = False,
                      user_id: str | None = None) -> None:
        """Push an event to every live connection for a device and remove failed connections."""
        # Invalidate the short-lived task snapshot before clients react to this event.
        # Invalidate without connected sockets as well so the next view reads current state.
        try:
            from .services import live_view_cache
            live_view_cache.invalidate(device, event)
        except Exception as exc:  # noqa: BLE001 - Cache failures must not block real events.
            log.warning("实时视图缓存失效失败: %s", type(exc).__name__)
        from .services.cluster_bus import bus
        if bus.enabled and not _local:
            try:
                await bus.broadcast({"kind": "publish", "device": device, "event": event,
                                     **({"userId": user_id} if user_id is not None else {})})
            except Exception as exc:
                bus.last_refresh = 0
                log.warning("跨节点通知暂不可用: %s", type(exc).__name__)
                # Task facts were already committed. Clients reconnect and replay,
                # instead of reporting a failed write which actually succeeded.
                from .services.cluster_runtime import on_failure
                await on_failure()
        conns = [ws for ws in self._conns.get(device, ())
                 if user_id is None or self._users.get(ws, "") == str(user_id)]
        # A device can have several windows or sockets; fan out concurrently so one slow connection
        # does not impose its timeout on every other connection in sequence.
        dead = []
        if conns:
            results = await asyncio.gather(
                *(asyncio.wait_for(ws.send_json(event), timeout=3) for ws in conns),
                return_exceptions=True)
            dead = [ws for ws, result in zip(conns, results)
                    if isinstance(result, BaseException)]
        for ws in dead:
            await self.disconnect(device, ws)

    def online_devices(self) -> set[str]:
        from .services.cluster_runtime import remote_devices
        return set(self._conns.keys()) | remote_devices()

    def is_online(self, device: str) -> bool:
        return device in self.online_devices()


hub = Hub()
