"""Completion receipts notify actual participants, never implicit managers."""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-notice-audience-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-notice-audience-admin")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models, realtime
from app.services import receipts, notify
from tests.sqlite_schema import create_fresh_sqlite_schema


class NoticeAudienceRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as connection:
            await create_fresh_sqlite_schema(connection, models.Base.metadata)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.addAsyncCleanup(self.session.close)
        self.session.add_all([models.User(id=uid, username=uid, is_active=True)
                              for uid in ("executor", "requester", "leader")])
        self.session.add_all([models.Client(id=cid, user_ref=uid, auth_state="active")
                              for cid, uid in (("e1", "executor"), ("e2", "executor"),
                                               ("r1", "requester"), ("l1", "leader"))])
        await self.session.commit()
        self.publish = AsyncMock()
        for target, value in (("app.realtime.hub.publish", self.publish),
                              ("app.services.team.direct_leaders", AsyncMock(return_value=["leader"]))):
            guard = patch(target, value)
            guard.start()
            self.addCleanup(guard.stop)

    async def close(self, **fields):
        task = models.Task(id="completed", title="Participant task", status="done",
                           origin="assigned", owner_client_id="e1", **fields)
        self.session.add(task)
        await self.session.commit()
        await receipts.notify_on_close(self.session, task, "e1")
        return [(call.args[0], call.args[1]) for call in self.publish.await_args_list]

    async def test_unrelated_direct_leader_does_not_receive_completion_notice(self):
        self.assertEqual(await self.close(), [])

    async def test_requester_keeps_receipt_with_explicit_recipient_and_task(self):
        notices = await self.close(requester_user_id="requester")
        self.assertEqual([cid for cid, _ in notices], ["r1"])
        self.assertEqual(notices[0][1].get("recipientId"), "requester")
        self.assertEqual(notices[0][1].get("taskId"), "completed")
        self.assertEqual(notices[0][1].get("kind"), "task_receipt")
        self.assertEqual(self.publish.await_args.kwargs["user_id"], "requester")

    async def test_external_request_keeps_creator_relay_without_manager_copy(self):
        notices = await self.close(created_by="requester", requester_name="Customer")
        self.assertEqual([cid for cid, _ in notices], ["r1"])
        self.assertEqual(notices[0][1].get("recipientId"), "requester")
        self.assertIn("Customer", notices[0][1]["text"])
        self.assertEqual(self.publish.await_args.kwargs["user_id"], "requester")

    async def test_task_notice_does_not_follow_device_to_another_account(self):
        task = models.Task(id="private", title="Executor private", status="doing", owner_client_id="e1")
        self.session.add(task)
        await self.session.commit()
        client = await self.session.get(models.Client, "e1")
        client.user_ref = "requester"
        await self.session.commit()
        self.assertEqual(await notify.notify_task(self.session, task, "Private result"), 0)
        self.publish.assert_not_awaited()
        client.user_ref = "executor"
        await self.session.commit()
        self.assertEqual(await notify.notify_task(self.session, task, "Own result"), 1)
        self.assertEqual(self.publish.await_args.args[0], "e1")
        self.assertEqual(self.publish.await_args.kwargs["user_id"], "executor")

    async def test_late_runner_updates_require_frozen_account(self):
        from app.api import runner_ws
        task = models.Task(id="runner-private", title="Private run", status="doing", owner_client_id="e1")
        self.session.add(task)
        await self.session.commit()
        event = {"type": "execution.updated", "taskId": task.id, "session": {"text": "Private output"}}
        factory = async_sessionmaker(self.engine, expire_on_commit=False)
        with patch.object(runner_ws, "SessionLocal", factory):
            await runner_ws._publish_task_owner(task.id, event)
            self.assertEqual(self.publish.await_args.kwargs["user_id"], "executor")
            self.publish.reset_mock()
            client = await self.session.get(models.Client, "e1")
            client.user_ref = "requester"
            await self.session.commit()
            await runner_ws._publish_task_owner(task.id, event)
            self.publish.assert_not_awaited()

    async def test_own_completion_does_not_become_a_notice_on_another_device(self):
        with patch("app.services.receipts.box_of_user", AsyncMock(return_value="e2")):
            self.assertEqual(await self.close(requester_user_id="executor"), [])


if __name__ == "__main__":
    unittest.main()
