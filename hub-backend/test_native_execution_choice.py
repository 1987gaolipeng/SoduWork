"""Verify explicit local selection over real HTTP with device authentication and isolated SQLite,
without Runner or model connections.
"""
import copy
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
import test_collaboration_receipt_delivery as receipts
from app.automation_models import ExecutionSession, ResourceLease, WorkflowRun
from app.models import Task, TaskEvent
from app.realtime import hub


class NativeExecutionChoiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.base = receipts.ReceiptDeliveryTests("test_null_legacy_conversation_receipt_keeps_requirement_detail_readable")
        await self.base.asyncSetUp()
        self.http, self.sessions = self.base.http, self.base.sessions
        self.routing = {"selectedStrategy": "workflow", "workflowBindingId": "old-flow",
            "selectedWorkflowBindingId": "old-flow", "outputContract": {"kind": "documents"},
            "executionContext": {"strategy": "workflow", "runner": {"mode": "remote"}, "model": "old-model"}}
        async with self.sessions() as session, session.begin():
            task = await session.get(Task, "task")
            task.status = "todo"
            task.work_routing = copy.deepcopy(self.routing)
        self.publish = patch.object(hub, "publish", new_callable=AsyncMock)
        self.publish.start()

    async def asyncTearDown(self):
        self.publish.stop()
        await self.base.asyncTearDown()

    async def prepare(self, tid="task", device="owner", **body):
        return await self.http.post(f"/api/v1/tasks/{tid}/conversation-turn", headers=self.base.headers[device],
            json={"action": "prepare", "conversationId": "native-chat", "turnId": "native-turn",
                  "executor": "native", "executionChoice": "native", "agentId": "local:pi", **body})

    async def test_authenticated_owner_saves_choice_and_receipt_once_without_losing_contract(self):
        for device in ("creator", "owner-other-device", "unrelated"):
            self.assertEqual((await self.prepare(device=device)).status_code, 404)
        response = await self.prepare()
        self.assertEqual(response.status_code, 200, response.text)
        routing = response.json()["task"]["workRouting"]
        self.assertEqual(routing["selectedStrategy"], "direct")
        self.assertEqual(routing["executionContext"]["runner"], {"mode": "local"})
        self.assertEqual(routing["executionContext"]["agent"]["id"], "local:pi")
        self.assertEqual(routing["outputContract"], self.routing["outputContract"])
        self.assertFalse(routing["workflowBindingId"])
        self.assertEqual((await self.prepare()).status_code, 200)
        self.assertEqual((await self.prepare(turnId="another-turn")).status_code, 409)
        async with self.sessions() as session:
            events = (await session.scalars(select(TaskEvent).where(TaskEvent.task_id == "task"))).all()
            self.assertEqual([x.kind for x in events].count("execution.choice"), 1)
            self.assertEqual([x.kind for x in events].count("conversation.turn"), 1)
            choice = next(x.detail for x in events if x.kind == "execution.choice")
            self.assertEqual(choice["previousBindingId"], "old-flow")

    async def test_live_lease_workflow_and_dispatch_prevent_native_takeover(self):
        for blocker in ("lease", "workflow", "dispatch", "old-dispatch", "session-without-event"):
            with self.subTest(blocker=blocker):
                async with self.sessions() as session, session.begin():
                    session.add(Task(id=blocker, title="隔离待办", status="todo", owner_client_id="owner",
                        work_routing=copy.deepcopy(self.routing)))
                    if blocker == "lease":
                        session.add(ResourceLease(resource_kind="workflow-start", resource_key=blocker,
                            token="fixture-lease", lease_until=datetime.now(timezone.utc) + timedelta(minutes=1)))
                    elif blocker == "workflow":
                        session.add(WorkflowRun(task_id=blocker, plugin_id="fixture", plugin_version_id="fixture",
                            state="running"))
                    else:
                        session.add(ExecutionSession(task_id=blocker, ref=blocker, state="running"))
                        if blocker != "session-without-event":
                            session.add(TaskEvent(task_id=blocker, kind="ai.dispatched", detail={"ref": blocker},
                                at=datetime.now(timezone.utc) - timedelta(minutes=20 if blocker == "old-dispatch" else 0)))
                response = await self.prepare(blocker)
                self.assertEqual(response.status_code, 409, response.text)
                async with self.sessions() as session:
                    self.assertEqual((await session.get(Task, blocker)).work_routing, self.routing)

    async def test_invalid_agent_executor_and_archived_task_do_not_change_saved_route(self):
        for body in ({"agentId": "runner:r:pi"}, {"agentId": ""}, {"executor": "workflow"}):
            with self.subTest(body=body):
                self.assertIn((await self.prepare(**body)).status_code, (409, 422))
        async with self.sessions() as session, session.begin():
            task = await session.get(Task, "task")
            self.assertEqual(task.work_routing, self.routing)
            task.archived_at = datetime.now(timezone.utc)
        self.assertEqual((await self.prepare()).status_code, 409)


if __name__ == "__main__":
    unittest.main()
