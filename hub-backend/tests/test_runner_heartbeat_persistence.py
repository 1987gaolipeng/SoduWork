"""Regression coverage for isolated Runner heartbeat persistence failures."""

import time
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.api import runner_ws
from app.services import runner_registry
from app.services.runner_identity_error import RunnerIdentityConflict


def _session_factory(session):
    @asynccontextmanager
    async def factory():
        yield session

    return factory


def _due_write() -> float:
    return time.time() - runner_registry.PERSIST_EVERY_S - 1


class RunnerHeartbeatPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_record_failure_keeps_connection_path_alive_and_retries(self):
        runner = SimpleNamespace(id="runner-record", _registry_write=_due_write())
        previous_write = runner._registry_write
        attempts = 0

        async def record(_session, target):
            nonlocal attempts
            attempts += 1
            target._registry_write = time.time()
            if attempts == 1:
                raise RuntimeError("record unavailable")

        session = SimpleNamespace(commit=AsyncMock())
        with patch.object(runner_ws, "SessionLocal", _session_factory(session)), \
             patch.object(runner_ws.runner_registry, "record", record), \
             patch.object(runner_ws.log, "warning"):
            self.assertFalse(await runner_ws._persist_runner_heartbeat(runner))
            self.assertEqual(runner._registry_write, previous_write)
            self.assertGreaterEqual(
                time.time() - runner._registry_write,
                runner_registry.PERSIST_EVERY_S,
            )

            self.assertTrue(await runner_ws._persist_runner_heartbeat(runner))

        self.assertEqual(attempts, 2)
        session.commit.assert_awaited_once()

    async def test_commit_failure_restores_throttle_and_retries_immediately(self):
        runner = SimpleNamespace(id="runner-commit", _registry_write=_due_write())
        previous_write = runner._registry_write
        record = AsyncMock(side_effect=lambda _session, target: setattr(
            target, "_registry_write", time.time()))
        session = SimpleNamespace(commit=AsyncMock(
            side_effect=[RuntimeError("commit unavailable"), None]))

        with patch.object(runner_ws, "SessionLocal", _session_factory(session)), \
             patch.object(runner_ws.runner_registry, "record", record), \
             patch.object(runner_ws.log, "warning"):
            self.assertFalse(await runner_ws._persist_runner_heartbeat(runner))
            self.assertEqual(runner._registry_write, previous_write)
            self.assertGreaterEqual(
                time.time() - runner._registry_write,
                runner_registry.PERSIST_EVERY_S,
            )

            self.assertTrue(await runner_ws._persist_runner_heartbeat(runner))

        self.assertEqual(record.await_count, 2)
        self.assertEqual(session.commit.await_count, 2)
        self.assertGreater(runner._registry_write, previous_write)

    async def test_session_exit_failure_restores_throttle_and_retries_immediately(self):
        runner = SimpleNamespace(id="runner-exit", _registry_write=_due_write())
        previous_write = runner._registry_write
        record = AsyncMock(side_effect=lambda _session, target: setattr(
            target, "_registry_write", time.time()))
        session = SimpleNamespace(commit=AsyncMock())
        exits = 0

        @asynccontextmanager
        async def factory():
            nonlocal exits
            yield session
            exits += 1
            if exits == 1:
                raise RuntimeError("session cleanup unavailable")

        with patch.object(runner_ws, "SessionLocal", factory), \
             patch.object(runner_ws.runner_registry, "record", record), \
             patch.object(runner_ws.log, "warning"):
            self.assertFalse(await runner_ws._persist_runner_heartbeat(runner))
            self.assertEqual(runner._registry_write, previous_write)
            self.assertGreaterEqual(
                time.time() - runner._registry_write,
                runner_registry.PERSIST_EVERY_S,
            )
            self.assertTrue(await runner_ws._persist_runner_heartbeat(runner))

        self.assertEqual(exits, 2)
        self.assertEqual(record.await_count, 2)
        self.assertEqual(session.commit.await_count, 2)
        self.assertGreater(runner._registry_write, previous_write)

    async def test_first_capability_report_bypasses_recent_hello_write(self):
        runner = SimpleNamespace(
            id="runner-capability",
            _registry_write=time.time(),
            capabilities={"reportedAt": 0},
        )
        report = {
            "schemaVersion": 3,
            "reportedAt": int(time.time()),
            "available": ["terminal"],
            "items": [],
        }
        force = runner_ws._update_runner_capabilities(
            runner, report, persisted=False)
        self.assertTrue(force)

        calls = []

        async def record(_session, target, *, force=False):
            calls.append(force)
            target._registry_write = time.time()

        session = SimpleNamespace(commit=AsyncMock())
        with patch.object(runner_ws, "SessionLocal", _session_factory(session)), \
             patch.object(runner_ws.runner_registry, "record", record):
            self.assertTrue(await runner_ws._persist_runner_heartbeat(
                runner, force=force))

        self.assertEqual(calls, [True])
        session.commit.assert_awaited_once()
        self.assertFalse(runner_ws._update_runner_capabilities(
            runner, report, persisted=True))

    async def test_identity_and_lifecycle_rejections_still_propagate(self):
        for rejection in (RunnerIdentityConflict(), ValueError("runner retired")):
            with self.subTest(rejection=type(rejection).__name__):
                runner = SimpleNamespace(id="runner-rejected", _registry_write=_due_write())
                previous_write = runner._registry_write

                async def reject(_session, target, rejection=rejection):
                    target._registry_write = time.time()
                    raise rejection

                session = SimpleNamespace(commit=AsyncMock())
                with patch.object(runner_ws, "SessionLocal", _session_factory(session)), \
                     patch.object(runner_ws.runner_registry, "record", reject):
                    with self.assertRaises(type(rejection)):
                        await runner_ws._persist_runner_heartbeat(runner)

                self.assertEqual(runner._registry_write, previous_write)
                session.commit.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
