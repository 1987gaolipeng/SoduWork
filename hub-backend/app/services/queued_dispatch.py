"""Reconcile an acknowledged queued dispatch against its original Runner journal."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from ..timestamps import iso_utc
from . import dispatch_reconcile, execution_sessions


@dataclass(frozen=True)
class Candidate:
    id: str
    task_id: str
    ref: str
    runner_id: str
    boot_id: str
    round: int
    client_id: str
    updated_at: datetime

    @classmethod
    def from_row(cls, row):
        meta = row.metadata_ or {}
        return cls(row.id, row.task_id, row.ref, row.runner_id, str(meta.get("runnerBootId") or ""),
                   int(meta.get("round") or 1), row.runner_client_id, row.updated_at)


async def probe(runner, ref: str) -> dict:
    """An absent journal entry cannot disprove an already acknowledged dispatch."""
    if runner is None or not runner.alive():
        return {"reason": "offline"}
    if "admit1" not in runner.caps or not runner.boot_id:
        return {"reason": "unverified-journal"}
    try:
        reply = await runner.call("job.has", {"ref": ref, "admissionKey": "dispatch:" + ref}, timeout=5)
    except Exception:  # a transport failure does not change ownership of the work
        return {"reason": "probe-failed"}
    data = reply.get("data") if reply.get("ok") else None
    if not isinstance(data, dict) or data.get("bootId") != runner.boot_id:
        return {"reason": "unverified-reply"}
    if data.get("admissionDurable") is True and data.get("persisted") is True:
        receipt = dispatch_reconcile.admission_receipt(data, ref)
        if receipt:
            return {"receipt": receipt, "bootId": runner.boot_id}
    return {"reason": "unconfirmed-receipt"}


async def lock_candidate(session: AsyncSession, candidate: Candidate):
    """Compare and lock before merging a network result, including on SQLite."""
    if candidate.round != 1:
        return None  # A follow-up turn may reuse the execution ref with another admission key.
    table = am.ExecutionSession
    locked = await session.scalar(update(table).where(
        table.id == candidate.id, table.ref == candidate.ref, table.state == "queued",
        table.runner_id == candidate.runner_id, table.runner_client_id == candidate.client_id,
    ).values(updated_at=table.updated_at).returning(table.id)
      .execution_options(synchronize_session=False))
    if locked is None:
        return None
    row = await session.get(table, locked, populate_existing=True)
    meta = row.metadata_ or {}
    if (iso_utc(row.updated_at) != iso_utc(candidate.updated_at)
            or str(meta.get("runnerBootId") or "") != candidate.boot_id
            or int(meta.get("round") or 1) != candidate.round
            or meta.get("admissionKey") not in (None, "", "dispatch:" + candidate.ref)):
        return None
    return row


async def apply_receipt(session: AsyncSession, runner, candidate: Candidate, result: dict,
                        *, now: datetime | None = None) -> list[dict]:
    receipt = result.get("receipt")
    if (not receipt or runner.id != candidate.runner_id or runner.client_id != candidate.client_id
            or runner.boot_id != result.get("bootId")):
        return []
    row = await lock_candidate(session, candidate)
    if row is None:
        return []
    task = await session.get(models.Task, row.task_id)
    if task is None or not await execution_sessions._allowed(session, runner, task, ref=row.ref):
        return []
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    meta = dict(row.metadata_ or {})
    visible_change = bool(meta.get("queueLeaseStatus"))
    from . import queued_dispatch_lease
    queued_dispatch_lease.renew(meta, now)
    meta["runnerBootId"] = runner.boot_id
    row.metadata_ = meta
    row.updated_at = now
    if receipt["state"] == "queued":
        visible_change |= (meta.get("queuePosition") != receipt["queuePosition"]
                           or meta.get("queueClass") != receipt["queueClass"])
        execution_sessions.apply_admission_receipt(row, receipt)
        if not visible_change:
            return []
        return [{"taskId": task.id, "clientId": task.owner_client_id or "",
                 "session": execution_sessions.session_api(row)}]
    # The journal attests the state. Native session telemetry remains the source of start time,
    # output and sequence. Use the normal terminal settlement and client notification path.
    return await execution_sessions.ingest_runner_snapshots(session, runner, [{
        **receipt, "taskId": row.task_id, "ref": row.ref, "round": candidate.round, "seq": row.seq,
    }])
