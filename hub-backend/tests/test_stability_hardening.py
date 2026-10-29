"""Regression tests for the stability hardening changes: atomic background-execution
slot accounting (no check-then-act race across the llm.load await), slot release when
workspace creation fails, and the bounded LRU runner-routing cache.
"""

import asyncio
import os
import tempfile
import time
import unittest
from contextlib import asynccontextmanager
from unittest.mock import patch

from app import models
from app.services import agent_runner, ai_remote, cluster_bus, task_requirements


def _task(task_id: str) -> models.Task:
    return models.Task(id=task_id, title="stability regression", status="doing",
                       owner_client_id="qa-client")


async def _noop_async(*_args, **_kwargs) -> None:
    pass


class AgentSlotTests(unittest.IsolatedAsyncioTestCase):
    """Concurrency and lifecycle guarantees around the _MAX_CONCURRENT slot pool."""

    def tearDown(self):
        agent_runner._RUNNING.clear()

    async def test_concurrent_starts_never_oversubscribe_slots(self):
        """Six racing starts must admit exactly _MAX_CONCURRENT tasks despite the
        llm.load await inside the critical section."""
        started_counter = {"n": 0}

        async def fake_load(_session, force=True):  # noqa: ARG001 - mirrors the real signature
            # Reproduce the original yielding window: the event loop can schedule
            # another start() while this coroutine is suspended.
            await asyncio.sleep(0.01)
            return {"llm_base_url": "http://gw", "llm_api_key": "k", "llm_model": "m"}

        def fake_record(_session, task_id, _event, _payload, actor=None):  # noqa: ARG001
            started_counter["n"] += 1

        with patch.object(agent_runner.llm, "load", fake_load), \
             patch.object(agent_runner.llm, "enabled", lambda _cfg: True), \
             patch.object(agent_runner, "_opencode_bin", lambda: "/bin/opencode"), \
             patch.object(agent_runner.task_events, "record", fake_record), \
             patch.object(agent_runner, "_run_bg", _noop_async), \
             patch.object(cluster_bus.bus, "enabled", False), \
             patch.object(task_requirements, "ensure_executable", lambda _task: None):
            results = await asyncio.gather(
                *(agent_runner.start(None, _task(f"slot-{i}"), "qa") for i in range(6)),
                return_exceptions=True,
            )
        admitted = [r for r in results if not isinstance(r, BaseException)]
        rejected = [r for r in results if isinstance(r, ValueError)]
        self.assertEqual(len(admitted), agent_runner._MAX_CONCURRENT)
        self.assertEqual(len(rejected), 6 - agent_runner._MAX_CONCURRENT)
        self.assertTrue(all("执行槽已满" in str(r) for r in rejected))
        self.assertEqual(len(agent_runner._RUNNING), agent_runner._MAX_CONCURRENT)

    async def test_workspace_failure_releases_slot(self):
        """A workspace-creation failure must still release the claimed slot via the
        finally block instead of leaking it (which would exhaust execution capacity)."""
        holder = tempfile.mkdtemp(prefix="slot-leak-")
        blocker = os.path.join(holder, "file")   # A file cannot contain a directory.
        with open(blocker, "w", encoding="utf-8") as fh:
            fh.write("x")
        bad_root = os.path.join(blocker, "sub")   # Parent is a file -> makedirs must fail.

        @asynccontextmanager
        async def fake_session():
            class _Session:
                async def get(self, *_a, **_k):
                    return None
                async def commit(self):
                    return None
            yield _Session()

        agent_runner._RUNNING["leak-1"] = time.monotonic()
        try:
            with patch.object(agent_runner, "_WS_ROOT", bad_root), \
                 patch.object(agent_runner, "SessionLocal", fake_session), \
                 patch.object(agent_runner.task_events, "record", lambda *_a, **_k: None):
                # Must not raise out of _run_bg and must clear the slot.
                await agent_runner._run_bg("leak-1", "t", "", "http://gw", "key", "m", "qa")
            self.assertNotIn("leak-1", agent_runner._RUNNING)
        finally:
            os.unlink(blocker)
            os.rmdir(holder)


class WhereCacheTests(unittest.TestCase):
    """The dispatch routing cache must stay bounded without losing correctness."""

    def tearDown(self):
        ai_remote._WHERE.clear()

    def test_remember_evicts_oldest_beyond_cap_and_refreshes_recency(self):
        original_cap = ai_remote._WHERE_MAX
        try:
            ai_remote._WHERE_MAX = 3
            ai_remote._WHERE.clear()
            for i in range(3):
                ai_remote.remember(f"ref-{i}", f"runner-{i}")
            # Touch ref-0 so it becomes the most recently used entry.
            ai_remote.remember("ref-0", "runner-0")
            ai_remote.remember("ref-3", "runner-3")     # Exceeds the cap by one.
            self.assertEqual(len(ai_remote._WHERE), 3)
            self.assertNotIn("ref-1", ai_remote._WHERE)  # LRU entry evicted, not ref-0.
            self.assertIn("ref-0", ai_remote._WHERE)
        finally:
            ai_remote._WHERE_MAX = original_cap

    def test_remember_keeps_cap_when_overwritten_in_place(self):
        original_cap = ai_remote._WHERE_MAX
        try:
            ai_remote._WHERE_MAX = 2
            ai_remote._WHERE.clear()
            ai_remote.remember("ref-a", "runner-a")
            ai_remote.remember("ref-b", "runner-b")
            ai_remote.remember("ref-a", "runner-a2")     # Same ref, refreshed value.
            self.assertEqual(len(ai_remote._WHERE), 2)
            self.assertEqual(ai_remote._WHERE.get("ref-a"), "runner-a2")
        finally:
            ai_remote._WHERE_MAX = original_cap


if __name__ == "__main__":
    unittest.main()
