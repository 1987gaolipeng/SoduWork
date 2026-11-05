"""Redis incarnation/eviction and staged-rollout boundaries, isolated only."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from redis.asyncio import BlockingConnectionPool, Redis
from redis.asyncio.connection import UnixDomainSocketConnection
from redis.exceptions import ConnectionError

from test_shared_auth_cache import IsolatedRedisTestCase
from app.services import shared_auth_cache as cache_module
from app.services.shared_auth_cache import AuthCacheUnavailable, PinnedAuthConnection, SharedAuthCache


class AuthConnectionTests(IsolatedRedisTestCase):
    async def pinned_client(self, expected):
        connection = type("TestPinnedConnection", (PinnedAuthConnection, UnixDomainSocketConnection),
                          {"expected_run_id": expected})
        pool = BlockingConnectionPool(connection_class=connection, path=self.socket,
                                      max_connections=2, socket_timeout=.3, timeout=.3)
        client = Redis(connection_pool=pool)
        self.addAsyncCleanup(pool.disconnect)
        self.addAsyncCleanup(client.aclose)
        return client

    async def test_matching_incarnation_can_share_cache_after_connection_reopens(self):
        run_id = (await self.redis.info("server"))["run_id"]
        client = await self.pinned_client(run_id)
        cache = SharedAuthCache(client, namespace=self.namespace)
        loader = AsyncMock(return_value={"active": True})
        self.assertEqual(await cache.load("user", "alice", loader), {"active": True})
        await client.connection_pool.disconnect()
        self.assertEqual(await cache.load("user", "alice", loader), {"active": True})
        loader.assert_awaited_once()

    async def test_changed_incarnation_never_accepts_restored_allow_and_blocks_writes(self):
        await self.first.load("user", "alice", AsyncMock(return_value={"active": True}))
        client = await self.pinned_client("0" * 40)
        cache = SharedAuthCache(client, namespace=self.namespace)
        loader = AsyncMock(return_value={"active": False})
        for _ in range(2):
            self.assertEqual(await cache.load("user", "alice", loader), {"active": False})
        self.assertEqual(loader.await_count, 2)
        with self.assertRaises(AuthCacheUnavailable):
            await cache.fence("transaction", {("user", "alice")})

    async def test_metadata_eviction_policy_is_rejected(self):
        run_id = (await self.redis.info("server"))["run_id"]
        client = await self.pinned_client(run_id)
        await self.redis.config_set("maxmemory-policy", "allkeys-lru")
        try:
            for _ in range(2):
                with self.assertRaisesRegex(ConnectionError, "maintenance revalidation"):
                    await client.ping()
        finally:
            await self.redis.config_set("maxmemory-policy", "noeviction")

    async def test_writer_only_stage_does_not_read_or_fill_cache(self):
        await self.first.load("user", "alice", AsyncMock(return_value={"active": True}))
        loader = AsyncMock(return_value={"active": False})
        with patch.object(cache_module, "get_cache", return_value=self.first), \
                patch.object(cache_module, "reads_enabled", return_value=False):
            self.assertEqual(await cache_module.load("user", "alice", loader), {"active": False})
            self.assertEqual(await cache_module.load("user", "alice", loader), {"active": False})
        self.assertEqual(loader.await_count, 2)

    async def test_factory_requires_pin_and_separates_auth_deployment_generation(self):
        from app import config
        settings = SimpleNamespace(auth_cache_enabled=False, auth_cache_fencing_enabled=True,
            cluster_redis_url="redis://127.0.0.1:1/0", cluster_namespace="fixture",
            auth_cache_generation="rollout-2", auth_cache_redis_run_id="")
        with patch.object(config, "get_settings", return_value=settings), \
                patch.object(cache_module, "_cache", None):
            with self.assertRaises(AuthCacheUnavailable):
                cache_module.get_cache()
            settings.auth_cache_redis_run_id = "a" * 40
            cache = cache_module.get_cache()
            self.assertTrue(cache.prefix.startswith("fixture:rollout-2:auth:v1:"))
            await cache_module.close()
            self.assertIsNone(cache_module._cache)
            await cache_module.close()
