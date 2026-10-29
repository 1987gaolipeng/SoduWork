"""The timer stays independent of delivery scans and individual bad plans."""
import asyncio
import importlib
import os
import tempfile
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-scheduler-loop-secret")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import automation_models, config, db, models
from app.services import artifacts_sweep, code_delivery, schedules


class Context:
    def __init__(self, exits):
        self.exits = exits

    async def __aenter__(self):
        return object()

    async def __aexit__(self, kind, *_):
        self.exits.append(kind)


class ScheduleLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_timer_runs_while_delivery_fails_or_remains_busy(self):
        loop = importlib.import_module("app.services.schedule_loop")
        for state in ("failed", "busy", "artifacts_failed"):
            with self.subTest(state=state):
                started, fired, blocked = asyncio.Event(), asyncio.Event(), asyncio.Event()

                async def delivery(_session):
                    started.set()
                    if state == "failed":
                        raise RuntimeError("isolated delivery failure")
                    if state == "busy":
                        await blocked.wait()
                    return {}

                async def timer(_session):
                    fired.set()
                    return {"fired": 1}

                with patch.object(db, "SessionLocal", lambda: Context([])), \
                     patch.object(config, "get_settings", return_value=SimpleNamespace(delivery_sweep_seconds=120)), \
                     patch.object(code_delivery, "sweep", delivery), \
                     patch.object(artifacts_sweep, "sweep", AsyncMock(return_value={},
                         side_effect=RuntimeError("isolated artifact failure") if state == "artifacts_failed" else None)), \
                     patch.object(schedules, "tick", timer):
                    delivery_job = asyncio.create_task(code_delivery.sweep_loop())
                    timer_job = None
                    try:
                        await asyncio.wait_for(started.wait(), 1)
                        timer_job = asyncio.create_task(loop.tick_loop())
                        await asyncio.wait_for(fired.wait(), 1)
                    finally:
                        jobs = [job for job in (delivery_job, timer_job) if job is not None]
                        for job in jobs:
                            job.cancel()
                        await asyncio.gather(*jobs, return_exceptions=True)

    async def test_failed_timer_iteration_retries_and_shutdown_propagates(self):
        loop = importlib.import_module("app.services.schedule_loop")
        exits = []
        tick = AsyncMock(side_effect=[RuntimeError("isolated timer error"), {"fired": 0}])
        sleep = AsyncMock(side_effect=[None, asyncio.CancelledError])
        with patch.object(db, "SessionLocal", lambda: Context(exits)), \
             patch.object(config, "get_settings", return_value=SimpleNamespace(delivery_sweep_seconds=120)), \
             patch.object(schedules, "tick", tick), patch.object(loop.asyncio, "sleep", sleep):
            with self.assertRaises(asyncio.CancelledError):
                await loop.tick_loop()
        self.assertEqual(tick.await_count, 2)
        self.assertEqual(exits, [RuntimeError, None])

    async def test_shutdown_cancels_inflight_tick_and_closes_its_session(self):
        loop = importlib.import_module("app.services.schedule_loop")
        started, blocked = asyncio.Event(), asyncio.Event()
        exits = []

        async def tick(_session):
            started.set()
            await blocked.wait()

        with patch.object(db, "SessionLocal", lambda: Context(exits)), \
             patch.object(config, "get_settings", return_value=SimpleNamespace(delivery_sweep_seconds=120)), \
             patch.object(schedules, "tick", tick):
            job = asyncio.create_task(loop.tick_loop())
            try:
                await asyncio.wait_for(started.wait(), 1)
            finally:
                job.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await job
        self.assertEqual(exits, [asyncio.CancelledError])


class ScheduleTickIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="schedule-loop-isolation-")
        self.addCleanup(self.temp.cleanup)
        filename = (Path(self.temp.name) / "schedules.db").as_posix()
        self.engine = create_async_engine("sqlite+aiosqlite:///" + filename)
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as connection:
            for table in (models.Client.__table__, models.AiSchedule.__table__,
                          models.AiScheduleRun.__table__, automation_models.ResourceLease.__table__):
                await connection.run_sync(table.create)
        self.factory = async_sessionmaker(self.engine, expire_on_commit=False)
        self.session = self.factory()
        self.addAsyncCleanup(self.session.close)
        now = datetime.now(timezone.utc)
        self.session.add(models.Client(id="device"))
        self.good = models.AiSchedule(id="good", title="valid appointment", owner_client_id="device",
            assignee_id="local:pi", every="once", run_at=now-timedelta(seconds=5),
            enabled=True, created_at=now-timedelta(days=1), retry_limit=0)
        self.bad = models.AiSchedule(id="bad", title="legacy invalid zone", owner_client_id="device",
            assignee_id="local:pi", every="daily", time_zone="/invalid-zone",
            enabled=True, created_at=now-timedelta(days=1), retry_limit=0)
        self.session.add_all([self.bad, self.good])
        await self.session.commit()

    async def test_bad_timing_cannot_block_next_plan_or_duplicate_its_receipt(self):
        with patch.object(schedules, "run_one", AsyncMock(return_value={"ok": True})) as dispatch, \
             patch.object(schedules, "_notify_failure", AsyncMock()):
            first = await schedules.tick(self.session)
            second = await schedules.tick(self.session)
        self.assertEqual(first["fired"], 1)
        self.assertEqual(second["fired"], 0)
        self.assertEqual(dispatch.await_count, 1)
        await self.session.refresh(self.bad)
        self.assertTrue(self.bad.last_error)
        runs = list((await self.session.execute(select(models.AiScheduleRun))).scalars())
        self.assertEqual([(run.schedule_id, run.trigger) for run in runs], [("good", "timer")])

    async def test_one_lease_error_keeps_appointment_pending_and_allows_other_plans(self):
        self.bad.every, self.bad.run_at = "once", self.good.run_at
        await self.session.commit()
        original = schedules.resource_leases.acquire

        async def acquire(session, kind, key, **options):
            if options.get("detail", {}).get("scheduleId") == "bad":
                raise RuntimeError("isolated lease acquisition failure")
            return await original(session, kind, key, **options)

        with patch.object(schedules.resource_leases, "acquire", acquire), \
             patch.object(schedules, "run_one", AsyncMock(return_value={"ok": True})) as dispatch, \
             patch.object(schedules, "_notify_failure", AsyncMock()):
            self.assertEqual((await schedules.tick(self.session))["fired"], 1)
        self.assertEqual(dispatch.await_count, 1)
        await self.session.refresh(self.bad)
        self.assertFalse(self.bad.once_fired)
        self.assertIsNone(self.bad.last_run_at)
        self.assertIn("lease acquisition", self.bad.last_error)
        with patch.object(schedules, "run_one", AsyncMock(return_value={"ok": True})) as recovery:
            self.assertEqual((await schedules.tick(self.session))["fired"], 1)
            self.assertEqual((await schedules.tick(self.session))["fired"], 0)
        self.assertEqual(recovery.await_count, 1)

    async def test_receipt_reconciliation_failure_does_not_stop_due_dispatch(self):
        self.bad.enabled = False
        await self.session.commit()
        with patch.object(schedules, "reconcile_runs", AsyncMock(side_effect=RuntimeError("isolated receipt failure"))), \
             patch.object(schedules, "run_one", AsyncMock(return_value={"ok": True})) as dispatch:
            self.assertEqual((await schedules.tick(self.session))["fired"], 1)
        self.assertEqual(dispatch.await_count, 1)

    async def _periodic_pre_dispatch_failure(self, every, failure, retry=False):
        original_clock = datetime.now(timezone.utc) - timedelta(days=8)
        original_retry = datetime.now(timezone.utc) - timedelta(seconds=30) if retry else None
        self.bad.every, self.bad.time_zone = every, "UTC"
        self.bad.at_hour, self.bad.at_minute, self.bad.weekday = 0, 0, 1
        self.bad.last_run_at, self.bad.retry_limit = original_clock, 2
        self.bad.next_retry_at, self.bad.retry_count = original_retry, 1 if retry else 0
        self.bad.plugin_binding_id = "isolated-plugin-binding"
        await self.session.commit()
        original_identity = schedules.trigger_identity(self.bad, "retry" if retry else "timer")
        self.assertTrue(schedules.due(self.bad))
        original_acquire, original_claim = schedules.resource_leases.acquire, schedules.claim_run
        original_refresh = self.session.refresh
        refresh_failed = False

        async def acquire(session, kind, key, **options):
            if options.get("detail", {}).get("scheduleId") == "bad":
                raise RuntimeError("isolated pre-dispatch lease failure")
            return await original_acquire(session, kind, key, **options)

        async def claim(session, schedule, *args, **options):
            if schedule.id == "bad":
                raise RuntimeError("isolated pre-claim failure")
            return await original_claim(session, schedule, *args, **options)

        async def refresh(instance, *args, **options):
            nonlocal refresh_failed
            if instance is self.bad and not refresh_failed:
                refresh_failed = True
                raise RuntimeError("isolated post-lease refresh failure")
            return await original_refresh(instance, *args, **options)

        with ExitStack() as stack:
            stack.enter_context(patch.object(schedules, "_notify_failure", AsyncMock()))
            dispatch = stack.enter_context(patch.object(schedules, "run_one", AsyncMock(return_value={"ok": True})))
            if failure == "lease":
                stack.enter_context(patch.object(schedules.resource_leases, "acquire", acquire))
            elif failure == "claim":
                stack.enter_context(patch.object(schedules, "claim_run", claim))
            else:
                stack.enter_context(patch.object(self.session, "refresh", refresh))
            self.assertEqual((await schedules.tick(self.session))["fired"], 1)
        self.assertEqual(dispatch.await_count, 1, "the other owner's appointment still dispatches")
        await self.session.refresh(self.bad)
        self.assertEqual(schedules._utc(self.bad.last_run_at), original_clock)
        self.assertEqual(schedules._utc(self.bad.next_retry_at) if self.bad.next_retry_at else None, original_retry)
        self.assertEqual(self.bad.retry_count, 1 if retry else 0)
        self.assertTrue(self.bad.last_error)
        self.assertTrue(schedules.due(self.bad), "unclaimed timer occurrences must remain due")
        self.assertEqual(schedules.trigger_identity(self.bad, "retry" if retry else "timer"), original_identity)
        with patch.object(schedules, "run_one", AsyncMock(return_value={"ok": True})) as recovered:
            self.assertEqual((await schedules.tick(self.session))["fired"], 1)
            self.assertEqual((await schedules.tick(self.session))["fired"], 0)
        self.assertEqual(recovered.await_count, 1)
        runs = list((await self.session.execute(select(models.AiScheduleRun).where(
            models.AiScheduleRun.schedule_id == "bad"))).scalars())
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0].idempotency_key, original_identity)

    async def test_daily_lease_failure_preserves_occurrence_for_recovery(self):
        await self._periodic_pre_dispatch_failure("daily", "lease")

    async def test_hourly_post_lease_refresh_failure_preserves_occurrence_for_recovery(self):
        await self._periodic_pre_dispatch_failure("hourly", "refresh")

    async def test_weekly_pre_claim_failure_preserves_occurrence_for_recovery(self):
        await self._periodic_pre_dispatch_failure("weekly", "claim")

    async def test_pending_retry_lease_failure_preserves_retry_budget_and_identity(self):
        await self._periodic_pre_dispatch_failure("hourly", "lease", retry=True)


if __name__ == "__main__":
    unittest.main()
