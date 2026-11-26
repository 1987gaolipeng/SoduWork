"""Confirm individual remote queue receipts without dispatching another job."""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select

from .. import automation_models as am
from .. import models
from ..db import SessionLocal
from . import queued_dispatch, runner_hub

log = logging.getLogger(__name__)
LEASE_SECONDS = 90
PROBE_SECONDS = LEASE_SECONDS // 2
_wake: asyncio.Event | None = None
_connected: set[str] = set()


def runner_connected(runner):
    if _wake is not None:
        _connected.add(runner.id)
        _wake.set()


def _utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def renew(meta, now):
    stamp = _utc(now).isoformat(timespec="microseconds")
    meta.update(queueLeaseCheckedAt=stamp, queueLeaseProbeAt=stamp)
    meta.pop("queueLeaseStatus", None)
    meta.pop("queueLeaseReason", None)


def status_fields(state, meta):
    if state == "queued" and meta.get("queueLeaseStatus") == "unconfirmed":
        return {"queueLeaseStatus": "unconfirmed", "queueLeaseReason": "no_runner_ack"}
    return {}


async def status_for_task(session, task_id, ref):
    row = (await session.execute(select(am.ExecutionSession.state, am.ExecutionSession.metadata_).where(
        am.ExecutionSession.task_id == task_id, am.ExecutionSession.ref == ref))).first()
    return status_fields(row[0], row[1] or {}) if row else {}


async def _candidates(session, now, connected, limit):
    row = am.ExecutionSession
    meta = row.metadata_
    probe = meta["queueLeaseProbeAt"].as_string()
    cutoff = now - timedelta(seconds=PROBE_SECONDS)
    due = or_(probe <= cutoff.isoformat(timespec="microseconds"),
              and_(probe.is_(None), row.created_at <= cutoff))
    ack = meta["queueLeaseCheckedAt"].as_string()
    deadline = now - timedelta(seconds=LEASE_SECONDS)
    due = or_(due, and_(func.coalesce(meta["queueLeaseStatus"].as_string(), "") != "unconfirmed",
                        or_(ack <= deadline.isoformat(timespec="microseconds"),
                            and_(ack.is_(None), row.created_at <= deadline))))
    if connected:
        due = or_(due, row.runner_id.in_(connected))
    key = meta["admissionKey"].as_string()
    rows = await session.scalars(select(row).where(
        row.state == "queued", row.runner_id.not_in(("", "backend-local")), row.ref != "",
        func.coalesce(meta["round"].as_integer(), 1) == 1,
        or_(func.coalesce(key, "") == "", key == "dispatch:" + row.ref),
        due).order_by(row.updated_at, row.id).limit(limit))
    return [queued_dispatch.Candidate.from_row(item) for item in rows]


async def _unconfirmed(session, candidate, now):
    row = await queued_dispatch.lock_candidate(session, candidate)
    if row is None:
        return []
    meta = dict(row.metadata_ or {})
    last = meta.get("queueLeaseCheckedAt")
    last_ack = datetime.fromisoformat(last) if last else row.created_at
    expired = now - _utc(last_ack) >= timedelta(seconds=LEASE_SECONDS)
    first_notice = expired and not status_fields(row.state, meta)
    if expired:
        meta.update(queueLeaseStatus="unconfirmed", queueLeaseReason="no_runner_ack")
    meta["queueLeaseProbeAt"] = now.isoformat(timespec="microseconds")
    row.metadata_ = meta
    row.updated_at = now
    if not first_notice:
        return []
    from . import execution_sessions
    owner = await session.scalar(select(models.Task.owner_client_id).where(models.Task.id == row.task_id))
    return [{"taskId": row.task_id, "clientId": owner or "", "session": execution_sessions.session_api(row)}]


async def _check(candidate, now):
    from . import execution_sessions
    runner = runner_hub.get(candidate.runner_id)
    result = {}
    if runner is not None and (runner.client_id or "") == candidate.client_id:
        # Standalone Runner registrations can retain their ID when ownership changes.
        async with SessionLocal() as session:
            task = await session.get(models.Task, candidate.task_id)
            allowed = task is not None and await execution_sessions._allowed(session, runner, task, ref=candidate.ref)
        if allowed:
            result = await queued_dispatch.probe(runner, candidate.ref)
    async with SessionLocal() as session:
        current = runner_hub.get(candidate.runner_id)
        if current is not runner and (not result.get("receipt") or current is None
                                      or any(getattr(current, field, "") != getattr(runner, field, "")
                                             for field in ("boot_id", "client_id", "owner_user_id", "org_id"))):
            return  # A newer connection can confirm its own queue.
        if result.get("receipt"):
            updates = await queued_dispatch.apply_receipt(session, runner, candidate, result, now=now)
        else:
            updates = await _unconfirmed(session, candidate, now)
        await session.commit()
    if updates:
        from ..api.runner_ws import _publish_session_updates
        await _publish_session_updates(updates)


async def sweep(*, now=None, connected=(), limit=50):
    now = _utc(now or datetime.now(timezone.utc))
    async with SessionLocal() as session:
        candidates = await _candidates(session, now, connected, limit)
    # Bound both concurrent Runner RPCs and database writes on a single Hub.
    for offset in range(0, len(candidates), 8):
        results = await asyncio.gather(*(_check(c, now) for c in candidates[offset:offset + 8]),
                                       return_exceptions=True)
        for result in results:
            if isinstance(result, Exception):
                log.warning("Queue receipt check failed: %s", type(result).__name__)


async def tick_loop():
    global _wake
    wake = _wake = asyncio.Event()
    try:
        while True:
            connected = set(_connected)
            _connected.clear()
            wake.clear()
            try:
                await sweep(connected=connected)
            except Exception:
                log.exception("Queue receipt sweep failed")
            try:
                await asyncio.wait_for(wake.wait(), timeout=15)
            except TimeoutError:
                pass
    finally:
        _wake = None
        _connected.clear()
