"""Durable, round-scoped retries for terminal settlement."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import timedelta

from sqlalchemy import and_, func, literal, or_, select, update

from .. import automation_models as am
from ..db import SessionLocal
from . import execution_sessions, execution_settlement

log = logging.getLogger(__name__)
TERMINAL = ("done", "failed", "stopped", "interrupted", "cancelled", "canceled", "error")


async def _mark(session, row, mark):
    """Patch only the retry field, fenced to the captured turn and state."""
    value = json.dumps(mark, ensure_ascii=False)
    if session.get_bind().dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import JSONB, array
        replacement = func.jsonb_set(am.ExecutionSession.metadata_.cast(JSONB),
                                    array(["terminalRecovery"]), literal(value).cast(JSONB))
    else:
        replacement = func.json_set(am.ExecutionSession.metadata_, "$.terminalRecovery", func.json(value))
    changed = await session.execute(update(am.ExecutionSession).where(
        am.ExecutionSession.id == row.id,
        am.ExecutionSession.state == mark["executionState"],
        func.coalesce(am.ExecutionSession.metadata_["round"].as_integer(), 1) == mark["round"],
    ).values(metadata_=replacement).execution_options(synchronize_session=False))
    await session.commit()
    await session.refresh(row)
    return bool(changed.rowcount)


async def _one(row_id):
    from .cloud_recovery import _now, retry_delay
    async with SessionLocal() as session:
        row = await session.get(am.ExecutionSession, row_id)
        if row is None or not execution_sessions.is_terminal(row.state):
            return "stale"
        meta = dict(row.metadata_ or {})
        round_no = int(meta.get("round") or 1)
        previous = dict(meta.get("terminalRecovery") or {})
        if (previous.get("round") != round_no or previous.get("executionState") != row.state
                or previous.get("seq") != int(row.seq or 0)
                or previous.get("state") == "done" and not execution_sessions.settlement_is_current(row)):
            previous = {}
        now = _now()
        if previous.get("state") == "done" or previous.get("nextRetryAt", "") > now.isoformat():
            return "stale"
        attempt = int(previous.get("attempts") or 0) + 1
        mark = {"round": round_no, "executionState": row.state, "seq": int(row.seq or 0), "state": "pending",
                "attempts": attempt, "updatedAt": now.isoformat(),
                "nextRetryAt": (now + timedelta(seconds=retry_delay(attempt))).isoformat()}
        if not await _mark(session, row, mark):
            return "stale"
        try:
            out = await execution_settlement.settle_terminal(session, row.task_id, row.ref, include_task=False)
            await session.refresh(row)
            if int((row.metadata_ or {}).get("round") or 1) != round_no or row.state != mark["executionState"]:
                return "stale"
            complete = bool(out.get("ok"))
            target = out.get("workflowTarget") or {}
            if complete and target:
                from . import workflow_engine
                wake = await workflow_engine.reconcile_terminal_execution(
                    session, target["workflowRunId"], target["nodeRunId"], target.get("ref") or row.ref)
                complete = bool(wake.get("ok"))
            # Durable task attachments are sufficient for settlement. Saving
            # them to a user's library is a separate, explicit action.
            mark.update(state="done" if complete else "pending",
                        error="" if complete else str(out.get("reason") or "等待执行结果或成果完整同步")[:300])
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await session.rollback()
            row = await session.get(am.ExecutionSession, row_id, populate_existing=True)
            if row is None:
                return "stale"
            mark.update(state="pending", error="终态同步暂不可用：" + type(exc).__name__)
            log.warning("Terminal recovery %s: %s", row_id, type(exc).__name__)
        if mark["state"] == "done":
            mark["nextRetryAt"] = ""
        return mark["state"] if await _mark(session, row, mark) else "stale"


async def recover(*, limit, leased):
    from .cloud_recovery import _now
    row = am.ExecutionSession
    meta = row.metadata_
    recovery = meta["terminalRecovery"]
    round_no = func.coalesce(meta["round"].as_integer(), 1)
    stale = or_(func.coalesce(recovery["round"].as_integer(), 0) != round_no,
                func.coalesce(recovery["executionState"].as_string(), "") != row.state,
                func.coalesce(recovery["seq"].as_integer(), -1) != row.seq,
                and_(recovery["state"].as_string() == "done",
                     func.coalesce(meta["terminalSettlement"]["state"].as_string(), "").not_in(
                         tuple(execution_settlement._SUCCESS_MARKS))))
    async with SessionLocal() as session:
        ids = list(await session.scalars(select(row.id).where(
            row.state.in_(TERMINAL),
            or_(stale, func.coalesce(recovery["state"].as_string(), "") != "done"),
            or_(stale, func.coalesce(recovery["nextRetryAt"].as_string(), "") <= _now().isoformat()),
        ).order_by(func.coalesce(recovery["nextRetryAt"].as_string(), ""), row.created_at, row.id).limit(limit)))
    counts = {"candidates": len(ids)}
    capacity = asyncio.Semaphore(4)

    async def recover_one(row_id):
        try:
            async with capacity:
                state = await leased("terminal-recovery", row_id, lambda: _one(row_id))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            state = "errors"
            log.warning("Terminal repair claim %s: %s", row_id, type(exc).__name__)
        counts[state] = counts.get(state, 0) + 1
    await asyncio.gather(*(recover_one(row_id) for row_id in ids))
    return counts
