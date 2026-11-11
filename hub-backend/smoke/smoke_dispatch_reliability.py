# -*- coding: utf-8 -*-
"""Direct task dispatch: stable identity, ACK ambiguity and heartbeat recovery."""
from __future__ import annotations

import asyncio
import concurrent.futures
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from sqlalchemy import func, select


DB = os.path.abspath(".smoke-dispatch-reliability.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import (ai_exec, ai_local, ai_remote, dispatch_attempts,  # noqa: E402
                          dispatch_identity, execution_sessions, runner_hub)


CID = "u-smoke-dispatch-reliability"
TID = "t-smoke-dispatch-reliability"
passed = failed = 0
lines: list[str] = []


def chk(name: str, condition, extra="") -> None:
    global passed, failed
    if condition:
        passed += 1
        lines.append("  PASS  " + name)
    else:
        failed += 1
        suffix = "  << " + str(extra)[:500] if extra not in (None, "") else ""
        lines.append("  FAIL  " + name + suffix)


class _Task:
    id = TID
    title = "可靠派活冒烟"
    note = ""
    result = ""
    status = "todo"
    priority = "normal"
    source = ""
    created_by_name = "测试"


class _RemoteRunner:
    id = "runner-reliable"
    host = "可靠性测试机"
    client_id = CID
    org_id = ""
    version = "9.9.9"
    work_root = ""
    agents = [{"key": "pi", "name": "Pi", "version": "1.0.0"}]
    skills_known = True
    skills: list[str] = []
    capabilities: dict = {}
    dispatch_mode = "accepting"
    tags = ["client-runtime"]
    busy = 0
    connected_at = 0.0

    @staticmethod
    def alive() -> bool:
        return True


class _SilentSocket:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(dict(payload))


class _ContendedSocket:
    def __init__(self):
        self.active = 0
        self.overlap = False
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.active += 1
        self.overlap = self.overlap or self.active > 1
        await asyncio.sleep(0.01)
        self.sent.append(dict(payload))
        self.active -= 1


def test_identity_and_local_dedupe() -> None:
    dispatch_id = "a" * 32
    ref = dispatch_identity.execution_ref(dispatch_id)
    chk("same dispatch id always maps to the same execution ref",
        ref == dispatch_identity.execution_ref(dispatch_id) and len(ref) == 36, ref)
    chk("different dispatch attempts never share a ref",
        ref != dispatch_identity.execution_ref("b" * 32))
    chk("invalid legacy values do not manufacture an identity",
        dispatch_identity.execution_ref("short") == "")

    run = {
        "ref": ref, "taskId": TID, "state": "running", "model": "company/coder",
        "cliSid": ref, "reasoningEffort": "high",
    }
    with ai_local._LOCK:
        previous = ai_local._RUNS.get(ref)
        ai_local._RUNS[ref] = run
    try:
        profile = {"name": "Pi", "own_session": True}
        receipt = ai_local._existing_dispatch_receipt(
            ref, _Task(), "pi", profile, {"selection": {"source": "smoke"}})
        chk("redelivered local dispatch returns the original running session",
            receipt.get("ok") is True and receipt.get("duplicate") is True
            and receipt.get("issueId") == ref and receipt.get("state") == "running",
            receipt)
        collision = ai_local._existing_dispatch_receipt(
            ref, SimpleNamespace(id="another-task"), "pi", profile, None)
        chk("one dispatch identity cannot be reused by another task",
            collision.get("ok") is False and "重复执行" in collision.get("error", ""),
            collision)
    finally:
        with ai_local._LOCK:
            if previous is None:
                ai_local._RUNS.pop(ref, None)
            else:
                ai_local._RUNS[ref] = previous


