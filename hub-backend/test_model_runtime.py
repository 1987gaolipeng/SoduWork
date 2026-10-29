"""Isolated concurrency/transport regressions. No business DB or model traffic."""
import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import AppSetting, Client, ModelDef, ModelProvider
from app.services import model_runtime as runtime, model_transport as transport

CONF = dict(base="https://fixture.invalid/v1", key="test-key", model="model", provider="provider", user="alice")


class IsolatedDatabase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-smoke-model-")
        self.url = "sqlite+aiosqlite:///" + (Path(self.temp.name) / "test.db").as_posix()
        self.engine = create_async_engine(self.url, connect_args={"timeout": 2})
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            for table in (AppSetting, Client, ModelProvider, ModelDef):
                await conn.run_sync(table.__table__.create)
        self.patch = patch.object(runtime, "SessionLocal", self.sessions)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.leases, self.work = [], []
        from tests.traceback_source_cache import snapshot_loaded_sources
        self.addCleanup(snapshot_loaded_sources())

    async def asyncTearDown(self):
        for task in self.work:
            task.cancel()
        await asyncio.gather(*self.work, return_exceptions=True)
        for lease in self.leases:
            await lease.close()
        await transport.shutdown()
        await self.engine.dispose()
        self.temp.cleanup()

    async def policy(self, **values):
        policy = runtime.clean_policy({**runtime.DEFAULTS, **values})
        async with self.sessions() as session, session.begin():
            row = await runtime.lock_setting(session, runtime.POLICY_KEY)
            row.value = json.dumps(policy)

    async def acquire(self, **overrides):
        lease = await runtime.acquire({**CONF, **overrides})
        self.leases.append(lease)
        return lease

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.work.append(task)
        return task

    async def queued(self, count=1):
        async with asyncio.timeout(3):
            while (await runtime.snapshot())["queued"] != count:
                await asyncio.sleep(.02)


