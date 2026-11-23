"""Desktop RPC isolation, cancellation ordering and bounded control capacity."""
import asyncio
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, patch

from app.services import agent_setup, ai_local, local_stream, runner_admission
from app.services import runner_local_rpc as rpc
from runner_main import LOCAL_RPC_PREFIX, Runner


class LocalRpcTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.replies = {}
        self.changed = asyncio.Event()
        self.loop = asyncio.get_running_loop()
        self.server = None

    def write(self, blob):
        self.assertTrue(blob.startswith(LOCAL_RPC_PREFIX))
        packet = json.loads(blob[len(LOCAL_RPC_PREFIX):])
        self.loop.call_soon_threadsafe(self.record, packet)

    def record(self, packet):
        self.replies[packet["id"]] = packet
        self.changed.set()

    def create(self, dispatch):
        self.server = rpc.Server(dispatch, self.write, LOCAL_RPC_PREFIX)
        return self.server

    async def reply(self, identity):
        async with asyncio.timeout(3):
            while identity not in self.replies:
                self.changed.clear()
                if identity not in self.replies:
                    await self.changed.wait()
        return self.replies[identity]

    async def asyncTearDown(self):
        if self.server:
            await self.server.close()

    def runner(self):
        machine = Runner.__new__(Runner)
        machine._admission = runner_admission.AdmissionQueue()
        machine._admission_wake = asyncio.Event()
        machine._ensure_admission_loop = lambda: None
        machine._drop_message_transfers = AsyncMock()
        return machine

    async def test_slow_native_detection_does_not_block_other_session_status_or_stop(self):
        machine = self.runner()
        server = self.create(machine._local_rpc_dispatch)
        entered, release = asyncio.Event(), threading.Event()

        def detect(*args, **kwargs):
            self.loop.call_soon_threadsafe(entered.set)
            if not release.wait(5):
                raise AssertionError("test did not release detector")
            return {"installed": True}

        try:
            with patch.object(agent_setup, "detect", side_effect=detect), \
                    patch.object(ai_local, "status_sync", return_value={"status": "running"}), \
                    patch.object(local_stream, "stop_sync", return_value={"ok": True}) as stopped:
                await server.submit("detect", {"op": "runtime.detect", "key": "codex"})
                await asyncio.wait_for(entered.wait(), 3)
                await server.submit("status", {"op": "job.status", "ref": "other-session"})
                await server.submit("stop", {"op": "job.stop", "ref": "other-session"})
                await server.submit("ping", {"op": "runtime.ping"})
                self.assertEqual((await self.reply("status"))["result"]["data"]["status"], "running")
                self.assertTrue((await self.reply("stop"))["result"]["data"]["ok"])
                self.assertTrue((await self.reply("ping"))["result"]["ok"])
                stopped.assert_called_once_with({"taskGoalControl": None}, "other-session")
                self.assertNotIn("detect", self.replies)
                release.set()
                self.assertTrue((await self.reply("detect"))["result"]["ok"])
        finally:
            release.set()

    async def test_same_session_mutations_remain_ordered_while_other_sessions_advance(self):
        entered, release = asyncio.Event(), asyncio.Event()
        seen = []

        async def dispatch(message):
            seen.append(message["tag"])
            if message["tag"] == "first":
                entered.set()
                await release.wait()
            return {"ok": True}

        server = self.create(dispatch)
        try:
            await server.submit("first", {"op": "job.comment", "ref": "a", "tag": "first"})
            await entered.wait()
            await server.submit("second", {"op": "job.authorize", "ref": "a", "tag": "second"})
            await server.submit("other", {"op": "job.comment", "ref": "b", "tag": "other"})
            await self.reply("other")
            self.assertEqual(seen, ["first", "other"])
            release.set()
            await self.reply("second")
            self.assertEqual(seen, ["first", "other", "second"])
        finally:
            release.set()

    async def test_stop_fences_pre_admission_validation_and_new_mutations_wait_for_cleanup(self):
        machine = self.runner()
        entered, release, stopped = asyncio.Event(), asyncio.Event(), asyncio.Event()
        seen = []

        async def dispatch(message):
            seen.append(message["id"])
            if message["op"] == "job.stop":
                stopped.set()
                return {"ok": True}
            if message["id"] == "before-stop":
                entered.set()
                await release.wait()
            return await machine._admit(message, key=message["id"], ref="a",
                category=runner_admission.INTERACTIVE, operation="comment")

        server = self.create(dispatch)
        try:
            await server.submit("before-stop", {"id": "before-stop", "op": "job.comment", "ref": "a"})
            await entered.wait()
            await server.submit("queued", {"id": "queued", "op": "job.comment", "ref": "a"})
            await server.submit("stop", {"id": "stop", "op": "job.stop", "ref": "a"})
            await self.reply("stop")
            await server.submit("after-stop", {"id": "after-stop", "op": "job.comment", "ref": "a"})
            self.assertEqual(seen, ["before-stop", "stop"])
            release.set()
            self.assertEqual((await self.reply("before-stop"))["result"]["code"], "RUNNER_REQUEST_CANCELLED")
            self.assertEqual((await self.reply("queued"))["result"]["code"], "RUNNER_REQUEST_CANCELLED")
            self.assertTrue((await self.reply("after-stop"))["result"]["ok"])
            self.assertIsNone(machine._admission.get("before-stop"))
            self.assertIsNone(machine._admission.get("queued"))
            self.assertIsNotNone(machine._admission.get("after-stop"))
        finally:
            release.set()

    async def test_stop_after_durable_admission_cancels_the_existing_receipt(self):
        machine = self.runner()

        async def dispatch(message):
            if message["op"] == "job.stop":
                return await machine._job({**message, "_localParent": True})
            return await machine._admit(message, key="accepted", ref="a",
                category=runner_admission.INTERACTIVE, operation="dispatch")

        server = self.create(dispatch)
        await server.submit("send", {"op": "job.dispatch", "ref": "a"})
        self.assertTrue((await self.reply("send"))["result"]["ok"])
        await server.submit("stop", {"op": "job.stop", "ref": "a"})
        self.assertTrue((await self.reply("stop"))["result"]["ok"])
        self.assertEqual(machine._admission.get("accepted").state, "cancelled")

    async def test_cancellation_before_coroutine_start_does_not_let_a_later_mutation_jump(self):
        entered, release = asyncio.Event(), asyncio.Event()
        seen = []

        async def dispatch(message):
            seen.append(message["tag"])
            if message["tag"] == "first":
                entered.set()
                await release.wait()
            return {"ok": True}

        server = self.create(dispatch)
        try:
            await server.submit("first", {"op": "job.comment", "ref": "a", "tag": "first"})
            await entered.wait()
            before = set(server.tasks)
            await server.submit("cancel", {"op": "job.comment", "ref": "a", "tag": "cancel"})
            next(iter(server.tasks - before)).cancel()
            await server.submit("later", {"op": "job.comment", "ref": "a", "tag": "later"})
            await server.submit("other", {"op": "job.status", "ref": "b", "tag": "other"})
            await self.reply("other")
            self.assertEqual(seen, ["first", "other"])
            release.set()
            await self.reply("later")
            self.assertEqual(seen, ["first", "other", "later"])
        finally:
            release.set()

    async def test_saturated_work_lane_retains_control_and_query_capacity(self):
        release = asyncio.Event()

        async def dispatch(message):
            if message["op"] == "job.comment":
                await release.wait()
            return {"ok": True}

        server = self.create(dispatch)
        try:
            for index in range(32):
                await server.submit(str(index), {"op": "job.comment", "ref": str(index)})
            await server.submit("overflow", {"op": "job.comment", "ref": "overflow"})
            self.assertEqual((await self.reply("overflow"))["result"]["code"], "RUNNER_RPC_BUSY")
            await server.submit("stop", {"op": "job.stop", "ref": "0"})
            await server.submit("status", {"op": "job.status", "ref": "other"})
            self.assertTrue((await self.reply("stop"))["result"]["ok"])
            self.assertTrue((await self.reply("status"))["result"]["ok"])
            self.assertLessEqual(len(server.tasks), 34)
        finally:
            release.set()

    async def test_repeated_stalled_polls_are_bounded_per_session(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def dispatch(message):
            if message.get("ref") == "slow":
                entered.set()
                await release.wait()
            return {"ok": True}

        server = self.create(dispatch)
        try:
            await server.submit("slow", {"op": "job.session", "ref": "slow"})
            await entered.wait()
            await server.submit("repeat", {"op": "job.session", "ref": "slow"})
            self.assertEqual((await self.reply("repeat"))["result"]["code"], "RUNNER_RPC_BUSY")
            await server.submit("fast", {"op": "job.session", "ref": "fast"})
            self.assertTrue((await self.reply("fast"))["result"]["ok"])
        finally:
            release.set()

    async def test_one_request_failure_does_not_cancel_its_sibling(self):
        async def dispatch(message):
            if message.get("ref") == "bad":
                raise ValueError("synthetic failure")
            return {"ok": True, "unicode": "独立会话"}

        server = self.create(dispatch)
        await server.submit("bad", {"op": "job.session", "ref": "bad"})
        await server.submit("good", {"op": "job.session", "ref": "good"})
        self.assertFalse((await self.reply("bad"))["ok"])
        self.assertEqual((await self.reply("good"))["result"]["unicode"], "独立会话")

    async def test_slow_reply_pipe_bounds_retained_results_without_blocking_stop_dispatch(self):
        entered, stopped, release = asyncio.Event(), asyncio.Event(), threading.Event()

        def write(blob):
            self.loop.call_soon_threadsafe(entered.set)
            release.wait(5)
            self.write(blob)

        async def dispatch(message):
            if message["op"] == "job.stop":
                stopped.set()
            return {"ok": True}

        self.server = server = rpc.Server(dispatch, write, LOCAL_RPC_PREFIX)
        try:
            for index in range(32):
                await server.submit(str(index), {"op": "job.comment", "ref": str(index)})
            await asyncio.wait_for(entered.wait(), 3)
            await server.submit("overflow", {"op": "job.comment", "ref": "overflow"})
            await server.submit("stop", {"op": "job.stop", "ref": "unrelated"})
            await asyncio.wait_for(stopped.wait(), 3)
            self.assertEqual(server.counts["work"], 32)
            self.assertEqual(len(server.tasks), 33)
            self.assertEqual(len(server.replies), 1)
            release.set()
            self.assertTrue((await self.reply("stop"))["result"]["ok"])
            self.assertEqual((await self.reply("overflow"))["result"]["code"], "RUNNER_RPC_BUSY")
        finally:
            release.set()

    async def test_broken_reply_pipe_retires_transport_without_retrying_the_operation(self):
        failed = asyncio.Event()
        writes = []
        calls = []

        def write(blob):
            writes.append(blob)
            raise BrokenPipeError("synthetic closed parent")

        async def dispatch(message):
            calls.append(message)
            return {"ok": True}

        self.server = server = rpc.Server(dispatch, write, LOCAL_RPC_PREFIX, failed.set)
        await server.submit("first", {"op": "runtime.ping"})
        await asyncio.wait_for(failed.wait(), 3)
        with self.assertRaises(ConnectionError):
            await server.submit("second", {"op": "job.dispatch"})
        self.assertEqual(len(writes), 1)
        self.assertEqual(len(calls), 1)

    async def test_cancelled_thread_keeps_its_lane_until_the_worker_finishes(self):
        entered, release = asyncio.Event(), threading.Event()

        def work():
            self.loop.call_soon_threadsafe(entered.set)
            release.wait(5)

        async def dispatch(message):
            await rpc.to_thread(work)
            return {"ok": True}

        server = self.create(dispatch)
        try:
            await server.submit("worker", {"op": "runtime.detect", "key": "codex"})
            await entered.wait()
            task = next(iter(server.tasks))
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            self.assertEqual(server.counts["probe"], 1)
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done(), "repeated cancellation must retain the actual worker")
            self.assertEqual(server.counts["probe"], 1)
            release.set()
            await asyncio.gather(task, return_exceptions=True)
            self.assertEqual(server.counts["probe"], 0)
        finally:
            release.set()

    async def test_actual_pipe_reader_keeps_consuming_during_slow_dispatch(self):
        machine = self.runner()
        incoming = asyncio.Queue()
        entered, release = asyncio.Event(), asyncio.Event()

        async def lines(stream):
            while True:
                value = await incoming.get()
                yield value
                if not value:
                    return

        async def dispatch(message):
            if message["op"] == "runtime.detect":
                entered.set()
                await release.wait()
            return {"ok": True}

        machine._local_rpc_dispatch = dispatch
        machine._write_local_rpc = self.write
        task = None
        try:
            with patch("app.services.runner_lifecycle.parent_lines", side_effect=lines):
                task = asyncio.create_task(machine._local_rpc_loop())
                for identity, op in (("slow", "runtime.detect"), ("ping", "runtime.ping")):
                    await incoming.put((LOCAL_RPC_PREFIX + json.dumps({"id": identity,
                        "message": {"op": op}}) + "\n").encode())
                await self.reply("ping")
                self.assertTrue(entered.is_set())
                self.assertNotIn("slow", self.replies)
                release.set()
                await self.reply("slow")
                await incoming.put(b"")
                await asyncio.wait_for(task, 3)
        finally:
            release.set()
            if task and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)


