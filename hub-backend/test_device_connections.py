"""Isolated revocation tests; no database, Redis, sockets or process startup."""
import asyncio
from collections import defaultdict
from contextlib import ExitStack
import unittest
from unittest.mock import AsyncMock, patch


def setUpModule():
    global resources, connections, cluster_bus, Hub
    resources = ExitStack()
    from app import config
    settings = config.Settings(_env_file=None, database_url="sqlite+aiosqlite:///:memory:",
        auth_secret="isolated-device-revocation-secret-over-32-characters",
        admin_pass="isolated-device-revocation-password", soduwork_env="development", cluster_redis_url="")
    resources.enter_context(patch.object(config, "get_settings", return_value=settings))
    from app.services import device_connections as connections, cluster_bus
    from app.realtime import Hub


def tearDownModule():
    resources.close()


class DeviceRevocationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.resources = ExitStack()
        self.addCleanup(self.resources.close)
        self.hub = Hub()
        self.resources.enter_context(patch.object(connections, "realtime_hub", self.hub))
        self.resources.enter_context(patch.object(connections, "_terminals", defaultdict(set)))
        self.resources.enter_context(patch.object(connections, "_lock", asyncio.Lock()))
        self.resources.enter_context(patch.object(cluster_bus.bus, "enabled", True))
        self.broadcast = self.resources.enter_context(patch.object(cluster_bus.bus, "broadcast", new=AsyncMock()))
        self.runner = self.resources.enter_context(patch.object(connections.runner_hub, "disconnect_client", new=AsyncMock()))
        self.event, self.terminal = AsyncMock(), AsyncMock()
        self.hub._conns["device"].add(self.event)
        self.hub._users[self.event] = "account"
        await connections.register_terminal("device", self.terminal)

    async def test_stalled_cluster_broadcast_does_not_block_local_revocation(self):
        async def stall(*_args, **_kwargs):
            await asyncio.Event().wait()
        self.broadcast.side_effect = stall
        pending = asyncio.create_task(connections.disconnect("device", 4401))
        try:
            # Drain scheduled callbacks, rather than impose a millisecond wall
            # deadline that can expire under the full regression suite's load.
            for _ in range(5):
                await asyncio.sleep(0)
            self.event.close.assert_awaited_once_with(code=4401)
            self.terminal.close.assert_awaited_once_with(code=4401)
            self.runner.assert_awaited_once_with("device", 4401, _local=True)
            self.assertNotIn("device", self.hub._conns)
            self.assertNotIn("device", connections._terminals)
            self.assertFalse(pending.done(), "cluster delivery remains in flight independently")
        finally:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)

    async def test_stalled_event_close_does_not_block_terminal_runner_or_cluster(self):
        async def stall(*_args, **_kwargs):
            await asyncio.Event().wait()
        self.event.close.side_effect = stall
        pending = asyncio.create_task(connections.disconnect("device", 4401))
        try:
            for _ in range(5):
                await asyncio.sleep(0)
            self.terminal.close.assert_awaited_once_with(code=4401)
            self.runner.assert_awaited_once_with("device", 4401, _local=True)
            self.broadcast.assert_awaited_once_with({"kind": "revoke", "device": "device", "code": 4401})
            self.assertFalse(pending.done(), "a stalled event close does not suppress the other channels")
        finally:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)

    async def test_healthy_revocation_closes_every_channel_and_broadcasts_once(self):
        await connections.disconnect("device", 4401)
        self.event.close.assert_awaited_once_with(code=4401)
        self.terminal.close.assert_awaited_once_with(code=4401)
        self.runner.assert_awaited_once_with("device", 4401, _local=True)
        self.broadcast.assert_awaited_once_with({"kind": "revoke", "device": "device", "code": 4401})

    async def test_received_cluster_revocation_closes_locally_without_rebroadcast(self):
        await connections.disconnect("device", 4401, _local=True)
        self.event.close.assert_awaited_once_with(code=4401)
        self.terminal.close.assert_awaited_once_with(code=4401)
        self.runner.assert_awaited_once_with("device", 4401, _local=True)
        self.broadcast.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