class RuntimeTests(IsolatedDatabase):
    async def test_untouched_legacy_defaults_are_upgraded(self):
        async with self.sessions() as session, session.begin():
            row = await runtime.lock_setting(session, runtime.POLICY_KEY)
            row.value = json.dumps(runtime.LEGACY_DEFAULTS)
        async with self.sessions() as session:
            self.assertEqual(await runtime.policy(session), runtime.DEFAULTS)

    async def test_each_capacity_dimension_and_credential_alias(self):
        variants = {
            "globalConcurrent": dict(base="https://other.invalid", key="other", model="other", user="bob"),
            "providerConcurrent": dict(key="other", model="other", user="bob"),
            "keyConcurrent": dict(provider="alias", model="other", user="bob"),
            "modelConcurrent": dict(key="other", user="bob"),
            "userConcurrent": dict(base="https://other.invalid", key="other", model="other"),
        }
        for dimension, other in variants.items():
            with self.subTest(dimension=dimension):
                await self.policy(**{dimension: 1, "queueSize": 0})
                first = await self.acquire()
                with self.assertRaises(runtime.CapacityError) as error:
                    await self.acquire(**other)
                self.assertEqual(error.exception.status, 429)
                self.assertEqual((await runtime.snapshot())["running"], 1)
                await first.close()
                second = await self.acquire(**other)
                await second.close()

    async def test_queue_is_bounded_cancellable_and_does_not_block_other_user(self):
        await self.policy(globalConcurrent=2, userConcurrent=1, userQueueSize=1)
        first = await self.acquire()
        queued = self.spawn(self.acquire())
        await self.queued()
        with self.assertRaises(runtime.CapacityError):
            await self.acquire()
        second = await self.acquire(user="bob")
        self.assertFalse(queued.done())
        self.assertEqual((await runtime.snapshot())["running"], 2)
        queued.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await queued
        self.assertEqual((await runtime.snapshot())["queued"], 0)
        await first.close()
        await second.close()

    async def test_release_admits_queued_request(self):
        # Successful handoff must not compete with the minimum supported
        # deadline; the separate timeout test retains the real one-second bound.
        await self.policy(globalConcurrent=1, queueTimeout=10)
        first = await self.acquire()
        queued = self.spawn(self.acquire(user="bob"))
        await self.queued()
        await first.close()
        second = await asyncio.wait_for(queued, 5)
        self.assertEqual((await runtime.snapshot())["queued"], 0)
        await second.close()

    async def test_queue_timeout_cleans_queue(self):
        await self.policy(globalConcurrent=1, queueTimeout=1)
        first = await self.acquire()
        with self.assertRaises(runtime.CapacityError) as error:
            await self.acquire(user="carol")
        self.assertEqual(error.exception.status, 429)
        data = await runtime.snapshot()
        self.assertEqual(data["queued"], 0)
        self.assertEqual(data["lastHour"]["queueTimeout"], 1)
        await first.close()

    async def test_independent_database_pools_share_admission_and_expiry(self):
        await self.policy(globalConcurrent=1, queueSize=0)
        first = await self.acquire()
        other_engine = create_async_engine(self.url)
        other_sessions = async_sessionmaker(other_engine, expire_on_commit=False)
        try:
            with patch.object(runtime, "SessionLocal", other_sessions):
                with self.assertRaises(runtime.CapacityError):
                    await self.acquire(user="other-worker")
                async with runtime._state() as (state, now, _):
                    state["leases"][0]["expires"] = now - 1
                recovered = await self.acquire(user="other-worker")
                self.assertEqual((await runtime.snapshot())["running"], 1)
                # An expired worker's eventual cleanup must not release its successor.
                await first.close()
                self.assertEqual((await runtime.snapshot())["running"], 1)
                await recovered.close()
        finally:
            await other_engine.dispose()

    async def test_many_requests_never_exceed_limit_and_store_no_credentials(self):
        # Measure capacity with the production loop mode. Debug task traceback
        # collection magnifies SQLite scheduling here; timeout/cancellation
        # tests keep IsolatedAsyncioTestCase's debug mode and their short bounds.
        loop = asyncio.get_running_loop()
        was_debug = loop.get_debug()
        try:
            loop.set_debug(False)
            await self._exercise_concurrent_capacity()
        finally:
            loop.set_debug(was_debug)

    async def _exercise_concurrent_capacity(self):
        await self.policy(globalConcurrent=3, userConcurrent=3, userQueueSize=32, queueTimeout=10)
        active, peak = 0, 0
        async def request(index):
            nonlocal active, peak
            lease = await self.acquire(user=str(index))
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(.03)
            active -= 1
            await lease.close()
        await asyncio.wait_for(asyncio.gather(*(self.spawn(request(i)) for i in range(20))), 15)
        self.assertLessEqual(peak, 3)
        data = await runtime.snapshot()
        self.assertEqual((data["running"], data["queued"]), (0, 0))
        self.assertEqual(data["lastHour"]["completed"], 20)
        async with self.sessions() as session:
            raw = (await session.get(AppSetting, runtime.STATE_KEY)).value
        self.assertNotIn(CONF["key"], raw)
        self.assertNotIn(CONF["base"], raw)

    async def test_lease_loss_cancels_upstream_and_closes_simultaneous_response(self):
        lease = await self.acquire()
        lease.lost.set()
        response = httpx.Response(200, stream=DelayedStream())
        async def opened():
            return response
        with self.assertRaises(runtime.CapacityError):
            await lease.run(opened())
        self.assertTrue(response.is_closed)


class DelayedStream(httpx.AsyncByteStream):
    def __init__(self, error=None):
        self.started, self.release = asyncio.Event(), asyncio.Event()
        self.closed = False
        self.error = error

    async def __aiter__(self):
        yield b'data: {"delta":"first"}\n\n'
        self.started.set()
        await self.release.wait()
        if self.error:
            raise self.error
        yield b"data: [DONE]\n\n"

    async def aclose(self):
        self.closed = True