def test_concurrent_local_dedupe() -> None:
    dispatch_id = "e" * 32
    expected_ref = dispatch_identity.execution_ref(dispatch_id)
    entered = threading.Event()
    release = threading.Event()
    calls: list[str] = []
    original = ai_local._dispatch_sync_once

    def fake_once(cfg, task, files=None, assignee=None, ctx=None):
        calls.append(str((ctx or {}).get("dispatchId") or ""))
        entered.set()
        release.wait(5)
        return {"ok": True, "issueId": expected_ref, "provider": "local"}

    ai_local._dispatch_sync_once = fake_once
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(ai_local.dispatch_sync, {}, _Task(), None, None,
                                {"dispatchId": dispatch_id})
            started = entered.wait(2)
            second = pool.submit(ai_local.dispatch_sync, {}, _Task(), None, None,
                                 {"dispatchId": dispatch_id})
            time.sleep(0.05)
            release.set()
            receipts = [first.result(timeout=5), second.result(timeout=5)]
        chk("concurrent delivery of one dispatch launches exactly one process",
            started and calls == [dispatch_id], calls)
        chk("the concurrent duplicate receives the same stable execution receipt",
            all(item.get("ok") and item.get("issueId") == expected_ref for item in receipts)
            and sum(bool(item.get("duplicate")) for item in receipts) == 1,
            receipts)
        chk("the in-memory start gate is released after the receipt",
            expected_ref not in ai_local._DISPATCH_STARTS,
            list(ai_local._DISPATCH_STARTS))
    finally:
        release.set()
        ai_local._dispatch_sync_once = original
        with ai_local._LOCK:
            ai_local._DISPATCH_STARTS.pop(expected_ref, None)


async def test_hub_capacity_and_send_serialization() -> None:
    first_socket = _ContendedSocket()
    second_socket = _ContendedSocket()
    first = runner_hub._Runner(first_socket, {
        "runnerId": "runner-capacity-a", "clientId": CID, "host": "A",
        "maxConcurrent": 1, "adaptiveLimit": 1, "taskQueueCapacity": 100,
        "taskOutstanding": 0, "agents": [{"key": "pi"}],
    })
    second = runner_hub._Runner(second_socket, {
        "runnerId": "runner-capacity-b", "clientId": CID, "host": "B",
        "maxConcurrent": 1, "agents": [{"key": "pi"}],
    })
    first.dispatch_mode = second.dispatch_mode = "accepting"
    chk("a new control channel is not dispatchable before its welcome handshake completes",
        not runner_hub.can_dispatch(first), first.api())
    first.ready = second.ready = True
    chk("a ready Runner with a known Agent inventory becomes dispatchable",
        runner_hub.can_dispatch(first), first.api())
    unscanned = runner_hub._Runner(_ContendedSocket(), {
        "runnerId": "runner-inventory-pending", "clientId": CID, "host": "扫描中",
        "maxConcurrent": 1, "agents": [],
    })
    unscanned.dispatch_mode = "accepting"
    unscanned.ready = True
    chk("welcome alone cannot route work before the first Agent inventory arrives",
        not runner_hub.can_dispatch(unscanned) and not unscanned.api()["inventoryReady"],
        unscanned.api())
    first.connected_at, second.connected_at = 1.0, 2.0
    reserved, token = runner_hub.reserve_dispatch(first, "dispatch-capacity")
    duplicate, duplicate_reason = runner_hub.reserve_dispatch(first, "dispatch-capacity")
    reservations = [token] if reserved else []
    for index in range(1, 100):
        accepted, reservation = runner_hub.reserve_dispatch(
            first, "dispatch-capacity-%03d" % index)
        if accepted:
            reservations.append(reservation)
    full, full_reason = runner_hub.reserve_dispatch(first, "dispatch-capacity-101")
    saved = dict(runner_hub._RUNNERS)
    runner_hub._RUNNERS.clear()
    runner_hub._RUNNERS.update({first.id: first, second.id: second})
    try:
        chk("one hundred background queue slots are reserved atomically before Runner ACK",
            reserved and token == "dispatch-capacity"
            and not duplicate and duplicate_reason == "duplicate"
            and len(reservations) == 100
            and not full and full_reason == "capacity", first.api())
        chk("scheduler bypasses a saturated Runner instead of overbooking it",
            runner_hub.pick_for(CID, "pi") is second,
            [item.api() for item in (first, second)])
        await asyncio.gather(first.send({"n": 1}), first.send({"n": 2}))
        chk("concurrent Hub writers are serialized on one WebSocket",
            not first_socket.overlap and len(first_socket.sent) == 2,
            first_socket.sent)
    finally:
        for reservation in reservations:
            runner_hub.release_dispatch(first, reservation)
        runner_hub._RUNNERS.clear()
        runner_hub._RUNNERS.update(saved)


