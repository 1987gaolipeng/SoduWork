# -*- coding: utf-8 -*-
"""Real SQLite smoke for immutable automation execution receipts."""
from __future__ import annotations

import atexit
import asyncio
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone


ROOT = os.path.abspath(os.path.dirname(__file__))
SMOKE_ROOT = tempfile.mkdtemp(prefix="soduwork-schedule-ledger-")
SMOKE_DB = os.path.join(SMOKE_ROOT, ".smoke-schedule-ledger.db")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + SMOKE_DB.replace("\\", "/")
atexit.register(lambda: shutil.rmtree(SMOKE_ROOT, ignore_errors=True))
sys.path.insert(0, ROOT)

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import schedules  # noqa: E402


checks = 0


def ok(condition, message):
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


async def main():
    await init_db()
    now = datetime.now(timezone.utc)
    async with SessionLocal() as session:
        schedule = models.AiSchedule(
            id="schedule-ledger", title="巡检", owner_client_id="client-ledger",
            assignee_id="local:pi", created_by_name="测试用户")
        done_task = models.Task(
            id="task-done", owner_client_id="client-ledger", title="已完成巡检",
            status="done", actual_end_at=now)
        direct_run = models.AiScheduleRun(
            id="run-direct", schedule_id=schedule.id, owner_client_id="client-ledger",
            task_id=done_task.id, trigger="timer", state="running",
            started_at=now - timedelta(seconds=65), receipt={"mode": "direct"})
        flow_task = models.Task(
            id="task-flow", owner_client_id="client-ledger", title="失败的发布", status="doing")
        workflow = am.WorkflowRun(
            id="workflow-failed", task_id=flow_task.id, plugin_id="plugin-1",
            plugin_version_id="version-1", state="failed", error="健康检查未通过",
            finished_at=now)
        flow_run = models.AiScheduleRun(
            id="run-flow", schedule_id=schedule.id, owner_client_id="client-ledger",
            task_id=flow_task.id, workflow_run_id=workflow.id, trigger="manual",
            state="running", started_at=now - timedelta(seconds=20),
            receipt={"mode": "plugin"})
        session.add_all([schedule, done_task, direct_run, flow_task, workflow, flow_run])
        await session.commit()

        items = await schedules.list_runs(
            session, schedule.id, owner_client_id="client-ledger", limit=20)
        await session.commit()
        by_id = {item["id"]: item for item in items}
        ok(by_id["run-direct"]["state"] == "succeeded",
           "completed task did not complete its automation receipt")
        ok(by_id["run-direct"]["taskTitle"] == "已完成巡检",
           "receipt lost the related task title")
        ok(by_id["run-direct"]["durationSeconds"] >= 65,
           "receipt did not expose stable duration")
        ok(by_id["run-flow"]["state"] == "failed",
           "failed workflow did not fail its automation receipt")
        ok(by_id["run-flow"]["error"] == "健康检查未通过",
           "workflow error did not reach the receipt")
        ok(by_id["run-flow"]["trigger"] == "manual",
           "manual trigger was not preserved")

        workflow.state = "running"
        workflow.error = ""
        workflow.finished_at = None
        await session.commit()
        items = await schedules.list_runs(
            session, schedule.id, owner_client_id="client-ledger", limit=20)
        await session.commit()
        recovered = {item["id"]: item for item in items}["run-flow"]
        ok(recovered["state"] == "running",
           "retried workflow left its automation receipt frozen as failed")
        ok(recovered["error"] == "",
           "retried workflow retained the previous terminal error")

        workflow.state = "failed"
        workflow.error = "retry health check failed"
        workflow.finished_at = now + timedelta(seconds=3)
        await session.commit()
        items = await schedules.list_runs(
            session, schedule.id, owner_client_id="client-ledger", limit=20)
        await session.commit()
        recovered = {item["id"]: item for item in items}["run-flow"]
        ok(recovered["error"] == "retry health check failed",
           "a second failure retained stale diagnostics from the first attempt")

        workflow.state = "succeeded"
        workflow.finished_at = now + timedelta(seconds=5)
        await session.commit()
        items = await schedules.list_runs(
            session, schedule.id, owner_client_id="client-ledger", limit=20)
        await session.commit()
        recovered = {item["id"]: item for item in items}["run-flow"]
        ok(recovered["state"] == "succeeded",
           "successful workflow retry did not close the automation receipt")
        ok(recovered["finishedAt"], "successful workflow retry lost its finish time")

        hidden = await schedules.list_runs(
            session, schedule.id, owner_client_id="another-client", limit=20)
        ok(hidden == [], "owner scope leaked automation execution receipts")

    await engine.dispose()


asyncio.run(main())
print(f"schedule ledger: {checks} checks passed")
