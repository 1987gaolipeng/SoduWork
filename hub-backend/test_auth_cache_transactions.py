"""Authentication invalidation through real SQLAlchemy transaction boundaries."""
from __future__ import annotations

import asyncio
from collections import Counter
from datetime import datetime, timezone
import os
from pathlib import Path
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ.setdefault("AUTH_SECRET", "isolated-auth-cache-transaction-tests")
os.environ.setdefault("ADMIN_PASS", "isolated-auth-cache-transaction-tests")

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import Base
from app.models import Client, Role, User
from app.services import auth_cache_transactions, shared_auth_cache
from app.services.auth_cache_transactions import AuthSession
from app.services.shared_auth_cache import AuthCacheUnavailable, SharedAuthCache
from test_shared_auth_cache import FaultRedis, IsolatedRedisTestCase


class AuthCacheTransactionTests(IsolatedRedisTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.db_path = Path(self.directory.name) / (self.namespace + ".db")
        self.engine = create_async_engine("sqlite+aiosqlite:///" + self.db_path.as_posix())
        self.sessions = async_sessionmaker(
            self.engine, expire_on_commit=False, class_=AsyncSession,
            sync_session_class=AuthSession)
        self.read_sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(
                sync, tables=[Client.__table__, User.__table__, Role.__table__]))
        async with self.read_sessions() as session:
            session.add_all([
                Role(id="reader", name="Reader", permissions=["read", "write"]),
                User(id="alice", username="alice", is_active=True, auth_version=1,
                     role_id="reader", org_id="department-a"),
                User(id="bob", username="bob", is_active=True, auth_version=1,
                     role_id="reader", org_id="department-a"),
                Client(id="pc", user_ref="alice", auth_state="active", auth_version=1,
                       config={"automationConversationV1": 1}),
            ])
            await session.commit()
        self.read_counts = Counter()
        self.cache_patch = patch.object(shared_auth_cache, "get_cache", return_value=self.first)
        self.transaction_patch = patch.object(auth_cache_transactions, "get_cache", return_value=self.first)
        self.cache_patch.start()
        self.transaction_patch.start()

    async def asyncTearDown(self):
        self.transaction_patch.stop()
        self.cache_patch.stop()
        await self.engine.dispose()
        await super().asyncTearDown()

    def database_loader(self, kind, identity):
        async def read():
            self.read_counts[kind, identity] += 1
            async with self.read_sessions() as session:
                if kind == "user":
                    statement = select(User.id, User.is_active, User.auth_version,
                                       User.role_id, User.org_id).where(User.id == identity)
                elif kind == "device":
                    statement = select(Client.id, Client.user_ref, Client.auth_state,
                                       Client.auth_version).where(Client.id == identity)
                else:
                    statement = select(Role.id, Role.permissions).where(Role.id == identity)
                row = (await session.execute(statement)).mappings().one_or_none()
                return dict(row) if row else None
        return read

    async def snapshot(self, kind, identity, *, peer=False):
        cache = self.second if peer else self.first
        return await cache.load(kind, identity, self.database_loader(kind, identity))

    async def assert_fenced(self, kind, identity):
        before = self.read_counts[kind, identity]
        await self.snapshot(kind, identity)
        await self.snapshot(kind, identity, peer=True)
        self.assertEqual(self.read_counts[kind, identity], before + 2)

    async def assert_shared_again(self, kind, identity):
        before = self.read_counts[kind, identity]
        first = await self.snapshot(kind, identity)
        second = await self.snapshot(kind, identity, peer=True)
        self.assertEqual(first, second)
        self.assertEqual(self.read_counts[kind, identity], before + 1)
        return first

    async def test_orm_user_disable_revokes_peer_snapshot_after_commit(self):
        await self.snapshot("user", "alice")
        async with self.sessions() as session:
            user = await session.get(User, "alice")
            user.is_active = False
            user.auth_version += 1
            await session.flush()
            await self.assert_fenced("user", "alice")
            await session.commit()
        row = await self.assert_shared_again("user", "alice")
        self.assertFalse(row["is_active"])
        self.assertEqual(row["auth_version"], 2)

    async def test_orm_device_transfer_revokes_peer_binding(self):
        await self.snapshot("device", "pc")
        async with self.sessions() as session:
            device = await session.get(Client, "pc")
            device.user_ref = "bob"
            device.auth_version += 1
            await session.commit()
        row = await self.assert_shared_again("device", "pc")
        self.assertEqual((row["user_ref"], row["auth_version"]), ("bob", 2))

    async def test_orm_role_permission_change_revokes_peer_permissions(self):
        await self.snapshot("role", "reader")
        async with self.sessions() as session:
            role = await session.get(Role, "reader")
            role.permissions = ["read"]
            await session.commit()
        self.assertEqual((await self.assert_shared_again("role", "reader"))["permissions"], ["read"])

    async def test_user_role_and_department_changes_invalidate_without_token_version_change(self):
        await self.snapshot("user", "alice")
        async with self.sessions() as session:
            user = await session.get(User, "alice")
            user.role_id = None
            user.org_id = "department-b"
            await session.commit()
        row = await self.assert_shared_again("user", "alice")
        self.assertIsNone(row["role_id"])
        self.assertEqual(row["org_id"], "department-b")
        self.assertEqual(row["auth_version"], 1)

    async def test_bulk_updates_of_user_device_and_role_invalidate_their_classes(self):
        cases = [
            ("user", "alice", update(User).where(User.id == "alice").values(is_active=False),
             "is_active", False),
            ("device", "pc", update(Client).where(Client.id == "pc").values(
                auth_state="revoked", auth_version=Client.auth_version + 1), "auth_state", "revoked"),
            ("role", "reader", update(Role).where(Role.id == "reader").values(permissions=[]),
             "permissions", []),
        ]
        for kind, identity, statement, field, expected in cases:
            with self.subTest(kind=kind):
                await self.snapshot(kind, identity)
                async with self.sessions() as session:
                    await session.execute(statement)
                    await self.assert_fenced(kind, identity)
                    await session.commit()
                self.assertEqual((await self.assert_shared_again(kind, identity))[field], expected)

    async def test_bulk_delete_cannot_leave_a_cached_identity_alive(self):
        for kind, model, identity in [("user", User, "alice"), ("device", Client, "pc"),
                                       ("role", Role, "reader")]:
            with self.subTest(kind=kind):
                await self.snapshot(kind, identity)
                async with self.sessions() as session:
                    await session.execute(delete(model).where(model.id == identity))
                    await session.commit()
                self.assertIsNone(await self.snapshot(kind, identity, peer=True))

    async def test_bulk_parameter_permissions_are_fenced_alongside_unrelated_values(self):
        now = datetime.now(timezone.utc)
        cases = [
            ("user", "alice", update(User).values(last_login_at=now),
             "is_active", False),
            ("device", "pc", update(Client).values(last_seen_at=now),
             "auth_state", "revoked"),
            ("role", "reader", update(Role).values(name="Updated reader"),
             "permissions", []),
        ]
        for kind, identity, statement, field, value in cases:
            with self.subTest(kind=kind):
                await self.snapshot(kind, identity)
                async with self.sessions() as session:
                    await session.execute(statement, [{"id": identity, field: value}])
                    await self.assert_fenced(kind, identity)
                    await session.commit()
                self.assertEqual((await self.assert_shared_again(kind, identity))[field], value)

    async def test_noop_statement_does_not_hide_parameter_revocation(self):
        await self.snapshot("user", "alice")
        async with self.sessions() as session:
            await session.execute(update(User).values(id=User.id),
                                  [{"id": "alice", "is_active": False}])
            await session.commit()
        self.assertFalse((await self.snapshot("user", "alice", peer=True))["is_active"])

    async def test_nested_commit_cannot_release_the_outer_transaction_fence(self):
        await self.snapshot("role", "reader")
        async with self.sessions() as session:
            async with session.begin():
                async with session.begin_nested():
                    role = await session.get(Role, "reader")
                    role.permissions = []
                    await session.flush()
                await self.assert_fenced("role", "reader")
        self.assertEqual((await self.assert_shared_again("role", "reader"))["permissions"], [])

    async def test_nested_rollback_retains_the_outer_fence_until_outer_completion(self):
        await self.snapshot("user", "alice")
        async with self.sessions() as session:
            outer = await session.begin()
            nested = await session.begin_nested()
            user = await session.get(User, "alice")
            user.is_active = False
            await session.flush()
            await nested.rollback()
            await self.assert_fenced("user", "alice")
            await outer.commit()
        self.assertTrue((await self.assert_shared_again("user", "alice"))["is_active"])

    async def test_failed_fence_cannot_be_bypassed_by_retrying_commit(self):
        await self.snapshot("user", "alice")
        fault = FaultRedis(self.redis)
        failing_cache = SharedAuthCache(fault, namespace=self.namespace)
        self.transaction_patch.stop()
        self.transaction_patch = patch.object(auth_cache_transactions, "get_cache", return_value=failing_cache)
        self.transaction_patch.start()
        async with self.sessions() as session:
            user = await session.get(User, "alice")
            user.is_active = False
            fault.fail = True
            with self.assertRaises(AuthCacheUnavailable):
                await session.flush()
            fault.fail = False
            with self.assertRaises(AuthCacheUnavailable):
                await session.commit()
            await session.rollback()
            self.assertTrue((await self.database_loader("user", "alice")())["is_active"])
            user = await session.get(User, "alice")
            user.is_active = False
            await session.commit()
        self.assertFalse((await self.assert_shared_again("user", "alice"))["is_active"])

    async def test_first_bulk_fence_failure_recovers_after_explicit_rollback(self):
        fault = FaultRedis(self.redis)
        cache = SharedAuthCache(fault, namespace=self.namespace)
        with patch.object(auth_cache_transactions, "get_cache", return_value=cache):
            async with self.sessions() as session:
                self.assertFalse(session.in_transaction())
                fault.fail = True
                with self.assertRaises(AuthCacheUnavailable):
                    await session.execute(update(User).where(User.id == "alice").values(is_active=False))
                fault.fail = False
                await session.rollback()
                self.assertNotIn("auth_cache_writer", session.info)
                self.assertTrue((await self.database_loader("user", "alice")())["is_active"])
                await session.execute(update(User).where(User.id == "alice").values(is_active=False))
                await session.commit()
        self.assertFalse((await self.assert_shared_again("user", "alice"))["is_active"])

    async def test_first_bulk_lost_fence_reply_is_released_by_rollback_or_close(self):
        class LostFenceReply(FaultRedis):
            async def eval(inner, script, *args, **kwargs):
                result = await inner.connection.eval(script, *args, **kwargs)
                if script == shared_auth_cache._FENCE:
                    raise ConnectionError("Isolated fence reply lost after applying")
                return result
        cache = SharedAuthCache(LostFenceReply(self.redis), namespace=self.namespace)
        for cleanup in ("rollback", "close"):
            with self.subTest(cleanup=cleanup), patch.object(
                    auth_cache_transactions, "get_cache", return_value=cache):
                async with self.sessions() as session:
                    with self.assertRaises(AuthCacheUnavailable):
                        await session.execute(update(User).where(User.id == "alice").values(is_active=False))
                    self.assertEqual(await self.redis.hlen(self.first.scope("user", "*")), 2)
                    await getattr(session, cleanup)()
                    self.assertNotIn("auth_cache_writer", session.info)
                self.assertEqual(await self.redis.hlen(self.first.scope("user", "*")), 1)
                self.assertTrue((await self.assert_shared_again("user", "alice"))["is_active"])

    async def test_presence_writes_do_not_discard_device_identity_cache(self):
        await self.snapshot("device", "pc")
        async with self.sessions() as session:
            device = await session.get(Client, "pc")
            device.last_seen_at = datetime.now(timezone.utc)
            await session.commit()
        async with self.sessions() as session:
            await session.execute(update(Client).where(Client.id == "pc").values(
                last_seen_at=datetime.now(timezone.utc)))
            await session.commit()
        await self.snapshot("device", "pc", peer=True)
        self.assertEqual(self.read_counts["device", "pc"], 1)

    async def test_two_live_transactions_do_not_release_each_others_writer(self):
        await self.snapshot("user", "alice")
        async with self.sessions() as first, self.sessions() as second:
            await first.execute(update(User).where(User.id == "alice").values(is_active=False))
            waiting_write = self.start(second.execute(update(User).where(User.id == "bob").values(
                is_active=False)))
            async def both_fenced():
                key = self.first.scope("user", "*")
                while await self.redis.hlen(key) < 3:
                    await asyncio.sleep(.005)
            await asyncio.wait_for(both_fenced(), 2)
            await first.commit()
            await asyncio.wait_for(waiting_write, 2)
            await self.assert_fenced("user", "alice")
            await second.commit()
        self.assertFalse((await self.assert_shared_again("user", "alice"))["is_active"])
        self.assertFalse((await self.assert_shared_again("user", "bob"))["is_active"])

    async def test_primary_key_change_invalidates_both_old_and_new_identity(self):
        for kind, model, identity in [("user", User, "alice"), ("device", Client, "pc"),
                                       ("role", Role, "reader")]:
            with self.subTest(kind=kind):
                await self.snapshot(kind, identity)
                async with self.sessions() as session:
                    row = await session.get(model, identity)
                    row.id = identity + "-new"
                    await session.commit()
                self.assertIsNone(await self.snapshot(kind, identity, peer=True))
                self.assertEqual((await self.snapshot(kind, identity + "-new", peer=True))["id"],
                                 identity + "-new")

    async def test_release_failure_does_not_misreport_a_successful_commit_as_rollback(self):
        await self.snapshot("user", "alice")
        fault = FaultRedis(self.redis)
        failing_cache = SharedAuthCache(fault, namespace=self.namespace)
        self.transaction_patch.stop()
        self.transaction_patch = patch.object(auth_cache_transactions, "get_cache", return_value=failing_cache)
        self.transaction_patch.start()
        async with self.sessions() as session:
            user = await session.get(User, "alice")
            user.is_active = False
            await session.flush()
            fault.fail = True
            with self.assertLogs("uvicorn.error", level="ERROR"):
                await session.commit()
        self.assertFalse((await self.database_loader("user", "alice")())["is_active"])
        await self.assert_fenced("user", "alice")


if __name__ == "__main__":
    import unittest
    unittest.main()
