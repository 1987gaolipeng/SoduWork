"""API timestamps must carry a UTC offset even when SQLite returns naive values."""
import os
import unittest
from datetime import datetime, timedelta, timezone

os.environ.setdefault("AUTH_SECRET", "isolated-timestamp-test-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-timestamp-test-admin")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.pool import StaticPool

from app import automation_models as am
from app.api import account_profile
from app.memory_record_models import MemoryRecord
from app.models import Base, Client
from app.services import execution_sessions, memory_records
from app.timestamps import iso_utc


class IsoUtcTests(unittest.TestCase):
    def test_naive_values_are_utc(self):
        self.assertEqual(iso_utc(datetime(2026, 11, 17, 9, 24, 39)), "2026-11-17T09:24:39+00:00")

    def test_aware_values_keep_their_instant(self):
        beijing = datetime(2026, 11, 17, 17, 24, 39, tzinfo=timezone(timedelta(hours=8)))
        self.assertEqual(iso_utc(beijing), "2026-11-17T09:24:39+00:00")

    def test_none(self):
        self.assertIsNone(iso_utc(None))


STAMP = datetime(2026, 11, 17, 9, 24, 39, tzinfo=timezone.utc)


class SqliteRoundTripTests(unittest.IsolatedAsyncioTestCase):
    async def _sessions(self, *tables):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:", poolclass=StaticPool)
        self.addAsyncCleanup(engine.dispose)
        async with engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(
                sync, tables=[table.__table__ for table in tables]))
        return async_sessionmaker(engine, expire_on_commit=False)

    def assertSameUtcInstant(self, text):
        """An explicit +00:00 offset, and the instant that was stored."""
        self.assertTrue(text.endswith("+00:00"), text)
        self.assertEqual(datetime.fromisoformat(text), STAMP)

    async def test_memory_record_read_back_from_sqlite_has_an_offset(self):
        stamp = STAMP
        sessions = await self._sessions(MemoryRecord)
        async with sessions() as session:
            session.add(MemoryRecord(id="m1", scope="personal", owner_user_id="u1", memory_key="k",
                                     title="t", created_at=stamp, updated_at=stamp))
            await session.commit()
        async with sessions() as session:
            row = await session.get(MemoryRecord, "m1")
            # This is the condition the serializers must handle.
            self.assertIsNone(row.created_at.tzinfo)
            view = memory_records.view(row)
        self.assertEqual(view["createdAt"], "2026-11-17T09:24:39+00:00")
        self.assertEqual(view["updatedAt"], "2026-11-17T09:24:39+00:00")

    async def test_device_last_seen_read_back_from_sqlite_has_an_offset(self):
        sessions = await self._sessions(Client)
        async with sessions() as session:
            session.add_all([
                Client(id="desk", user_ref="u1", auth_state="active", last_seen_at=STAMP),
                Client(id="phone", user_ref="u1", auth_state="active", last_seen_at=None),
            ])
            await session.commit()
        async with sessions() as session:
            current = await session.get(Client, "desk")
            self.assertIsNone(current.last_seen_at.tzinfo)
            items = {item["id"]: item for item in
                     (await account_profile.devices(client=current, session=session))["items"]}
        self.assertSameUtcInstant(items["desk"]["lastSeenAt"])
        self.assertIsNone(items["phone"]["lastSeenAt"])

    async def test_execution_event_read_back_from_sqlite_has_an_offset(self):
        sessions = await self._sessions(am.ExecutionEvent)
        async with sessions() as session:
            session.add(am.ExecutionEvent(id="e1", session_id="s1", seq=1, at=STAMP))
            await session.commit()
        async with sessions() as session:
            row = await session.get(am.ExecutionEvent, "e1")
            self.assertIsNone(row.at.tzinfo)
            self.assertSameUtcInstant(execution_sessions._event_api(row)["at"])
            # An event without a time keeps serializing as an empty string.
            row.at = None
            self.assertEqual(execution_sessions._event_api(row)["at"], "")


if __name__ == "__main__":
    unittest.main()
