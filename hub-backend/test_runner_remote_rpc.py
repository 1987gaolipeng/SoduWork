"""Bounded remote Runner requests preserve control capacity and negative ACKs."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import contextvars
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import runner_main
from app.services import agent_setup, ai_local, ai_remote, local_base, local_stream, runner_local_rpc, runner_turn_selection
from app.services.runner_admission import AdmissionQueue


class Socket:
    def __init__(self):
        self.messages = []
        self.closed = []

    async def send(self, payload):
        self.messages.append(json.loads(payload))

    async def close(self, **kwargs):
        self.closed.append(kwargs)


class RemoteRpcTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.machine = runner_main.Runner.__new__(runner_main.Runner)
        self.machine._rpc_tasks, self.machine._dispatch_tasks = set(), set()
        self.machine._send_target = contextvars.ContextVar("remote-test-target", default=None)
        self.machine._send_lock = asyncio.Lock()
        self.machine.ws = Socket()
        self.releases = []

    async def asyncTearDown(self):
        for release in self.releases:
            release.set()
        await asyncio.gather(*list(self.machine._rpc_tasks), return_exceptions=True)
        await asyncio.gather(*list(getattr(self.machine, "_rpc_rejections", [])), return_exceptions=True)
        workers = getattr(self.machine, "_network_workers", None)
        if workers:
            workers.close()

    async def reply(self, identity):
        for _ in range(500):
            for packet in self.machine.ws.messages:
                if packet.get("id") == identity:
                    return packet
            await asyncio.sleep(.001)
        self.fail("missing remote reply: " + identity)

    def admission_fixture(self):
        self.machine._admission = AdmissionQueue()
        self.machine._admission_wake = asyncio.Event()
        self.machine._ensure_admission_loop = lambda: None
        self.machine.work_root, self.machine.capability_grants = "", None

    async def test_status_preview_preserves_runner_fields_without_packaging_or_git_writes(self):
        self.admission_fixture()
        with tempfile.TemporaryDirectory() as folder:
            for name in ("a.html", "b.html", "c.html"):
                (Path(folder) / name).write_text("<h1>Fixture</h1>", encoding="utf-8")
            ref = "preview-ref"
            run = {"ref": ref, "ws": folder, "state": "done", "cli": "pi", "artifactMode": "mixed",
                   "round": 2, "segment": 3, "gitDelivery": {"head": "recorded-head"},
                   "lines": [{"kind": "say", "text": "Final text"}]}
            with patch.dict(ai_local._RUNS, {ref: run}), \
                    patch.object(ai_local, "_bundle_artifact", side_effect=AssertionError("Unexpected ZIP write")), \
                    patch.object(ai_local, "_git_delivery", side_effect=AssertionError("Unexpected Git capture")):
                await self.machine._queue_message({"op": "job.info", "id": "preview", "ref": ref,
                                                   "statusPreview": True}, self.machine.ws)
                reply = await self.reply("preview")
                self.assertTrue(reply["ok"], reply)
                status = reply["data"]
                self.assertEqual((status["round"], status["segment"], status["finalText"]), (2, 3, "Final text"))
                self.assertEqual(status["gitHead"], "recorded-head")
                self.assertCountEqual([a["filename"] for a in status["attachments"]], ["a.html", "b.html", "c.html"])
                self.assertNotIn("artDropped", run)

    def test_status_preview_reads_older_runners_via_job_info(self):
        from types import SimpleNamespace
        machine = SimpleNamespace(host="fixture-host")
        previous = {"taskStatus": "queued", "done": False, "queued": True, "queuePosition": 2}
        with patch.dict(ai_remote._WHERE, clear=True), \
                patch.object(ai_remote, "_runner_of_ref", side_effect=AssertionError("Unexpected job discovery")), \
                patch.object(ai_remote.runner_hub, "get", return_value=machine), \
                patch.object(ai_remote.runner_hub, "call_sync", return_value={"ok": True, "data": previous}) as rpc:
            self.assertEqual(ai_remote.preview_status_sync("run-1", runner_id="", detailed=False), {})
            self.assertFalse(ai_remote.preview_status_sync("run-1", runner_id="", detailed=True)["ok"])
            rpc.assert_not_called()
            status = ai_remote.preview_status_sync("run-1", runner_id="node-1", detailed=True)
        rpc.assert_called_once_with(machine, "job.info", {"ref": "run-1", "statusPreview": True}, timeout=30)
        self.assertEqual((status["status"], status["host"], status["queuePosition"]), ("queued", "fixture-host", 2))

    async def test_real_agent_discovery_cannot_block_other_session_status_stop_or_ping(self):
        self.admission_fixture()
        loop = asyncio.get_running_loop()
        entered, release, expired, first = asyncio.Event(), threading.Event(), threading.Event(), threading.Event()
        self.releases.append(release)

        def detect(key, **kwargs):
            if not first.is_set():
                first.set()
                loop.call_soon_threadsafe(entered.set)
                if not release.wait(3):
                    expired.set()
            return {"key": key, "installed": False}

        with patch.object(agent_setup, "node_env", return_value={"ok": True}), \
                patch.object(agent_setup, "_load_probes", return_value={}), \
                patch.object(agent_setup, "detect", side_effect=detect), \
                patch.object(agent_setup, "detect_all", wraps=agent_setup.detect_all) as actual_discovery, \
                patch.object(ai_local, "status_sync", return_value={"ok": True, "status": "done"}), \
                patch.object(local_stream, "stop_sync", return_value={"ok": True}):
            await self.machine._queue_message({"op": "agent.setup", "id": "setup", "hasModel": True},
                                              self.machine.ws)
            await entered.wait()
            for op in ("job.status", "job.stop", "ping"):
                await self.machine._queue_message({"op": op, "id": op, "ref": "other-session"},
                                                  self.machine.ws)
                self.assertTrue((await self.reply(op))["ok"])
            self.assertFalse(expired.is_set(), "synchronous discovery blocked the event loop")
            self.assertFalse(any(packet.get("id") == "setup" for packet in self.machine.ws.messages))
            release.set()
            setup = await self.reply("setup")
            self.assertEqual({item["key"] for item in setup["data"]["agents"]}, set(agent_setup._SPECS))
            actual_discovery.assert_called_once_with(has_model=True)

    async def test_stop_during_dispatch_capability_probe_prevents_late_admission(self):
        self.admission_fixture()
        from app.services.dispatch_identity import execution_ref
        loop = asyncio.get_running_loop()
        entered, release, expired = asyncio.Event(), threading.Event(), threading.Event()
        self.releases.append(release)

        def capability_gate(*args):
            loop.call_soon_threadsafe(entered.set)
            if not release.wait(3):
                expired.set()
            return None

        dispatch_id = "chat:slow-capability-check"
        with patch.object(runner_main, "_capability_gate", side_effect=capability_gate), \
                patch.object(local_stream, "stop_sync", return_value={"ok": True}):
            await self.machine._queue_message({"op": "job.dispatch", "id": "dispatch", "dispatchId": dispatch_id,
                "task": {"id": "fixture-task"}, "cli": "opencode", "ctx": {}, "cfg": {}}, self.machine.ws)
            await entered.wait()
            await self.machine._queue_message({"op": "job.stop", "id": "stop", "ref": execution_ref(dispatch_id)},
                                              self.machine.ws)
            self.assertTrue((await self.reply("stop"))["ok"])
            self.assertFalse(expired.is_set(), "capability discovery blocked the event loop")
            self.assertEqual(self.machine._admission.active_items(), [])
            release.set()
            self.assertEqual((await self.reply("dispatch"))["code"], "RUNNER_REQUEST_CANCELLED")
            self.assertEqual(self.machine._admission.active_items(), [])

    async def test_agent_and_component_preparation_keeps_ping_responsive(self):
        from app.services import runtime_components
        cases = [
            ({"op": "agent.install", "key": "qwen", "action": "install"},
             agent_setup, "node_env", {"ok": False, "why": "fixture runtime unavailable"}),
            ({"op": "agent.configure", "key": "opencode", "llm": {"model": "hub-model"}},
             agent_setup, "configure", {"ok": True, "detail": "fixture configuration complete"}),
            ({"op": "component.list"}, runtime_components, "status", {"schemaVersion": 1, "items": []}),
            ({"op": "component.job", "jobId": "fixture-job"}, runner_main, "_capabilities", {}),
        ]
        loop = asyncio.get_running_loop()
        for index, (message, module, name, result) in enumerate(cases):
            with self.subTest(op=message["op"], blocking=name):
                entered, release, expired = asyncio.Event(), threading.Event(), threading.Event()
                self.releases.append(release)

                def blocked(*args, **kwargs):
                    loop.call_soon_threadsafe(entered.set)
                    if not release.wait(3):
                        expired.set()
                    return result

                self.machine.work_root, self.machine.capability_grants = "", None
                try:
                    with patch.object(agent_setup, "is_bundled", return_value=False), \
                            patch.object(agent_setup, "start_install") as install, \
                            patch.object(runtime_components, "job", return_value={"state": "done", "ok": True}), \
                            patch.object(module, name, side_effect=blocked):
                        identity, ping_id = "prepare-" + str(index), "ping-" + str(index)
                        await self.machine._queue_message({**message, "id": identity}, self.machine.ws)
                        await entered.wait()
                        await self.machine._queue_message({"op": "ping", "id": ping_id}, self.machine.ws)
                        self.assertTrue((await self.reply(ping_id))["ok"])
                        self.assertFalse(expired.is_set(), name + " blocked the event loop")
                        self.assertFalse(any(packet.get("id") == identity for packet in self.machine.ws.messages))
                        release.set()
                        prepared = await self.reply(identity)
                        if name == "node_env":
                            self.assertFalse(prepared["ok"])
                            self.assertEqual(prepared["error"], "fixture runtime unavailable")
                            install.assert_not_called()
                        else:
                            self.assertTrue(prepared["ok"])
                finally:
                    release.set()
                    await asyncio.gather(*list(self.machine._rpc_tasks))

    async def test_private_model_guards_run_before_remote_preparation_workers(self):
        self.admission_fixture()
        with patch.object(runner_main, "_capability_gate") as capability, \
                patch.object(agent_setup, "configure") as configure, \
                patch.object(agent_setup, "start_probe") as probe:
            messages = [
                {"op": "job.dispatch", "dispatchId": "chat:private-rejection", "cfg": {
                    "llm": {"localOnly": True, "model": "private-wire"}}},
                {"op": "agent.configure", "key": "opencode", "llm": {"localOnly": True}},
                {"op": "agent.probe", "key": "opencode", "llm": {"localOnly": True}},
            ]
            for index, message in enumerate(messages):
                identity = "private-" + str(index)
                await self.machine._queue_message({**message, "id": identity, "_localParent": True},
                                                  self.machine.ws)
                rejected = await self.reply(identity)
                self.assertFalse(rejected["ok"])
                self.assertEqual(rejected["code"], "LOCAL_MODEL_REMOTE_FORBIDDEN")
            capability.assert_not_called()
            configure.assert_not_called()
            probe.assert_not_called()
            self.assertEqual(self.machine._admission.active_items(), [])

    async def test_full_work_lane_rejects_without_blocking_stop_and_can_retry_once(self):
        entered, stopped = asyncio.Event(), asyncio.Event()
        release = asyncio.Event()
        self.releases.append(release)
        executed = []

        async def handle(message):
            executed.append(message["id"])
            if message["id"] == "slow":
                entered.set()
                await release.wait()
            elif message["op"] == "job.stop":
                stopped.set()

        self.machine._on = handle
        retry = {"op": "job.dispatch", "id": "retry", "dispatchId": "chat:same-business-id"}
        with patch.object(runner_main, "MAX_INFLIGHT_RPC", 1):
            await self.machine._queue_message({"op": "job.dispatch", "id": "slow"}, self.machine.ws)
            await asyncio.wait_for(entered.wait(), 1)
            await asyncio.wait_for(self.machine._queue_message(retry, self.machine.ws), .2)
            rejected = self.machine.ws.messages[-1]
            self.assertFalse(rejected["ok"])
            self.assertEqual(rejected["code"], "RUNNER_BACKPRESSURE")
            self.assertTrue(rejected["retryable"])
            self.assertFalse(rejected["uncertain"])
            self.assertNotIn("retry", executed)
            await self.machine._queue_message({"op": "job.stop", "id": "stop"}, self.machine.ws)
            await asyncio.wait_for(stopped.wait(), 1)
            self.assertFalse(release.is_set())
            release.set()
            await asyncio.gather(*list(self.machine._rpc_tasks))
            await self.machine._queue_message(retry, self.machine.ws)
            await asyncio.gather(*list(self.machine._rpc_tasks))
        self.assertEqual(executed.count("retry"), 1)

    async def test_query_and_control_lanes_are_bounded_and_do_not_share_the_work_limit(self):
        release = asyncio.Event()
        self.releases.append(release)
        entered = []

        async def handle(message):
            entered.append(message["id"])
            await release.wait()

        self.machine._on = handle
        with patch.object(runner_main, "MAX_INFLIGHT_RPC", 1), \
                patch.object(runner_main, "MAX_INFLIGHT_QUERY_RPC", 1, create=True), \
                patch.object(runner_main, "MAX_INFLIGHT_CONTROL_RPC", 1, create=True):
            for op, identity in (("job.dispatch", "work"), ("job.session", "query"),
                                 ("job.session", "query-overflow"), ("job.stop", "control"),
                                 ("job.stop", "control-overflow")):
                await asyncio.wait_for(self.machine._queue_message({"op": op, "id": identity},
                                                                   self.machine.ws), .2)
            await asyncio.sleep(0)
            self.assertEqual(set(entered), {"work", "query", "control"})
            self.assertEqual(len(self.machine._rpc_tasks), 3)
            self.assertEqual({reply["id"] for reply in self.machine.ws.messages},
                             {"query-overflow", "control-overflow"})
            self.assertTrue(all(reply["retryable"] and not reply["uncertain"]
                                for reply in self.machine.ws.messages))

    async def test_rejected_dispatch_can_retry_through_production_admission_without_duplication(self):
        machine = self.machine
        machine._admission = AdmissionQueue()
        machine._admission_wake = asyncio.Event()
        machine._ensure_admission_loop = lambda: None
        machine.work_root, machine.capability_grants = "", None
        release = asyncio.Event()
        self.releases.append(release)
        blocker = asyncio.create_task(release.wait())
        machine._rpc_tasks.add(blocker)
        blocker.add_done_callback(machine._rpc_tasks.discard)
        message = {"op": "job.dispatch", "id": "initial", "dispatchId": "chat:production-bounded-retry",
                   "task": {"id": "fixture-task"}, "cli": "opencode", "ctx": {}, "cfg": {}}
        with patch.object(runner_main, "MAX_INFLIGHT_RPC", 1), \
                patch.object(runner_main, "_capability_gate", return_value=None):
            await machine._queue_message(message, machine.ws)
            self.assertEqual(machine._admission.active_items(), [])
            self.assertEqual(machine.ws.messages[-1]["code"], "RUNNER_BACKPRESSURE")
            self.assertFalse(machine.ws.messages[-1]["uncertain"])
            release.set()
            await blocker
            await asyncio.sleep(0)
            for identity in ("retry", "duplicate"):
                await machine._queue_message({**message, "id": identity}, machine.ws)
                await asyncio.gather(*list(machine._rpc_tasks))
        self.assertEqual(len(machine._admission.active_items()), 1)
        replies = machine.ws.messages[-2:]
        self.assertTrue(all(reply["ok"] for reply in replies))
        self.assertFalse(replies[0]["data"]["duplicate"])
        self.assertTrue(replies[1]["data"]["duplicate"])
        self.assertEqual(replies[0]["data"]["admissionKey"], replies[1]["data"]["admissionKey"])

    async def test_saturated_default_executor_cannot_starve_a_remote_stop(self):
        loop = asyncio.get_running_loop()
        default_release = threading.Event()
        default_entered = threading.Event()
        self.releases.append(default_release)
        loop.set_default_executor(ThreadPoolExecutor(1))

        def occupy_default():
            default_entered.set()
            default_release.wait(5)

        default_job = loop.run_in_executor(None, occupy_default)
        while not default_entered.is_set():
            await asyncio.sleep(.001)
        stopped = asyncio.Event()

        async def handle(message):
            await runner_local_rpc.to_thread(lambda: None)
            stopped.set()

        self.machine._on = handle
        try:
            await self.machine._queue_message({"op": "job.stop", "id": "stop"}, self.machine.ws)
            await asyncio.wait_for(stopped.wait(), .2)
            self.assertFalse(default_release.is_set())
        finally:
            default_release.set()
            await default_job

    async def test_stop_fences_a_comment_waiting_for_production_selection_validation(self):
        machine = self.machine
        machine._admission = AdmissionQueue()
        machine._admission_wake = asyncio.Event()
        machine._ensure_admission_loop = lambda: None
        machine._reap_admission = lambda: None
        ref = "remote-comment-before-stop"
        selected = {"agentId": "opencode", "modelName": "hub-model", "reasoningEffort": ""}
        entered, release = asyncio.Event(), threading.Event()
        self.releases.append(release)
        loop = asyncio.get_running_loop()

        def validate(*args):
            loop.call_soon_threadsafe(entered.set)
            release.wait(5)
            return selected

        local_base._RUNS[ref] = {"cli": "opencode", "model": "hub-model"}
        self.addCleanup(local_base._RUNS.pop, ref, None)
        with patch.object(runner_turn_selection, "validate", side_effect=validate), \
                patch.object(local_stream, "stop_sync", return_value={"ok": True}):
            await machine._queue_message({"op": "job.comment", "id": "comment", "ref": ref,
                "turnId": "turn:before-stop", "text": "must not restart after stop",
                "executionSelection": selected}, machine.ws)
            await asyncio.wait_for(entered.wait(), 1)
            await machine._queue_message({"op": "job.stop", "id": "stop", "ref": ref}, machine.ws)
            for _ in range(100):
                if any(reply.get("id") == "stop" for reply in machine.ws.messages):
                    break
                await asyncio.sleep(.001)
            self.assertTrue(next(reply for reply in machine.ws.messages if reply["id"] == "stop")["ok"])
            self.assertFalse(release.is_set())
            release.set()
            await asyncio.gather(*list(machine._rpc_tasks))
        reply = next(reply for reply in machine.ws.messages if reply["id"] == "comment")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["code"], "RUNNER_REQUEST_CANCELLED")
        self.assertIsNone(machine._admission.get("comment:turn:before-stop"))

    async def test_cancelled_comment_validation_retains_its_worker_and_session_fifo(self):
        self.admission_fixture()
        self.machine._reap_admission = lambda: None
        ref = "cancelled-comment-validation-worker"
        selected = {"agentId": "opencode", "modelName": "hub-model", "reasoningEffort": ""}
        entered, second, release = asyncio.Event(), asyncio.Event(), threading.Event()
        self.releases.append(release)
        loop, order = asyncio.get_running_loop(), []

        def validate(*args):
            if not order:
                order.append("first-enter")
                loop.call_soon_threadsafe(entered.set)
                release.wait(3)
                order.append("first-exit")
            else:
                order.append("second-enter")
                loop.call_soon_threadsafe(second.set)
            return selected

        local_base._RUNS[ref] = {"cli": "opencode", "model": "hub-model"}
        self.addCleanup(local_base._RUNS.pop, ref, None)
        message = {"op": "job.comment", "ref": ref, "executionSelection": selected, "text": "follow up"}
        with patch.object(runner_turn_selection, "validate", side_effect=validate):
            try:
                await self.machine._queue_message({**message, "id": "first", "turnId": "turn:cancelled-first"},
                                                  self.machine.ws)
                await entered.wait()
                first_task = next(iter(self.machine._rpc_tasks))
                first_task.cancel()
                await self.machine._queue_message({**message, "id": "second", "turnId": "turn:after-cancel"},
                                                  self.machine.ws)
                await self.machine._queue_message({"op": "ping", "id": "responsive"}, self.machine.ws)
                self.assertTrue((await self.reply("responsive"))["ok"])
                self.assertFalse(first_task.done(), "cancellation must retain an active blocking worker")
                self.assertFalse(second.is_set(), "same-session validation overtook the active worker")
                release.set()
                self.assertTrue((await self.reply("second"))["ok"])
                self.assertEqual(order, ["first-enter", "first-exit", "second-enter"])
                self.assertIsNone(self.machine._admission.get("comment:turn:cancelled-first"))
                self.assertIsNotNone(self.machine._admission.get("comment:turn:after-cancel"))
            finally:
                release.set()
                await asyncio.gather(*list(self.machine._rpc_tasks), return_exceptions=True)

    async def test_cancelled_admitted_comment_staging_and_native_worker_keep_the_session_fence(self):
        from app.services import runtime_images
        loop = asyncio.get_running_loop()
        for stage in ("staging", "comment"):
            with self.subTest(stage=stage):
                self.admission_fixture()
                ref = "cancelled-admitted-comment-" + stage
                entered, later, release = asyncio.Event(), asyncio.Event(), threading.Event()
                self.releases.append(release)
                order = []

                def pause():
                    order.append("first-enter")
                    loop.call_soon_threadsafe(entered.set)
                    release.wait(3)
                    order.append("first-exit")

                def stage_inputs(*args):
                    pause()
                    return [{"name": "fixture.txt", "path": "/fixture/fixture.txt"}]

                def native_comment(cfg, target, text):
                    if text == "first":
                        pause()
                    else:
                        order.append("second-enter")
                        loop.call_soon_threadsafe(later.set)
                    return {"ok": True}

                message = {"op": "job.comment", "ref": ref}
                first_message = {**message, "text": "first"}
                if stage == "staging":
                    first_message["files"] = {"items": [{"name": "fixture.txt"}]}
                items = {}
                for identity, payload in (("first", first_message), ("second", {**message, "text": "second"})):
                    items[identity] = self.machine._admission.submit(identity, ref,
                        runner_main.runner_admission.INTERACTIVE, "comment", payload)[2]

                async def deliver(message):
                    # Only the trusted durable-delivery path creates _admitted.
                    # Neither authenticated transport may accept it from JSON.
                    await self.machine._run_admitted(items[message["turnId"]])
                    return {"ok": True}

                workers = self.machine._network_rpc_workers()
                local_replies = []
                server = runner_local_rpc.Server(deliver,
                    lambda blob: local_replies.append(json.loads(blob[len(runner_main.LOCAL_RPC_PREFIX):])),
                    runner_main.LOCAL_RPC_PREFIX, pending=workers.pending, tails=workers.tails)
                try:
                    with patch.object(runner_main, "_read_packet", return_value=[({"filename": "fixture.txt"}, b"fixture")]), \
                            patch.object(ai_local, "_stage_inputs", side_effect=stage_inputs), \
                            patch.object(runtime_images, "prepare", side_effect=lambda cfg, *args: cfg), \
                            patch.object(local_stream, "comment_sync", side_effect=native_comment):
                        await server.submit("first", {**message, "turnId": "first"})
                        await entered.wait()
                        first_task = next(iter(server.tasks))
                        first_task.cancel()
                        await server.submit("second", {**message, "turnId": "second"})
                        await self.machine._queue_message({"op": "ping", "id": "ping-" + stage}, self.machine.ws)
                        self.assertTrue((await self.reply("ping-" + stage))["ok"])
                        self.assertFalse(first_task.done(), "native work outlived its mutation reservation")
                        self.assertFalse(later.is_set(), "next native comment overtook unfinished work")
                        release.set()
                        for _ in range(500):
                            if any(packet.get("id") == "second" for packet in local_replies):
                                break
                            await asyncio.sleep(.001)
                        second_reply = next(packet for packet in local_replies if packet["id"] == "second")
                        self.assertTrue(second_reply["result"]["ok"])
                        self.assertEqual(items["second"].state, "running")
                        self.assertEqual(order, ["first-enter", "first-exit", "second-enter"])
                finally:
                    release.set()
                    await server.close()

    async def test_same_ref_mutations_wait_for_both_prior_work_and_stop(self):
        entered, release, stopped, stop_release = (asyncio.Event() for _ in range(4))
        self.releases.extend([release, stop_release])
        executed = []

        async def handle(message):
            executed.append(message["id"])
            if message["id"] == "first":
                entered.set()
                await release.wait()
            elif message["op"] == "job.stop":
                stopped.set()
                await stop_release.wait()

        self.machine._on = handle
        for identity in ("first", "before-stop"):
            await self.machine._queue_message({"op": "job.comment", "id": identity, "ref": "same"},
                                              self.machine.ws)
        await asyncio.wait_for(entered.wait(), 1)
        await self.machine._queue_message({"op": "job.stop", "id": "stop", "ref": "same"},
                                          self.machine.ws)
        await asyncio.wait_for(stopped.wait(), 1)
        await self.machine._queue_message({"op": "job.comment", "id": "after-stop", "ref": "same"},
                                          self.machine.ws)
        await asyncio.sleep(0)
        self.assertEqual(executed, ["first", "stop"])
        release.set()
        await asyncio.sleep(0)
        self.assertNotIn("after-stop", executed)
        stop_release.set()
        await asyncio.gather(*list(self.machine._rpc_tasks))
        self.assertEqual(executed, ["first", "stop", "after-stop"])
        cancelled = next(reply for reply in self.machine.ws.messages if reply["id"] == "before-stop")
        self.assertEqual(cancelled["code"], "RUNNER_REQUEST_CANCELLED")

    async def cross_path_stop(self, *, local_comment):
        machine = self.machine
        machine._admission = AdmissionQueue()
        machine._admission_wake = asyncio.Event()
        machine._ensure_admission_loop = lambda: None
        machine._reap_admission = lambda: None
        workers = machine._network_rpc_workers()
        local_replies = []
        server = runner_local_rpc.Server(machine._local_rpc_dispatch,
            lambda blob: local_replies.append(json.loads(blob[len(runner_main.LOCAL_RPC_PREFIX):])),
            runner_main.LOCAL_RPC_PREFIX, pending=workers.pending, tails=workers.tails)
        ref = "cross-path-stop-" + str(local_comment)
        selected = {"agentId": "opencode", "modelName": "hub-model", "reasoningEffort": ""}
        entered, release = asyncio.Event(), threading.Event()
        self.releases.append(release)
        loop = asyncio.get_running_loop()

        def validate(*args):
            loop.call_soon_threadsafe(entered.set)
            release.wait(5)
            return selected

        async def submit(identity, message, local):
            if local:
                await server.submit(identity, message)
            else:
                await machine._queue_message({**message, "id": identity}, machine.ws)

        async def reply(identity, local):
            for _ in range(200):
                messages = local_replies if local else machine.ws.messages
                for item in messages:
                    if item.get("id") == identity:
                        return item["result"] if local else item
                await asyncio.sleep(.001)
            self.fail("missing cross-path reply: " + identity)

        local_base._RUNS[ref] = {"cli": "opencode", "model": "hub-model"}
        self.addCleanup(local_base._RUNS.pop, ref, None)
        try:
            with patch.object(runner_turn_selection, "validate", side_effect=validate), \
                    patch.object(local_stream, "stop_sync", return_value={"ok": True}):
                await submit("comment", {"op": "job.comment", "ref": ref,
                    "turnId": "turn:cross-path", "text": "must remain stopped",
                    "executionSelection": selected}, local_comment)
                await asyncio.wait_for(entered.wait(), 1)
                await submit("stop", {"op": "job.stop", "ref": ref}, not local_comment)
                self.assertTrue((await reply("stop", not local_comment))["ok"])
                self.assertFalse(release.is_set())
                release.set()
                cancelled = await reply("comment", local_comment)
                self.assertFalse(cancelled["ok"])
                self.assertEqual(cancelled["code"], "RUNNER_REQUEST_CANCELLED")
                self.assertIsNone(machine._admission.get("comment:turn:cross-path"))
        finally:
            release.set()
            await server.close()

    async def test_local_stop_cancels_unadmitted_remote_comment(self):
        await self.cross_path_stop(local_comment=False)

    async def test_remote_stop_cancels_unadmitted_local_comment(self):
        await self.cross_path_stop(local_comment=True)

    async def test_cancelled_unstarted_reservation_keeps_the_prior_mutation_fence(self):
        entered, release, later = asyncio.Event(), asyncio.Event(), asyncio.Event()
        self.releases.append(release)
        executed = []

        async def handle(message):
            executed.append(message["id"])
            if message["id"] == "first":
                entered.set()
                await release.wait()
            else:
                later.set()

        machine = self.machine
        machine._on = handle
        await machine._queue_message({"op": "job.comment", "id": "first", "ref": "serial"}, machine.ws)
        await entered.wait()
        previous_tasks = set(machine._rpc_tasks)
        await machine._queue_message({"op": "job.comment", "id": "cancel", "ref": "serial"}, machine.ws)
        cancelled = next(iter(machine._rpc_tasks - previous_tasks))
        cancelled.cancel()
        await asyncio.gather(cancelled, return_exceptions=True)
        await machine._queue_message({"op": "job.comment", "id": "later", "ref": "serial"}, machine.ws)
        await asyncio.sleep(0)
        self.assertFalse(later.is_set())
        self.assertEqual(executed, ["first"])
        release.set()
        await asyncio.wait_for(later.wait(), 1)
        await asyncio.gather(*list(machine._rpc_tasks))
        self.assertEqual(executed, ["first", "later"])
        self.assertEqual(machine._pending_rpc_requests, {})
        self.assertEqual(machine._pending_rpc_tails, {})

    async def test_repeated_slow_polls_of_one_ref_leave_other_refs_available(self):
        release = asyncio.Event()
        self.releases.append(release)
        entered, other, stopped = [], asyncio.Event(), asyncio.Event()

        async def handle(message):
            entered.append(message["id"])
            if message["op"] == "job.stop":
                stopped.set()
            elif message["ref"] == "slow-ref":
                await release.wait()
            else:
                other.set()

        self.machine._on = handle
        for index in range(3):
            await self.machine._queue_message({"op": "job.session", "id": str(index), "ref": "slow-ref"},
                                              self.machine.ws)
        await self.machine._queue_message({"op": "job.session", "id": "other", "ref": "other-ref"},
                                          self.machine.ws)
        await self.machine._queue_message({"op": "job.stop", "id": "stop", "ref": "slow-ref"},
                                          self.machine.ws)
        await asyncio.wait_for(other.wait(), 1)
        await asyncio.wait_for(stopped.wait(), 1)
        self.assertEqual(set(entered), {"0", "other", "stop"})
        self.assertEqual({reply["id"] for reply in self.machine.ws.messages}, {"1", "2"})

    async def test_backpressure_replies_stay_on_the_original_connection_without_echoing_payload(self):
        release, entered = asyncio.Event(), asyncio.Event()
        self.releases.append(release)

        async def handle(message):
            entered.set()
            await release.wait()

        self.machine._on = handle
        old, current = Socket(), Socket()
        with patch.object(runner_main, "MAX_INFLIGHT_RPC", 1):
            await self.machine._queue_message({"op": "job.dispatch", "id": "slow"}, old)
            await asyncio.wait_for(entered.wait(), 1)
            self.machine.ws = current
            await asyncio.wait_for(self.machine._queue_message({"op": "job.comment", "id": "rejected",
                "cfg": {"llm": {"key": "PRIVATE-FIXTURE"}}}, old), .2)
        self.assertEqual(current.messages, [])
        self.assertEqual(old.messages[0]["id"], "rejected")
        self.assertNotIn("PRIVATE-FIXTURE", str(old.messages))

    async def test_blocked_refusal_writer_is_bounded_and_does_not_delay_stop_dispatch(self):
        release, work_release = asyncio.Event(), asyncio.Event()
        self.releases.extend([release, work_release])
        stopped = asyncio.Event()

        async def send(payload):
            await release.wait()

        async def handle(message):
            if message["op"] == "job.stop":
                stopped.set()
            else:
                await work_release.wait()

        self.machine.ws.send = send
        self.machine._on = handle
        with patch.object(runner_main, "MAX_INFLIGHT_RPC", 1), \
                patch.object(runner_main, "MAX_PENDING_RPC_REPLIES", 2):
            await self.machine._queue_message({"op": "job.comment", "id": "slow", "ref": "slow"},
                                              self.machine.ws)
            for index in range(2):
                await asyncio.wait_for(self.machine._queue_message({"op": "job.comment", "id": str(index)},
                                                                   self.machine.ws), .2)
            await self.machine._queue_message({"op": "job.stop", "id": "stop", "ref": "other"},
                                              self.machine.ws)
            await asyncio.wait_for(stopped.wait(), .2)
            for index in range(10):
                await asyncio.wait_for(self.machine._queue_message({"op": "job.comment", "id": str(index + 2)},
                                                                   self.machine.ws), .2)
            self.assertLessEqual(len(self.machine._rpc_rejections), 3)
            self.assertEqual(len(self.machine.ws.closed), 1)
            self.assertEqual(self.machine.ws.closed[0]["code"], 1013)
            self.assertFalse(release.is_set())

    async def test_failed_old_refusal_writer_retires_only_its_original_connection(self):
        release, entered = asyncio.Event(), asyncio.Event()
        self.releases.append(release)
        old, current = Socket(), Socket()

        async def send(payload):
            entered.set()
            await release.wait()
            raise ConnectionError("synthetic old socket failure")

        old.send = send
        self.machine._on = lambda message: release.wait()
        with patch.object(runner_main, "MAX_INFLIGHT_RPC", 0):
            await self.machine._queue_message({"op": "job.comment", "id": "refused"}, old)
            await entered.wait()
            self.machine.ws = current
            release.set()
            await asyncio.gather(*list(self.machine._rpc_rejections))
        self.assertEqual(current.messages, [])
        self.assertEqual(current.closed, [])
        self.assertEqual(len(old.closed), 1)

    async def test_old_reply_failure_cannot_unretire_a_newer_connection(self):
        old_release, work_release, entered = asyncio.Event(), asyncio.Event(), asyncio.Event()
        self.releases.extend([old_release, work_release])
        old, current = Socket(), Socket()
        executed = []

        async def send(payload):
            await old_release.wait()
            raise ConnectionError("synthetic delayed old writer failure")

        async def handle(message):
            executed.append(message["id"])
            if message["id"] == "work":
                entered.set()
                await work_release.wait()

        old.send = send
        self.machine._on = handle
        with patch.object(runner_main, "MAX_INFLIGHT_RPC", 1), \
                patch.object(runner_main, "MAX_PENDING_RPC_REPLIES", 1):
            await self.machine._queue_message({"op": "job.comment", "id": "work"}, old)
            await entered.wait()
            await self.machine._queue_message({"op": "job.comment", "id": "old-refused"}, old)
            self.machine.ws = current
            await self.machine._queue_message({"op": "job.comment", "id": "current-refused"}, current)
            self.assertEqual(len(current.closed), 1)
            old_release.set()
            await asyncio.gather(*list(self.machine._rpc_rejections))
            work_release.set()
            await asyncio.gather(*list(self.machine._rpc_tasks))
            await self.machine._queue_message({"op": "job.comment", "id": "current-late"}, current)
            await asyncio.gather(*list(self.machine._rpc_tasks))
        self.assertEqual(executed, ["work"])
        self.assertEqual(len(old.closed), 1)
        self.assertEqual(len(current.closed), 1)


if __name__ == "__main__":
    unittest.main()
