"""Session deadlines cancel transport work without returning partial history."""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""

import asyncio
import base64
import concurrent.futures
import contextvars
import hashlib
import json
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import Depends, FastAPI
from app.services import ai_exec, ai_local, ai_remote, cluster_runtime, conversation_content
from app.services import access_policy
from app.services import endpoint_events, runner_hub, session_read_budget as budget
from app.services.cluster_bus import ClusterBus


PATH = "/api/v1/tasks/task/ai-session"


def read_app(read):
    app = FastAPI()
    app.add_middleware(budget.SessionReadBudgetMiddleware)
    app.get(PATH)(read)
    app.get("/api/v1/cloud-execution-sync/conversation")(read)
    app.post(PATH)(read)
    app.get("/api/v1/tasks/task/events")(read)
    return app


def client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


class RoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_authoritative_owner_never_probes_unrelated_runners(self):
        runner = SimpleNamespace(id="owner", host="fixture", call=AsyncMock(return_value={
            "ok": True, "data": {"items": [{"seq": 8, "text": "saved"}], "last": 8}}))
        with patch.object(runner_hub, "get", return_value=runner) as get, \
                patch.object(runner_hub, "online", side_effect=AssertionError("unrelated runners")), \
                patch.object(ai_remote, "runner_of_ref_async", side_effect=AssertionError("discovery")), \
                patch.object(ai_exec, "_by_ref", side_effect=AssertionError("sync discovery")):
            result = await ai_exec.read_session({}, "ref", 7, runner_id="owner", limit=25)
        get.assert_called_once_with("owner")
        runner.call.assert_awaited_once_with("job.session", {"ref": "ref", "since": 7, "limit": 25}, timeout=30)
        self.assertEqual(result["last"], 8)
        with patch.object(runner_hub, "get", return_value=None), \
                patch.object(ai_remote, "runner_of_ref_async", side_effect=AssertionError("discovery")):
            self.assertFalse((await ai_exec.read_session({}, "ref", runner_id="offline"))["ok"])

    async def test_legacy_discovery_and_local_history_remain_available(self):
        runner = SimpleNamespace(id="legacy", host="fixture", call=AsyncMock(return_value={"ok": True, "data": {"items": []}}))
        with patch.object(ai_remote, "runner_of_ref_async", AsyncMock(return_value=runner)) as discover:
            self.assertTrue((await ai_exec.read_session({}, "ref"))["ok"])
            discover.assert_awaited_once_with("ref")
        with patch.object(ai_local, "session_sync", return_value={"ok": True, "items": ["past"]}) as local:
            self.assertEqual((await ai_exec.read_session({}, "old", runner_id="backend-local"))["items"], ["past"])
            local.assert_called_once()

    async def test_legacy_rolling_upgrade_only_reads_other_runners_that_own_the_ref(self):
        old = SimpleNamespace(id="old", host="fixture", call=AsyncMock(return_value={"ok": False}))
        unrelated = SimpleNamespace(id="other", call=AsyncMock(return_value={"ok": True, "data": {"has": False}}))
        new = SimpleNamespace(id="new", host="fixture", call=AsyncMock(side_effect=[
            {"ok": True, "data": {"has": True}}, {"ok": True, "data": {"items": ["past"]}}]))
        with patch.object(ai_remote, "runner_of_ref_async", AsyncMock(return_value=old)), \
                patch.object(runner_hub, "online", return_value=[old, unrelated, new]):
            result = await ai_exec.read_session({}, "legacy")
        unrelated.call.assert_awaited_once_with("job.has", {"ref": "legacy"}, timeout=15)
        self.assertEqual(result['runnerId'], 'new')
        self.assertEqual(result['items'], ['past'])


class DeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def test_production_middleware_returns_timeout_during_authentication(self):
        from app.main import app
        from app.api.tasks import current_client
        cancelled = asyncio.Event()
        async def authorize():
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        with patch.dict(app.dependency_overrides, {current_client: authorize}):
            async with client(app) as http, patch_budget(0.03):
                response = await http.get(PATH)
        self.assertEqual(response.status_code, 504, response.text)
        self.assertTrue(response.json()['detail']['retryable'])
        self.assertTrue(cancelled.is_set())

    async def test_deadline_includes_auth_dependencies_and_only_session_gets(self):
        cancelled = []
        async def authorize():
            try:
                await asyncio.sleep(0.08)
            except asyncio.CancelledError:
                cancelled.append(True)
                raise
        async def read(_auth=Depends(authorize)):
            return {"last": 7, "items": []}
        async with client(read_app(read)) as http, patch_budget(0.02):
            for path in (PATH, "/api/v1/cloud-execution-sync/conversation"):
                result = await http.get(path)
                self.assertEqual(result.status_code, 504)
                self.assertEqual(result.json()["detail"]["code"], "SESSION_READ_TIMEOUT")
                self.assertNotIn("last", result.json())
            self.assertEqual((await http.post(PATH)).status_code, 200)
            self.assertEqual((await http.get("/api/v1/tasks/task/events")).status_code, 200)
        self.assertEqual(cancelled, [True, True])
        self.assertEqual(budget.remaining(35), 35)

    async def test_local_socket_send_and_reply_waiters_are_cancelled(self):
        for stall_send in (True, False):
            with self.subTest(stall_send=stall_send):
                sending = asyncio.Event()
                send_cancelled = []
                async def send(_packet):
                    sending.set()
                    if stall_send:
                        try:
                            await asyncio.Event().wait()
                        finally:
                            send_cancelled.append(True)
                node = runner_hub._Runner(SimpleNamespace(send_json=send), {"runnerId": "owner"})
                node.ready = True
                async def read():
                    return await node.call("job.session", {"ref": "ref"}, timeout=30)
                with patch.object(cluster_runtime, "check_owner", AsyncMock()):
                    async with client(read_app(read)) as http, patch_budget(0.03):
                        result = await http.get(PATH)
                self.assertTrue(sending.is_set())
                self.assertEqual(result.status_code, 504)
                self.assertFalse(node._waiters)
                self.assertFalse(node._send_lock.locked())
                self.assertEqual(bool(send_cancelled), stall_send)

    async def test_hydration_shares_deadline_across_chunks_and_cancels_remote_owner(self):
        # The receiver runs in a separate context, as on another Hub. Only the
        # existing packet deadline can cancel its underlying Runner waiter.
        caller, receiver = ClusterBus(), ClusterBus()
        caller.enabled = receiver.enabled = False
        caller.peers = {receiver.node: {}}
        deadlines, operations = [], []
        async def to_owner(_node, packet, **_kwargs):
            deadlines.append(packet["deadline"] - time.time())
            packet = {**packet, "source": caller.node}
            await asyncio.create_task(receiver._consume(packet), context=contextvars.Context())
        async def reply(_node, packet, **_kwargs):
            await caller._consume({**packet, "deadline": time.time() + 1})
        caller.send, receiver.send = to_owner, reply
        body = json.dumps([{"seq": 8, "text": "saved complete text", "detail": {}}]).encode()
        pointer = {"schema": 1, "runnerId": "owner", "scope": conversation_content.scope("user", "events"),
            "sha256": hashlib.sha256(body).hexdigest(), "size": len(body),
            "ownerUserId": "user", "record": "events", "index": 0}
        blocked = True
        async def send(packet):
            operations.append(packet["offset"])
            if blocked and packet["offset"] > 0:
                return  # Keep the real Runner reply waiter pending.
            offset = packet["offset"]
            node._waiters[packet["id"]].set_result({"ok": True, "data": {
                **pointer, "offset": offset, "b64": base64.b64encode(body[offset:offset + 32]).decode()}})
        node = runner_hub._Runner(SimpleNamespace(send_json=send), {"runnerId": "owner"})
        node.ready = True
        async def request(_method, data, _source):
            return await node.call(data["op"], data["data"], data["timeout"])
        receiver.on_request = request
        remote = cluster_runtime.RemoteRunner(receiver.node, {"runnerId": "owner", "clusterToken": "test",
            "lastSeen": time.time(), "caps": ["conversationContent1"]})
        row = SimpleNamespace(seq=8, kind="say", tool="", text="", at=None, detail={"contentRef": pointer})
        async def read():
            rows = await endpoint_events.hydrate([row])
            return {"last": rows[-1].seq, "items": [{"seq": r.seq, "text": r.text} for r in rows]}
        with patch.object(cluster_runtime, "bus", caller), \
                patch.object(cluster_runtime, "check_owner", AsyncMock()), \
                patch.object(runner_hub, "get", return_value=remote), \
                patch.object(conversation_content, "CHUNK", 32):
            async with client(read_app(read)) as http, patch_budget(0.08):
                result = await http.get(PATH + "?since=7")
                self.assertEqual(result.status_code, 504)
                self.assertNotIn("last", result.json())
                await asyncio.wait_for(asyncio.gather(*receiver._handlers), 0.2)
                self.assertFalse(node._waiters)
                self.assertFalse(caller._pending)
                self.assertEqual(operations, [0, 32])
                self.assertTrue(all(0 < seconds <= 0.08 for seconds in deadlines))
                # A later retry rehydrates the same immutable pointer fully.
                blocked = False
                retried = await http.get(PATH + "?since=7")
                self.assertEqual(retried.status_code, 200, retried.text)
                self.assertEqual(retried.json(), {"last": 8, "items": [{"seq": 8, "text": "saved complete text"}]})
        self.assertEqual(row.text, "")
        self.assertNotIn("contentUnavailable", row.detail)

    async def test_owner_reroute_uses_remaining_budget_not_a_new_timeout(self):
        old = cluster_runtime.RemoteRunner("old", {"runnerId": "owner", "clusterToken": "old"})
        new = cluster_runtime.RemoteRunner("new", {"runnerId": "owner", "clusterToken": "new"})
        timeouts = []
        async def request(_node, _method, _data, timeout):
            timeouts.append(timeout)
            if len(timeouts) == 1:
                await asyncio.sleep(0.025)
                return {"ok": False, "code": "RUNNER_OWNER_CHANGED"}
            await asyncio.Event().wait()
        bus = SimpleNamespace(request=request, refresh=AsyncMock())
        async def read():
            return await old.call("job.session", {"ref": "ref"}, timeout=30)
        with patch.object(cluster_runtime, "bus", bus), patch.object(runner_hub, "get", return_value=new):
            async with client(read_app(read)) as http, patch_budget(0.08):
                self.assertEqual((await http.get(PATH)).status_code, 504)
        self.assertEqual(len(timeouts), 2)
        self.assertLess(timeouts[1], timeouts[0] - 0.02)


class LocalSnapshotTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="soduwork-session-snapshot-")
        self.addCleanup(folder.cleanup)
        self.ref = "coherent-read-fixture"
        self.run = {"state": "running", "cli": "codex-harness", "ws": folder.name,
                    "lines": [], "error": "", "started": 100, "ended": 0,
                    "model": "initial-model", "reasoningEffort": "low", "tokens": {},
                    "usage": {"output": 7}}
        self.patch = patch.dict(ai_local._RUNS, {self.ref: self.run})
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def read_during_change(self, reader, io_name, change):
        reading, release = threading.Event(), threading.Event()

        def archive(*_args):
            reading.set()
            if not release.wait(5):
                raise AssertionError("The archive read was not released")
            return []

        with patch.object(ai_local, io_name, side_effect=archive), \
                concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(reader)
            try:
                self.assertTrue(reading.wait(5), "The public read must reach the archive boundary")
                with ai_local._LOCK:
                    change(self.run)
            finally:
                release.set()
            return future.result(timeout=5)

    def test_session_read_keeps_running_state_and_diagnostics_when_execution_settles_during_io(self):
        reply = self.read_during_change(lambda: ai_local.session_sync({}, self.ref), "_read_events",
            lambda run: run.update(state="failed", error="Fixture home could not be created", ended=101))
        self.assertEqual(reply["status"], "running")
        self.assertEqual(reply["error"], "")
        self.assertTrue(reply["canStop"])
        self.assertEqual(reply["ended"], 0)
        with patch.object(ai_local, "_read_events", return_value=[]):
            settled = ai_local.session_sync({}, self.ref)
        self.assertEqual(settled["status"], "failed")
        self.assertEqual(settled["error"], "Fixture home could not be created")
        self.assertFalse(settled["canStop"])

    def test_session_read_binds_policy_model_usage_and_timing_to_the_same_turn(self):
        policy = access_policy.normalize({"schema": access_policy.SCHEMA, "mode": "standard",
            "revision": 1, "workspaceRoot": self.run["ws"]})
        self.run.update(accessPolicy=policy, permissionWaiting=True)

        def advance(run):
            run.update(permissionWaiting=False, accessPolicy={**policy, "revision": 2},
                       model="next-model", reasoningEffort="high", round=2, started=200)
            run["usage"]["output"] = 8

        reply = self.read_during_change(lambda: ai_local.session_sync({}, self.ref), "_read_events", advance)
        self.assertEqual(reply["status"], "waiting-permission")
        self.assertEqual(reply["accessPolicy"]["revision"], 1)
        self.assertEqual(reply["round"], 1)
        self.assertEqual(reply["model"], "initial-model")
        self.assertEqual(reply["activeExecutionSelection"]["reasoningEffort"], "low")
        self.assertEqual(reply["usage"], {"output": 7})
        self.assertEqual(reply["firstStarted"], 100)
        self.assertEqual(reply["started"], 100)

    def test_status_read_keeps_failure_state_and_error_when_delivery_io_overlaps_completion(self):
        self.run.update(state="failed", error="Initial fixture failure", failureKind="fixture")
        reply = self.read_during_change(lambda: ai_local.status_sync({}, self.ref, read_only=True),
            "_fresh_entries", lambda run: run.update(state="done", error="", failureKind=""))
        self.assertEqual(reply["status"], "failed")
        self.assertEqual(reply["error"], "Initial fixture failure")
        self.assertEqual(reply["failureKind"], "fixture")
        self.assertFalse(reply["running"])
        self.assertTrue(reply["done"])


class patch_budget:
    """Async context spelling keeps each HTTP client and its short test budget together."""
    def __init__(self, seconds):
        self.patch = patch.object(budget, "READ_SECONDS", seconds)

    async def __aenter__(self):
        self.patch.start()

    async def __aexit__(self, *_exc):
        self.patch.stop()


if __name__ == "__main__":
    unittest.main()
