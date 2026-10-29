"""Real ASGI/auth/SQLite/Runner/ACP processes; synthetic vendor, no real account."""
import asyncio
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import test_cloud_conversations as cloud
from app import db
from app.conversation_handoff_models import ConversationHandoff
from app.services import model_catalog, conversation_handoffs


class ExecutionSwitchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.base = cloud.CloudConversationTests("test_direct_entry_security_idempotency_inputs_and_capacity")
        await self.base.asyncSetUp()
        self.http, self.fx = self.base.http, self.base.fixture
        self.fx.runner.caps.append("executionSelection1")
        self.fx.runner.agents = [{"key": a, "name": a, "auth": "authed"}
                                 for a in ("pi", "opencode", "qwen", "codex")]
        async def model(_session, _client, name=""):
            if name == "unavailable":
                raise ValueError("model unavailable")
            return {"base": "http://127.0.0.1:1/v1", "key": "fixture-only", "model": name or "default-model"}
        self.models = patch.object(model_catalog, "resolve", model)
        self.models.start()

    async def asyncTearDown(self):
        self.models.stop()
        await self.base.asyncTearDown()

    async def rpc(self, op, **body):
        return await asyncio.to_thread(self.fx.peer.call, self.fx.runner, op, body)

    async def test_switch_sequence_model_reopen_busy_and_identity(self):
        made = await self.base.create("switch", agentId="pi", model="model-a")
        self.assertEqual(made.status_code, 200, made.text)
        receipt = made.json()
        ref, tid = receipt["ref"], receipt["taskId"]
        await self.fx.complete(ref)
        info = (await self.rpc("job.info", ref=ref))["data"]
        workspace = Path(info["workDir"])
        url = f"/api/v1/tasks/{tid}/ai-say"
        async def send(agent, model, key, text="Continue using earlier results"):
            return await self.http.post(url, json={"text": text, "messageId": key,
                "executionSelection": {"agentId": agent, "modelName": model}})
        for index, (agent, model) in enumerate((("opencode", "model-a"), ("qwen", "model-a"),
                                              ("qwen", "model-b"), ("pi", "model-b"))):
            with self.subTest(agent=agent, model=model):
                response = await send(agent, model, f"switch-{index}")
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json().get("ok"), response.text)
                self.assertEqual(response.json()["acceptedSelection"]["agentId"], agent)
                live = await self.fx.complete(ref)
                self.assertEqual(live["cli"], agent)
                self.assertEqual(live["model"], model)
                self.assertEqual(live["activeExecutionSelection"]["agentId"], agent)
                current = await self.http.get(f"/api/v1/tasks/{tid}/ai-session")
                self.assertEqual(current.status_code, 200, current.text)
                self.assertEqual(current.json()["activeExecutionSelection"]["agentId"], agent)
                self.assertEqual(current.json()["activeExecutionSelection"]["modelName"], model)
                self.assertEqual(Path((await self.rpc("job.info", ref=ref))["data"]["workDir"]), workspace)
                history = [json.loads(line) for line in (workspace / "prompts.jsonl").read_text(encoding="utf-8").splitlines()]
                self.assertEqual(len(history), index + 2)
                self.assertNotEqual(history[-1]["sid"], history[-2]["sid"])
                self.assertFalse(history[-1]["resumed"])
                self.assertIn("CLOUD_NEW_TEST", history[-1]["prompt"])
                self.assertIn("delivery.md", history[-1]["prompt"])
                replay = await send(agent, model, f"switch-{index}")
                self.assertTrue(replay.json()["duplicate"], replay.text)
                conflict = await send(agent, "different-model", f"switch-{index}")
                self.assertEqual(conflict.status_code, 409, conflict.text)
        reopened = await self.http.get("/api/v1/conversation-handoffs/switch")
        self.assertEqual(reopened.json()["target"]["agentId"], "pi")
        self.assertEqual(reopened.json()["target"]["model"], "model-b")
        async with db.SessionLocal() as session:
            row = await session.get(ConversationHandoff, conversation_handoffs.identity(self.fx.client.id, "switch"))
            self.assertEqual(row.options["model"], "model-a")
            self.assertEqual(row.options["agentId"], "pi")
            self.assertGreater(row.receipt["activeExecutionSelectionRevision"], 0)
        self.assertEqual((await self.base.create("switch", agentId="pi", model="model-a")).json()["ref"], ref)
        self.assertEqual(self.fx.peer.calls.count("job.dispatch"), 1)

        unavailable = await send("qwen", "unavailable", "unavailable")
        self.assertEqual(unavailable.status_code, 409)
        self.assertEqual((await self.rpc("job.session", ref=ref))["data"]["cli"], "pi")
        self.fx.runner.caps.remove("executionSelection1")
        outdated = await send("qwen", "model-b", "old-runner")
        self.assertEqual(outdated.status_code, 409)
        self.fx.runner.caps.append("executionSelection1")

        (workspace / "hold-process").write_text("hold", encoding="utf-8")
        try:
            normal = await self.http.post(url, json={"text": "Keep working", "messageId": "normal-active"})
            self.assertTrue(normal.json()["ok"], normal.text)
            blocked = await send("qwen", "model-b", "busy-switch")
            self.assertEqual(blocked.json().get("code"), "EXECUTION_SWITCH_BUSY", blocked.text)
            self.assertEqual(blocked.json().get("delivery"), "rejected", blocked.text)
            queued = await self.http.post(url, json={"text": "Then summarize", "messageId": "normal-queued"})
            self.assertTrue(queued.json()["ok"], queued.text)
            self.assertTrue(queued.json()["queued"], queued.text)
        finally:
            (workspace / "hold-process").unlink(missing_ok=True)
        await self.fx.complete(ref)
        denied = await self.http.post(url, json={"text": "steal", "executionSelection": {
            "agentId": "qwen", "modelName": "model-b"}},
            headers={"Authorization": "Device " + self.fx.other_token})
        self.assertIn(denied.status_code, (403, 404))

        await asyncio.to_thread(self.fx.peer.close)
        self.fx.peer.start()
        live = (await self.rpc("job.session", ref=ref))["data"]
        self.assertEqual(live["cli"], "pi")
        self.assertEqual(live["model"], "model-b")
        response = await send("qwen", "", "after-restart")
        self.assertTrue(response.json()["ok"], response.text)
        self.assertEqual(response.json()["acceptedSelection"]["modelName"], "default-model")
        await self.fx.complete(ref)

        # A selected turn may be accepted behind other conversations, then
        # cancelled before any native session changes. The next plain message
        # must still apply the accepted Agent instead of running on the old one.
        hold = self.fx.peer.work / "hold-queue"
        hold.touch()
        try:
            response = await send("opencode", "model-a", "cancel-before-launch")
            self.assertTrue(response.json()["ok"], response.text)
            self.assertTrue(response.json()["queued"], response.text)
            stopped = await self.rpc("job.stop", ref=ref)
            self.assertTrue(stopped["ok"], stopped)
        finally:
            hold.unlink(missing_ok=True)
        resumed = await self.http.post(url, json={"text": "Continue with the chosen Agent", "messageId": "plain-after-cancel"})
        self.assertTrue(resumed.json()["ok"], resumed.text)
        self.assertEqual((await self.fx.complete(ref))["cli"], "opencode")


if __name__ == "__main__":
    unittest.main()
