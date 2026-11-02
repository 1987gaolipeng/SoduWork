"""Ordinary-conversation receipts use device acknowledgements, never task truth."""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ.setdefault("AUTH_SECRET", "isolated-schedule-reconciliation-test")
import unittest
from datetime import datetime, timedelta, timezone
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models
from app.services import schedules, schedule_conversations as chats, schedule_timing


class ScheduleRunReconciliationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            for table in (models.Client.__table__, models.Task.__table__, models.AiSchedule.__table__,
                          models.AiScheduleRun.__table__):
                await connection.run_sync(table.create)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.client = models.Client(id="device")
        self.started = datetime.now(timezone.utc) - timedelta(hours=2)
        self.finished = self.started + timedelta(seconds=5)
        self.plan = models.AiSchedule(id="schedule", owner_client_id="device", title="Morning briefing",
                                     assignee_id="local:pi", every="daily")
        self.task = models.Task(id="task", title="Unrelated task", status="todo", owner_client_id="device")
        self.run = models.AiScheduleRun(id="run", schedule_id="schedule", owner_client_id="device",
            trigger="timer", state="starting", started_at=self.started,
            receipt={"executionMode": chats.PROTOCOL, "phase": "device"})
        self.session.add_all([self.client, self.plan, self.task, self.run])
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()

    async def reconcile(self):
        await self.session.commit()
        await schedules.reconcile_runs(self.session, schedule_id="schedule")
        await self.session.commit()

    async def ack(self, state, error=""):
        await chats.claim(self.session, self.client, "run", "worker")
        return await chats.acknowledge(self.session, self.client, "run", {
            "instanceId": "worker", "state": state, "conversationId": "chat", "error": error})

    async def test_reading_failed_startup_preserves_error_and_original_finish(self):
        self.run.state, self.run.error, self.run.finished_at = "failed", "插件尚未获得运行许可", self.finished
        for _ in range(2):
            await self.reconcile()
            self.assertEqual(self.run.state, "failed")
            self.assertEqual(self.run.error, "插件尚未获得运行许可")
            self.assertEqual(self.run.finished_at, self.finished)

    async def test_task_changes_cannot_complete_an_unacknowledged_conversation(self):
        self.task.status, self.task.actual_end_at = "done", datetime.now(timezone.utc)
        await self.reconcile()
        self.assertEqual(self.run.state, "starting")
        self.assertIsNone(self.run.finished_at)

    async def test_legacy_links_are_retired_once_without_replaying_or_mutating_task(self):
        self.run.task_id, self.run.workflow_run_id = "task", "workflow"
        self.run.finished_at = self.finished
        self.run.receipt = {"taskStatus": "done", "workflowState": "succeeded"}
        await self.reconcile()
        self.assertEqual(self.run.state, "failed")
        self.assertEqual(self.run.error, "旧版自动化已迁移为普通会话，请重新执行")
        self.assertEqual(self.run.finished_at, self.finished)
        self.assertEqual((self.run.task_id, self.run.workflow_run_id), ("", ""))
        self.assertEqual(self.run.receipt, {"migratedFrom": "legacy-task-workflow"})
        self.assertEqual(self.task.status, "todo")
        await self.reconcile()
        self.assertEqual(self.run.finished_at, self.finished)

    async def test_missing_legacy_task_is_retired_with_actionable_diagnostic(self):
        self.run.task_id = "missing-task"
        await self.reconcile()
        self.assertEqual(self.run.state, "failed")
        self.assertIn("请重新执行", self.run.error)
        self.assertIsNotNone(self.run.finished_at)

    async def test_native_starting_receipt_waits_for_actual_device_ack(self):
        await self.reconcile()
        self.assertEqual(self.run.state, "starting")
        self.assertEqual(self.run.receipt["phase"], "device")
        self.assertIsNone(self.run.finished_at)

    async def test_running_then_succeeded_ack_closes_same_conversation(self):
        await self.ack("running")
        await self.reconcile()
        self.assertEqual(self.run.state, "running")
        self.assertNotIn("phase", self.run.receipt)
        await self.ack("succeeded")
        await self.reconcile()
        self.assertEqual(self.run.state, "succeeded")
        self.assertEqual(self.run.receipt["conversationId"], "chat")
        self.assertIsNotNone(self.run.finished_at)
        self.assertEqual(self.run.error, "")

    async def test_failed_ack_keeps_actual_error_and_cannot_be_rewritten_by_late_success(self):
        await self.ack("failed", "真实执行失败")
        finished = self.run.finished_at
        await self.ack("succeeded")
        await self.reconcile()
        self.assertEqual(self.run.state, "failed")
        self.assertEqual(self.run.error, "真实执行失败")
        self.assertEqual(schedules._utc(self.run.finished_at), schedules._utc(finished))

    async def test_other_worker_cannot_change_receipt(self):
        await chats.claim(self.session, self.client, "run", "worker")
        with self.assertRaises(HTTPException) as caught:
            await chats.acknowledge(self.session, self.client, "run", {
                "instanceId": "intruder", "state": "succeeded", "conversationId": "chat"})
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.run.state, "starting")

    async def test_terminal_ack_cannot_replace_conversation_identity(self):
        await self.ack("running")
        with self.assertRaises(HTTPException) as caught:
            await chats.acknowledge(self.session, self.client, "run", {
                "instanceId": "worker", "state": "succeeded", "conversationId": "other-chat"})
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.run.receipt["conversationId"], "chat")

    async def test_deleted_or_rescheduled_unhanded_appointment_is_cancelled(self):
        self.plan.every = "once"
        self.plan.run_at = datetime.now(timezone.utc) + timedelta(days=1)
        self.run.receipt = {"timing": schedule_timing.snapshot(self.plan)}
        self.plan.run_at += timedelta(days=1)
        await self.reconcile()
        self.assertEqual(self.run.state, "cancelled")
        self.assertIn("日期已变更", self.run.error)
        self.assertIsNotNone(self.run.finished_at)

    async def test_unhanded_current_appointment_remains_pending(self):
        self.plan.every = "once"
        self.plan.run_at = datetime.now(timezone.utc) + timedelta(days=1)
        self.run.receipt = {"timing": schedule_timing.snapshot(self.plan)}
        await self.reconcile()
        self.assertEqual(self.run.state, "starting")
        self.assertIsNone(self.run.finished_at)


if __name__ == "__main__":
    unittest.main()
