"""Resume explicitly submitted handoffs and unfinished delivery, without a viewer.

Task, Handoff and ExecutionSession remain authoritative. Leases only serialize
repair work; an expired lease never proves that an external execution stopped.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select, update

from .. import models
from ..conversation_handoff_models import ConversationHandoff as Handoff
from ..db import SessionLocal
from . import ai_exec, conversation_handoffs as handoffs, resource_leases

log = logging.getLogger(__name__)
INTERVAL_SECONDS = 10
BATCH_SIZE = 30
LEASE_SECONDS = 300


def _now():
    return datetime.now(timezone.utc)


def _utc(value):
    return value.replace(tzinfo=timezone.utc) if value and not value.tzinfo else value


def retry_delay(attempts):
    return min(900, 10 * 2 ** min(7, max(0, attempts - 1)))


async def _leased(kind, key, operation):
    """Keep the claim alive across RPCs using independent short transactions."""
    async with SessionLocal() as session:
        try:
            lease = await resource_leases.acquire(session, kind, key, ttl_seconds=LEASE_SECONDS)
        except resource_leases.LeaseBusy:
            return "busy"
    work = asyncio.create_task(operation())

    async def renew():
        while True:
            await asyncio.sleep(30)
            async with SessionLocal() as session:
                if not await resource_leases.heartbeat(session, lease, LEASE_SECONDS):
                    raise RuntimeError("Recovery lease ownership lost")

    pulse = asyncio.create_task(renew())
    try:
        done, _ = await asyncio.wait((work, pulse), return_when=asyncio.FIRST_COMPLETED)
        if pulse in done:
            await pulse
        return await work
    finally:
        work.cancel()
        pulse.cancel()
        await asyncio.gather(work, pulse, return_exceptions=True)
        async with SessionLocal() as session:
            await resource_leases.release(session, lease)


async def _latest_dispatch(session, task_id):
    return await session.scalar(select(models.TaskEvent).where(
        models.TaskEvent.task_id == task_id,
        models.TaskEvent.kind.in_(ai_exec.KINDS_DISPATCH_STATE),
    ).order_by(models.TaskEvent.at.desc(), models.TaskEvent.id.desc()).limit(1))


async def _safe_started_replay(session, row, latest, now):
    """Allow the same ID only with a same-process durable-admission negative."""
    from . import dispatch_identity, dispatch_reconcile, task_events
    if not row.commit_started_at or _utc(row.commit_started_at) > now - timedelta(minutes=2):
        return False
    detail = dict(latest.detail or {})
    candidate = dispatch_reconcile.Candidate(
        row.task_id, handoffs.dispatch_id(row), dispatch_identity.execution_ref(handoffs.dispatch_id(row)),
        row.options["assigneeId"].split(":")[1],
        detail.get("runnerBootId") or (row.receipt or {}).get("runnerBootId", ""),
        detail.get("host", ""), latest.at, detail)
    result = await dispatch_reconcile.probe(candidate)
    if result.get("state") != "not-started" or result.get("admissionDurable") is not True:
        return False
    await session.execute(select(models.Task.id).where(models.Task.id == row.task_id).with_for_update())
    current = await _latest_dispatch(session, row.task_id)
    if current is None or current.id != latest.id or current.kind != ai_exec.EV_DISPATCH_STARTED:
        return False
    task_events.record(session, row.task_id, ai_exec.EV_DISPATCH_FAILED, {
        **detail, "retryable": True, "confirmedNotStarted": True,
        "summary": "原执行机确认尚未接收；将使用相同派发编号恢复",
        "healedFrom": "durable-admission-negative", "observedBootId": result["observedBootId"],
    }, actor="SoduWork")
    row.phase = "prepared"
    await session.commit()
    return True


async def _submission(row_id):
    async with SessionLocal() as session:
        row = await session.get(Handoff, row_id, populate_existing=True)
        now = _now()
        if (row is None or row.submitted_at is None or row.phase not in {"prepared", "committing"}
                or row.retry_after and _utc(row.retry_after) > now):
            return "stale"
        # Persist the retry schedule before any external work, including a crash.
        row.recovery_attempts = int(row.recovery_attempts or 0) + 1
        row.retry_after = now + timedelta(seconds=retry_delay(row.recovery_attempts))
        await session.commit()
        client = await session.get(models.Client, row.owner_client_id)
        task = await session.get(models.Task, row.task_id)
        if (client is None or client.user_ref != row.owner_user_id
                or client.auth_state != "active" or task is None or task.status == "cancel"):
            row.error = "云端请求已保留，账号权限或任务状态需要核对"
            await session.commit()
            return "blocked"
        await handoffs.owner(session, client)
        row = await handoffs.refresh(session, row)
        if row.phase == "committed":
            return "confirmed"
        latest = await _latest_dispatch(session, row.task_id)
        if latest and (latest.detail or {}).get("attemptId") != handoffs.dispatch_id(row):
            return "blocked"
        replay = (latest is not None and latest.kind == ai_exec.EV_DISPATCH_STARTED
                  and await _safe_started_replay(session, row, latest, now))
        if latest and latest.kind in {ai_exec.EV_DISPATCH_STARTED, ai_exec.EV_DISPATCH_UNCERTAIN} and not replay:
            # A negative STARTED probe does not fence a still-uploading caller.
            # refresh reconciles positive evidence or safe UNCERTAIN negatives.
            row.error = "正在核对原执行机回执；确认前不会重复派发"
            await session.commit()
            return "uncertain"
        if latest and latest.kind == ai_exec.EV_DISPATCH_FAILED and not (latest.detail or {}).get("retryable", False):
            return "blocked"
        if row.phase == "committing":
            # No dispatch event means the external launch intent was never
            # recorded. The original pipeline records it before touching Runner.
            if latest or not row.commit_started_at or _utc(row.commit_started_at) > now - timedelta(minutes=2):
                return "waiting"
            changed = await session.execute(update(Handoff).where(
                Handoff.id == row.id, Handoff.phase == "committing",
                Handoff.commit_started_at == row.commit_started_at,
            ).values(phase="prepared"))
            if changed.rowcount:
                from .cloud_sync_notifications import mark
                mark(session, row.task_id, owner=row.owner_user_id)
            await session.commit()
            if not changed.rowcount:
                return "stale"
        result = await handoffs.commit(session, client, row.transfer_id, row.sha256)
        return "dispatched" if result.get("phase") == "committed" else "pending"


async def recover_submissions(limit=BATCH_SIZE):
    now = _now()
    async with SessionLocal() as session:
        ids = list(await session.scalars(select(Handoff.id).where(
            Handoff.submitted_at.is_not(None), Handoff.phase.in_(("prepared", "committing")),
            or_(Handoff.retry_after.is_(None), Handoff.retry_after <= now),
        ).order_by(Handoff.retry_after.asc().nullsfirst(), Handoff.created_at, Handoff.id).limit(limit)))
    counts = {"candidates": len(ids)}
    capacity = asyncio.Semaphore(4)

    async def recover_one(row_id):
        try:
            async with capacity:
                state = await _leased("cloud-submit", row_id, lambda: _submission(row_id))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            state = "errors"
            log.warning("Cloud submission recovery %s: %s", row_id, type(exc).__name__)
            async with SessionLocal() as session:
                row = await session.get(Handoff, row_id)
                if row is not None and row.phase in {"prepared", "committing"}:
                    row.error = "云端受理请求正在等待恢复：" + type(exc).__name__
                    await session.commit()
        counts[state] = counts.get(state, 0) + 1
    await asyncio.gather(*(recover_one(row_id) for row_id in ids))
    return counts


async def recover_deliveries(limit=BATCH_SIZE):
    from . import terminal_recovery
    return await terminal_recovery.recover(limit=limit, leased=_leased)


async def tick_loop():
    """The kill switch stops repairs, never accepted executions or durable intent."""
    while True:
        if os.environ.get("CLOUD_RECOVERY_ENABLED", "true").lower() not in {"0", "false", "off"}:
            try:
                submitted = await recover_submissions()
                delivered = await recover_deliveries()
                if submitted.get("candidates") or delivered.get("candidates"):
                    log.info("Cloud recovery submissions=%s deliveries=%s", submitted, delivered)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("Cloud recovery sweep failed: %s", type(exc).__name__)
        await asyncio.sleep(INTERVAL_SECONDS)
