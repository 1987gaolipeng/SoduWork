"""Isolated lease renewal failures with a real SQLite lease and HTTP stream."""
import asyncio
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from test_model_runtime import CONF, DelayedStream, IsolatedDatabase, runtime, transport


class RenewalTests(IsolatedDatabase):
    async def test_transient_renewal_failure_keeps_the_same_upstream_stream(self):
        stream = DelayedStream()
        failed, renewed = asyncio.Event(), asyncio.Event()
        original_state = runtime._state
        attempts = 0
        requests = []

        @asynccontextmanager
        async def interrupted_state(*args, **kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                failed.set()
                raise ConnectionError("isolated lease connection interruption")
            async with original_state(*args, **kwargs) as value:
                yield value
            renewed.set()

        def upstream(request):
            requests.append(request)
            return httpx.Response(200, stream=stream)

        with patch.object(runtime, "RENEW_SECONDS", .03):
            async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
                with patch.object(transport, "_client", return_value=client):
                    response = await transport.open_response(CONF, "/responses", b"{}", stream=True)
                    reader = self.spawn(response.read())
                    await asyncio.wait_for(stream.started.wait(), 2)
                    with patch.object(runtime, "_state", interrupted_state):
                        await asyncio.wait_for(failed.wait(), 2)
                        await asyncio.sleep(.01)
                        self.assertFalse(response.lease.lost.is_set(), "a transient failure is not an expired lease")
                        await asyncio.wait_for(renewed.wait(), 3)
                        self.assertFalse(reader.done())
                        stream.release.set()
                        body = await asyncio.wait_for(reader, 3)
                    self.assertIn(b"[DONE]", body)
                    self.assertEqual(len(requests), 1, "do not replay a streamed model request")
                    self.assertTrue(stream.closed)
        self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_renewal_timeout_retries_without_replacing_the_lease(self):
        failed, committed = asyncio.Event(), asyncio.Event()
        original_state = runtime._state
        attempts = 0

        @asynccontextmanager
        async def stalled_once(*args, **kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                failed.set()
                await asyncio.Event().wait()
            async with original_state(*args, **kwargs) as value:
                yield value
            committed.set()

        with patch.object(runtime, "RENEW_SECONDS", .03), \
                patch.object(runtime, "RENEW_TIMEOUT_SECONDS", 1), \
                patch.object(runtime, "RENEW_RETRY_SECONDS", .03):
            lease = await self.acquire()
            identifier = lease.id
            with patch.object(runtime, "_state", stalled_once):
                await asyncio.wait_for(failed.wait(), 2)
                await asyncio.wait_for(committed.wait(), 5)
            self.assertFalse(lease.lost.is_set())
            self.assertEqual(lease.id, identifier)
            self.assertGreaterEqual(attempts, 2)
        self.assertEqual((await runtime.snapshot())["running"], 1)

    async def test_persistent_failure_expires_and_closes_the_upstream(self):
        original_state = runtime._state
        attempts = 0
        stream = DelayedStream()

        @asynccontextmanager
        async def unavailable(*args, **kwargs):
            nonlocal attempts
            if args:  # Cleanup is available again; only renewals fail.
                async with original_state(*args, **kwargs) as value:
                    yield value
                return
            attempts += 1
            raise ConnectionError("password=private-fixture-secret")
            yield  # pragma: no cover - async context manager contract

        with patch.object(runtime, "LEASE_SECONDS", 2), \
                patch.object(runtime, "RENEW_SECONDS", .03), \
                patch.object(runtime, "RENEW_RETRY_SECONDS", .03):
            async with httpx.AsyncClient(transport=httpx.MockTransport(
                    lambda _: httpx.Response(200, stream=stream))) as client:
                with patch.object(transport, "_client", return_value=client), \
                        patch.object(runtime, "_state", unavailable), \
                        self.assertLogs("uvicorn.error", level="WARNING") as logs:
                    response = await transport.open_response(CONF, "/responses", b"{}", stream=True)
                    bound = response.lease.valid_until
                    reader = self.spawn(response.read())
                    await asyncio.wait_for(stream.started.wait(), 2)
                    with self.assertRaises(runtime.CapacityError) as error:
                        await asyncio.wait_for(reader, 4)
                    self.assertEqual(error.exception.status, 503)
                    self.assertNotIn("private-fixture-secret", " ".join(logs.output))
                    self.assertGreaterEqual(attempts, 2)
                    self.assertEqual(response.lease.valid_until, bound)
                    self.assertTrue(response.lease.lost.is_set())
                    self.assertTrue(stream.closed)
                    self.assertTrue(response.lease.renewal.done())
                    self.assertTrue(response.lease.expiry.done())
        self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_missing_or_nonrunning_lease_is_not_renewed(self):
        for state_name in (None, "queued"):
            with self.subTest(state=state_name), patch.object(runtime, "RENEW_SECONDS", .2):
                lease = await self.acquire()
                bound = lease.valid_until
                async with runtime._state() as (state, _, _):
                    hit = next(row for row in state["leases"] if row["id"] == lease.id)
                    if state_name is None:
                        state["leases"].remove(hit)
                    else:
                        hit["state"] = state_name
                await asyncio.wait_for(lease.lost.wait(), 2)
                self.assertLess(time.monotonic(), bound)
                self.assertEqual(lease.valid_until, bound)
                await lease.close()
        self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_pending_commit_cannot_extend_or_revive_expired_lease(self):
        original_state = runtime._state
        pending, release = asyncio.Event(), asyncio.Event()
        clock = [100.0]
        expire = asyncio.Event()

        async def controlled_sleep(delay):
            if delay > 1:
                # Let the real expiry guard wait until the DB commit is held;
                # slow fixture admission must not consume this test's lease.
                await expire.wait()
            else:
                await asyncio.sleep(delay)

        proxy = SimpleNamespace(**{**vars(asyncio), "sleep": controlled_sleep})

        @asynccontextmanager
        async def delayed_commit(*args, **kwargs):
            async with original_state(*args, **kwargs) as value:
                yield value
                pending.set()
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    # Model cancellation-resistant DB commit/rollback cleanup.
                    await release.wait()

        with patch.object(runtime, "time", SimpleNamespace(monotonic=lambda: clock[0])), \
                patch.object(runtime, "asyncio", proxy), \
                patch.object(runtime, "RENEW_SECONDS", .03):
            lease = await self.acquire()
            bound = lease.valid_until
            try:
                with patch.object(runtime, "_state", delayed_commit):
                    await asyncio.wait_for(pending.wait(), 2)
                    self.assertEqual(lease.valid_until, bound, "uncommitted TTL must not count")
                    clock[0] = bound + 1
                    expire.set()
                    await asyncio.wait_for(lease.lost.wait(), 2)
                    self.assertFalse(lease.renewal.done(), "expiry must not wait on DB cleanup")
                    release.set()
                    await asyncio.wait_for(asyncio.shield(lease.renewal), 2)
                    self.assertTrue(lease.lost.is_set())
                    self.assertEqual(lease.valid_until, bound)
            finally:
                expire.set()
                release.set()
                await lease.close()

    async def test_commit_return_checks_expiry_before_watchdog_can_run(self):
        original_state = runtime._state
        clock = [100.0]
        committed = asyncio.Event()

        @asynccontextmanager
        async def delayed_commit_return(*args, **kwargs):
            async with original_state(*args, **kwargs) as value:
                yield value
            # Simulate the event loop resuming this transaction after a stall.
            # There is deliberately no await between crossing the old bound
            # and returning to renewal; the separate watchdog has not run yet.
            clock[0] = bound + 1
            committed.set()

        with patch.object(runtime, "time", SimpleNamespace(monotonic=lambda: clock[0])), \
                patch.object(runtime, "RENEW_SECONDS", .03):
            lease = await self.acquire()
            bound = lease.valid_until
            clock[0] += 20
            with patch.object(runtime, "_state", delayed_commit_return):
                await asyncio.wait_for(committed.wait(), 2)
                self.assertTrue(lease.lost.is_set(), "commit must check expiry synchronously")
                self.assertEqual(lease.valid_until, bound, "expired lease cannot revive")
                await asyncio.wait_for(asyncio.shield(lease.renewal), 2)
            await lease.close()

    async def test_cancel_during_retry_releases_capacity_and_both_tasks(self):
        original_state = runtime._state
        failed = asyncio.Event()

        @asynccontextmanager
        async def renewal_unavailable(*args, **kwargs):
            if not args:
                failed.set()
                raise ConnectionError("isolated renewal failure")
            async with original_state(*args, **kwargs) as value:
                yield value

        with patch.object(runtime, "RENEW_SECONDS", .03):
            lease = await self.acquire()
            with patch.object(runtime, "_state", renewal_unavailable):
                await asyncio.wait_for(failed.wait(), 2)
                await asyncio.wait_for(lease.close("cancelled"), 2)
            self.assertTrue(lease.renewal.done())
            self.assertTrue(lease.expiry.done())
            self.assertFalse(lease.lost.is_set())
        self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_admission_commit_time_is_deducted_from_lease(self):
        original_state = runtime._state
        clock = [100.0]

        @asynccontextmanager
        async def slow_admission(*args, **kwargs):
            async with original_state(*args, **kwargs) as value:
                yield value
                if kwargs.get("read_policy"):
                    clock[0] += .2

        with patch.object(runtime, "LEASE_SECONDS", 1), \
                patch.object(runtime, "time", SimpleNamespace(monotonic=lambda: clock[0])), \
                patch.object(runtime, "_state", slow_admission):
            lease = await self.acquire()
            self.assertLess(lease.valid_until - clock[0], .85)
            self.assertFalse(lease.lost.is_set())
            await lease.close()

    async def test_queued_admission_keeps_the_database_expiry_bound(self):
        await self.policy(globalConcurrent=1)
        original_state = runtime._state
        polling, observe = asyncio.Event(), asyncio.Event()
        clock = [100.0]

        async def database_clock(session):
            return clock[0]

        @asynccontextmanager
        async def delayed_observation(*args, **kwargs):
            if args and args[0] != first.id and not kwargs.get("read_policy"):
                polling.set()
                await observe.wait()
            async with original_state(*args, **kwargs) as value:
                yield value

        # Advance DB and monotonic time together only after the queued lease is
        # admitted. Real SQLite work must not expire the fixture before its check.
        with patch.object(runtime, "LEASE_SECONDS", 1.5), \
                patch.object(runtime, "time", SimpleNamespace(monotonic=lambda: clock[0])), \
                patch.object(runtime, "_now", database_clock):
            first = await self.acquire()
            with patch.object(runtime, "_state", delayed_observation):
                waiting = self.spawn(self.acquire(user="second"))
                try:
                    await asyncio.wait_for(polling.wait(), 2)
                    admitted_at = clock[0]
                    await first.close()
                    clock[0] += .15
                    observe.set()
                    second = await asyncio.wait_for(waiting, 2)
                finally:
                    observe.set()
            self.assertLessEqual(second.valid_until, admitted_at + 1.5 + .05)
            self.assertLess(second.valid_until - clock[0], 1.4)

    async def test_expired_before_admission_commit_does_not_open_a_lease(self):
        original_state = runtime._state

        @asynccontextmanager
        async def expired_admission(*args, **kwargs):
            async with original_state(*args, **kwargs) as value:
                yield value
                if kwargs.get("read_policy"):
                    await asyncio.sleep(.2)

        with patch.object(runtime, "LEASE_SECONDS", .1), \
                patch.object(runtime, "_state", expired_admission):
            with self.assertRaises(runtime.CapacityError) as error:
                await self.acquire()
        self.assertEqual(error.exception.status, 503)
        self.assertEqual((await runtime.snapshot())["running"], 0)