class RunnerPipeProcessTests(unittest.TestCase):
    def test_real_runner_pipe_can_admit_observe_and_cancel_while_detection_is_blocked(self):
        # Exercise real stdin/stdout, worker threads and the durable admission
        # journal. Only native discovery is synthetic; no provider is contacted.
        child_source = '''
import asyncio, json, threading
from runner_main import Runner, LOCAL_RPC_PREFIX
from app.services import agent_setup
machine = Runner("http://127.0.0.1:1", "", "fixture-device", "fixture-runner")
machine._ensure_admission_loop = lambda: None
gate = threading.Event()
def detect(key, **kwargs):
    if key == "codex":
        machine._write_local_rpc(LOCAL_RPC_PREFIX + json.dumps({"id":"detector-entered","ok":True}) + "\\n")
        if not gate.wait(15):
            raise RuntimeError("test detector release missing")
    else:
        gate.set()
    return {"installed": True}
agent_setup.detect = detect
asyncio.run(machine._local_rpc_loop())
'''
        with tempfile.TemporaryDirectory(prefix="runner-pipe-") as directory:
            env = {key: value for key, value in os.environ.items()
                   if key in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"}}
            env.update(SODUWORK_DATA_ROOT=directory, AUTH_SECRET="fixture-rpc-secret",
                       ADMIN_PASS="fixture-rpc-password", PYTHONDONTWRITEBYTECODE="1",
                       PYTHONUNBUFFERED="1")
            with tempfile.TemporaryFile() as errors:
                process = subprocess.Popen([sys.executable, "-c", child_source],
                    cwd=Path(__file__).parent, env=env, stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=errors, text=True, encoding="utf-8")
                packets = queue.Queue()
                pending = {}

                def read():
                    for line in process.stdout:
                        if line.startswith(LOCAL_RPC_PREFIX):
                            packets.put(json.loads(line[len(LOCAL_RPC_PREFIX):]))

                reader = threading.Thread(target=read, daemon=True)
                reader.start()

                def send(identity, op, **payload):
                    process.stdin.write(LOCAL_RPC_PREFIX + json.dumps({"id": identity,
                        "message": {"op": op, **payload}}) + "\n")
                    process.stdin.flush()

                def receive(identity):
                    while identity not in pending:
                        packet = packets.get(timeout=5)
                        pending[packet["id"]] = packet
                    return pending.pop(identity)

                try:
                    send("detect", "runtime.detect", key="codex")
                    receive("detector-entered")
                    send("dispatch", "job.dispatch", cli="opencode", dispatchId="chat:pipe-isolation",
                         task={"id": "pipe-fixture"}, ctx={"conversationMode": "chat"})
                    admitted = receive("dispatch")["result"]
                    self.assertTrue(admitted["ok"], admitted)
                    ref = admitted["data"]["ref"]
                    send("session", "job.session", ref=ref)
                    self.assertEqual(receive("session")["result"]["data"]["status"], "queued")
                    send("stop", "job.stop", ref=ref)
                    self.assertTrue(receive("stop")["result"]["ok"])
                    send("status", "job.status", ref=ref)
                    self.assertEqual(receive("status")["result"]["data"]["status"], "cancelled")
                    self.assertNotIn("detect", pending)
                    send("release", "runtime.detect", key="qwen")
                    self.assertTrue(receive("release")["result"]["ok"])
                    self.assertTrue(receive("detect")["result"]["ok"])
                    process.stdin.close()
                    self.assertEqual(process.wait(timeout=5), 0)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
                    if not process.stdin.closed:
                        process.stdin.close()
                    reader.join(timeout=2)
                    process.stdout.close()


if __name__ == "__main__":
    unittest.main()