class TransportTests(IsolatedDatabase):
    async def test_proxy_disconnect_before_open_handoff_releases_real_capacity(self):
        from app.api.ai_proxy import _open_then_stream
        stream, arrived = DelayedStream(), asyncio.Event()
        async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda req: httpx.Response(200, stream=stream))) as http:
            with patch.object(transport, "_client", return_value=http):
                async def open_now():
                    opened = await transport.open_response(CONF, "/responses", b"{}", stream=True)
                    arrived.set()
                    return opened
                response = await _open_then_stream(None, open_now)
                await anext(response.body_iterator)
                await asyncio.wait_for(arrived.wait(), 3)
                self.assertEqual((await runtime.snapshot())["running"], 1)
                await response.body_iterator.aclose()
                self.assertTrue(stream.closed)
                data = await runtime.snapshot()
                self.assertEqual(data["running"], 0)
                self.assertEqual(data["lastHour"]["cancelled"], 1)

    async def test_proxy_close_while_sending_body_releases_real_capacity(self):
        from app.api.ai_proxy import _open_then_stream
        stream = DelayedStream()
        async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda req: httpx.Response(200, stream=stream))) as http:
            with patch.object(transport, "_client", return_value=http):
                response = await _open_then_stream(None, lambda: transport.open_response(
                    CONF, "/responses", b"{}", stream=True))
                await anext(response.body_iterator)
                self.assertIn(b"first", await anext(response.body_iterator))
                self.assertEqual((await runtime.snapshot())["running"], 1)
                await response.body_iterator.aclose()
                self.assertTrue(stream.closed)
                self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_consumer_close_claim_before_deadline_guard_does_not_deadlock(self):
        entered, release = asyncio.Event(), asyncio.Event()
        stream = DelayedStream()
        original = transport.Response._close_resources
        overlap = {}
        guard_timers = []

        def capture_timeout(seconds):
            timer = asyncio.timeout(seconds)
            guard_timers.append(timer)
            return timer

        proxy = SimpleNamespace(**{**vars(asyncio), "timeout": capture_timeout})

        async def paused_cleanup(response, cancel_guard):
            overlap["cancel_guard"] = cancel_guard
            entered.set()
            await release.wait()
            # On a regression, still release the isolated lease rather than
            # leaving the deliberately constructed cyclic wait in teardown.
            await original(response, cancel_guard and response.guard.done())

        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=stream))) as http:
            with patch.object(transport, "_client", return_value=http), \
                    patch.object(transport.Response, "_close_resources", paused_cleanup), \
                    patch.object(transport, "asyncio", proxy):
                response = await transport.open_response(CONF, "/responses", b"{}")
                closer = self.spawn(response.aclose())
                await asyncio.wait_for(entered.wait(), 2)
                try:
                    # The external close has claimed ownership but its cleanup
                    # has not yet had a chance to cancel the deadline guard.
                    self.assertEqual(len(guard_timers), 1)
                    guard_timers[0].reschedule(asyncio.get_running_loop().time())
                    done, _ = await asyncio.wait((response.guard,), timeout=1)
                    self.assertIn(response.guard, done)
                    self.assertEqual(response.outcome, "timeout")
                    self.assertFalse(closer.done())
                    self.assertTrue(overlap["cancel_guard"])
                finally:
                    release.set()
                    await asyncio.wait_for(asyncio.gather(closer, response.guard), 3)
                self.assertTrue(stream.closed)
        self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_deadline_and_consumer_wait_for_the_same_lease_cleanup(self):
        entered, release = asyncio.Event(), asyncio.Event()
        stream = DelayedStream()
        original_close = runtime.Lease.close
        calls = 0

        async def delayed_close(lease, outcome="completed"):
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            await original_close(lease, outcome)

        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=stream))) as http:
            with patch.object(transport, "_client", return_value=http), patch.object(runtime.Lease, "close", delayed_close):
                response = await transport.open_response(CONF, "/responses", b"{}", timeout=.1)
                # Make the lifetime guard own the close before the consumer.
                await asyncio.wait_for(entered.wait(), 2)
                reader = self.spawn(response.read())
                closer = self.spawn(response.aclose())
                try:
                    await asyncio.sleep(.02)
                    self.assertFalse(reader.done())
                    self.assertFalse(closer.done())
                    self.assertEqual((await runtime.snapshot())["running"], 1)
                finally:
                    release.set()
                    await asyncio.wait_for(asyncio.gather(reader, closer, response.guard, return_exceptions=True), 3)
                with self.assertRaises(runtime.UpstreamError):
                    await reader
                self.assertEqual(calls, 1)
                self.assertTrue(stream.closed)
        self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_cancelled_close_waiter_does_not_abandon_shared_cleanup(self):
        entered, release = asyncio.Event(), asyncio.Event()
        stream = DelayedStream()
        original_close = runtime.Lease.close
        calls = 0

        async def delayed_close(lease, outcome="completed"):
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            await original_close(lease, outcome)

        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=stream))) as http:
            with patch.object(transport, "_client", return_value=http), patch.object(runtime.Lease, "close", delayed_close):
                response = await transport.open_response(CONF, "/responses", b"{}")
                first = self.spawn(response.aclose())
                await asyncio.wait_for(entered.wait(), 2)
                second = self.spawn(response.aclose())
                try:
                    first.cancel()
                    await asyncio.sleep(.02)
                    first.cancel()
                    await asyncio.sleep(.02)
                    self.assertFalse(first.done())
                    self.assertFalse(second.done())
                    self.assertEqual(calls, 1)
                finally:
                    release.set()
                    await asyncio.wait_for(asyncio.gather(first, second, return_exceptions=True), 3)
                with self.assertRaises(asyncio.CancelledError):
                    await first
                await second
                self.assertEqual(calls, 1)
                self.assertTrue(stream.closed)
        self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_deadline_closes_unconsumed_response_and_releases_lease(self):
        stream = DelayedStream()
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=stream))) as http:
            with patch.object(transport, "_client", return_value=http):
                response = await transport.open_response(CONF, "/responses", b"{}")
                # Expire the unconsumed body after headers exist, before the
                # newly created guard gets its first turn on the event loop.
                response.lease.deadline = time.monotonic()
                await asyncio.wait_for(response.guard, 2)
                self.assertEqual(response.outcome, "timeout")
        self.assertTrue(stream.closed)
        self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_sse_keeps_slot_until_eof_and_pool_headers_are_per_request(self):
        await self.policy(globalConcurrent=1)
        stream = DelayedStream()
        seen = []
        async def upstream(request):
            seen.append(request.headers["authorization"])
            return httpx.Response(200, stream=stream if len(seen) == 1 else httpx.ByteStream(b"ok"))
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as http:
            with patch.object(transport, "_client", return_value=http):
                response = await transport.open_response(CONF, "/responses", b"{}", stream=True)
                self.assertGreaterEqual(response.timing["admissionMs"], 0)
                self.assertGreaterEqual(response.timing["upstreamHeadersMs"], 0)
                reader = self.spawn(response.read())
                await stream.started.wait()
                next_response = self.spawn(transport.open_response({**CONF, "key": "second", "user": "bob"}, "/chat/completions", b"{}"))
                await self.queued()
                self.assertEqual(seen, ["Bearer test-key"])
                stream.release.set()
                self.assertEqual(await reader, b'data: {"delta":"first"}\n\ndata: [DONE]\n\n')
                second = await asyncio.wait_for(next_response, 2)
                self.assertEqual(await second.read(), b"ok")
                self.assertEqual(seen, ["Bearer test-key", "Bearer second"])
        self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_disconnect_during_headers_releases_capacity(self):
        entered, disconnected = asyncio.Event(), asyncio.Event()
        async def upstream(request):
            entered.set()
            await asyncio.Event().wait()
        async def is_disconnected():
            return disconnected.is_set()
        request = SimpleNamespace(is_disconnected=is_disconnected)
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as http:
            with patch.object(transport, "_client", return_value=http):
                work = self.spawn(transport.until_disconnect(request, transport.open_response(CONF, "/responses", b"{}")))
                await entered.wait()
                disconnected.set()
                with self.assertRaises(HTTPException) as error:
                    await asyncio.wait_for(work, 2)
                self.assertEqual(error.exception.status_code, 499)
        self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_cancel_during_body_closes_socket_and_lease(self):
        stream = DelayedStream()
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=stream))) as http:
            with patch.object(transport, "_client", return_value=http):
                response = await transport.open_response(CONF, "/responses", b"{}")
                read = self.spawn(response.read())
                await stream.started.wait()
                read.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(read, 2)
        self.assertTrue(stream.closed)
        self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_stalled_body_deadline_and_truncation_are_errors_not_success(self):
        from app.api.ai_proxy import _stream_upstream_response
        for failure in (None, httpx.ReadError("fixture")):
            stream = DelayedStream(error=failure)
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=stream))) as http:
                with patch.object(transport, "_client", return_value=http):
                    response = await transport.open_response(CONF, "/responses", b"{}")
                    response.lease.deadline = time.monotonic() + .1
                    if failure:
                        stream.release.set()
                    raw = b"".join([chunk async for chunk in _stream_upstream_response(response)])
            self.assertIn(b'"error"', raw)
            self.assertNotIn(b"[DONE]", raw)
            self.assertTrue(stream.closed)
        self.assertEqual((await runtime.snapshot())["running"], 0)

    async def test_upstream_rate_limit_preserves_retry_after_and_never_retries(self):
        seen = []
        def upstream(request):
            seen.append(request)
            return httpx.Response(429, content=b'{"error":"quota"}', headers={"Retry-After": "7"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as http:
            with patch.object(transport, "_client", return_value=http):
                with self.assertRaises(runtime.UpstreamError) as error:
                    await transport.open_response(CONF, "/responses", b"{}")
                self.assertEqual(error.exception.retry_after, 7)
                self.assertEqual(error.exception.status, 429)
        self.assertEqual(len(seen), 1)
        data = await runtime.snapshot()
        self.assertEqual(data["running"], 0)
        self.assertEqual(data["lastHour"]["rateLimited"], 1)


if __name__ == "__main__":
    unittest.main()
