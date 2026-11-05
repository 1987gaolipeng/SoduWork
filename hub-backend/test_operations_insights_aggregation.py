"""Isolated SQL read-model and concurrent snapshot regression tests."""
import asyncio
import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ.setdefault("AUTH_SECRET", "operations-insights-isolated-test")
os.environ.setdefault("ADMIN_PASS", "operations-insights-isolated-test")

from sqlalchemy import select
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app import automation_models as am, models
from app.db import Base
from app.services import operations_insights as stats
from app.services import operations_insights_cache as cache


class AggregationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.now = datetime(2026, 11, 4, 8, tzinfo=timezone.utc)
        self.clock = patch.object(stats, "_now", return_value=self.now)
        self.clock.start()

    async def asyncTearDown(self):
        self.clock.stop()
        await self.engine.dispose()

    async def test_beijing_boundaries_empty_days_states_and_distinct_clients(self):
        # 16:00 UTC is the next product day, irrespective of the server timezone.
        midnight = datetime(2026, 11, 3, 16, tzinfo=timezone.utc)
        start = midnight - timedelta(days=29)
        stamps = [start - timedelta(microseconds=1), start, midnight - timedelta(microseconds=1),
                  midnight, midnight + timedelta(days=1)]
        async with AsyncSession(self.engine) as session:
            for i, stamp in enumerate(stamps):
                session.add(models.Task(id=f"t{i}", title="task", status="done", created_at=stamp))
            for i, client in enumerate(["a", "a", "b", ""]):
                session.add(am.ExecutionSession(id=f"e{i}", task_id="t", ref=f"e{i}",
                    runner_client_id=client, created_at=midnight))
            for i, state in enumerate(["succeeded", "failed", "cancelled", "running", "queued"]):
                session.add(models.AiScheduleRun(id=f"r{i}", schedule_id="s", state=state, started_at=midnight))
            await session.commit()
            data = await stats._trend(session)
        self.assertEqual(len(data), 30)
        self.assertEqual(sum(row["tasksCreated"] for row in data), 3)
        self.assertEqual(data[0]["tasksCreated"], 1)
        self.assertEqual(data[-2]["tasksCreated"], 1)
        self.assertTrue(all(row["tasksCreated"] == 0 for row in data[1:-2]))
        self.assertEqual({key: data[-1][key] for key in ("activeClients", "aiSessions", "automationRuns",
            "automationCompleted", "automationSucceeded", "automationFailed", "automationRunning")},
            dict(activeClients=2, aiSessions=4, automationRuns=5, automationCompleted=3,
                 automationSucceeded=1, automationFailed=1, automationRunning=2))

    async def test_department_same_names_devices_deduplicated_and_unknown_excluded(self):
        async with AsyncSession(self.engine) as session:
            session.add_all([models.OrgUnit(id="o1", name="Product"), models.OrgUnit(id="o2", name="Product"),
                models.User(id="u1", username="one", org_id="o1"), models.User(id="u2", username="two", org_id="o2"),
                models.Client(id="c1", user_ref="u1"), models.Client(id="c2", user_ref="u1"),
                models.Client(id="c3", user_ref="u2"), models.Client(id="orphan", user_ref="absent")])
            for i, cid in enumerate(["c1", "c2", "c3", "orphan", "missing"]):
                session.add(am.ExecutionSession(id=f"e{i}", task_id="t", ref=f"e{i}", runner_client_id=cid, created_at=self.now))
                session.add(models.Task(id=f"t{i}", title="task", status="done", owner_client_id=cid, created_at=self.now))
            await session.commit()
            self.assertEqual(await stats._departments(session),
                [dict(org="Product", activeUsers7d=2, tasks30d=3, done30d=3)])

    def test_sqlite_and_postgres_day_expressions_use_explicit_product_timezone(self):
        for dialect, expected in [(sqlite.dialect(), "+8 hours"), (postgresql.dialect(), "Asia/Shanghai")]:
            session = SimpleNamespace(get_bind=lambda: SimpleNamespace(dialect=dialect))
            expr = stats._day_expression(session, models.Task.created_at)
            sql = str(select(expr).compile(dialect=dialect, compile_kwargs={"literal_binds": True}))
            self.assertIn(expected, sql)
            self.assertIn("date(", sql)

    async def test_complete_grouped_queries_compile_on_sqlite_and_postgres(self):
        for dialect in [sqlite.dialect(), postgresql.dialect()]:
            queries = []
            async def execute(statement):
                queries.append(str(statement.compile(dialect=dialect, compile_kwargs={"literal_binds": True})))
                return SimpleNamespace(all=lambda: [])
            session = SimpleNamespace(execute=execute, get_bind=lambda: SimpleNamespace(dialect=dialect))
            self.assertEqual(len(await stats._trend(session)), 30)
            self.assertEqual(await stats._departments(session), [])
            self.assertEqual(len(queries), 5)
            self.assertTrue(all("GROUP BY" in query for query in queries))
            self.assertTrue(all("count(" in query.lower() for query in queries))


class CacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        cache._snapshots.clear()
        self.engines = [create_async_engine("sqlite+aiosqlite:///:memory:") for _ in range(2)]

    async def asyncTearDown(self):
        cache._snapshots.clear()
        for engine in self.engines:
            await engine.dispose()

    async def test_concurrent_readers_cancelled_waiter_separate_session_and_copy(self):
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def build(session):
            calls.append(session)
            entered.set()
            await release.wait()
            self.assertEqual((await session.execute(select(1))).scalar(), 1)
            return {"trend": [{"count": 1}]}
        with patch.object(cache, "insights", build):
            readers = [asyncio.create_task(cache.get_insights(self.engines[0])) for _ in range(20)]
            await entered.wait()
            readers[0].cancel()
            with self.assertRaises(asyncio.CancelledError):
                await readers[0]
            release.set()
            values = await asyncio.gather(*readers[1:])
            self.assertEqual(len(calls), 1)
            values[0]["trend"][0]["count"] = 999
            self.assertEqual((await cache.get_insights(self.engines[0]))["trend"][0]["count"], 1)

    async def test_expiry_engine_partition_and_failed_build_retry(self):
        calls = []
        async def build(session):
            calls.append(session.bind)
            if len(calls) == 1:
                raise ValueError("isolated failure")
            return {"count": len(calls)}
        with patch.object(cache, "insights", build), patch.object(cache, "_monotonic", return_value=10) as clock:
            with self.assertRaises(ValueError):
                await cache.get_insights(self.engines[0])
            self.assertEqual((await cache.get_insights(self.engines[0]))["count"], 2)
            self.assertEqual((await cache.get_insights(self.engines[0]))["count"], 2)
            self.assertEqual((await cache.get_insights(self.engines[1]))["count"], 3)
            clock.return_value = 21
            self.assertEqual((await cache.get_insights(self.engines[0]))["count"], 4)

    async def test_route_releases_authenticated_read_transaction_before_build(self):
        from app.api.operations import operations_insights
        async with AsyncSession(self.engines[0]) as auth_session:
            await auth_session.execute(select(1))
            async def build(session):
                self.assertIsNot(session, auth_session)
                self.assertFalse(auth_session.in_transaction())
                return {"count": 1}
            with patch.object(cache, "insights", build):
                self.assertEqual(await operations_insights(auth_session), {"count": 1})

    async def test_cached_response_still_checks_live_account_and_permission(self):
        from fastapi import FastAPI
        from httpx import ASGITransport, AsyncClient
        from app import deps
        from app.api.operations import router
        from app.db import get_session
        async with self.engines[0].begin() as conn:
            await conn.run_sync(lambda sync: models.User.__table__.create(sync))
        async with AsyncSession(self.engines[0]) as session:
            session.add_all([models.User(id="reader", username="reader", is_super=True),
                             models.User(id="denied", username="denied")])
            await session.commit()
        async def sessions():
            async with AsyncSession(self.engines[0]) as session:
                yield session
        builds = []
        async def build(session):
            builds.append(session)
            return {"count": 1}
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_session] = sessions
        with patch.object(cache, "insights", build), patch.object(deps, "verify_user_claims", side_effect=lambda token: {"uid": token, "ver": 1}):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://isolated") as client:
                url = "/api/v1/admin/operations/insights"
                self.assertEqual((await client.get(url)).status_code, 401)
                self.assertEqual((await client.get(url, headers={"Authorization": "Bearer reader"})).status_code, 200)
                self.assertEqual((await client.get(url, headers={"Authorization": "Bearer reader"})).status_code, 200)
                self.assertEqual((await client.get(url, headers={"Authorization": "Bearer denied"})).status_code, 403)
                async with AsyncSession(self.engines[0]) as session:
                    reader = await session.get(models.User, "reader")
                    reader.is_active = False
                    await session.commit()
                self.assertEqual((await client.get(url, headers={"Authorization": "Bearer reader"})).status_code, 401)
        self.assertEqual(len(builds), 1)


if __name__ == "__main__":
    unittest.main()
