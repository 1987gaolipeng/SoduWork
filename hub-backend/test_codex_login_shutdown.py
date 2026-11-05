"""Runner shutdown cancels only owned Codex authorization jobs within a deadline."""
import asyncio
import ast
import contextlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from app.services import codex_account_home as account
from app.services import codex_login_flow as flow
from app.services import runner_lifecycle


class LoginShutdownTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory(prefix="soduwork-login-shutdown-")
        self.addCleanup(self.root.cleanup)
        with flow._LOCK:
            self.assertFalse(flow._PENDING)
            flow._SHUTTING_DOWN.clear()
        self.addCleanup(flow._SHUTTING_DOWN.clear)

    def test_empty_shutdown_is_immediate_and_closes_admission(self):
        started = time.monotonic()
        self.assertTrue(flow.shutdown(timeout=1))
        self.assertLess(time.monotonic() - started, .25)
        self.assertFalse(flow.reserve("too-late", self.root.name))
        self.assertTrue(flow.shutdown(timeout=0))

    def test_reserved_job_cannot_launch_after_shutdown_begins(self):
        self.assertTrue(flow.reserve("reserved", self.root.name))
        outcomes = []
        stopping = threading.Thread(target=lambda: outcomes.append(flow.shutdown(timeout=2)))
        stopping.start()
        try:
            self.assertTrue(flow._SHUTTING_DOWN.wait(1))
            with patch.object(flow, "environment", side_effect=AssertionError("No native launch after shutdown")):
                result = flow.run("reserved", "unused", self.root.name, publish=lambda _: None)
            self.assertEqual(result[2], 130)
        finally:
            stopping.join(3)
        self.assertFalse(stopping.is_alive())
        self.assertEqual(outcomes, [True])

    def test_unresponsive_job_has_bounded_wait_and_retains_cancellation(self):
        self.assertTrue(flow.reserve("unresponsive", self.root.name))
        started = time.monotonic()
        try:
            self.assertFalse(flow.shutdown(timeout=.05))
            self.assertLess(time.monotonic() - started, .3)
            self.assertTrue(flow._PENDING["unresponsive"][1].is_set())
            self.assertFalse(flow.reserve("late", self.root.name))
        finally:
            result = flow.run("unresponsive", "unused", self.root.name, publish=lambda _: None)
            self.assertEqual(result[2], 130)
        self.assertTrue(flow.shutdown(timeout=0))

    def test_lock_held_by_commit_cannot_exceed_shutdown_deadline(self):
        held, release = threading.Event(), threading.Event()
        def hold():
            with flow._LOCK:
                held.set()
                release.wait(2)
        owner = threading.Thread(target=hold)
        owner.start()
        try:
            self.assertTrue(held.wait(1))
            started = time.monotonic()
            self.assertFalse(flow.shutdown(timeout=.05))
            self.assertLess(time.monotonic() - started, .3)
        finally:
            release.set()
            owner.join(2)

    def test_real_child_is_reaped_without_stopping_unrelated_process(self):
        flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        unrelated = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(120)"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **flags)
        child = []
        actual_popen = subprocess.Popen
        started = threading.Event()
        outcomes, updates = [], []
        env = dict(os.environ, CODEX_HOME=self.root.name)
        def record(argv, *args, **kwargs):
            process = actual_popen(argv, *args, **kwargs)
            if argv[0] == sys.executable:
                child.append(process)
            return process
        def execute(argv, process_env, emit, timeout, **kwargs):
            def output(line):
                started.set()
                emit(line)
            return account._execute([sys.executable, "-c",
                "import time;print('synthetic-ready',flush=True);time.sleep(120)"],
                process_env, output, timeout, **kwargs)
        self.assertTrue(flow.reserve("real-child", self.root.name))
        worker = threading.Thread(target=lambda: outcomes.append(flow.run("real-child", "fixture",
            self.root.name, publish=updates.append, execute=execute)), daemon=True)
        try:
            with patch.object(flow, "environment", return_value=env), \
                 patch.object(account, "status", return_value=("unauthed", "fixture")), \
                 patch.object(subprocess, "Popen", side_effect=record):
                worker.start()
                self.assertTrue(started.wait(5))
                began = time.monotonic()
                self.assertTrue(flow.shutdown(timeout=8))
                self.assertLess(time.monotonic() - began, 9)
                worker.join(1)
            self.assertFalse(worker.is_alive())
            self.assertEqual(outcomes[0][2], 130)
            self.assertEqual(updates[-1], {"state": "cancelled"})
            self.assertEqual(len(child), 1)
            self.assertIsNotNone(child[0].poll())
            self.assertIsNone(unrelated.poll())
        finally:
            flow.cancel("real-child", self.root.name)
            for process in [*child, unrelated]:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
            worker.join(3)


class RunnerLoginShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_normal_stop_drains_login_outside_event_loop(self):
        entered = asyncio.Event()
        stopped = asyncio.Event()
        main_thread = threading.get_ident()
        calls = []
        async def run():
            entered.set()
            await asyncio.Future()
        runner = SimpleNamespace(run=run, _shutdown_event=stopped)
        def cleanup():
            calls.append(threading.get_ident())
            return True
        with patch.object(flow, "shutdown", side_effect=cleanup):
            task = asyncio.create_task(runner_lifecycle.run_until_stopped(runner))
            await entered.wait()
            stopped.set()
            await asyncio.wait_for(task, 2)
        self.assertEqual(len(calls), 1)
        self.assertNotEqual(calls[0], main_thread)

    async def test_runner_failure_still_drains_login_and_preserves_error(self):
        async def run():
            raise RuntimeError("synthetic connection failure")
        runner = SimpleNamespace(run=run, _shutdown_event=asyncio.Event())
        with patch.object(flow, "shutdown", return_value=True) as cleanup:
            with self.assertRaisesRegex(RuntimeError, "synthetic connection failure"):
                await runner_lifecycle.run_until_stopped(runner)
        cleanup.assert_called_once_with()

    async def test_external_cancellation_still_drains_login(self):
        entered = asyncio.Event()
        async def run():
            entered.set()
            await asyncio.Future()
        runner = SimpleNamespace(run=run, _shutdown_event=asyncio.Event())
        with patch.object(flow, "shutdown", return_value=True) as cleanup:
            task = asyncio.create_task(runner_lifecycle.run_until_stopped(runner))
            await entered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        cleanup.assert_called_once_with()


class HubLoginShutdownTests(unittest.IsolatedAsyncioTestCase):
    def finalizer(self, cluster, transport):
        # Exercise the actual finalizer with inert services, without executing
        # database bootstrap or unrelated Hub background work.
        source = Path(__file__).parent / "app" / "main.py"
        module = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        lifecycle = next(node for node in module.body
                         if isinstance(node, ast.AsyncFunctionDef) and node.name == "lifespan")
        lifecycle.body = [lifecycle.body[-1]]
        self.assertIsInstance(lifecycle.body[0], ast.Try)
        code = ast.fix_missing_locations(ast.Module(body=[lifecycle], type_ignores=[]))
        namespace = {"__name__": "app.main", "__package__": "app", "FastAPI": object,
                     "asynccontextmanager": contextlib.asynccontextmanager,
                     "contextlib": contextlib, "asyncio": asyncio, "bg": [],
                     "cluster_runtime": cluster, "log": Mock()}
        # The extracted finalizer normally closes these services over from
        # startup. Supply inert peers because this fixture omits startup.
        for name in ("automation_inbox_events", "cloud_sync_notifications", "client_domain_events"):
            namespace[name] = SimpleNamespace(stop=AsyncMock())
        exec(compile(code, str(source), "exec"), namespace)
        from app import services
        self.enterContext(patch.object(services, "model_transport", transport, create=True))
        return namespace["lifespan"]

    async def test_hub_normal_exit_drains_authorization_off_event_loop(self):
        cluster = SimpleNamespace(stop=AsyncMock())
        transport = SimpleNamespace(shutdown=AsyncMock())
        finalizer = self.finalizer(cluster, transport)
        main_thread, calls = threading.get_ident(), []
        def cleanup():
            calls.append(threading.get_ident())
            return True
        with patch.object(flow, "shutdown", side_effect=cleanup):
            async with finalizer(None):
                pass
        cluster.stop.assert_awaited_once_with()
        transport.shutdown.assert_awaited_once_with()
        self.assertEqual(len(calls), 1)
        self.assertNotEqual(calls[0], main_thread)

    async def test_hub_cleanup_failure_still_drains_and_preserves_error(self):
        cluster = SimpleNamespace(stop=AsyncMock(side_effect=RuntimeError("synthetic shutdown failure")))
        transport = SimpleNamespace(shutdown=AsyncMock())
        finalizer = self.finalizer(cluster, transport)
        with patch.object(flow, "shutdown", return_value=True) as cleanup:
            with self.assertRaisesRegex(RuntimeError, "synthetic shutdown failure"):
                async with finalizer(None):
                    pass
        cleanup.assert_called_once_with()
        transport.shutdown.assert_awaited_once_with()


if __name__ == "__main__":
    unittest.main()
