"""Automation receipts keep startup failures until execution actually resumes."""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ.setdefault("AUTH_SECRET", "isolated-schedule-reconciliation-test")

import unittest
from datetime import datetime, timedelta, timezone
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import automation_models as am, models
from app.services import ai_exec, schedules


class ScheduleRunReconciliationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            for table in [models.Client.__table__, models.Task.__table__, models.TaskEvent.__table__,
                          models.AiSchedule.__table__, models.AiScheduleRun.__table__,
                          am.WorkflowRun.__table__, am.NodeRun.__table__,
                          am.ExecutionSession.__table__]:
                await connection.run_sync(table.create)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.session.add(models.Client(id="device"))
        await self.session.flush()
        self.started = datetime.now(timezone.utc) - timedelta(hours=2)
        self.finished = self.started + timedelta(seconds=5)
        self.task = models.Task(id="task", title="Plugin automation", status="todo",
                                origin="automation", owner_client_id="device")
        self.run = models.AiScheduleRun(id="run", schedule_id="schedule", task_id="task",
            owner_client_id="device", trigger="timer", state="failed", started_at=self.started,
            finished_at=self.finished, error="插件尚未获得运行许可", receipt={"mode": "plugin"})
        self.session.add_all([self.task, self.run])
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()

    async def reconcile(self):
        await self.session.commit()
        await schedules.reconcile_runs(self.session, schedule_id="schedule")
        await self.session.commit()

    async def test_reading_failed_startup_preserves_error_and_original_finish(self):
        for _ in range(2):
            await self.reconcile()
            self.assertEqual(self.run.state, "failed")
            self.assertEqual(self.run.error, "插件尚未获得运行许可")
            self.assertEqual(self.run.finished_at, self.finished)

    async def test_task_doing_without_execution_evidence_cannot_erase_failure(self):
        self.task.status = "doing"
        await self.reconcile()
        self.assertEqual(self.run.state, "failed")
        self.assertEqual(self.run.error, "插件尚未获得运行许可")

    async def test_stale_preparing_task_gets_diagnostic_without_borrowing_newer_error(self):
        self.run.state, self.run.error, self.run.finished_at = "starting", "", None
        self.session.add(models.AiSchedule(id="schedule", title="Plan", owner_client_id="device",
            assignee_id="local:pi", last_task_id="task", last_error="A later attempt failed differently"))
        await self.reconcile()
        self.assertEqual(self.run.state, "failed")
        self.assertEqual(self.run.error, "调度启动中断，任务尚未交付执行，请检查执行条件后重试")
        finished = self.run.finished_at
        await self.reconcile()
        self.assertEqual(self.run.finished_at, finished)
        self.assertNotIn("later", self.run.error)

    async def test_orphaned_preparing_diagnostic_is_not_replaced_by_generic_failure(self):
        self.run.state, self.run.error, self.run.finished_at = "starting", "", None
        self.run.task_id = "missing-task"
        await self.reconcile()
        self.assertEqual(self.run.state, "failed")
        self.assertEqual(self.run.error, "调度启动中断，未形成可执行任务")

    async def test_preparing_receipt_with_its_own_error_preserves_that_evidence(self):
        self.run.state, self.run.finished_at = "starting", None
        self.run.started_at = datetime.now(timezone.utc)
        await self.reconcile()
        self.assertEqual(self.run.state, "failed")
        self.assertEqual(self.run.error, "插件尚未获得运行许可")

    async def test_new_preparing_task_remains_preparing(self):
        self.run.state, self.run.error, self.run.finished_at = "starting", "", None
        self.run.started_at = datetime.now(timezone.utc)
        await self.reconcile()
        self.assertEqual(self.run.state, "starting")
        self.assertIsNone(self.run.finished_at)

    async def test_real_dispatch_retry_recovers_and_returned_artifacts_wait_for_acceptance(self):
        self.session.add(models.TaskEvent(id="dispatch", task_id="task", kind=ai_exec.EV_DISPATCHED,
                                         detail={"ref": "exec-ref"}, at=datetime.now(timezone.utc)))
        await self.reconcile()
        self.assertEqual(self.run.state, "running")
        self.assertEqual(self.run.error, "")
        self.assertIsNone(self.run.finished_at)
        self.session.add(models.TaskEvent(id="artifacts", task_id="task", kind=ai_exec.EV_ARTIFACTS,
                                         detail={}, at=datetime.now(timezone.utc)))
        await self.reconcile()
        self.assertEqual(self.run.state, "waiting")
        self.assertEqual(self.run.receipt["phase"], "acceptance")

    async def test_workflow_retry_human_approval_and_completion_reconcile(self):
        workflow = am.WorkflowRun(id="workflow", task_id="task", plugin_id="plugin",
                                 plugin_version_id="version", state="running")
        self.session.add(workflow)
        self.run.workflow_run_id = "workflow"
        await self.reconcile()
        self.assertEqual(self.run.state, "running")
        self.assertEqual(self.run.error, "")
        node = am.NodeRun(id="approval", run_id="workflow", node_key="approval", node_type="approval",
                          state="waiting_human", idempotency_key="workflow:approval")
        self.session.add(node)
        await self.reconcile()
        self.assertEqual(self.run.state, "waiting")
        self.assertEqual(self.run.receipt["phase"], "human_gate")
        node.state, workflow.state, workflow.finished_at = "succeeded", "succeeded", datetime.now(timezone.utc)
        await self.reconcile()
        self.assertEqual(self.run.state, "succeeded")
        self.assertEqual(self.run.finished_at, workflow.finished_at)

    async def test_task_completion_is_conclusive_even_after_failed_start(self):
        self.task.status, self.task.actual_end_at = "done", datetime.now(timezone.utc)
        await self.reconcile()
        self.assertEqual(self.run.state, "succeeded")
        self.assertEqual(self.run.error, "")

    async def test_native_conversation_receipts_still_belong_to_device_ack(self):
        self.run.state, self.run.error, self.run.finished_at = "starting", "", None
        self.run.receipt = {"executionMode": "soduwork.automation-conversation/v1", "phase": "device"}
        await self.reconcile()
        self.assertEqual(self.run.state, "starting")
        self.assertEqual(self.run.receipt["phase"], "device")


if __name__ == "__main__":
    unittest.main()
