"""Assignment notices are durable, transactional and acknowledged by the recipient."""
import os
import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-task-assignment-notice-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-task-assignment-notice-admin")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models, automation_models, realtime
from app.api import clients as api
from app.services import tasks, team, mate_messages, inbox, task_notifications


class TaskAssignmentNotificationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as connection:
            await connection.run_sync(models.Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.session = self.sessions()
        self.addAsyncCleanup(self.session.close)
        self.session.add(models.OrgUnit(id="company", name="company"))
        self.session.add_all([models.User(id=uid, username=uid, org_id="company", is_active=True)
                              for uid in ("sender", "recipient", "other")])
        self.session.add_all([models.Client(id=cid, user_ref=uid, auth_state="active") for cid, uid in
                             (("s1", "sender"), ("s2", "sender"), ("r1", "recipient"), ("r2", "recipient"), ("o1", "other"))])
        await self.session.commit()
        self.sender = await self.session.get(models.Client, "s1")
        self.recipient = await self.session.get(models.Client, "r1")
        self.other = await self.session.get(models.Client, "o1")
        self.publish = AsyncMock()
        self.patcher = patch.object(realtime.hub, "publish", self.publish)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    async def assigned(self, tid="assigned"):
        return await api.create_assigned_task({"taskId": tid, "title": "Please review", "note": "Preserve source",
                                              "assigneeUserId": "recipient"}, self.sender, self.session)

    async def received(self, client=None):
        return (await mate_messages.list_for(self.session, client or self.recipient))["items"]

    async def test_offline_assignment_survives_reconnect_and_retry_without_duplicate(self):
        with patch.object(realtime.hub, "is_online", return_value=False):
            result = await self.assigned()
            retried = await self.assigned()
        rows = await self.received()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["kind"], "task_assignment")
        self.assertEqual(rows[0]["taskId"], result["task"]["id"])
        self.assertEqual(rows[0]["status"], "accepted")
        self.assertIsNone(rows[0]["deliveredAt"])
        self.assertTrue(retried["reused"])
        self.assertFalse([call for call in self.publish.await_args_list
                          if call.args[1]["type"] == "notice"], "save must not wait for delivery")
        while await task_notifications.run_once(self.sessions):
            pass
        sent = (await mate_messages.list_for(self.session, self.sender, "sent"))["items"]
        self.assertEqual(sent[0]["id"], rows[0]["id"])
        notices = [(call.args[0], call.args[1]) for call in self.publish.await_args_list if call.args[1]["type"] == "notice"]
        self.assertEqual({cid for cid, event in notices}, {"r1", "r2"})
        self.assertTrue(all(event["serverMessageId"] == rows[0]["id"] for cid, event in notices))

    async def test_online_socket_does_not_claim_recipient_has_persisted_message(self):
        with patch.object(realtime.hub, "is_online", return_value=True):
            await self.assigned()
            result = await team.message_mate(self.session, self.sender, "recipient", "Hello", {"messageId": "chat"})
        self.assertFalse(result["delivered"])
        self.assertTrue(all(row["status"] == "accepted" for row in await self.received()))

    async def test_direct_message_notice_identifies_recipient_on_every_target_device(self):
        result = await team.message_mate(self.session, self.sender, "recipient", "Only for you", {"messageId": "private-chat"})
        self.assertTrue(result["ok"])
        notices = [(call.args[0], call.args[1]) for call in self.publish.await_args_list
                   if call.args[1].get("type") == "notice"]
        self.assertEqual({cid for cid, event in notices}, {"r1", "r2"})
        for cid, event in notices:
            matching = [call for call in self.publish.await_args_list if call.args[0] == cid and call.args[1] == event]
            self.assertTrue(all(call.kwargs.get("user_id") == "recipient" for call in matching))
            self.assertEqual(event.get("senderId"), "sender")
            self.assertEqual(event.get("recipientId"), "recipient")
            self.assertEqual(event.get("recipientName"), "recipient")
            self.assertEqual(event.get("serverMessageId"), result["messageId"])
        self.assertEqual(await self.received(self.other), [])

    async def test_delivery_and_read_are_recipient_authorized_and_sync_both_accounts(self):
        await self.assigned()
        row = (await self.received())[0]
        self.publish.reset_mock()
        for client in (self.sender, self.other):
            with self.assertRaises(HTTPException):
                await mate_messages.mark_delivered(self.session, client, row["id"])
        delivered = await mate_messages.mark_delivered(self.session, self.recipient, row["id"])
        self.assertEqual(delivered["status"], "delivered")
        self.assertTrue(delivered["deliveredAt"])
        self.assertEqual({call.args[0] for call in self.publish.await_args_list}, {"s1", "s2", "r1", "r2"})
        self.assertTrue(all(call.args[1]["type"] == "mate_message_delivered" for call in self.publish.await_args_list))
        self.publish.reset_mock()
        read = await mate_messages.mark_read(self.session, self.recipient, row["id"])
        self.assertEqual(read["status"], "read")
        self.assertTrue(read["readAt"])
        self.assertEqual({call.args[0] for call in self.publish.await_args_list}, {"s1", "s2", "r1", "r2"})
        count = self.publish.await_count
        await mate_messages.mark_read(self.session, self.recipient, row["id"])
        await mate_messages.mark_delivered(self.session, self.recipient, row["id"])
        self.assertEqual(self.publish.await_count, count)
        self.assertEqual((await self.received())[0]["status"], "read")

    async def test_read_implies_delivery_even_when_delivery_ack_was_lost(self):
        await self.assigned()
        row = (await self.received())[0]
        receipt = await mate_messages.mark_read(self.session, self.recipient, row["id"])
        self.assertTrue(receipt["deliveredAt"])
        self.assertTrue(receipt["readAt"])
        self.assertEqual(receipt["status"], "read")

    async def test_actual_handoffs_have_distinct_messages_and_no_sender_self_notice(self):
        await tasks.create_task(self.session, "s1", {"title": "Handoff"}, notify=False, task_id="handoff")
        await api.handoff_my_task("handoff", {"assigneeUserId": "recipient"}, self.sender, self.session)
        await api.handoff_my_task("handoff", {"assigneeUserId": "sender"}, self.recipient, self.session)
        await api.handoff_my_task("handoff", {"assigneeUserId": "recipient"}, self.sender, self.session)
        rows = await self.received()
        self.assertEqual(len(rows), 2)
        self.assertEqual({row["taskId"] for row in rows}, {"handoff"})
        self.assertEqual(len({row["messageId"] for row in rows}), 2)

    async def test_legacy_read_record_repairs_missing_delivery_without_rewriting_read_time(self):
        from datetime import datetime, timezone
        await self.assigned()
        row = (await self.received())[0]
        saved = await self.session.get(models.MateMessage, row["id"])
        stamp = datetime(2030, 1, 1, tzinfo=timezone.utc)
        saved.status, saved.read_at, saved.delivered_at = "read", stamp, None
        await self.session.commit()
        self.publish.reset_mock()
        result = await mate_messages.mark_read(self.session, self.recipient, row["id"])
        expected = int(stamp.timestamp() * 1000)
        self.assertEqual(result["readAt"], expected)
        self.assertEqual(result["deliveredAt"], expected)
        self.assertEqual(result["status"], "read")
        self.assertEqual({call.args[0] for call in self.publish.await_args_list}, {"s1", "s2", "r1", "r2"})

    async def test_notice_failure_rolls_back_created_task_and_handoff(self):
        with patch.object(mate_messages, "create", AsyncMock(side_effect=ValueError("isolated write failure"))):
            with self.assertRaises(ValueError):
                await self.assigned("failed-create")
        await self.session.rollback()
        self.assertIsNone(await self.session.get(models.Task, "failed-create"))
        self.sender = await self.session.get(models.Client, "s1")
        self.recipient = await self.session.get(models.Client, "r1")
        await tasks.create_task(self.session, "s1", {"title": "Handoff"}, notify=False, task_id="failed-handoff")
        self.publish.reset_mock()
        with patch.object(mate_messages, "create", AsyncMock(side_effect=ValueError("isolated write failure"))):
            with self.assertRaises(ValueError):
                await api.handoff_my_task("failed-handoff", {"assigneeUserId": "recipient"}, self.sender, self.session)
        await self.session.rollback()
        self.assertEqual((await self.session.get(models.Task, "failed-handoff")).owner_client_id, "s1")
        self.publish.assert_not_awaited()

    async def test_sender_cannot_ack_other_recipient_or_override_notification_scope(self):
        outsider = await self.session.get(models.User, "other")
        outsider.org_id = None
        await self.session.commit()
        with self.assertRaises(HTTPException):
            await api.create_assigned_task({"taskId": "forbidden", "title": "no", "assigneeUserId": "other"}, self.sender, self.session)
        self.assertEqual(await self.received(self.other), [])
        self.assertIsNone(await self.session.get(models.Task, "forbidden"))

    async def test_cross_department_assignment_preserves_private_notification_scope(self):
        recipient_user = await self.session.get(models.User, "recipient")
        self.session.add(models.OrgUnit(id="another-department", name="another department"))
        recipient_user.org_id = "another-department"
        await self.session.commit()
        await self.assigned()
        row = (await self.received())[0]
        self.assertEqual(row["senderId"], "sender")
        self.assertEqual(await self.received(self.other), [])
        with self.assertRaises(HTTPException):
            await mate_messages.mark_read(self.session, self.other, row["id"])
        with self.assertRaises(HTTPException):
            await mate_messages.list_for(self.session, self.other, before=row["id"])

    async def test_notification_pages_do_not_lose_same_timestamp_rows(self):
        from datetime import datetime, timezone
        stamp = datetime(2030, 1, 1, tzinfo=timezone.utc)
        for index in range(5):
            self.session.add(models.MateMessage(id=f"message-{index}", sender_id="sender", recipient_id="recipient",
                                               client_message_id=f"message-{index}", text="notice", created_at=stamp))
        await self.session.commit()
        seen, cursor = [], ""
        while True:
            page = await mate_messages.list_for(self.session, self.recipient, limit=2, before=cursor)
            seen.extend(row["id"] for row in page["items"])
            cursor = page["nextCursor"]
            if not cursor:
                break
        self.assertEqual(seen, [f"message-{index}" for index in reversed(range(5))])

    async def test_requirement_assignee_edit_and_inbox_assign_use_actual_actor(self):
        await tasks.create_task(self.session, "s1", {"title": "Edit owner"}, notify=False, task_id="edit")
        updated = await tasks.update_task(self.session, "s1", "edit", {"assigneeUserId": "recipient"})
        self.assertEqual(updated["ownerClientId"], "s1")
        row = (await self.received())[0]
        self.assertEqual((row["senderId"], row["taskId"]), ("sender", "edit"))
        await tasks.update_task(self.session, "s1", "edit", {"assigneeUserId": "recipient"})
        self.assertEqual(len(await self.received()), 1)
        self.session.add(models.Task(id="pool", title="Inbox", owner_client_id=None, pool_org_id="company", status="todo"))
        await self.session.commit()
        recipient_user = await self.session.get(models.User, "recipient")
        result = await inbox.assign_to_user(self.session, "pool", recipient_user, {"company"},
                                           actor_name="same display name", actor_id="sender")
        self.assertTrue(result["ok"])
        rows = await self.received()
        self.assertEqual({(row["senderId"], row["taskId"]) for row in rows}, {("sender", "edit"), ("sender", "pool")})
        events = [call.args[1] for call in self.publish.await_args_list if call.args[1].get("arrival") == "assign"]
        self.assertTrue(all(event.get("notificationId") for event in events))

    async def test_concurrent_delivery_read_remains_read_and_send_failure_keeps_receipt(self):
        await self.assigned()
        row = (await self.received())[0]
        factory = async_sessionmaker(self.engine, expire_on_commit=False)
        async def ack(read):
            async with factory() as session:
                client = await session.get(models.Client, "r1")
                return await (mate_messages.mark_read if read else mate_messages.mark_delivered)(session, client, row["id"])
        with patch.object(realtime.hub, "publish", AsyncMock(side_effect=OSError("offline"))):
            await asyncio.gather(ack(False), ack(True))
        self.session.expire_all()
        saved = await self.session.get(models.MateMessage, row["id"])
        self.assertEqual(saved.status, "read")
        self.assertTrue(saved.delivered_at and saved.read_at)

    async def test_coworker_messages_cannot_spoof_reserved_assignment_identity(self):
        for payload in ({"messageId": "task:spoof"}, {"conversationId": "task:spoof"}):
            with self.assertRaises(HTTPException):
                await team.message_mate(self.session, self.sender, "recipient", "Fake arrival", payload)
        self.assertEqual(await self.received(), [])

    async def test_concurrent_duplicate_create_keeps_one_task_and_one_notice(self):
        # Separate SQLite connections exercise the real uniqueness race, not a mocked retry.
        with tempfile.TemporaryDirectory(prefix="soduwork-notice-race-") as directory:
            filename = (Path(directory) / "race.db").as_posix()
            engine = create_async_engine("sqlite+aiosqlite:///" + filename)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(models.Base.metadata.create_all)
                factory = async_sessionmaker(engine, expire_on_commit=False)
                async with factory() as seed:
                    seed.add(models.OrgUnit(id="company", name="company"))
                    seed.add_all([models.User(id=uid, username=uid, org_id="company", is_active=True) for uid in ("sender", "recipient")])
                    seed.add_all([models.Client(id=cid, user_ref=uid, auth_state="active") for cid, uid in (("s1", "sender"), ("r1", "recipient"))])
                    await seed.commit()
                async def submit():
                    async with factory() as session:
                        client = await session.get(models.Client, "s1")
                        return await team.create_assigned_task(session, client, {"taskId": "concurrent", "title": "one", "assigneeUserId": "recipient"})
                results = await asyncio.gather(submit(), submit(), return_exceptions=True)
                self.assertFalse([result for result in results if isinstance(result, BaseException)], results)
                self.assertTrue(all(result["ok"] for result in results))
                async with factory() as session:
                    self.assertEqual(len(list((await session.scalars(select(models.Task))).all())), 1)
                    self.assertEqual(len(list((await session.scalars(select(models.MateMessage))).all())), 1)
            finally:
                await engine.dispose()


if __name__ == "__main__":
    unittest.main()
