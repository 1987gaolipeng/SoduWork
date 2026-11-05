"""Real isolated Redis capability intersection; never connects to configured Redis."""
import asyncio
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-native-push-redis-tests")
os.environ.setdefault("ADMIN_PASS", "isolated-native-push-redis-tests")

from redis.asyncio import Redis
from app.services import native_discovery as discovery
from app.services.cluster_bus import PacketCodec


class RedisNegotiationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        binary = os.environ.get("SODUWORK_TEST_REDIS_SERVER") or shutil.which("redis-server")
        if not binary:
            self.skipTest("isolated redis-server binary required")
        self.directory = tempfile.TemporaryDirectory(prefix="native-push-redis-")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]
        self.process = subprocess.Popen([binary, "--bind", "127.0.0.1", "--port", str(port),
            "--save", "", "--appendonly", "no", "--dir", self.directory.name],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.redis = Redis(host="127.0.0.1", port=port, socket_connect_timeout=.2, socket_timeout=.2)
        for _ in range(50):
            try:
                await self.redis.ping(); break
            except Exception:
                if self.process.poll() is not None:
                    raise RuntimeError("isolated Redis did not start")
                await asyncio.sleep(.02)
        else:
            raise RuntimeError("isolated Redis startup timed out")
        prefix = "isolated-push-" + uuid.uuid4().hex
        self.bus = SimpleNamespace(enabled=True, healthy=True, redis=self.redis,
            settings=SimpleNamespace(cluster_lease_seconds=30), codec=PacketCodec("isolated-secret", prefix),
            key=lambda kind, value="": f"{prefix}:{kind}:{value}")
        self.patcher = patch.object(discovery, "bus", self.bus)
        self.patcher.start()

    async def asyncTearDown(self):
        self.patcher.stop()
        await self.redis.aclose()
        self.process.terminate()
        await asyncio.to_thread(self.process.wait, 3)
        self.directory.cleanup()

    async def node(self, node, topics=None, *, age=0):
        state = {"node": node, "label": node, "at": time.time(), "devices": ["pc"], "runners": []}
        if topics is not None:
            state["nativeDiscoveryTopics"] = topics
        await self.redis.set(self.bus.key("state", node), self.bus.codec.encode(state), ex=60)
        await self.redis.zadd(self.bus.key("nodes"), {node: time.time() - age})

    async def test_cluster_snapshot_envelope_round_trip_and_old_node_blocks_all_new_topics(self):
        requested = ["automation-inbox", "conversation-projects"]
        await self.node("new", requested)
        self.assertEqual(await discovery.confirmed_topics(requested), requested)
        await self.node("old")
        self.assertEqual(await discovery.confirmed_topics(requested), [])
        await self.node("old", ["automation-inbox"])
        self.assertEqual(await discovery.confirmed_topics(requested), ["automation-inbox"])
        await self.node("old", requested)
        self.assertEqual(await discovery.confirmed_topics(requested), requested)

    async def test_missing_or_corrupt_member_state_never_inherits_other_nodes_support(self):
        await self.node("new", ["automation-inbox"])
        await self.node("unknown", ["automation-inbox"])
        await self.redis.delete(self.bus.key("state", "unknown"))
        self.assertEqual(await discovery.confirmed_topics(["automation-inbox"]), [])
        await self.redis.set(self.bus.key("state", "unknown"), b"corrupt")
        self.assertEqual(await discovery.confirmed_topics(["automation-inbox"]), [])

    async def test_only_expired_registry_members_are_excluded_and_redis_loss_disables_v2(self):
        await self.node("new", ["automation-inbox"])
        await self.node("old", age=29)
        self.assertEqual(await discovery.confirmed_topics(["automation-inbox"]), [])
        await self.node("old", age=31)
        self.assertEqual(await discovery.confirmed_topics(["automation-inbox"]), ["automation-inbox"])
        self.process.terminate(); await asyncio.to_thread(self.process.wait, 3)
        self.assertEqual(await discovery.confirmed_topics(["automation-inbox"]), [])


if __name__ == "__main__": unittest.main()
