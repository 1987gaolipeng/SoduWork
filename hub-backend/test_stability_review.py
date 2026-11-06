"""Offline shutdown failure isolation and bounded integration query counts."""
import asyncio
import unittest
from unittest.mock import AsyncMock

from sqlalchemy import event
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models
from app.db import Base
from app.services.aggregation import list_integrations
from app.services.shutdown import shutdown


class ShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_background_task_cannot_skip_other_tasks_or_resources(self):
        async def failed():
            raise RuntimeError("fixture")
        first = asyncio.create_task(failed())
        second = asyncio.create_task(asyncio.sleep(3600))
        await asyncio.sleep(0)
        callbacks = [AsyncMock(), AsyncMock(side_effect=ValueError("close")), AsyncMock()]
        with self.assertRaisesRegex(RuntimeError, "fixture"):
            await shutdown([first, second], list(zip(["one", "two", "three"], callbacks)))
        self.assertTrue(second.cancelled())
        for callback in callbacks:
            callback.assert_awaited_once()

    async def test_uncooperative_task_has_bounded_wait_and_later_resources_close(self):
        release = asyncio.Event()
        async def stubborn():
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    pass
        task = asyncio.create_task(stubborn())
        await asyncio.sleep(0)
        close = AsyncMock()
        try:
            with self.assertRaises(TimeoutError):
                await shutdown([task], [("close", close)], timeout=.2, step_timeout=.02)
            close.assert_awaited_once()
        finally:
            release.set()
            await task

    async def test_outer_cancellation_is_preserved_after_resource_cleanup(self):
        entered = asyncio.Event()
        async def waiting():
            entered.set()
            await asyncio.sleep(3600)
        close = AsyncMock()
        task = asyncio.create_task(shutdown([], [("first", waiting), ("last", close)]))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        close.assert_awaited_once()


class AggregationTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_thousand_integrations_use_two_queries_and_preserve_zero_counts(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with async_sessionmaker(engine)() as session:
                session.add_all([models.Integration(id=str(i), name=str(i), type="generic",
                    ingest_token="fixture-" + str(i)) for i in range(1000)])
                session.add_all([models.Task(id="t" + str(i), title="fixture", integration_id="1")
                                 for i in range(100)])
                await session.commit()
                queries = []
                def record(_c, _cursor, sql, _parameters, _context, _many):
                    queries.append(sql)
                event.listen(engine.sync_engine, "before_cursor_execute", record)
                rows = await list_integrations(session)
                self.assertEqual(len(queries), 2)
                self.assertEqual(len(rows), 1000)
                self.assertEqual(next(row for row in rows if row["id"] == "1")["taskCount"], 100)
                self.assertEqual(next(row for row in rows if row["id"] == "0")["taskCount"], 0)
        finally:
            await engine.dispose()
