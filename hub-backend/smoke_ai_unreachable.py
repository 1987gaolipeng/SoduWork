# -*- coding: utf-8 -*-
"""Offline missing-Runner regression tests: tolerate transient status loss, clear recovered misses,
and fail persistently missing AI execution as infrastructure after a bounded grace period.
Verify retry remains available without permanent running state.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-ai-unreachable.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

import sqlalchemy as sa  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import workflow_contracts, workflow_engine  # noqa: E402

ok = fail = 0
OFFLINE = {"ok": False, "error": "这条活所在的执行机不在线"}
ALIVE = {"ok": True, "status": "running", "running": True, "done": False}


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


WORKFLOW = {"nodes": [{"key": "impl", "type": "ai",
                       # Infrastructure failure must not activate a configured business rework path.
                       # Executor repair does not require code regeneration.
                       "config": {"onFailure": {"retryFrom": "impl", "maxRounds": 2}}}]}


async def _poll(reply, run_id="run-au", node_id="n-impl"):
    """Poll once with the supplied status response and return node and run state."""
    workflow_engine.ai_exec.status_sync = lambda cfg, ref: dict(reply)
    async with SessionLocal() as s:
        run = await s.get(am.WorkflowRun, run_id)
        nr = await s.get(am.NodeRun, node_id)
        await workflow_engine._poll_node(s, run, nr)
        await s.commit()
        await workflow_engine._schedule(s, run)
        await s.commit()
    async with SessionLocal() as s:
        return await s.get(am.NodeRun, node_id), await s.get(am.WorkflowRun, run_id)


async def _kill(run_id, node_id):
    """Accumulate enough misses and expire the grace period to reach terminal missing-status
    handling.
    """
    for _ in range(workflow_engine._AI_UNREACHABLE_MIN_POLLS):
        await _poll(OFFLINE, run_id, node_id)
    await _backdate(run_id, node_id, workflow_engine._AI_UNREACHABLE_GRACE_S + 60)
    return await _poll(OFFLINE, run_id, node_id)


def _backdate(run_id, node_id, seconds):
    """Move the first-miss timestamp backward to simulate elapsed grace time."""
    async def go():
        async with SessionLocal() as s:
            run = await s.get(am.WorkflowRun, run_id)
            context = dict(run.context or {})
            marks = dict(context.get("aiUnreachable") or {})
            mark = dict(marks.get(node_id) or {})
            mark["since"] = float(mark.get("since") or 0) - seconds
            marks[node_id] = mark
            context["aiUnreachable"] = marks
            run.context = context
            await s.commit()
    return go()


async def main():
    await init_db()
    real_load, real_status = workflow_engine.ai_exec.load, workflow_engine.ai_exec.status_sync

    async def fake_load(session, **kw):
        return {}
    workflow_engine.ai_exec.load = fake_load
    try:
        async with SessionLocal() as s:
            s.add(models.Client(id="c-au", name="机"))
            s.add(models.Task(id="t-au", title="掉线的活", status="doing",
                              owner_client_id="c-au"))
            s.add(am.PluginVersion(id="pv-au", plugin_id="pl-au", version="1", checksum="x",
                                   trust_state="approved", workflow=WORKFLOW))
            s.add(am.WorkflowRun(id="run-au", task_id="t-au", plugin_id="pl-au",
                                 plugin_version_id="pv-au", binding_id="b", state="running"))
            s.add(am.NodeRun(id="n-impl", run_id="run-au", node_key="impl", node_type="ai",
                             attempt=1, state="running", idempotency_key="run-au:impl:1",
                             started_at=workflow_engine._now(),
                             executor={"provider": "runner", "ref": "ref-au",
                                       "runnerId": "r-au"}))
            await s.commit()

        # One missing response remains within restart tolerance.
        nr, run = await _poll(OFFLINE)
        chk("读不到状态一次不判死", nr.state == "running" and run.state == "running",
            (nr.state, run.state))
        marks = workflow_engine._unreachable_marks(run)
        chk("但已经开始记账（记了次数和从什么时候起）",
            int((marks.get("n-impl") or {}).get("polls") or 0) == 1
            and float((marks.get("n-impl") or {}).get("since") or 0) > 0, marks)

        # A successful response resets previous misses.
        nr, run = await _poll(ALIVE)
        chk("★又读到了就清账（抖动不累加）",
            not workflow_engine._unreachable_marks(run).get("n-impl")
            and nr.state == "running", workflow_engine._unreachable_marks(run))

        # Enough misses without elapsed grace still waits.
        for _ in range(4):
            nr, run = await _poll(OFFLINE)
        chk("次数够了但没超宽限期，仍然不判死", nr.state == "running", nr.state)

        # Expired grace with repeated misses fails the attempt.
        await _backdate("run-au", "n-impl", workflow_engine._AI_UNREACHABLE_GRACE_S + 60)
        nr, run = await _poll(OFFLINE)
        chk("★超过宽限期就判死，不再永久 running", nr.state == "failed", nr.state)
        chk("失败类别是 infrastructure（修复在执行机上）",
            workflow_contracts.failure_output("infrastructure")["failureKind"]
            == str(dict(nr.output or {}).get("failureKind") or ""), nr.output)
        chk("错话说清了是执行机的事、下一步点什么",
            "执行机" in (nr.error or "") and "重试这一关" in (nr.error or ""), nr.error)

        # Verify the explicit recovery path is available.
        chk("★run 落到 failed —— retry-gate 的前置条件（原来必 409）",
            run.state == "failed", run.state)
        async with SessionLocal() as s:
            rows = list((await s.execute(
                sa.select(am.NodeRun).where(
                    am.NodeRun.run_id == "run-au"))).scalars().all())
        chk("★infrastructure 不回卷：没有凭空多出一次 implement 重跑",
            len(rows) == 1 and rows[0].attempt == 1, [(r.node_key, r.attempt) for r in rows])
        async with SessionLocal() as s:
            events = list((await s.execute(
                sa.select(am.WorkflowEvent).where(
                    am.WorkflowEvent.run_id == "run-au",
                    am.WorkflowEvent.kind == "node.execution_lost"))).scalars().all())
        chk("留了一条 node.execution_lost 证据", len(events) == 1, events)
        chk("判死后把记账清掉了（别留垃圾）",
            not workflow_engine._unreachable_marks(run).get("n-impl"),
            workflow_engine._unreachable_marks(run))

        # Verify nodes with configured retry attempts.
        # Infrastructure failures may recover through another bounded attempt.
        # After retries are exhausted, fail the run rather than leaving it running forever.
        async with SessionLocal() as s:
            s.add(models.Task(id="t-r", title="会重试的活", status="doing",
                              owner_client_id="c-au"))
            s.add(am.PluginVersion(id="pv-r", plugin_id="pl-r", version="1", checksum="x",
                                   trust_state="approved", workflow={"nodes": [
                                       {"key": "impl", "type": "ai",
                                        "retry": {"maxAttempts": 2}}]}))
            s.add(am.WorkflowRun(id="run-r", task_id="t-r", plugin_id="pl-r",
                                 plugin_version_id="pv-r", binding_id="b", state="running"))
            s.add(am.NodeRun(id="n-r1", run_id="run-r", node_key="impl", node_type="ai",
                             attempt=1, state="running", idempotency_key="run-r:impl:1",
                             started_at=workflow_engine._now(),
                             executor={"provider": "runner", "ref": "ref-r", "runnerId": "r-au"}))
            await s.commit()

        nr, run = await _kill("run-r", "n-r1")
        async with SessionLocal() as s:
            rows = sorted((await s.execute(sa.select(am.NodeRun).where(
                am.NodeRun.run_id == "run-r"))).scalars().all(), key=lambda r: r.attempt)
        chk("配了重试的关口：第一次掉线换来一次新尝试，run 还在跑",
            nr.state == "failed" and run.state == "running" and len(rows) == 2
            and rows[1].attempt == 2 and rows[1].state == "queued",
            (nr.state, run.state, [(r.attempt, r.state) for r in rows]))

        async with SessionLocal() as s:
            row = await s.get(am.NodeRun, rows[1].id)
            row.state, row.started_at = "running", workflow_engine._now()
            row.executor = {"provider": "runner", "ref": "ref-r2", "runnerId": "r-au"}
            await s.commit()
        nr2, run2 = await _kill("run-r", rows[1].id)
        chk("★额度用完就落 failed —— 有尽头，不会永远 running",
            nr2.state == "failed" and run2.state == "failed", (nr2.state, run2.state))
    finally:
        workflow_engine.ai_exec.load = real_load
        workflow_engine.ai_exec.status_sync = real_status

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
