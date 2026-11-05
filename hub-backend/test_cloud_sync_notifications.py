"""Transaction and frozen-account scope for cloud invalidation hints."""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-cloud-notifications")
os.environ.setdefault("ADMIN_PASS", "isolated-cloud-notifications")
os.environ["CLUSTER_REDIS_URL"] = ""

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models, automation_models as am
from app.db import Base
from app.conversation_handoff_models import ConversationHandoff, ConversationMessageReceipt
from app.services import cloud_sync_notifications as events


class CloudSyncNotificationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        tables = {row.__table__ for row in (models.User, models.Client, models.Task,
            models.Attachment, ConversationHandoff, ConversationMessageReceipt,
            am.ExecutionSession, am.ExecutionEvent, am.ApprovalRequest)}
        pending = list(tables)
        while pending:
            for fk in pending.pop().foreign_keys:
                if fk.column.table not in tables:
                    tables.add(fk.column.table); pending.append(fk.column.table)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda c: Base.metadata.create_all(c, tables=list(tables)))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.real_enqueue = events._enqueue
        self.enqueued = patch.object(events, "_enqueue")
        self.enqueue = self.enqueued.start()
        async with self.sessions() as session:
            session.add_all([models.User(id="alice", username="alice", is_active=True),
                models.User(id="bob", username="bob", is_active=True),
                models.Client(id="old", user_ref="bob", auth_state="active"),
                models.Client(id="new", user_ref="alice", auth_state="active"),
                models.Client(id="revoked", user_ref="alice", auth_state="revoked")])
            await session.commit()
        self.enqueue.reset_mock()

    async def asyncTearDown(self):
        self.enqueued.stop()
        await self.engine.dispose()

    def handoff(self, task="task-a"):
        return ConversationHandoff(id=task, task_id=task, transfer_id=task,
            owner_client_id="old", owner_user_id="alice", phase="committed")

    async def test_outer_commit_only_and_rollback_discards_nested_records(self):
        async with self.sessions() as session:
            session.add(self.handoff())
            await session.flush()
            self.enqueue.assert_not_called()
            async with session.begin_nested():
                events.mark(session, "committed-child")
            self.enqueue.assert_not_called()
            savepoint = await session.begin_nested()
            events.mark(session, "rolled-back-child")
            await savepoint.rollback()
            await session.commit()
        records = self.enqueue.call_args.args[1]
        self.assertEqual({value[0] for value in records}, {"task-a", "committed-child"})
        self.enqueue.reset_mock()
        async with self.sessions() as session:
            session.add(self.handoff("rollback"))
            await session.flush()
            await session.rollback()
        self.enqueue.assert_not_called()

    async def test_all_detail_domains_collect_without_changing_receipt_payloads(self):
        async with self.sessions() as session:
            session.add_all([self.handoff(),
                am.ExecutionSession(id="execution", task_id="task-a", ref="ref-a"),
                am.ExecutionEvent(session_id="execution", seq=1, text="private output"),
                am.ApprovalRequest(id="approval", task_id="task-a", artifact_version_id="artifact", action="review"),
                models.Attachment(id="attachment", task_id="task-a", filename="output.txt"),
                ConversationMessageReceipt(id="message", task_id="task-a", owner_client_id="old",
                    message_id="msg", content_hash="hash")])
            await session.commit()
        records = self.enqueue.call_args.args[1]
        self.assertIn(("task-a", "alice", ""), records)
        self.assertIn(("task-a", "", ""), records)
        self.assertIn(("", "", "execution"), records)
        self.assertNotIn("private output", repr(records))
        self.enqueue.reset_mock()
        async with self.sessions() as session:
            row = await session.get(models.Attachment, "attachment")
            await session.delete(row)
            await session.commit()
        self.assertIn(("task-a", "", ""), self.enqueue.call_args.args[1])

    async def test_hint_routes_frozen_account_on_every_device_not_reassigned_source(self):
        async with self.sessions() as session:
            session.add(self.handoff())
            await session.commit()
        with patch("app.realtime.hub.publish", new_callable=AsyncMock) as publish:
            await events.publish(self.engine.sync_engine, {("task-a", "", "")})
        publish.assert_awaited_once_with("new", {"type": "native-discovery",
            "topic": "cloud-execution-sync", "taskId": "task-a"}, user_id="alice")

    async def test_committed_delete_can_wake_original_owner_without_exposing_contents(self):
        async with self.sessions() as session:
            row = self.handoff()
            session.add(row); await session.commit()
            self.enqueue.reset_mock()
            await session.delete(row); await session.commit()
        with patch("app.realtime.hub.publish", new_callable=AsyncMock) as publish:
            await events.publish(self.engine.sync_engine, self.enqueue.call_args.args[1])
        self.assertEqual(publish.call_args.kwargs, {"user_id": "alice"})

    async def test_notification_failure_never_relabels_successful_commit_as_failure(self):
        self.enqueue.side_effect = RuntimeError("transport unavailable")
        async with self.sessions() as session:
            session.add(self.handoff()); await session.commit()
        async with self.sessions() as session:
            self.assertIsNotNone(await session.get(ConversationHandoff, "task-a"))

    async def test_queue_coalesces_repeated_hints_and_stop_prevents_restart(self):
        self.enqueue.side_effect = self.real_enqueue
        events.start()
        with patch("app.services.cluster_bus.bus.enabled", True), patch.object(events, "publish", new_callable=AsyncMock) as publish:
            for _ in range(20):
                events._enqueue(self.engine.sync_engine, {("task-a", "alice", "")})
            await events.flush_for_test()
            publish.assert_awaited_once()
            self.assertEqual(publish.call_args.args[1], [("task-a", "alice", "")])
            await events.stop()
            events._enqueue(self.engine.sync_engine, {("task-b", "alice", "")})
            await events.flush_for_test()
            publish.assert_awaited_once()
        events.start()


if __name__ == "__main__":
    unittest.main()
