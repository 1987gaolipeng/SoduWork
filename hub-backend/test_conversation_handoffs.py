"""Authenticated ASGI + migrated SQLite + separate Runner and model processes.

Only the Runner websocket transport and vendor CLI boundary are fixtures. Task
dispatch, admission, input chunks, restore, execution and archives are real.
"""
import asyncio
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from unittest.mock import AsyncMock
import zipfile

WORK = Path(tempfile.mkdtemp(prefix="soduwork-handoff-test-"))
os.environ.update(DATABASE_URL="sqlite+aiosqlite:///" + (WORK / "test.db").as_posix(),
    AUTH_SECRET="handoff-isolated-test-secret-not-a-real-credential", REDIS_URL="",
    MINIO_ENDPOINT="", DEVICE_AUTH_COMPAT="false", DB_MIGRATION_MODE="auto",
    CLOUD_EXECUTION_RUNNER_IDS="", HUB_LOCAL_EXECUTION_ENABLED="true",
    SODUWORK_DATA_ROOT=str(WORK / "hub-data"))

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from app import db, models
from app.agent_catalog import AGENTS
from app.api import conversation_handoffs as api, tasks
from app.conversation_handoff_models import ConversationHandoff
from app.services import (ai_remote, device_auth, execution_capabilities, runner_hub,
                          storage, conversation_handoffs as svc)


def archive(text="portable input", history="Keep the report title unchanged.", agent="codex", model="old-model"):
    content = text.encode()
    source = {"sessionId": "local-history-1", "adapterId": agent, "modelName": model,
              "title": "Continue my document", "goal": "",
              "messages": [{"role": "user", "text": history, "at": 1},
                           {"role": "assistant", "text": "The input is ready in input.txt", "at": 2}]}
    manifest = {"schema": "soduwork.workspace-handoff/v1", "source": source,
                "files": [{"path": "input.txt", "size": len(content),
                           "sha256": hashlib.sha256(content).hexdigest()}], "excluded": []}
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr(zipfile.ZipInfo("manifest.json"), json.dumps(manifest))
        package.writestr(zipfile.ZipInfo("workspace/input.txt"), content)
    data = out.getvalue()
    return data, hashlib.sha256(data).hexdigest()


