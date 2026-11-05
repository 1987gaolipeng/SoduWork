"""Shared authentication cache protocol against a private, disposable Redis.

Set SODUWORK_TEST_REDIS_SERVER when redis-server is outside PATH. This suite
never accepts a Redis URL: it starts its own server on a temporary Unix socket.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import AsyncMock
import uuid

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-shared-auth-cache-tests")
os.environ.setdefault("ADMIN_PASS", "isolated-shared-auth-cache-tests")
os.environ["CLUSTER_REDIS_URL"] = ""

import redis
from redis.asyncio import Redis

from app.services.shared_auth_cache import AuthCacheUnavailable, SharedAuthCache


class FaultRedis:
    """Inject transport faults without replacing Redis's Lua implementation."""

    def __init__(self, connection):
        self.connection = connection
        self.fail = False
        self.stall = False

    def __getattr__(self, name):
        return getattr(self.connection, name)

    async def eval(self, *args, **kwargs):
        if self.fail:
            raise redis.ConnectionError("isolated Redis transport failure")
        if self.stall:
            await asyncio.Event().wait()
        return await self.connection.eval(*args, **kwargs)


class IsolatedRedisTestCase(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        binary = os.environ.get("SODUWORK_TEST_REDIS_SERVER") or shutil.which("redis-server")
        if not binary:
            raise RuntimeError(
                "Shared-auth protocol tests require redis-server; set "
                "SODUWORK_TEST_REDIS_SERVER to an isolated executable")
        cls.directory = tempfile.TemporaryDirectory(prefix="soduwork-auth-cache-test-")
        cls.socket = str(Path(cls.directory.name) / "redis.sock")
        cls.process = subprocess.Popen([
            binary, "--port", "0", "--unixsocket", cls.socket,
            "--unixsocketperm", "700", "--save", "", "--appendonly", "no",
            "--dir", cls.directory.name, "--loglevel", "warning",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        connection = redis.Redis(unix_socket_path=cls.socket, socket_timeout=.1)
        deadline = time.monotonic() + 5
        try:
            while time.monotonic() < deadline:
                if cls.process.poll() is not None:
                    raise RuntimeError("Isolated Redis exited before becoming ready")
                try:
                    connection.ping()
                    break
                except (redis.ConnectionError, redis.TimeoutError):
                    time.sleep(.02)
            else:
                raise RuntimeError("Isolated Redis did not become ready within five seconds")
        except BaseException:
            cls._stop_server()
            raise
        finally:
            connection.close()

    @classmethod
    def _stop_server(cls):
        if cls.process.poll() is None:
            cls.process.terminate()
            try:
                cls.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                cls.process.kill()
                cls.process.wait(timeout=3)
        cls.directory.cleanup()

    @classmethod
    def tearDownClass(cls):
        cls._stop_server()
        super().tearDownClass()

    async def asyncSetUp(self):
        self.redis = Redis(unix_socket_path=self.socket, socket_timeout=1)
        self.peer_redis = Redis(unix_socket_path=self.socket, socket_timeout=1)
        self.namespace = "auth-test-" + uuid.uuid4().hex
        self.first = SharedAuthCache(self.redis, namespace=self.namespace)
        self.second = SharedAuthCache(self.peer_redis, namespace=self.namespace)
        self.pending = []

    async def asyncTearDown(self):
        for task in self.pending:
            if not task.done():
                task.cancel()
        if self.pending:
            await asyncio.gather(*self.pending, return_exceptions=True)
        await self.redis.aclose()
        await self.peer_redis.aclose()

    def loader(self, value):
        async def read():
            return copy.deepcopy(value)
        return AsyncMock(side_effect=read)

    def start(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.pending.append(task)
        return task


class SharedAuthCacheTests(IsolatedRedisTestCase):
    async def test_two_nodes_share_cache_without_another_database_read(self):
        value = {"id": "pc", "owner_id": "alice", "auth_version": 3, "active": True}
        first_loader = self.loader(value)
        peer_loader = self.loader({"unexpected": True})
        self.assertEqual(await self.first.load("device", "pc", first_loader), value)
        self.assertEqual(await self.second.load("device", "pc", peer_loader), value)
        first_loader.assert_awaited_once()
        peer_loader.assert_not_awaited()

    async def test_namespaces_kinds_and_identifiers_do_not_share_payloads(self):
        for kind, identity in [("device", "same"), ("user", "same"), ("role", "same"),
                               ("user", "other")]:
            value = {"kind": kind, "id": identity}
            await self.first.load(kind, identity, self.loader(value))
        for kind, identity in [("device", "same"), ("user", "same"), ("role", "same"),
                               ("user", "other")]:
            loader = self.loader({"unexpected": True})
            self.assertEqual(await self.second.load(kind, identity, loader),
                             {"kind": kind, "id": identity})
            loader.assert_not_awaited()
        other = SharedAuthCache(self.redis, namespace=self.namespace + "-other")
        loader = self.loader({"id": "same", "deployment": "other"})
        self.assertEqual(await other.load("user", "same", loader),
                         {"id": "same", "deployment": "other"})
        loader.assert_awaited_once()

    async def test_absent_identity_is_not_negative_cached(self):
        missing = self.loader(None)
        self.assertIsNone(await self.first.load("user", "new", missing))
        self.assertIsNone(await self.second.load("user", "new", missing))
        self.assertEqual(missing.await_count, 2)
        created = {"id": "new", "active": True}
        self.assertEqual(await self.second.load("user", "new", self.loader(created)), created)

    async def test_entity_fence_invalidates_only_affected_identity(self):
        await self.first.load("user", "alice", self.loader({"active": True}))
        await self.first.load("user", "bob", self.loader({"active": True}))
        await self.first.load("role", "alice", self.loader({"permissions": ["read"]}))
        subjects = {("user", "alice")}
        await self.first.fence("transaction-a", subjects)
        revoked = self.loader({"active": False})
        for _ in range(2):
            self.assertEqual(await self.second.load("user", "alice", revoked), {"active": False})
        self.assertEqual(revoked.await_count, 2, "A writer fence must bypass cache fills too")
        for kind, identity, expected in [("user", "bob", {"active": True}),
                                         ("role", "alice", {"permissions": ["read"]})]:
            loader = self.loader({"unexpected": True})
            self.assertEqual(await self.second.load(kind, identity, loader), expected)
            loader.assert_not_awaited()
        await self.first.release("transaction-a", subjects)
        self.assertEqual(await self.second.load("user", "alice", revoked), {"active": False})
        self.assertEqual(await self.first.load("user", "alice", revoked), {"active": False})
        self.assertEqual(revoked.await_count, 3)

    async def test_class_fence_covers_existing_and_new_entities_without_other_kinds(self):
        for identity in ("a", "b"):
            await self.first.load("device", identity, self.loader({"version": 1}))
        await self.first.load("user", "a", self.loader({"version": 1}))
        subjects = {("device", "*")}
        await self.second.fence("bulk-device-change", subjects)
        for identity in ("a", "b", "new"):
            loader = self.loader({"version": 2})
            await self.first.load("device", identity, loader)
            await self.second.load("device", identity, loader)
            self.assertEqual(loader.await_count, 2)
        unaffected = self.loader({"version": 99})
        self.assertEqual(await self.first.load("user", "a", unaffected), {"version": 1})
        unaffected.assert_not_awaited()
        await self.second.release("bulk-device-change", subjects)
        fresh = self.loader({"version": 2})
        self.assertEqual(await self.first.load("device", "a", fresh), {"version": 2})
        self.assertEqual(await self.second.load("device", "a", fresh), {"version": 2})
        fresh.assert_awaited_once()

    async def test_releasing_one_writer_does_not_release_another_writer(self):
        subjects = {("user", "alice")}
        await self.first.fence("transaction-a", subjects)
        await self.second.fence("transaction-b", subjects)
        await self.first.release("transaction-a", subjects)
        loader = self.loader({"active": False})
        await self.first.load("user", "alice", loader)
        await self.second.load("user", "alice", loader)
        self.assertEqual(loader.await_count, 2)
        await self.second.release("transaction-b", subjects)
        await self.first.load("user", "alice", loader)
        await self.second.load("user", "alice", loader)
        self.assertEqual(loader.await_count, 3)

    async def test_class_and_entity_writers_both_protect_the_same_identity(self):
        await self.first.fence("class-write", {("role", "*")})
        await self.second.fence("role-write", {("role", "reader")})
        await self.first.release("class-write", {("role", "*")})
        loader = self.loader({"permissions": []})
        await self.first.load("role", "reader", loader)
        await self.second.load("role", "reader", loader)
        self.assertEqual(loader.await_count, 2)
        await self.second.release("role-write", {("role", "reader")})
        await self.first.load("role", "reader", loader)
        await self.second.load("role", "reader", loader)
        self.assertEqual(loader.await_count, 3)

    async def test_old_database_read_cannot_refill_after_committed_change(self):
        entered, resume = asyncio.Event(), asyncio.Event()
        async def stale_read():
            entered.set()
            await resume.wait()
            return {"active": True, "version": 1}
        old_request = self.start(self.first.load("user", "alice", stale_read))
        await asyncio.wait_for(entered.wait(), 2)
        subjects = {("user", "alice")}
        await self.second.fence("revoke", subjects)
        await self.second.release("revoke", subjects)
        fresh = self.loader({"active": False, "version": 2})
        self.assertEqual(await self.second.load("user", "alice", fresh), {"active": False, "version": 2})
        resume.set()
        await asyncio.wait_for(old_request, 2)
        self.assertEqual(await self.first.load("user", "alice", fresh), {"active": False, "version": 2})
        fresh.assert_awaited_once()

    async def test_key_loss_does_not_allow_old_inflight_fill_to_overwrite_new_generation(self):
        entered, resume = asyncio.Event(), asyncio.Event()
        async def stale_read():
            entered.set()
            await resume.wait()
            return {"version": 1}
        old_request = self.start(self.first.load("device", "pc", stale_read))
        await asyncio.wait_for(entered.wait(), 2)
        # This is the suite's private server, never an environment Redis URL.
        await self.redis.flushdb()
        fresh = self.loader({"version": 2})
        self.assertEqual(await self.second.load("device", "pc", fresh), {"version": 2})
        resume.set()
        await asyncio.wait_for(old_request, 2)
        self.assertEqual(await self.first.load("device", "pc", fresh), {"version": 2})
        fresh.assert_awaited_once()

    async def test_lost_scope_key_does_not_validate_a_surviving_old_payload(self):
        await self.first.load("device", "pc", self.loader({"version": 1}))
        scope_key = self.first.keys("device", "pc")[1]
        await self.redis.delete(scope_key)
        fresh = self.loader({"version": 2})
        self.assertEqual(await self.second.load("device", "pc", fresh), {"version": 2})
        fresh.assert_awaited_once()

    async def test_repeated_fence_for_one_transaction_does_not_leak_a_writer(self):
        subjects = {("device", "pc"), ("user", "alice")}
        await self.first.fence("transaction-a", subjects)
        await self.first.fence("transaction-a", subjects)
        await self.first.release("transaction-a", subjects)
        for kind, identity in subjects:
            loader = self.loader({"version": 2})
            await self.first.load(kind, identity, loader)
            await self.second.load(kind, identity, loader)
            loader.assert_awaited_once()

    async def test_read_transport_failure_falls_back_to_database(self):
        fault = FaultRedis(self.redis)
        cache = SharedAuthCache(fault, namespace=self.namespace)
        await cache.load("user", "alice", self.loader({"active": True}))
        fault.fail = True
        loader = self.loader({"active": False})
        self.assertEqual(await cache.load("user", "alice", loader), {"active": False})
        loader.assert_awaited_once()

    async def test_read_timeout_is_bounded_and_uses_database(self):
        fault = FaultRedis(self.redis)
        fault.stall = True
        cache = SharedAuthCache(fault, namespace=self.namespace, timeout_seconds=.03)
        loader = self.loader({"active": False})
        value = await asyncio.wait_for(cache.load("user", "alice", loader), 1)
        self.assertEqual(value, {"active": False})
        loader.assert_awaited_once()

    async def test_fence_failure_is_reported_to_block_the_permission_write(self):
        fault = FaultRedis(self.redis)
        fault.fail = True
        cache = SharedAuthCache(fault, namespace=self.namespace)
        with self.assertRaises(AuthCacheUnavailable):
            await cache.fence("revoke", {("user", "alice")})

    async def test_fence_timeout_is_bounded_and_rejects_the_permission_write(self):
        fault = FaultRedis(self.redis)
        fault.stall = True
        cache = SharedAuthCache(fault, namespace=self.namespace, timeout_seconds=.03)
        with self.assertRaises(AuthCacheUnavailable):
            await asyncio.wait_for(cache.fence("revoke", {("user", "alice")}), 1)

    async def test_release_failure_keeps_other_nodes_bypassing_the_cache(self):
        fault = FaultRedis(self.redis)
        cache = SharedAuthCache(fault, namespace=self.namespace)
        subjects = {("user", "alice")}
        await cache.load("user", "alice", self.loader({"active": True}))
        await cache.fence("revoke", subjects)
        fault.fail = True
        with self.assertRaises(redis.ConnectionError):
            await cache.release("revoke", subjects)
        fresh = self.loader({"active": False})
        await self.second.load("user", "alice", fresh)
        await self.second.load("user", "alice", fresh)
        self.assertEqual(fresh.await_count, 2)
        fault.fail = False
        await cache.release("revoke", subjects)
        await self.second.load("user", "alice", fresh)
        await cache.load("user", "alice", fresh)
        self.assertEqual(fresh.await_count, 3)

    async def test_expired_payload_is_reloaded_from_database(self):
        cache = SharedAuthCache(self.redis, namespace=self.namespace, ttl_seconds=1)
        await cache.load("role", "reader", self.loader({"permissions": ["read"]}))
        await asyncio.sleep(1.1)
        loader = self.loader({"permissions": []})
        self.assertEqual(await self.second.load("role", "reader", loader), {"permissions": []})
        loader.assert_awaited_once()

    async def test_database_failure_is_not_masked_or_cached_as_an_identity(self):
        broken_database = AsyncMock(side_effect=RuntimeError("isolated database unavailable"))
        with self.assertRaisesRegex(RuntimeError, "isolated database unavailable"):
            await self.first.load("device", "pc", broken_database)
        broken_database.assert_awaited_once()
        fresh = self.loader({"active": True})
        self.assertEqual(await self.second.load("device", "pc", fresh), {"active": True})
        fresh.assert_awaited_once()

    async def test_database_failure_under_a_writer_fence_is_not_retried(self):
        subjects = {("user", "alice")}
        await self.first.fence("writing", subjects)
        broken_database = AsyncMock(side_effect=RuntimeError("isolated database unavailable"))
        with self.assertRaisesRegex(RuntimeError, "isolated database unavailable"):
            await self.second.load("user", "alice", broken_database)
        broken_database.assert_awaited_once()
        await self.first.release("writing", subjects)

    async def test_database_failure_during_redis_outage_is_not_retried(self):
        fault = FaultRedis(self.redis)
        fault.fail = True
        cache = SharedAuthCache(fault, namespace=self.namespace)
        broken_database = AsyncMock(side_effect=RuntimeError("isolated database unavailable"))
        with self.assertRaisesRegex(RuntimeError, "isolated database unavailable"):
            await cache.load("user", "alice", broken_database)
        broken_database.assert_awaited_once()

    async def test_corrupted_payload_is_never_accepted_as_an_identity(self):
        value = {"id": "alice", "active": True}
        await self.first.load("user", "alice", self.loader(value))
        payload_key = self.first.keys("user", "alice")[2]
        original = json.loads(await self.redis.get(payload_key))
        corruptions = [b"not-json", b"{}", b"[]",
                       json.dumps(original[:2]).encode(),
                       json.dumps([*original[:2], "not-an-identity"]).encode(),
                       json.dumps([*original[:2], None]).encode()]
        for corrupted in corruptions:
            with self.subTest(payload=corrupted):
                await self.redis.set(payload_key, corrupted)
                fresh = self.loader(value)
                self.assertEqual(await self.second.load("user", "alice", fresh), value)
                fresh.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
