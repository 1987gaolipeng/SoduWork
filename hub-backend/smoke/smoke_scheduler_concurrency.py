# -*- coding: utf-8 -*-
"""Real SQLite checks for scheduler idempotency and multi-Hub lease ownership."""
from __future__ import annotations

import atexit
import asyncio
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select


ROOT = os.path.abspath(os.path.dirname(__file__))
SMOKE_ROOT = tempfile.mkdtemp(prefix="soduwork-scheduler-concurrency-")
SMOKE_DB = os.path.join(SMOKE_ROOT, ".smoke-scheduler-concurrency.db")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + SMOKE_DB.replace("\\", "/")
atexit.register(lambda: shutil.rmtree(SMOKE_ROOT, ignore_errors=True))
sys.path.insert(0, ROOT)

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import resource_leases, schedule_run_contracts, schedules  # noqa: E402
from app.services import workflow_engine  # noqa: E402


checks = 0


def ok(condition, message):
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


async def main():
    await init_db()
    now = datetime.now(timezone.utc)
    schedule_id = "schedule-concurrency"
    async with SessionLocal() as session:
        schedule = models.AiSchedule(
            id=schedule_id, title="multi-Hub check",
            every="daily", at_hour=9, at_minute=0, time_zone="Asia/Shanghai",
            owner_client_id="client-1", assignee_id="local:pi", enabled=True,
            retry_limit=0, created_at=now - timedelta(days=2))
        session.add(schedule)
        await session.commit()
        identity = schedules.trigger_identity(schedule, "timer")
        first_run, first_claimed = await schedule_run_contracts.claim_run(
            session, schedule, "timer", identity)
        first_run_id = first_run.id
        ok(first_claimed, "the first Hub did not claim the scheduled occurrence")

    async with SessionLocal() as contender:
        same_schedule = await contender.get(models.AiSchedule, schedule_id)
        same_identity = schedules.trigger_identity(same_schedule, "timer")
        second_run, second_claimed = await schedule_run_contracts.claim_run(
            contender, same_schedule, "timer", same_identity)
        ok(same_identity == identity, "the same occurrence did not produce a stable identity")
        ok(not second_claimed and second_run.id == first_run_id,
           "a second Hub created a duplicate run receipt")
        count = await contender.scalar(select(func.count()).select_from(
            models.AiScheduleRun).where(
                models.AiScheduleRun.idempotency_key == identity))
        ok(count == 1, "the database uniqueness guard did not hold")

    # Simulate a crash after the durable receipt but before hand-off. The next owner must
    # resume that receipt once, and all later sweeps must deduplicate it.
    original_run_one = schedules.run_one
    handoffs = []

    async def fake_run_one(session, schedule, who="", schedule_run_id="", conversation_title=""):
        handoffs.append(schedule_run_id)
        return {"ok": True, "taskId": "task-from-resume", "identifier": "exec-resumed"}

    schedules.run_one = fake_run_one
    try:
        async with SessionLocal() as recovery:
            same_schedule = await recovery.get(models.AiSchedule, schedule_id)
            resumed = await schedules.execute_one(
                recovery, same_schedule, trigger="timer", idempotency_key=identity)
            await recovery.commit()
        async with SessionLocal() as duplicate:
            same_schedule = await duplicate.get(models.AiSchedule, schedule_id)
            repeated = await schedules.execute_one(
                duplicate, same_schedule, trigger="timer", idempotency_key=identity)
        ok(resumed.get("scheduleRunId") == first_run_id,
           "crash recovery did not resume the durable receipt")
        ok(handoffs == [first_run_id], "the same occurrence was handed off more than once")
        ok(repeated.get("deduplicated") is True,
           "a completed hand-off was not recognized as a duplicate")
    finally:
        schedules.run_one = original_run_one

    async with SessionLocal() as manual:
        row = await manual.get(models.AiSchedule, schedule_id)
        one = await schedule_run_contracts.begin_run(manual, row, "manual")
        two = await schedule_run_contracts.begin_run(manual, row, "manual")
        ok(one.idempotency_key != two.idempotency_key,
           "independent manual clicks were incorrectly deduplicated")
        await manual.rollback()

    # Generic resource leases are token-guarded and visible across independent sessions.
    async with SessionLocal() as owner, SessionLocal() as rival:
        lease = await resource_leases.acquire(
            owner, "scheduler-smoke", "shared", owner="hub-a", ttl_seconds=60)
        busy = False
        try:
            await resource_leases.acquire(
                rival, "scheduler-smoke", "shared", owner="hub-b", ttl_seconds=60)
        except resource_leases.LeaseBusy:
            busy = True
        ok(busy, "a second Hub acquired a live resource lease")
        ok(await resource_leases.release(owner, lease),
           "the token owner could not release its lease")
        recovered_lease = await resource_leases.acquire(
            rival, "scheduler-smoke", "shared", owner="hub-b", ttl_seconds=60)
        ok(recovered_lease.owner == "hub-b", "a released lease could not be reclaimed")
        await resource_leases.release(rival, recovered_lease)

    # Outbox claims use one compare-and-set UPDATE. Startup recovery may reclaim expired
    # work, but must leave a live owner and its dispatching node untouched.
    async with SessionLocal() as setup:
        setup.add_all([
            am.NodeRun(
                id="node-claim", run_id="run-claim", node_key="work", node_type="tool",
                state="queued", idempotency_key="run-claim:work:1"),
            am.NodeRun(
                id="node-live", run_id="run-live", node_key="work", node_type="tool",
                state="dispatching", idempotency_key="run-live:work:1"),
            am.NodeRun(
                id="node-expired", run_id="run-expired", node_key="work", node_type="tool",
                state="dispatching", idempotency_key="run-expired:work:1"),
            am.NodeRun(
                id="node-legacy", run_id="run-legacy", node_key="work", node_type="tool",
                state="dispatching", idempotency_key="run-legacy:work:1"),
            am.WorkflowOutbox(
                id="outbox-claim", run_id="run-claim", node_run_id="node-claim",
                topic="node.execute", status="pending",
                available_at=now - timedelta(seconds=1)),
            am.WorkflowOutbox(
                id="outbox-live", run_id="run-live", node_run_id="node-live",
                topic="node.execute", status="processing", lease_owner="other-live-hub",
                lease_until=now + timedelta(minutes=10)),
            am.WorkflowOutbox(
                id="outbox-expired", run_id="run-expired", node_run_id="node-expired",
                topic="node.execute", status="processing", lease_owner="dead-hub",
                lease_until=now - timedelta(seconds=1)),
            am.WorkflowOutbox(
                id="outbox-legacy", run_id="run-legacy", node_run_id="node-legacy",
                topic="node.execute", status="processing", lease_owner="old-hub",
                lease_until=None),
        ])
        await setup.commit()

    async with SessionLocal() as first:
        claimed = await workflow_engine._claim_outbox(first, "outbox-claim", now)
        ok(claimed is not None and claimed.lease_owner == workflow_engine._WORKFLOW_OWNER,
           "the due outbox was not atomically claimed")
    async with SessionLocal() as second:
        lost = await workflow_engine._claim_outbox(second, "outbox-claim", now)
        ok(lost is None, "two sessions claimed the same outbox")
        reclaimed = await workflow_engine.reclaim_startup_leases(second)
        ok(reclaimed == 2, "startup recovery did not isolate expired and legacy leases")
        live_box = await second.get(am.WorkflowOutbox, "outbox-live")
        live_node = await second.get(am.NodeRun, "node-live")
        expired_box = await second.get(am.WorkflowOutbox, "outbox-expired")
        expired_node = await second.get(am.NodeRun, "node-expired")
        legacy_box = await second.get(am.WorkflowOutbox, "outbox-legacy")
        ok(live_box.status == "processing" and live_box.lease_owner == "other-live-hub",
           "startup stole another live Hub's outbox")
        ok(live_node.state == "dispatching",
           "startup rewound another live Hub's node")
        ok(expired_box.status == "pending" and expired_node.state == "queued",
           "an expired outbox was not made recoverable")
        ok(legacy_box.status == "pending",
           "a pre-lease processing row was not made recoverable")

    # Runner saturation is temporary scheduling pressure. Keep the same node attempt and
    # durable outbox pending instead of turning the workflow into a failed/rework run.
    async with SessionLocal() as capacity:
        capacity.add_all([
            am.NodeRun(
                id="node-capacity", run_id="run-capacity", node_key="develop",
                node_type="ai", attempt=3, state="dispatching",
                idempotency_key="run-capacity:develop:3"),
            am.WorkflowOutbox(
                id="outbox-capacity", run_id="run-capacity",
                node_run_id="node-capacity", topic="node.execute",
                status="processing", lease_owner=workflow_engine._WORKFLOW_OWNER,
                lease_until=now + timedelta(minutes=10), available_at=now),
        ])
        await capacity.commit()
        busy = workflow_engine._RunnerCapacityBusy(
            "runner is full", {"busy": 1, "capacity": 1})
        queued = await workflow_engine._requeue_capacity_wait(
            capacity, "outbox-capacity", "node-capacity", "run-capacity", busy)
        ok(queued, "a capacity rejection was not durably requeued")
        nr = await capacity.get(am.NodeRun, "node-capacity")
        box = await capacity.get(am.WorkflowOutbox, "outbox-capacity")
        scheduling = dict((nr.output or {}).get("scheduling") or {})
        ok(nr.state == "queued" and nr.attempt == 3 and not nr.error,
           "capacity waiting changed the business attempt or failed the node")
        ok(box.status == "pending" and box.attempts == 1
           and not box.lease_owner and box.lease_until is None,
           "capacity waiting did not release and defer the same outbox")
        ok(scheduling.get("state") == "waiting_capacity"
           and scheduling.get("capacity", {}).get("busy") == 1,
           "capacity waiting metadata is not visible to clients")

        first_events = await capacity.scalar(select(func.count()).select_from(
            am.WorkflowEvent).where(
                am.WorkflowEvent.run_id == "run-capacity",
                am.WorkflowEvent.kind == "node.waiting"))
        box.status = "processing"
        box.lease_owner = workflow_engine._WORKFLOW_OWNER
        box.lease_until = now + timedelta(minutes=10)
        nr.state = "dispatching"
        await capacity.commit()
        queued_again = await workflow_engine._requeue_capacity_wait(
            capacity, "outbox-capacity", "node-capacity", "run-capacity", busy)
        second_events = await capacity.scalar(select(func.count()).select_from(
            am.WorkflowEvent).where(
                am.WorkflowEvent.run_id == "run-capacity",
                am.WorkflowEvent.kind == "node.waiting"))
        ok(queued_again and box.attempts == 2 and nr.attempt == 3,
           "a repeated capacity wait created a new business attempt")
        ok(first_events == 1 and second_events == 1,
           "repeated capacity retries spammed the workflow timeline")

    await engine.dispose()


asyncio.run(main())
print(f"scheduler concurrency: {checks} checks passed")
