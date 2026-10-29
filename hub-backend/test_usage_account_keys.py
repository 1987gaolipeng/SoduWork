"""One reused device/conversation ID cannot rewrite another account's usage."""
import os
import unittest
from types import SimpleNamespace

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ.setdefault("AUTH_SECRET", "isolated-usage-account-secret-over-32-characters")
os.environ.setdefault("ADMIN_PASS", "isolated-usage-account-password")

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.db import Base
from app.services import usage_ledger


class UsageAccountKeyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
                models.User.__table__, models.AIUsageEvent.__table__, models.AIUsageDaily.__table__]))
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.session.add_all([models.User(id="first", username="first", org_id="first-org"),
                              models.User(id="second", username="second", org_id="second-org")])
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()

    async def report(self, user, tokens):
        row = await usage_ledger.from_client(self.session, SimpleNamespace(id="shared-device", user_ref=user), {
            "sourceId": "same-conversation", "usage": {"totalTokens": tokens}})
        await self.session.commit()
        return row

    async def test_new_reports_use_separate_account_counters_and_keep_replays_idempotent(self):
        first = await self.report("first", 10)
        first_id, first_key = first.id, first.idempotency_key
        second = await self.report("second", 20)
        self.assertNotEqual(first_id, second.id)
        self.assertNotEqual(first_key, second.idempotency_key)
        repeated = await self.report("second", 30)
        self.assertEqual(repeated.id, second.id)
        await self.session.refresh(first)
        self.assertEqual((first.billing_user_id, first.org_id, first.total_tokens), ("first", "first-org", 10))
        self.assertEqual(len((await self.session.scalars(select(models.AIUsageEvent))).all()), 2)

    async def test_legacy_key_updates_only_its_proven_original_account(self):
        legacy = await usage_ledger.upsert_cumulative(self.session, "client:shared-device:same-conversation", {
            "client_id": "shared-device", "billing_user_id": "first", "actor_user_id": "first",
            "org_id": "first-org", "source_id": "same-conversation", "total_tokens": 5})
        await self.session.commit()
        original = await self.report("first", 10)
        self.assertEqual(original.id, legacy.id)
        self.assertEqual(original.total_tokens, 10)
        second = await self.report("second", 20)
        self.assertNotEqual(second.id, legacy.id)
        await self.session.refresh(legacy)
        self.assertEqual((legacy.billing_user_id, legacy.org_id, legacy.total_tokens), ("first", "first-org", 10))
        again = await self.report("first", 15)
        self.assertEqual(again.id, legacy.id)
        self.assertEqual(again.total_tokens, 15)
        await self.session.refresh(second)
        self.assertEqual((second.billing_user_id, second.total_tokens), ("second", 20))


if __name__ == "__main__":
    unittest.main()
