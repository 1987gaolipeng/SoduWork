"""Account reconciliation and continuation fences using isolated SQLite only."""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-cloud-sync-not-a-real-secret")

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models, automation_models as am
from app.db import Base
from app.conversation_handoff_models import ConversationHandoff, ConversationMessageReceipt
from app.services import ai_exec, cloud_execution_sync as sync


class CloudExecutionSyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        tables = {model.__table__ for model in (
            models.User, models.Client, models.Task, models.TaskEvent, models.Attachment,
            ConversationHandoff, ConversationMessageReceipt, am.ExecutionSession,
            am.ExecutionEvent, am.ApprovalRequest)}
        pending = list(tables)
        while pending:
            for foreign_key in pending.pop().foreign_keys:
                target = foreign_key.column.table
                if target not in tables:
                    tables.add(target)
                    pending.append(target)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=list(tables)))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as session:
            session.add_all([models.User(id="alice", username="alice", is_active=True),
                models.User(id="bob", username="bob", is_active=True),
                models.Client(id="original", user_ref="alice", auth_state="active"),
                models.Client(id="new", user_ref="alice", auth_state="active"),
                models.Client(id="other", user_ref="bob", auth_state="active")])
            await session.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def seed(self, number=1, *, owner="alice", legacy=False):
        key, tid, ref = f"{number:036d}", f"task-{number}", f"ref-{number}"
        async with self.sessions() as session:
            session.add_all([
                models.Task(id=tid, title="Cloud work", owner_client_id="original",
                    owner_user_id=None if legacy else owner, origin="cloud-conversation"),
                ConversationHandoff(id=key, owner_client_id="original", owner_user_id=owner,
                    transfer_id=key, task_id=tid, phase="committed", options={"agentId": "pi", "assigneeId": "runner:cloud:pi",
                        "targetSnapshot": {"runnerId": "cloud"}},
                    source={"entryKind": "cloud", "sessionId": "source-" + key, "adapterId": "pi"},
                    receipt={"ref": ref, "runnerId": "cloud"}),
                models.TaskEvent(task_id=tid, kind=ai_exec.EV_DISPATCHED, detail={"ref": ref, "runnerId": "cloud"}),
                am.ExecutionSession(id="execution-" + key, task_id=tid, ref=ref, runner_id="cloud", state="done", seq=3),
                am.ExecutionEvent(session_id="execution-" + key, seq=1, kind="say", text="First"),
                am.ExecutionEvent(session_id="execution-" + key, seq=2, kind="say", text="Second"),
                am.ExecutionEvent(session_id="execution-" + key, seq=3, kind="say", text="Third"),
            ])
            await session.commit()
            if legacy:
                # The current insertion hook freezes ownership automatically;
                # bypass it only here to reproduce a pre-migration database row.
                await session.execute(update(models.Task).where(models.Task.id == tid).values(owner_user_id=None))
                await session.commit()
        return key, tid

    async def test_new_device_discovers_all_pages_and_late_lower_ids_on_next_scan(self):
        for number in range(2, 108):
            await self.seed(number)
        async with self.sessions() as session:
            caller = await session.get(models.Client, "new")
            seen, after = [], ""
            while True:
                page = await sync.directory(session, caller, after=after, limit=25)
                seen.extend(row["id"] for row in page["items"])
                if not page["hasMore"]:
                    break
                after = page["next"]
            self.assertEqual(len(set(seen)), 106)
        first, _ = await self.seed(1)
        async with self.sessions() as session:
            caller = await session.get(models.Client, "new")
            self.assertEqual((await sync.directory(session, caller, limit=1))["items"][0]["id"], first)
            other = await session.get(models.Client, "other")
            self.assertEqual((await sync.directory(session, other))["items"], [])
            with self.assertRaises(HTTPException):
                await sync.detail(session, other, first)

    async def test_detail_replays_contiguous_pages_and_existing_approvals_without_credentials(self):
        key, tid = await self.seed()
        async with self.sessions() as session:
            session.add_all([am.ApprovalRequest(id="approval", task_id=tid, artifact_version_id="artifact", action="review"),
                ConversationMessageReceipt(id="send", task_id=tid, owner_client_id="original", message_id="message",
                    content_hash="hash", phase="queued", payload={"text": "private prompt", "secret": "private credential"},
                    receipt={"queued": True, "delivery": "queued", "prompt": "private prompt"})])
            await session.commit()
            caller = await session.get(models.Client, "new")
            first = await sync.detail(session, caller, key, limit=2)
            self.assertEqual(first["page"]["last"], 2)
            self.assertEqual(first["page"]["persistedThrough"], 3)
            self.assertTrue(first["page"]["hasMore"])
            self.assertEqual(first["approvals"][0]["id"], "approval")
            self.assertNotIn("private", str(first))
            self.assertEqual(first["messages"][0]["messageId"], "message")
            second = await sync.detail(session, caller, key, ref="ref-1", since=2, limit=2)
            self.assertEqual([row["seq"] for row in second["page"]["items"]], [3])
            self.assertFalse(second["page"]["hasMore"])
            with self.assertRaises(HTTPException):
                await sync.detail(session, caller, key, ref="stale")

    async def test_continuation_uses_frozen_account_and_original_execution(self):
        key, tid = await self.seed()
        async with self.sessions() as session:
            caller = await session.get(models.Client, "new")
            original = await session.get(models.Client, "original")
            original.user_ref = "bob"
            await session.commit()
            self.assertEqual((await sync.require_account_cloud_task(session, caller, tid)).id, tid)
            with self.assertRaises(HTTPException):
                await sync.require_account_cloud_task(session, original, tid)
            execution = await session.get(am.ExecutionSession, "execution-" + key)
            execution.runner_id = "different"
            await session.commit()
            with self.assertRaises(HTTPException):
                await sync.require_account_cloud_task(session, caller, tid)

    async def test_legacy_account_requires_original_device_proof_and_never_grants_normal_task_writes(self):
        _, tid = await self.seed(legacy=True)
        async with self.sessions() as session:
            caller = await session.get(models.Client, "new")
            self.assertEqual((await sync.require_account_cloud_task(session, caller, tid)).id, tid)
            original = await session.get(models.Client, "original")
            original.user_ref = "bob"
            await session.commit()
            with self.assertRaises(HTTPException):
                await sync.require_account_cloud_task(session, caller, tid)
            session.add(models.Task(id="ordinary", title="Ordinary", owner_client_id="original", owner_user_id="alice"))
            await session.commit()
            self.assertIsNone(await sync.require_account_cloud_task(session, caller, "ordinary", optional=True))

    async def test_existing_say_and_stop_routes_keep_the_real_new_device_caller(self):
        from app.api import tasks
        from app.services import conversation_handoffs, conversation_message_receipts, task_execution_model
        _, tid = await self.seed()
        async with self.sessions() as session:
            caller = await session.get(models.Client, "new")
            with patch.object(ai_exec, "load", AsyncMock(return_value={})), \
                 patch.object(conversation_handoffs, "destination", AsyncMock(return_value={"runnerId": "cloud", "agentId": "pi"})) as target, \
                 patch.object(task_execution_model, "prepare", AsyncMock(return_value=({}, {"model": ""}))), \
                 patch.object(conversation_message_receipts, "send", AsyncMock(return_value={"ok": True, "queued": True,
                     "messageId": "next", "delivery": "queued"})) as send, \
                 patch.object(ai_exec, "stop_sync", return_value={"ok": True}):
                result = await tasks.ai_say_task(tid, {"text": "Continue", "messageId": "next"}, caller, session)
                self.assertEqual(result["delivery"], "queued")
                self.assertIs(send.await_args.args[1], caller)
                self.assertIs(target.await_args.args[1], caller)
                self.assertTrue((await tasks.ai_stop_task(tid, caller, session))["ok"])
                session.add(models.Task(id="ordinary", title="Ordinary", owner_client_id="original"))
                await session.commit()
                with self.assertRaises(HTTPException):
                    await tasks.ai_stop_task("ordinary", caller, session)


if __name__ == "__main__":
    unittest.main()