async def test_transport_uncertainty() -> None:
    socket = _SilentSocket()
    rpc_runner = runner_hub._Runner(
        socket, {"runnerId": "runner-timeout", "host": "超时测试机"})
    rpc_runner.ready = True
    dispatch = await rpc_runner.call("job.dispatch", {"task": {}}, timeout=0.01)
    status = await rpc_runner.call("job.status", {"ref": "missing"}, timeout=0.01)
    chk("dispatch timeout is explicitly an uncertain ACK",
        dispatch.get("code") == "RUNNER_ACK_TIMEOUT"
        and dispatch.get("uncertain") is True, dispatch)
    chk("read-only RPC timeout remains an ordinary failure",
        status.get("code") == "RUNNER_ACK_TIMEOUT"
        and status.get("uncertain") is False, status)


def test_remote_adapter_uncertainty() -> None:
    runner = _RemoteRunner()
    dispatch_id = "c" * 32
    expected_ref = dispatch_identity.execution_ref(dispatch_id)
    calls: list[tuple[str, dict]] = []
    dispatch_payload: dict = {}

    old_get = runner_hub.get
    old_can = runner_hub.can_dispatch
    old_scope = runner_hub.in_scope
    old_verdict = runner_hub.capability_verdict
    old_call = runner_hub.call_sync
    old_required = ai_remote.execution_capabilities.required_for

    def uncertain_call(_runner, op, data, timeout=60.0):
        calls.append((op, dict(data or {})))
        if op == "job.dispatch":
            dispatch_payload.update(data or {})
            return {"ok": False, "uncertain": True,
                    "code": "RUNNER_ACK_TIMEOUT", "error": "timeout"}
        return {"ok": True, "data": {}}

    runner_hub.get = lambda rid: runner if rid == runner.id else None
    runner_hub.can_dispatch = lambda _runner: True
    runner_hub.in_scope = lambda *_args, **_kwargs: True
    runner_hub.capability_verdict = lambda *_args, **_kwargs: {"ok": True, "missing": []}
    runner_hub.call_sync = uncertain_call
    ai_remote.execution_capabilities.required_for = lambda *_args, **_kwargs: []
    try:
        receipt = ai_remote.dispatch_sync(
            {}, _Task(), [("brief.txt", b"brief", "text/plain")],
            {"id": "runner:%s:pi" % runner.id, "name": "可靠性测试机 · Pi"},
            {"dispatchId": dispatch_id})
        ops = [op for op, _ in calls]
        chk("Hub sends the stable dispatch id to the Runner",
            dispatch_payload.get("dispatchId") == dispatch_id, dispatch_payload)
        chk("lost ACK keeps the deterministic ref and forbids immediate retry",
            receipt.get("ok") is False and receipt.get("uncertain") is True
            and receipt.get("expectedRef") == expected_ref
            and receipt.get("issueId") == expected_ref, receipt)
        chk("uncertain dispatch does not delete inputs that the Runner may be consuming",
            "input.chunk" in ops and "job.dispatch" in ops and "input.drop" not in ops,
            ops)

        calls.clear()

        def duplicate_call(_runner, op, data, timeout=60.0):
            calls.append((op, dict(data or {})))
            if op == "job.dispatch":
                return {"ok": True, "data": {
                    "ref": expected_ref, "identifier": "LOCAL-duplicate",
                    "dispatchId": dispatch_id, "duplicate": True,
                }}
            return {"ok": True, "data": {}}

        runner_hub.call_sync = duplicate_call
        duplicate = ai_remote.dispatch_sync(
            {}, _Task(), None,
            {"id": "runner:%s:pi" % runner.id, "name": "可靠性测试机 · Pi"},
            {"dispatchId": dispatch_id})
        chk("Runner duplicate receipt is surfaced as the same successful execution",
            duplicate.get("ok") is True and duplicate.get("duplicate") is True
            and duplicate.get("issueId") == expected_ref
            and duplicate.get("dispatchId") == dispatch_id, duplicate)
    finally:
        runner_hub.get = old_get
        runner_hub.can_dispatch = old_can
        runner_hub.in_scope = old_scope
        runner_hub.capability_verdict = old_verdict
        runner_hub.call_sync = old_call
        ai_remote.execution_capabilities.required_for = old_required
        ai_remote._WHERE.pop(expected_ref, None)