class Peer:
    def __init__(self, work):
        self.work, self.lock, self.calls = work, threading.Lock(), []
        self.start()

    def start(self):
        self.log = (self.work / "runner.log").open("a", encoding="utf-8")
        self.process = subprocess.Popen([sys.executable, str(Path(__file__).parent / "tests/handoff_runner_fixture.py"),
            str(self.work)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
            text=True, encoding="utf-8", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        assert json.loads(self.process.stdout.readline())["ready"]

    def call(self, runner, op, data, timeout=60):
        with self.lock:
            self.calls.append(op)
            self.process.stdin.write(json.dumps({"op": op, **data}, ensure_ascii=False) + "\n")
            self.process.stdin.flush()
            result = self.process.stdout.readline()
            if not result:
                raise AssertionError("Runner stopped: " + (self.work / "runner.log").read_text(encoding="utf-8"))
            return json.loads(result)

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.write('{"op":"fixture.close"}\n')
            self.process.stdin.flush()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()
        self.log.close()

    def crash(self):
        self.process.kill()
        self.process.wait(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()
        self.log.close()


class HandoffTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await db.init_db()
        storage._LOCAL_DIR = str(WORK / "uploads")
        async with db.SessionLocal() as session:
            self.owner = models.User(id="owner", username="owner", org_id="org", is_active=True)
            self.other = models.User(id="other", username="other", org_id="other-org", is_active=True)
            self.client = models.Client(id="u-handoff", user_ref="owner", auth_state="active")
            other_client = models.Client(id="u-other", user_ref="other", auth_state="active")
            session.add_all([models.OrgUnit(id="org", name="Team"), models.OrgUnit(id="other-org", name="Other"),
                             self.owner, self.other, self.client, other_client])
            await session.commit()
        self.token = device_auth.issue_session(self.client)[0]
        self.other_token = device_auth.issue_session(other_client)[0]
        self.app = FastAPI()
        self.app.include_router(api.router)
        self.app.include_router(tasks.router)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://isolated",
                                     headers={"Authorization": "Device " + self.token})
        self.peer = Peer(WORK)
        caps = execution_capabilities.runtime_report(str(WORK), grants=[])
        self.runner = runner_hub._Runner(None, {"runnerId": "cloud", "host": "fixture-cloud", "version": "999.0.0",
            "workRoot": str(WORK / "workspace"), "agents": [{"key": "codex", "name": "Codex", "auth": "authed"}],
            "skills": [], "caps": ["handoff1"], "capabilities": caps, "maxConcurrent": 4, "taskQueueCapacity": 100})
        self.runner.org_id, self.runner.ready, self.runner.dispatch_mode = "org", True, "accepting"
        from app.automation_models import RunnerNode
        self.runner.owner_user_id = self.owner.id
        async with db.SessionLocal() as session:
            session.add(RunnerNode(id="cloud", org_id="org", owner_user_id=self.owner.id))
            await session.commit()
        self.runner.alive = lambda: True
        async def call(op, data, timeout=60):
            return await asyncio.to_thread(self.peer.call, self.runner, op, data, timeout)
        self.runner.call = call
        runner_hub._RUNNERS["cloud"] = self.runner
        self.rpc = patch.object(runner_hub, "call_sync", self.peer.call)
        self.rpc.start()

    async def asyncTearDown(self):
        self.rpc.stop()
        await asyncio.to_thread(self.peer.close)
        await self.http.aclose()
        runner_hub._RUNNERS.clear()
        await db.engine.dispose()

    async def prepare(self, transfer, snapshot=None, **overrides):
        data, digest = snapshot or archive()
        options = {"sha256": digest, "assigneeId": "runner:cloud:codex", "model": "",
                   "instruction": "WAIT_FOR_DISCONNECT: continue the report", **overrides}
        return await self.http.post("/api/v1/conversation-handoffs/" + transfer,
            files={"file": ("snapshot.zip", data, "application/zip")}, data={"options": json.dumps(options)})

    async def complete(self, ref):
        for _ in range(160):
            reply = await asyncio.to_thread(self.peer.call, self.runner, "job.session", {"ref": ref})
            data = reply.get("data", {})
            if data.get("status") == "failed":
                self.fail(str(data))
            if data.get("status") == "done":
                return data
            await asyncio.sleep(.1)
        self.fail("Execution did not finish: " + str(reply))

    async def test_security_two_phase_real_execution_and_restart(self):
        targets = await self.http.get("/api/v1/conversation-handoffs/targets")
        self.assertEqual(targets.status_code, 200, targets.text)
        self.assertEqual([x["id"] for x in targets.json()["targets"]], ["runner:cloud:codex"])
        with self.subTest("same device and unauthorized devices never qualify"):
            self.runner.client_id = self.client.id
            self.assertEqual((await self.http.get("/api/v1/conversation-handoffs/targets")).json()["targets"], [])
            self.runner.client_id = "u-other"
            self.assertEqual((await self.http.get("/api/v1/conversation-handoffs/targets")).json()["targets"], [])
            self.runner.client_id = ""
        with self.subTest("admins see shared infrastructure but never colleagues' devices"):
            async with db.SessionLocal() as session:
                user = await session.get(models.User, "owner")
                user.is_super = True
                await session.commit()
            self.runner.org_id = "other-org"
            admin_targets = (await self.http.get("/api/v1/conversation-handoffs/targets")).json()["targets"]
            self.assertEqual([x["id"] for x in admin_targets], ["runner:cloud:codex"])
            self.runner.client_id = "u-other"
            self.assertEqual((await self.http.get("/api/v1/conversation-handoffs/targets")).json()["targets"], [])
            self.runner.client_id, self.runner.org_id = "", "org"
            async with db.SessionLocal() as session:
                user = await session.get(models.User, "owner")
                user.is_super = False
                await session.commit()
        for field, value in (("personalPlugins", ["local-plugin"]), ("requiredSkills", ["computer-use"]),
                             ("requiredSkills", ["missing-skill"]), ("model", "invalid model"), ("workDir", "C:/unsafe")):
            with self.subTest(field=field, value=value):
                response = await self.prepare("rejected-" + str(len(str(value))), **{field: value})
                self.assertIn(response.status_code, [400, 409], response.text)
        with self.subTest("unknown abort fences late upload"):
            aborted = await self.http.post("/api/v1/conversation-handoffs/late/abort")
            self.assertEqual(aborted.json()["phase"], "aborted", aborted.text)
            self.assertEqual((await self.prepare("late")).json()["phase"], "aborted")
        with self.subTest("abort wins an already in-flight prepare"):
            entered, release = asyncio.Event(), asyncio.Event()
            actual_destination = svc.destination
            async def pause_destination(*args, **kwargs):
                result = await actual_destination(*args, **kwargs)
                entered.set()
                await release.wait()
                return result
            with patch.object(svc, "destination", pause_destination):
                inflight = asyncio.create_task(self.prepare("abort-race"))
                await asyncio.wait_for(entered.wait(), 5)
                aborted = await self.http.post("/api/v1/conversation-handoffs/abort-race/abort")
                self.assertEqual(aborted.json()["phase"], "aborted", aborted.text)
                release.set()
                late_response = await inflight
                self.assertEqual(late_response.json()["phase"], "aborted", late_response.text)
        prepared = await self.prepare("transfer-1")
        self.assertEqual(prepared.status_code, 200, prepared.text)
        receipt = prepared.json()
        self.assertEqual(receipt["phase"], "prepared", receipt)
        task_id = receipt["taskId"]
        self.assertNotIn("job.dispatch", self.peer.calls)
        repeated = await self.prepare("transfer-1")
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertEqual(repeated.json()["taskId"], task_id)
        self.assertEqual((await self.prepare("transfer-1", instruction="changed")).status_code, 409)
        forbidden = await self.http.get("/api/v1/conversation-handoffs/transfer-1",
            headers={"Authorization": "Device " + self.other_token})
        self.assertEqual(forbidden.status_code, 404)
        bypass = await self.http.post(f"/api/v1/tasks/{task_id}/ai-dispatch", json={"assigneeId": "local:codex"})
        self.assertEqual(bypass.status_code, 409, bypass.text)
        committed = await self.http.post("/api/v1/conversation-handoffs/transfer-1/commit", json={"sha256": receipt["sha256"]})
        self.assertEqual(committed.status_code, 200, committed.text)
        cloud = committed.json()
        self.assertEqual(cloud["phase"], "committed", cloud)
        self.assertTrue(cloud["ref"], cloud)
        self.assertEqual((await self.http.post("/api/v1/conversation-handoffs/transfer-1/abort")).status_code, 409)
        # Close the device HTTP session while its remote subprocess is running.
        await self.http.aclose()
        await self.complete(cloud["ref"])
        restored = WORK / "workspace" / ("handoff-" + svc.identity(self.client.id, "transfer-1"))
        self.assertTrue((restored / "delivery.md").is_file())
        rows = [json.loads(x) for x in (restored / "prompts.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertIn("Keep the report title unchanged.", rows[0]["prompt"])
        self.assertIn("WAIT_FOR_DISCONNECT", rows[0]["prompt"])
        self.assertFalse((restored / "soduwork-workspace-handoff.zip").exists())
        # Reopen connections and drop Hub route caches; durable receipt wins.
        await db.engine.dispose()
        ai_remote._WHERE.clear()
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://isolated",
                                     headers={"Authorization": "Device " + self.token})
        retried = await self.http.post("/api/v1/conversation-handoffs/transfer-1/commit", json={"sha256": receipt["sha256"]})
        self.assertEqual(retried.json()["ref"], cloud["ref"])
        self.assertEqual(self.peer.calls.count("job.dispatch"), 1)
        # Runner process restart must reclaim the same native execution archive.
        await asyncio.to_thread(self.peer.close)
        await asyncio.to_thread(self.peer.start)
        actual = await asyncio.to_thread(self.peer.call, self.runner, "job.has", {"ref": cloud["ref"]})
        self.assertTrue(actual["data"]["has"], actual)
        long_text = "Follow up unchanged: " + "文字" * 2400
        sent = await self.http.post(f"/api/v1/tasks/{task_id}/ai-say", json={"text": long_text, "messageId": "follow-1"})
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertEqual(sent.json()["delivery"], "accepted", sent.text)
        await self.complete(cloud["ref"])
        repeat = await self.http.post(f"/api/v1/tasks/{task_id}/ai-say", json={"text": long_text, "messageId": "follow-1"})
        self.assertTrue(repeat.json()["duplicate"], repeat.text)
        conflict = await self.http.post(f"/api/v1/tasks/{task_id}/ai-say", json={"text": "changed", "messageId": "follow-1"})
        self.assertEqual(conflict.status_code, 409)
        too_long = await self.http.post(f"/api/v1/tasks/{task_id}/ai-say", json={"text": "x" * 200001})
        self.assertEqual(too_long.status_code, 413)
        rows = [json.loads(x) for x in (restored / "prompts.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(rows), 2)
        self.assertIn(long_text, rows[-1]["prompt"])
        # Explicit refusal is distinct from unknown acknowledgement: the desktop
        # can correct the input with a new id without creating a permanent fence.
        from app.services import ai_exec
        with patch.object(ai_exec, "say_sync", return_value={"ok": False, "error": "configuration unavailable"}):
            refused = await self.http.post(f"/api/v1/tasks/{task_id}/ai-say",
                json={"text": "Not launched", "messageId": "known-refusal"})
        self.assertEqual(refused.status_code, 200, refused.text)
        self.assertEqual(refused.json()["delivery"], "rejected", refused.text)
        self.assertFalse(refused.json()["ok"])
        # A transport timeout after acceptance must keep local fenced; read-only
        # reconciliation recovers the exact existing execution without redispatch.
        pending = (await self.prepare("lost-ack")).json()
        original = self.peer.call
        def lose_ack(runner, op, data, timeout=60):
            result = original(runner, op, data, timeout)
            if op == "job.dispatch":
                return {"ok": False, "uncertain": True, "error": "fixture lost ACK"}
            return result
        with patch.object(runner_hub, "call_sync", lose_ack):
            response = await self.http.post("/api/v1/conversation-handoffs/lost-ack/commit", json={"sha256": pending["sha256"]})
        self.assertEqual(response.json()["phase"], "committing", response.text)
        self.assertEqual((await self.http.post("/api/v1/conversation-handoffs/lost-ack/abort")).status_code, 409)
        for _ in range(100):
            recovered = await self.http.get("/api/v1/conversation-handoffs/lost-ack")
            if recovered.json()["phase"] == "committed":
                break
            await asyncio.sleep(.05)
        self.assertEqual(recovered.json()["phase"], "committed", recovered.text)
        await self.complete(recovered.json()["ref"])
        self.assertEqual(self.peer.calls.count("job.dispatch"), 2)
        # An unambiguous pre-send configuration error is still abortable.
        fail = (await self.prepare("offline-before-commit")).json()
        self.runner.ready = False
        rejected = await self.http.post("/api/v1/conversation-handoffs/offline-before-commit/commit", json={"sha256": fail["sha256"]})
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual((await self.http.get("/api/v1/conversation-handoffs/offline-before-commit")).json()["phase"], "prepared")
        self.assertEqual((await self.http.post("/api/v1/conversation-handoffs/offline-before-commit/abort")).json()["phase"], "aborted")
        self.runner.ready = True
        # Old Runners cannot accept a supposedly portable package. A personal
        # cloud Runner remains usable by its owner even if its reported org is
        # temporarily stale; durable owner authorization is the boundary.
        self.runner.caps = []
        self.assertEqual((await self.prepare("old-runner")).status_code, 409)
        self.runner.caps = ["handoff1"]
        self.runner.org_id = "other-org"
        self.assertEqual((await self.prepare("foreign-org")).status_code, 200)
        self.runner.org_id = "org"
        # Partial/unknown follow-up ACKs remain fenced across HTTP retries.
        before = self.peer.calls.count("job.comment")
        def lose_message(runner, op, data, timeout=60):
            result = original(runner, op, data, timeout)
            return {"ok": False, "uncertain": True, "error": "fixture lost comment ACK"} if op == "job.comment" else result
        with patch.object(runner_hub, "call_sync", lose_message):
            uncertain = await self.http.post(f"/api/v1/tasks/{task_id}/ai-say", json={"text": "Second followup", "messageId": "lost-message"})
        self.assertTrue(uncertain.json()["pending"], uncertain.text)
        again = await self.http.post(f"/api/v1/tasks/{task_id}/ai-say", json={"text": "Second followup", "messageId": "lost-message"})
        self.assertTrue(again.json()["pending"], again.text)
        self.assertEqual(self.peer.calls.count("job.comment"), before + 1)
        await self.complete(cloud["ref"])
        # Every shipped adapter crosses the same real restore/admission/process
        # path. Substitute model credentials/catalog only at the vendor boundary.
        from app.services import model_catalog
        self.runner.agents = [{"key": key, "name": value["displayName"], "auth": "authed"}
                              for key, value in AGENTS.items()]
        for agent, declaration in AGENTS.items():
            if agent == "codex":
                continue
            with self.subTest(agent=agent), patch.object(model_catalog, "resolve", AsyncMock(return_value={
                    "base": "http://127.0.0.1:1/v1", "key": "fixture-only", "model": "fixture-model"})):
                selected_model = "fixture-model" if declaration["modelMode"] == "managed" else ""
                prepared_agent = await self.prepare("agent-" + agent, assigneeId="runner:cloud:" + agent,
                    snapshot=archive(agent=agent), model=selected_model, instruction="Continue the report")
                self.assertEqual(prepared_agent.status_code, 200, prepared_agent.text)
                launch = await self.http.post("/api/v1/conversation-handoffs/agent-" + agent + "/commit",
                                               json={"sha256": prepared_agent.json()["sha256"]})
                self.assertEqual(launch.json()["phase"], "committed", launch.text)
                await self.complete(launch.json()["ref"])
                destination = WORK / "workspace" / ("handoff-" + svc.identity(self.client.id, "agent-" + agent))
                self.assertTrue((destination / "delivery.md").is_file(), agent)
                history = (destination / "prompts.jsonl").read_text(encoding="utf-8")
                self.assertIn("Keep the report title unchanged.", history, agent)
        long_history = "HISTORY_START:" + "h" * 1900000 + ":HISTORY_END"
        for agent in ("codex", "qwen"):
            with self.subTest(largeHistory=agent), patch.object(model_catalog, "resolve", AsyncMock(return_value={
                    "base": "http://127.0.0.1:1/v1", "key": "fixture-only", "model": "fixture-model"})):
                large = await self.prepare("large-" + agent, snapshot=archive(history=long_history, agent=agent),
                    assigneeId="runner:cloud:" + agent, model="fixture-model" if agent == "qwen" else "",
                    instruction="Check the full history")
                self.assertEqual(large.status_code, 200, large.text)
                first, second = await asyncio.gather(*[
                    self.http.post("/api/v1/conversation-handoffs/large-" + agent + "/commit", json={"sha256": large.json()["sha256"]})
                    for _ in range(2)])
                self.assertEqual(first.status_code, 200, first.text)
                self.assertEqual(second.status_code, 200, second.text)
                result = first.json() if first.json()["phase"] == "committed" else second.json()
                self.assertEqual(result["phase"], "committed", result)
                await self.complete(result["ref"])
                dest = WORK / "workspace" / ("handoff-" + svc.identity(self.client.id, "large-" + agent))
                prompts = [json.loads(x)["prompt"] for x in (dest / "prompts.jsonl").read_text(encoding="utf-8").splitlines()]
                self.assertEqual(len(prompts), 1)
                self.assertIn(long_history, prompts[0], "Accepted history must never be silently truncated")
        with self.subTest("ACKed queue survives Runner kill, including inputs and followups"):
            (WORK / "hold-queue").touch()
            waiting = (await self.prepare("queued-crash")).json()
            queued = await self.http.post("/api/v1/conversation-handoffs/queued-crash/commit",
                                         json={"sha256": waiting["sha256"]})
            self.assertEqual(queued.json()["status"], "queued", queued.text)
            queued_ref = queued.json()["ref"]
            await asyncio.to_thread(self.peer.crash)
            await asyncio.to_thread(self.peer.start)
            existence = await asyncio.to_thread(self.peer.call, self.runner, "job.has", {"ref": queued_ref})
            self.assertTrue(existence["data"]["persisted"], existence)
            self.assertEqual(existence["data"]["state"], "queued")
            (WORK / "hold-queue").unlink()
            await self.complete(queued_ref)
            destination = WORK / "workspace" / ("handoff-" + svc.identity(self.client.id, "queued-crash"))
            self.assertEqual(len((destination / "prompts.jsonl").read_text(encoding="utf-8").splitlines()), 1)
            (WORK / "hold-queue").touch()
            url = f"/api/v1/tasks/{waiting['taskId']}/ai-say"
            follow = {"text": "Durable queued followup", "messageId": "queued-crash-followup"}
            delivered = await self.http.post(url, json=follow)
            self.assertTrue(delivered.json()["queued"], delivered.text)
            await asyncio.to_thread(self.peer.crash)
            await asyncio.to_thread(self.peer.start)
            self.assertTrue((await self.http.post(url, json=follow)).json()["duplicate"])
            (WORK / "hold-queue").unlink()
            await self.complete(queued_ref)
            prompts = [json.loads(x)["prompt"] for x in (destination / "prompts.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(prompts), 2)
            self.assertIn(follow["text"], prompts[1])
        with self.subTest("started native process is reclaimed without a second launch"):
            (destination / "hold-process").touch()
            live = {"text": "Keep running across Runner crash", "messageId": "live-crash-followup"}
            self.assertEqual((await self.http.post(url, json=live)).status_code, 200)
            for _ in range(200):
                if len((destination / "prompts.jsonl").read_text(encoding="utf-8").splitlines()) == 3:
                    break
                await asyncio.sleep(.05)
            self.assertEqual(len((destination / "prompts.jsonl").read_text(encoding="utf-8").splitlines()), 3)
            await asyncio.to_thread(self.peer.crash)
            await asyncio.to_thread(self.peer.start)
            (destination / "hold-process").unlink()
            await self.complete(queued_ref)
            self.assertEqual(len((destination / "prompts.jsonl").read_text(encoding="utf-8").splitlines()), 3)
        with self.subTest("ambiguous start is surfaced and never automatically repeated"):
            (WORK / "hold-start").touch()
            uncertain_turn = {"text": "Unconfirmed launch", "messageId": "starting-crash-followup"}
            self.assertEqual((await self.http.post(url, json=uncertain_turn)).status_code, 200)
            for _ in range(200):
                if (WORK / "claimed").exists():
                    break
                await asyncio.sleep(.02)
            self.assertTrue((WORK / "claimed").exists())
            await asyncio.to_thread(self.peer.crash)
            (WORK / "hold-start").unlink()
            await asyncio.to_thread(self.peer.start)
            status = await asyncio.to_thread(self.peer.call, self.runner, "job.session", {"ref": queued_ref})
            self.assertEqual(status["data"]["status"], "failed", status)
            self.assertIn("无法确认", status["data"]["error"])
            self.assertTrue((await self.http.post(url, json=uncertain_turn)).json()["duplicate"])
            self.assertEqual(len((destination / "prompts.jsonl").read_text(encoding="utf-8").splitlines()), 3)
        print(json.dumps({"ok": True, "workspace": str(WORK), "oneDispatch": True,
                          "survivesDeviceDisconnect": True, "runnerRestart": True, "longFollowup": len(long_text),
                          "uncertainDispatchRecovered": True, "uncertainMessageNotReplayed": True,
                          "agents": list(AGENTS), "historyCharacters": len(long_history),
                          "inflightAbortFenced": True, "concurrentCommit": True,
                          "queuedCrashRecovered": True, "liveCrashNoDuplicate": True,
                          "ambiguousStartFenced": True}))


if __name__ == "__main__":
    unittest.main()
