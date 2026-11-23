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


ROOT = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
SMOKE_ROOT = tempfile.mkdtemp(prefix="soduwork-schedule-ledger-")
SMOKE_DB = os.path.join(SMOKE_ROOT, ".smoke-schedule-ledger.db")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + SMOKE_DB.replace("\\", "/")
atexit.register(lambda: shutil.rmtree(SMOKE_ROOT, ignore_errors=True))
sys.path.insert(0, ROOT)

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import schedules, schedule_conversations as chats  # noqa: E402


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
            assignee_id="local:pi", created_by_name="测试用户", enabled=False)
        done_task = models.Task(
            id="task-done", owner_client_id="client-ledger", title="已完成巡检",
            status="done", actual_end_at=now)
        direct_run = models.AiScheduleRun(
            id="run-direct", schedule_id=schedule.id, owner_client_id="client-ledger",
            task_id=done_task.id, trigger="timer", state="succeeded",
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
        cloud_run = models.AiScheduleRun(
            id="run-cloud", schedule_id=schedule.id, owner_client_id="client-ledger",
            task_id=done_task.id, state="succeeded", finished_at=now,
            receipt={"executionMode": schedules.CLOUD_PROTOCOL})
        client = models.Client(id="client-ledger")
        session.add_all([client, schedule, done_task, direct_run, flow_task, workflow, flow_run, cloud_run])
        await session.commit()

        await schedules.tick(session)
        items = await schedules.list_runs(
            session, schedule.id, owner_client_id="client-ledger", limit=20)
        by_id = {item["id"]: item for item in items}
        ok(by_id["run-cloud"]["receipt"] == {"executionMode": schedules.CLOUD_PROTOCOL}
           and cloud_run.task_id == done_task.id, "settled cloud receipt was rewritten")
        for run_id in ("run-direct", "run-flow"):
            row = by_id[run_id]
            ok(row["state"] == "failed", "legacy work must not masquerade as a conversation")
            ok(row["receipt"]["migratedFrom"] == "legacy-task-workflow", "migration evidence lost")
            ok("请重新执行" in row["error"], "legacy migration lacks an actionable diagnostic")
            ok("taskTitle" not in row and "taskStatus" not in row, "retired task UI leaked")
            ok(row["finishedAt"], "retired receipt has no finish time")
        ok(by_id["run-flow"]["trigger"] == "manual", "manual trigger lost")
        ok(by_id["run-direct"]["durationSeconds"] >= 65, "stable duration lost")
        workflow.state = "succeeded"
        await session.commit()
        await schedules.tick(session)
        again = await schedules.list_runs(session, schedule.id, owner_client_id=client.id)
        ok({row["id"] for row in again if row["state"] == "failed"} == {"run-direct", "run-flow"},
           "legacy workflow resurrected a retired receipt")

        native = models.AiScheduleRun(id="run-chat", schedule_id=schedule.id,
            owner_client_id=client.id, trigger="manual", state="starting",
            started_at=now - timedelta(seconds=20), receipt={})
        session.add(native)
        await session.commit()
        await chats.prepare(session, schedule, client, None, native.id, "pi", {})
        claimed = await chats.claim(session, client, native.id, "ledger-worker")
        replay = await chats.claim(session, client, native.id, "ledger-worker")
        ok(claimed["input"] == replay["input"], "claim retry changed immutable input")
        for state in ("running", "succeeded"):
            await chats.acknowledge(session, client, native.id, {
                "instanceId": "ledger-worker", "state": state, "conversationId": "chat-ledger"})
            rows = await schedules.list_runs(session, schedule.id, owner_client_id=client.id)
            item = next(row for row in rows if row["id"] == native.id)
            ok(item["state"] == state, "real device outcome did not reach history")
            ok(item["conversationId"] == "chat-ledger", "history lost ordinary conversation identity")
        ok(item["durationSeconds"] >= 20, "conversation duration lost")
        ok(not native.task_id and not native.workflow_run_id, "conversation created legacy links")

        hidden = await schedules.list_runs(
            session, schedule.id, owner_client_id="another-client", limit=20)
        ok(hidden == [], "owner scope leaked automation execution receipts")

    await engine.dispose()


asyncio.run(main())
print(f"schedule ledger: {checks} checks passed")