async def test_heartbeat_reconciliation() -> None:
    await init_db()
    now = datetime.now(timezone.utc)
    old_failure = now - timedelta(days=1)
    runner_id = "runner-reliable"

    async with SessionLocal() as session:
        session.add_all([
            models.Client(id=CID, secret="smoke"),
            models.Task(id=TID, title="可靠派活冒烟", owner_client_id=CID),
            models.TaskEvent(
                task_id=TID, kind=ai_exec.EV_DISPATCH_FAILED, actor="测试",
                at=old_failure, detail={"error": "an old unrelated attempt"}),
        ])
        await session.commit()

        task = await session.get(models.Task, TID)
        attempt_id = await dispatch_attempts.start(
            session, TID, "测试", "runner:%s:pi" % runner_id, "agent", "company/coder")
        expected_ref = dispatch_identity.execution_ref(attempt_id)
        row = am.ExecutionSession(
            task_id=TID, ref=expected_ref, state="running", runner_id=runner_id,
            runner_client_id=CID, engine="pi", host="可靠性测试机",
            metadata_={"executionIdentity": {"runnerVersion": "9.9.9", "agentName": "Pi"}},
        )
        session.add(row)
        await session.commit()
        starting = await dispatch_attempts.existing(session, TID, "todo")
        chk("a concurrent request reuses the starting dispatch attempt",
            starting.get("already") is True and starting.get("pending") is True
            and starting.get("attemptId") == attempt_id
            and starting.get("issueId") == expected_ref,
            starting)

        task = await session.get(models.Task, TID)
        deferred = await execution_sessions._heal_lost_dispatch(session, task, row)
        success_count = (await session.execute(select(func.count(models.TaskEvent.id)).where(
            models.TaskEvent.task_id == TID,
            models.TaskEvent.kind.in_(ai_exec.KINDS_DISPATCHED),
        ))).scalar() or 0
        chk("initial heartbeat waits for the normal RPC reply instead of racing it",
            deferred is False and task.status == "todo" and success_count == 0,
            (deferred, task.status, success_count))

        detail = dispatch_attempts.uncertain(
            session, TID, "测试", attempt_id, "Runner ACK timeout",
            "runner:%s:pi" % runner_id,
            {"id": "runner:%s:pi" % runner_id, "runnerId": runner_id,
             "host": "可靠性测试机", "name": "可靠性测试机 · Pi"})
        task.status = "doing"
        from app.services import tasks as task_service
        pending_state = await task_service.ai_states(session, [TID])
        projected = pending_state.get(TID) or {}
        chk("uncertain ACK stays visibly dispatching instead of looking completed",
            projected.get("state") == "dispatching"
            and projected.get("confirmationPending") is True,
            projected)
        waiting = await dispatch_attempts.existing(session, TID, "doing")
        chk("a repeated request cannot bypass an uncertain ACK",
            waiting.get("already") is True and waiting.get("pending") is True
            and waiting.get("confirmationPending") is True,
            waiting)
        confirmed = await execution_sessions.confirm_uncertain_dispatch(
            session, task, detail["expectedRef"], runner_id)
        await session.commit()

        healed_events = list((await session.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == TID,
            models.TaskEvent.kind.in_(ai_exec.KINDS_DISPATCHED),
        ))).scalars().all())
        matching = [event for event in healed_events
                    if str((event.detail or {}).get("ref") or "") == expected_ref]
        chk("uncertain ACK closes immediately when its heartbeat is already durable",
            confirmed == expected_ref and len(matching) == 1
            and matching[0].detail.get("healedFrom") == "runner-ack-reconciliation",
            (confirmed, [event.detail for event in matching]))
        chk("reconciliation preserves the exact attempt correlation",
            matching and matching[0].detail.get("attemptId") == attempt_id
            and matching[0].detail.get("expectedRef") == expected_ref,
            matching and matching[0].detail)
        running = await dispatch_attempts.existing(session, TID, "doing")
        chk("an HTTP retry after successful recovery returns the same execution",
            running.get("already") is True and running.get("pending") is False
            and running.get("issueId") == expected_ref,
            running)

        again = await execution_sessions.confirm_uncertain_dispatch(
            session, task, expected_ref, runner_id)
        await session.commit()
        count_again = (await session.execute(select(func.count(models.TaskEvent.id)).where(
            models.TaskEvent.task_id == TID,
            models.TaskEvent.kind.in_(ai_exec.KINDS_DISPATCHED),
        ))).scalar() or 0
        chk("heartbeat reconciliation is idempotent",
            again == "" and count_again == 1, (again, count_again))

        row.state = "done"
        await session.commit()
        released = await dispatch_attempts.existing(session, TID, "doing")
        chk("a terminal execution releases the duplicate guard for an explicit retry",
            released is None, released)

        stale_tid = TID + "-stale"
        stale_task = models.Task(
            id=stale_tid, title="旧会话不能认领新尝试",
            owner_client_id=CID, status="doing")
        stale_row = am.ExecutionSession(
            task_id=stale_tid, ref="old-runner-session", state="running",
            runner_id=runner_id, runner_client_id=CID, engine="pi",
            host="可靠性测试机", started_at=old_failure,
            created_at=old_failure)
        session.add_all([stale_task, stale_row])
        await session.commit()
        stale_attempt = await dispatch_attempts.start(
            session, stale_tid, "测试", "runner:%s:pi" % runner_id, "agent")
        dispatch_attempts.uncertain(
            session, stale_tid, "测试", stale_attempt, "Runner ACK timeout",
            "runner:%s:pi" % runner_id,
            {"id": "runner:%s:pi" % runner_id, "runnerId": runner_id,
             "host": "可靠性测试机", "name": "可靠性测试机 · Pi"})
        await session.commit()
        stale_healed = await execution_sessions._heal_lost_dispatch(
            session, stale_task, stale_row)
        stale_success = (await session.execute(select(func.count(models.TaskEvent.id)).where(
            models.TaskEvent.task_id == stale_tid,
            models.TaskEvent.kind.in_(ai_exec.KINDS_DISPATCHED),
        ))).scalar() or 0
        chk("an old same-runner session cannot claim a newer uncertain attempt",
            stale_healed is False and stale_success == 0,
            (stale_healed, stale_success))

        for event in list((await session.execute(select(models.TaskEvent).where(
                models.TaskEvent.task_id.in_((TID, stale_tid))))).scalars().all()):
            await session.delete(event)
        await session.delete(row)
        await session.delete(task)
        client = await session.get(models.Client, CID)
        await session.delete(stale_row)
        await session.delete(stale_task)
        if client is not None:
            await session.delete(client)
        await session.commit()


async def main() -> int:
    test_identity_and_local_dedupe()
    test_concurrent_local_dedupe()
    await test_hub_capacity_and_send_serialization()
    await test_transport_uncertainty()
    test_remote_adapter_uncertainty()
    await test_heartbeat_reconciliation()
    print("\n".join(lines))
    print("\ndispatch reliability smoke: PASS=%d FAIL=%d" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
