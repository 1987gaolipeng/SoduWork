# -*- coding: utf-8 -*-
"""Offline contract for ACK reconciliation, Runner generations and safe release."""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select


DB = os.path.abspath(".smoke-dispatch-reconcile.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import (ai_exec, ai_local, dispatch_attempts, dispatch_identity,  # noqa: E402
                          dispatch_reconcile, runner_hub)
from runner_main import Runner as RuntimeRunner  # noqa: E402


CID = "u-smoke-dispatch-reconcile"
RUNNER_ID = "runner-generation-smoke"
BOOT_ID = "boot-generation-one"
NOW = datetime.now(timezone.utc)
passed = failed = 0
lines: list[str] = []


def chk(name: str, condition, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        lines.append("  PASS  " + name)
    else:
        failed += 1
        suffix = "  << " + str(detail)[:500] if detail not in (None, "") else ""
        lines.append("  FAIL  " + name + suffix)


def uncertainty(task_id: str, attempt: str, *, at: datetime = NOW,
                attention: bool = False) -> models.TaskEvent:
    detail = {
        "attemptId": attempt,
        "expectedRef": dispatch_identity.execution_ref(attempt),
        "requestedId": "runner:%s:pi" % RUNNER_ID,
        "runnerId": RUNNER_ID,
        "runnerBootId": BOOT_ID,
        "host": "可靠派活测试机",
        "assigneeName": "可靠派活测试机 · Pi",
        "assigneeCli": "Pi",
        "phase": "confirmation",
        "retryable": False,
    }
    if attention:
        detail["attentionRaised"] = True
    return models.TaskEvent(
        task_id=task_id, kind=ai_exec.EV_DISPATCH_UNCERTAIN,
        detail=detail, actor="测试", at=at)


def candidate(task_id: str, attempt: str, *, at: datetime = NOW) -> dispatch_reconcile.Candidate:
    detail = dict(uncertainty(task_id, attempt, at=at).detail or {})
    return dispatch_reconcile.Candidate(
        task_id=task_id,
        attempt_id=attempt,
        expected_ref=dispatch_identity.execution_ref(attempt),
        runner_id=RUNNER_ID,
        runner_boot_id=BOOT_ID,
        host="可靠派活测试机",
        at=at,
        detail=detail,
    )


async def runner_protocol() -> None:
    runtime = RuntimeRunner("http://127.0.0.1:9080", "", CID, RUNNER_ID)
    ref = dispatch_identity.execution_ref("a" * 32)
    runtime._dispatching_refs.add(ref)
    with ai_local._LOCK:
        previous = ai_local._RUNS.pop(ref, None)
    try:
        reply = await runtime._job({"op": "job.has", "ref": ref})
        data = dict(reply.get("data") or {})
        chk("Runner process owns one boot generation",
            len(runtime.boot_id) == 32 and data.get("bootId") == runtime.boot_id,
            data)
        chk("in-flight preflight is visible before the durable run exists",
            data.get("has") is True and data.get("inflight") is True
            and data.get("persisted") is False, data)
    finally:
        runtime._dispatching_refs.discard(ref)
        if previous is not None:
            with ai_local._LOCK:
                ai_local._RUNS[ref] = previous

    socket = object()
    registered = runner_hub._Runner(socket, {
        "runnerId": RUNNER_ID, "host": "可靠派活测试机", "bootId": BOOT_ID})
    chk("Hub preserves the authenticated Runner generation",
        registered.boot_id == BOOT_ID and registered.api().get("bootId") == BOOT_ID,
        registered.api())


class FakeRunner:
    id = RUNNER_ID
    host = "可靠派活测试机"
    boot_id = BOOT_ID

    def __init__(self, data: dict | None = None, *, online: bool = True):
        self.data = dict(data or {})
        self.online = online

    def alive(self) -> bool:
        return self.online

    async def call(self, op: str, payload: dict, timeout: float = 15) -> dict:
        return {"ok": True, "data": self.data}


async def probe_contract() -> None:
    old_get = runner_hub.get
    item = candidate("t-probe", "b" * 32)
    try:
        runner_hub.get = lambda _rid: FakeRunner({
            "has": True, "persisted": True, "inflight": False, "bootId": BOOT_ID})
        confirmed = await dispatch_reconcile.probe(item)
        chk("a durable run is authoritative success",
            confirmed.get("state") == "confirmed", confirmed)

        runner_hub.get = lambda _rid: FakeRunner({
            "has": False, "persisted": False, "inflight": False, "bootId": BOOT_ID})
        missing = await dispatch_reconcile.probe(item)
        chk("same-process negative is authoritative non-start",
            missing.get("state") == "not-started", missing)

        runner_hub.get = lambda _rid: FakeRunner({
            "has": False, "persisted": False, "inflight": False,
            "bootId": "boot-generation-two"})
        restarted = await dispatch_reconcile.probe(item)
        chk("a restarted Runner can never prove the old process did not start",
            restarted.get("state") == "ambiguous"
            and restarted.get("reason") == "runner-restarted", restarted)

        runner_hub.get = lambda _rid: None
        offline = await dispatch_reconcile.probe(item)
        chk("an offline Runner remains uncertain instead of being retried",
            offline.get("state") == "ambiguous"
            and offline.get("reason") == "offline", offline)
    finally:
        runner_hub.get = old_get


async def persistence_contract() -> None:
    await init_db()
    old = NOW - timedelta(seconds=dispatch_reconcile.ATTENTION_AFTER_SECONDS + 30)
    ids = {
        "confirmed": ("t-rec-confirmed", "c" * 32),
        "released": ("t-rec-released", "d" * 32),
        "attention": ("t-rec-attention", "e" * 32),
        "stale": ("t-rec-stale", "f" * 32),
    }
    async with SessionLocal() as session:
        session.add(models.Client(id=CID, secret="smoke"))
        for name, (task_id, attempt) in ids.items():
            session.add(models.Task(
                id=task_id, title="派活对账 " + name,
                owner_client_id=CID, status="doing"))
            session.add(uncertainty(task_id, attempt, at=old))
        session.add(models.TaskEvent(
            task_id=ids["stale"][0], kind=ai_exec.EV_DISPATCHED,
            detail={"ref": "newer-run"}, actor="测试", at=NOW))
        await session.commit()

    async with SessionLocal() as session:
        rows = await dispatch_reconcile.candidates(session, now=NOW, limit=20)
        found = {row.task_id for row in rows}
        chk("candidate query selects only the latest uncertain state",
            found == {ids["confirmed"][0], ids["released"][0], ids["attention"][0]},
            found)

    task_id, attempt = ids["confirmed"]
    async with SessionLocal() as session:
        action, _task = await dispatch_reconcile.apply_probe(
            session, candidate(task_id, attempt, at=old),
            {"state": "confirmed", "runnerOnline": True,
             "observedBootId": BOOT_ID, "persisted": True}, now=NOW)
        await session.commit()
        task = await session.get(models.Task, task_id)
        event = await dispatch_reconcile._latest_state(session, task_id)
        execution = (await session.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.task_id == task_id))).scalar_one_or_none()
        chk("positive evidence creates one durable dispatch fact",
            action == "confirmed" and event.kind == ai_exec.EV_DISPATCHED
            and execution is not None and execution.ref == dispatch_identity.execution_ref(attempt)
            and task.status == "doing", (action, event.kind, execution and execution.ref))

    task_id, attempt = ids["released"]
    async with SessionLocal() as session:
        action, _task = await dispatch_reconcile.apply_probe(
            session, candidate(task_id, attempt, at=old),
            {"state": "not-started", "runnerOnline": True,
             "observedBootId": BOOT_ID}, now=NOW)
        await session.commit()
        task = await session.get(models.Task, task_id)
        event = await dispatch_reconcile._latest_state(session, task_id)
        active = await dispatch_attempts.existing(session, task_id, task.status)
        chk("same-process negative safely releases the task for retry",
            action == "released" and task.status == "todo"
            and event.kind == ai_exec.EV_DISPATCH_FAILED
            and bool((event.detail or {}).get("confirmedNotStarted"))
            and active is None, (action, task.status, event.kind, active))

    task_id, attempt = ids["attention"]
    item = candidate(task_id, attempt, at=old)
    async with SessionLocal() as session:
        action, _task = await dispatch_reconcile.apply_probe(
            session, item,
            {"state": "ambiguous", "reason": "offline", "runnerOnline": False},
            now=NOW)
        await session.commit()
        first_count = (await session.execute(select(func.count(models.TaskEvent.id)).where(
            models.TaskEvent.task_id == task_id,
            models.TaskEvent.kind == ai_exec.EV_DISPATCH_UNCERTAIN))).scalar() or 0
        event = await dispatch_reconcile._latest_state(session, task_id)
        task = await session.get(models.Task, task_id)
        again, _task = await dispatch_reconcile.apply_probe(
            session, item,
            {"state": "ambiguous", "reason": "offline", "runnerOnline": False},
            now=NOW + timedelta(minutes=1))
        await session.commit()
        second_count = (await session.execute(select(func.count(models.TaskEvent.id)).where(
            models.TaskEvent.task_id == task_id,
            models.TaskEvent.kind == ai_exec.EV_DISPATCH_UNCERTAIN))).scalar() or 0
        chk("long ambiguity raises one actionable attention state without retry",
            action == "attention" and again == "pending" and task.status == "doing"
            and bool((event.detail or {}).get("attentionRaised"))
            and (event.detail or {}).get("nextAction")
            and first_count == second_count == 2,
            (action, again, task.status, first_count, second_count, event.detail))

    task_id, attempt = ids["stale"]
    async with SessionLocal() as session:
        before = (await session.execute(select(func.count(models.TaskEvent.id)).where(
            models.TaskEvent.task_id == task_id))).scalar() or 0
        action, _task = await dispatch_reconcile.apply_probe(
            session, candidate(task_id, attempt, at=old),
            {"state": "not-started", "runnerOnline": True,
             "observedBootId": BOOT_ID}, now=NOW)
        await session.commit()
        after = (await session.execute(select(func.count(models.TaskEvent.id)).where(
            models.TaskEvent.task_id == task_id))).scalar() or 0
        chk("a newer dispatch fact defeats a stale multi-Hub reconciliation",
            action == "stale" and before == after, (action, before, after))


async def main() -> None:
    await runner_protocol()
    await probe_contract()
    await persistence_contract()
    await engine.dispose()


try:
    asyncio.run(main())
finally:
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except OSError:
            pass

print("\n".join(lines))
print("\ndispatch reconcile smoke: PASS=%d FAIL=%d" % (passed, failed))
raise SystemExit(1 if failed else 0)
