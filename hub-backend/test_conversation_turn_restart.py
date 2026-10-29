"""Exercise interrupted native receipts through authenticated HTTP and durable SQLite.

The client must prove that its original runtime stopped before reusing a receipt.
Hub keeps the same turn identity and continues to reject duplicate scheduling.
"""
import copy
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import test_collaboration_receipt_delivery as receipts
from app import automation_models  # Register foreign-key targets for standalone fixture creation.
from app.api import tasks
from app.db import get_session
from app.models import Client, Task, TaskEvent
from app.realtime import hub
from app.services import device_auth


class ConversationTurnRestartTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.base = receipts.ReceiptDeliveryTests(
            "test_null_legacy_conversation_receipt_keeps_requirement_detail_readable")
        await self.base.asyncSetUp()
        self.publish = patch.object(hub, "publish", new_callable=AsyncMock)
        self.publish.start()
        self.scope = {"conversationId": "chat", "turnId": "turn", "executor": "native"}

    async def asyncTearDown(self):
        self.publish.stop()
        await self.base.asyncTearDown()

    async def _saved_state(self, state):
        routing = {"executionSubmissionMode": "manual", "selectedStrategy": "direct",
                   "outputContract": {"kind": "web", "deliverables": ["game.html"]},
                   "conversationTurn": {**self.scope, "state": state}}
        async with self.base.sessions() as session, session.begin():
            task = await session.get(Task, "task")
            task.status = "doing"
            task.work_routing = copy.deepcopy(routing)
        return routing

    async def _restart(self):
        # Recreate transport, connection pool, and device authentication without
        # rewriting the persisted task or inventing a replacement turn.
        database_url = self.base.engine.url
        await self.base.http.aclose()
        await self.base.engine.dispose()
        self.base.engine = create_async_engine(database_url)
        self.base.sessions = async_sessionmaker(self.base.engine, expire_on_commit=False)
        app = FastAPI()
        app.include_router(tasks.router)

        async def isolated_session():
            async with self.base.sessions() as session:
                yield session

        app.dependency_overrides[get_session] = isolated_session
        self.base.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://fixture")
        async with self.base.sessions() as session:
            token, _ = device_auth.issue_session(await session.get(Client, "owner"))
            self.base.headers["owner"] = {"Authorization": "Device " + token}

    async def _transition(self, action, device="owner", **changes):
        return await self.base.http.post(
            "/api/v1/tasks/task/conversation-turn", headers=self.base.headers[device],
            json={**self.scope, "action": action, **changes})

    async def test_restart_reuses_queued_running_and_waiting_receipts(self):
        for state in ("queued", "running", "waiting"):
            with self.subTest(state=state):
                routing = await self._saved_state(state)
                await self._restart()
                detail = await self.base.http.get(
                    "/api/v1/tasks/task", headers=self.base.headers["owner"])
                self.assertEqual(detail.status_code, 200, detail.text)
                self.assertEqual(detail.json()["workRouting"], routing)

                # Reconnecting alone leaves the original receipt unchanged.
                # The recovered queue only claims start for its queued head.
                if state == "queued":
                    started = await self._transition("start")
                    self.assertEqual(started.status_code, 200, started.text)
                    self.assertEqual(started.json()["turn"]["state"], "running")
                result = await self._transition("complete")
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual(result.json()["turn"], {**self.scope, "state": "completed"})
                self.assertEqual(result.json()["task"]["status"], "doing")
                saved = result.json()["task"]["workRouting"]
                self.assertEqual(saved["outputContract"], routing["outputContract"])
                self.assertEqual(saved["executionSubmissionMode"], "manual")

                async with self.base.sessions() as session:
                    before = len((await session.scalars(select(TaskEvent).where(
                        TaskEvent.task_id == "task", TaskEvent.kind == "conversation.turn"))).all())
                duplicate = await self._transition("complete")
                self.assertEqual(duplicate.status_code, 200, duplicate.text)
                async with self.base.sessions() as session:
                    after = len((await session.scalars(select(TaskEvent).where(
                        TaskEvent.task_id == "task", TaskEvent.kind == "conversation.turn"))).all())
                self.assertEqual(after, before, "retrying a completion must not duplicate its receipt")

    async def test_restart_does_not_allow_replacement_turns_or_other_conversations(self):
        for state in ("queued", "running", "waiting"):
            with self.subTest(state=state):
                routing = await self._saved_state(state)
                await self._restart()
                for changes in ({"turnId": "new-turn"}, {"conversationId": "other-chat"}):
                    response = await self._transition("prepare", **changes)
                    self.assertEqual(response.status_code, 409, response.text)
                    self.assertIn("执行或排队", response.json()["detail"])
                    stale = await self._transition("complete", **changes)
                    self.assertEqual(stale.status_code, 409, stale.text)
                async with self.base.sessions() as session:
                    self.assertEqual((await session.get(Task, "task")).work_routing, routing)

    async def test_restart_does_not_transfer_execution_to_another_device_or_account(self):
        routing = await self._saved_state("running")
        await self._restart()
        for device in ("owner-other-device", "creator", "requester", "unrelated"):
            with self.subTest(device=device):
                for action in ("prepare", "start", "complete", "fail", "cancel"):
                    response = await self._transition(action, device=device)
                    self.assertEqual(response.status_code, 404, response.text)
        async with self.base.sessions() as session:
            self.assertEqual((await session.get(Task, "task")).work_routing, routing)

    async def test_restart_cannot_restart_a_terminal_receipt(self):
        for state in ("completed", "failed", "cancelled"):
            with self.subTest(state=state):
                routing = await self._saved_state(state)
                await self._restart()
                response = await self._transition("start")
                self.assertEqual(response.status_code, 409, response.text)
                async with self.base.sessions() as session:
                    self.assertEqual((await session.get(Task, "task")).work_routing, routing)


if __name__ == "__main__":
    unittest.main()
