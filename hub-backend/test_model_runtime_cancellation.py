"""Actual SQLite cancellation, commit races and timeout classification."""
import asyncio
from pathlib import Path
import time
from types import SimpleNamespace
from unittest.mock import patch

import aiosqlite
from sqlalchemy.ext.asyncio import AsyncSessionTransaction

from app.services import model_runtime_transaction as boundary
from test_model_runtime import IsolatedDatabase, runtime


class CancellationTests(IsolatedDatabase):
    async def asyncTearDown(self):
        # A failed assertion must still let released fixture barriers drain
        # before changing SessionLocal or removing this fixture's database.
        try:
            async with asyncio.timeout(5):
                while boundary._pending:
                    await asyncio.sleep(.01)
        finally:
            await super().asyncTearDown()

    async def assert_reusable_and_closed(self, retained):
        self.assertIsNotNone(retained.__traceback__)
        self.assertEqual((await runtime.snapshot())["running"], 0)
        lease = await self.acquire()
        await lease.close()
        self.assertEqual((await runtime.snapshot())["running"], 0)
        await self.engine.dispose()
        # Retain the exception chain while deleting, exactly reproducing the
        # prior sqlite cursor leak; no gc/traceback clearing is allowed here.
        (Path(self.temp.name) / "test.db").unlink()
        self.assertIsNotNone(retained.__traceback__)
        self.assertFalse(boundary._pending)

    async def test_cursor_cancellation_retains_original_chain_and_releases_database(self):
        entered, release = asyncio.Event(), asyncio.Event()
        original_fetch = aiosqlite.Cursor.fetchall
        armed = True

        async def fetch(cursor):
            nonlocal armed
            if armed:
                armed = False
                entered.set()
                await release.wait()
            return await original_fetch(cursor)

        with patch.object(aiosqlite.Cursor, "fetchall", fetch):
            work = self.spawn(runtime.snapshot())
            try:
                await asyncio.wait_for(entered.wait(), 3)
                work.cancel("original cancellation")
                await asyncio.sleep(.02)
                work.cancel("second cancellation")
            finally:
                release.set()
            try:
                await work
            except asyncio.CancelledError as error:
                retained = error
            else:
                self.fail("The cancelled caller returned a result")
        self.assertEqual(retained.args, ("original cancellation",))
        await self.assert_reusable_and_closed(retained)

    async def test_one_second_queue_deadline_does_not_interrupt_sql_cursor(self):
        await self.policy(globalConcurrent=1, queueTimeout=1)
        first = await self.acquire()
        queued = self.spawn(self.acquire(user="bob"))
        await self.queued()
        entered, release = asyncio.Event(), asyncio.Event()
        original_fetch = aiosqlite.Cursor.fetchall
        armed = True

        async def fetch(cursor):
            nonlocal armed
            if armed:
                armed = False
                entered.set()
                await release.wait()
            return await original_fetch(cursor)

        with patch.object(aiosqlite.Cursor, "fetchall", fetch):
            try:
                await asyncio.wait_for(entered.wait(), 3)
                await asyncio.sleep(1.05)
            finally:
                release.set()
            try:
                await queued
            except runtime.CapacityError as error:
                retained = error
            else:
                self.fail("The expired queued request was admitted")
        self.assertEqual(retained.status, 429)
        data = await runtime.snapshot()
        self.assertEqual((data["running"], data["queued"]), (1, 0))
        self.assertEqual(data["lastHour"]["queueTimeout"], 1)
        await first.close()
        await self.assert_reusable_and_closed(retained)

    async def commit_race(self, after_commit, bounded=False):
        entered, release = asyncio.Event(), asyncio.Event()
        original_exit = AsyncSessionTransaction.__aexit__
        original_remaining = boundary.CleanupBudget.remaining
        budgets = set()
        armed = True

        def remaining(budget):
            budgets.add(id(budget))
            return original_remaining(budget)

        async def transaction_exit(transaction, kind, value, traceback):
            nonlocal armed
            if armed and kind is None:
                armed = False
                if after_commit:
                    await original_exit(transaction, kind, value, traceback)
                entered.set()
                await release.wait()
                if after_commit:
                    return
            return await original_exit(transaction, kind, value, traceback)

        with patch.object(AsyncSessionTransaction, "__aexit__", transaction_exit):
            work = self.spawn(self.acquire())
            try:
                await asyncio.wait_for(entered.wait(), 3)
                work.cancel("commit boundary cancellation")
                if not bounded:
                    release.set()
                start = time.perf_counter()
                with patch.object(boundary, "CLEANUP_SECONDS", .05 if bounded else 5), \
                        patch.object(boundary.CleanupBudget, "remaining", remaining):
                    try:
                        await work
                    except asyncio.CancelledError as error:
                        retained = error
                    else:
                        self.fail("Cancelled admission returned a lease")
                if bounded:
                    self.assertLess(time.perf_counter() - start, 1)
                    self.assertEqual(len(budgets), 1, "transaction and final removal share one deadline")
                    self.assertTrue(boundary._pending)
                    successor = self.spawn(self.acquire(user="successor"))
                    release.set()
                    lease = await asyncio.wait_for(successor, 5)
                    await lease.close()
            finally:
                release.set()
        async with asyncio.timeout(5):
            while boundary._pending:
                await asyncio.sleep(.01)
        data = await runtime.snapshot()
        self.assertEqual((data["running"], data["queued"]), (0, 0))
        self.assertEqual(data["lastHour"]["cancelled"], 1)
        await self.assert_reusable_and_closed(retained)

    async def test_cancellation_during_commit_compensates_registered_lease(self):
        await self.commit_race(after_commit=False)

    async def test_cancellation_after_commit_compensates_registered_lease(self):
        await self.commit_race(after_commit=True)

    async def test_bounded_caller_keeps_late_commit_cleanup_tracked(self):
        await self.commit_race(after_commit=True, bounded=True)

    async def test_second_cancel_during_final_remove_preserves_original_error(self):
        await self.policy(globalConcurrent=1)
        first = await self.acquire()
        work = self.spawn(self.acquire(user="bob"))
        await self.queued()
        entered, release = asyncio.Event(), asyncio.Event()
        original_remove = runtime._remove

        async def remove(identifier, outcome):
            entered.set()
            await release.wait()
            await original_remove(identifier, outcome)

        with patch.object(runtime, "_remove", remove):
            try:
                work.cancel("first cancellation")
                await asyncio.wait_for(entered.wait(), 3)
                work.cancel("second cancellation")
            finally:
                release.set()
            try:
                await work
            except asyncio.CancelledError as error:
                retained = error
            else:
                self.fail("The cancelled caller returned a lease")
        self.assertEqual(retained.args, ("first cancellation",))
        self.assertEqual((await runtime.snapshot())["queued"], 0)
        await first.close()
        await self.assert_reusable_and_closed(retained)

    async def test_early_queue_timer_is_429_using_expired_timer_not_wall_clock(self):
        await self.policy(globalConcurrent=1, queueTimeout=1)
        first = await self.acquire()
        chosen = []

        def early_timeout(seconds):
            if seconds < 5:
                chosen.append(seconds)
                return asyncio.timeout(.001)
            return asyncio.timeout(seconds)

        # Keep the real event loop/Timeout implementation. Only this module's
        # queue timer is delivered early, deterministically on every platform.
        proxy = SimpleNamespace(**{**vars(asyncio), "timeout": early_timeout})
        with patch.object(runtime, "asyncio", proxy):
            with self.assertRaises(runtime.CapacityError) as error:
                await self.acquire(user="bob")
        self.assertEqual(error.exception.status, 429)
        self.assertTrue(chosen and chosen[0] > .1)
        self.assertEqual((await runtime.snapshot())["lastHour"]["queueTimeout"], 1)
        await first.close()

    async def test_database_timeout_during_queue_poll_is_still_503(self):
        # Exercise the DB error, not a competing one-second queue expiry under
        # scheduler contention; the adjacent tests keep the real short timer.
        await self.policy(globalConcurrent=1, queueTimeout=10)
        first = await self.acquire()
        original_now = runtime._now
        calls = 0
        database_timeout = TimeoutError("isolated database timeout")

        async def database_clock(session):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise database_timeout
            return await original_now(session)

        with patch.object(runtime, "_now", database_clock):
            with self.assertRaises(runtime.CapacityError) as error:
                await self.acquire(user="bob")
        self.assertEqual(error.exception.status, 503)
        self.assertIs(error.exception.__cause__, database_timeout)
        data = await runtime.snapshot()
        self.assertEqual(data["queued"], 0)
        self.assertEqual(data["lastHour"]["failed"], 1)
        await first.close()
