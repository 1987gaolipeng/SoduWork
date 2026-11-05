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
from app.api import tasks as task_api
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
        self.assertEqual(rows[0]["textMessage"]["key"], "notification.task_assignment")
        self.assertEqual(rows[0]["textMessage"]["params"]["taskId"], result["task"]["id"])
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
        self.assertTrue(all(event["textMessage"]["key"] == "notification.task_assignment"
                            for _cid, event in notices))

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

    async def test_handoff_note_is_persisted_in_task_detail_and_projection(self):
        await tasks.create_task(self.session, "s1", {
            "title": "Handoff with context", "note": "Original requirement context",
        }, notify=False, task_id="handoff-note")
        frozen = await self.session.get(models.Task, "handoff-note")
        frozen.requirement_content = {"title": frozen.title, "note": "Frozen source context"}
        await self.session.commit()
        result = await api.handoff_my_task(
            "handoff-note", {"assigneeUserId": "recipient", "note": "先补充复现步骤，再开始执行"},
            self.sender, self.session)

        task = await self.session.get(models.Task, "handoff-note")
        self.assertIn("Original requirement context", task.note)
        self.assertIn("转交补充说明", task.note)
        self.assertIn("先补充复现步骤，再开始执行", task.note)
        self.assertIn("先补充复现步骤，再开始执行", result["task"]["note"])
        # The mutation acknowledgement carries the base task. The detail route
        # and recipient-specific WS projection add requirementContent after ACLs.
        detail = await task_api.get_task("handoff-note", self.recipient, self.session)
        self.assertTrue(detail["canViewExecution"])
        self.assertIn("Original requirement context", detail["note"])
        self.assertIn("先补充复现步骤，再开始执行", detail["note"])
        self.assertIn("Frozen source context", detail["requirementContent"]["note"])
        self.assertIn("先补充复现步骤，再开始执行", detail["requirementContent"]["note"])
        self.assertNotIn("Original requirement context", detail["requirementContent"]["note"])
        self.assertEqual(detail["requirementContent"], task.requirement_content)

        recipient_events = {
            call.args[0]: call.args[1]["task"] for call in self.publish.await_args_list
            if call.args[0] in {"r1", "r2"} and call.args[1].get("type") == "task.updated"
            and (call.args[1].get("task") or {}).get("id") == "handoff-note"
        }
        self.assertEqual(set(recipient_events), {"r1", "r2"})
        for projected in recipient_events.values():
            self.assertEqual(projected["requirementContent"], detail["requirementContent"])
            self.assertIn("先补充复现步骤，再开始执行", projected["note"])
        self.assertFalse(any(call.args[0] == self.other.id for call in self.publish.await_args_list))
        with self.assertRaises(HTTPException) as denied:
            await task_api.get_task("handoff-note", self.other, self.session)
        self.assertEqual(denied.exception.status_code, 404)

        event = (await self.session.scalars(
            select(models.TaskEvent).where(models.TaskEvent.task_id == "handoff-note")
        )).all()[-1]
        self.assertEqual(event.kind, "reassign")
        self.assertEqual(event.detail.get("note"), "先补充复现步骤，再开始执行")

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


    async def test_conditional_revision_skips_projection_and_is_account_and_folder_scoped(self):
        await self.assigned()
        initial = await mate_messages.list_for(self.session, self.recipient)
        with patch.object(mate_messages, "public", side_effect=AssertionError("unchanged rows must not be projected")):
            unchanged = await mate_messages.list_for(self.session, self.recipient, if_revision=initial["revision"])
        self.assertTrue(unchanged["notModified"])
        self.assertEqual(unchanged["items"], [])
        other = await mate_messages.list_for(self.session, self.other, if_revision=initial["revision"])
        sent = await mate_messages.list_for(self.session, self.recipient, "sent", if_revision=initial["revision"])
        self.assertNotIn("notModified", other)
        self.assertNotIn("notModified", sent)
        self.assertEqual(other["items"], [])
        # Verify the HTTP handler forwards the optional revision as well.
        response = await api.list_mate_messages(client=self.recipient, session=self.session, ifRevision=initial["revision"])
        self.assertTrue(response["notModified"])

    async def test_old_message_receipts_invalidate_both_sender_and_recipient_revisions(self):
        await self.assigned("older")
        old = (await self.received())[0]
        await self.assigned("newer")
        received = await mate_messages.list_for(self.session, self.recipient)
        sent = await mate_messages.list_for(self.session, self.sender, "sent")
        for acknowledge in (mate_messages.mark_delivered, mate_messages.mark_read):
            await acknowledge(self.session, self.recipient, old["id"])
            next_received = await mate_messages.list_for(self.session, self.recipient, if_revision=received["revision"])
            next_sent = await mate_messages.list_for(self.session, self.sender, "sent", if_revision=sent["revision"])
            self.assertNotIn("notModified", next_received)
            self.assertNotIn("notModified", next_sent)
            self.assertNotEqual(next_received["revision"], received["revision"])
            self.assertNotEqual(next_sent["revision"], sent["revision"])
            received, sent = next_received, next_sent
        await mate_messages.mark_read(self.session, self.recipient, old["id"])
        unchanged = await mate_messages.list_for(self.session, self.sender, "sent", if_revision=sent["revision"])
        self.assertTrue(unchanged["notModified"], "replayed acknowledgements must not invalidate the snapshot")

    async def test_pagination_reports_a_changed_final_revision_and_never_skips_remaining_pages(self):
        await self.assigned("one")
        await self.assigned("two")
        first = await mate_messages.list_for(self.session, self.recipient, limit=1)
        self.assertTrue(first["nextCursor"])
        await mate_messages.mark_read(self.session, self.recipient, first["items"][0]["id"])
        final = await mate_messages.list_for(self.session, self.recipient, limit=1,
                                             before=first["nextCursor"], if_revision=first["revision"])
        self.assertEqual(len(final["items"]), 1)
        self.assertNotEqual(final["revision"], first["revision"])
        self.assertNotIn("notModified", final)
        await self.assigned("three")
        fresh = await mate_messages.list_for(self.session, self.recipient, if_revision=final["revision"])
        self.assertEqual(len(fresh["items"]), 3)

    async def test_revision_periodically_refreshes_derived_names_and_preview_tickets(self):
        await self.assigned()
        with patch.object(mate_messages.time, "time", return_value=900000):
            before = await mate_messages.list_for(self.session, self.recipient)
        with patch.object(mate_messages.time, "time", return_value=900901):
            after = await mate_messages.list_for(self.session, self.recipient, if_revision=before["revision"])
        self.assertNotIn("notModified", after)
        self.assertNotEqual(before["revision"], after["revision"])


if __name__ == "__main__":
    unittest.main()
