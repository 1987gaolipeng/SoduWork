# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

DB = os.path.abspath(".smoke-stall.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import workflow_engine  # noqa: E402

ok = fail = 0
pushed = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:260] if extra else ""))


def _ago(hours):
    return datetime.now(timezone.utc) - timedelta(hours=hours)


async def main():
    await init_db()
    async with SessionLocal() as s:
        s.add(models.Client(id="c-sw", name="机"))
        s.add(models.Task(id="t-sw", title="卡住的活", status="doing", owner_client_id="c-sw"))
        s.add(am.PluginVersion(id="pv-sw", plugin_id="pl-sw", version="1", checksum="x",
                               trust_state="approved",
                               workflow={"nodes": [{"key": "gate", "type": "human_review"},
                                                   {"key": "q", "type": "quality"}]}))
        s.add(am.WorkflowRun(id="run-sw", task_id="t-sw", plugin_id="pl-sw",
                             plugin_version_id="pv-sw", binding_id="b", state="running"))
        await s.commit()

    from app import realtime
    real_pub = realtime.hub.publish

    async def fake_pub(cid, msg, *, user_id=None):
        pushed.append((cid, msg))
    realtime.hub.publish = fake_pub
    try:
        # Do not notify after only two hours at a human gate.
        async with SessionLocal() as s:
            s.add(am.NodeRun(id="n-gate", run_id="run-sw", node_key="gate",
                             node_type="human_review", attempt=1, state="waiting_human",
                             idempotency_key="run-sw:gate:1", started_at=_ago(2)))
            await s.commit()
            run = await s.get(am.WorkflowRun, "run-sw")
            n = await workflow_engine._watch_stalled(s, run)
            chk("人工关等 2 小时不吵人", n == 0 and not pushed, (n, pushed))

        # After thirty hours at a human gate, notify with actionable guidance.
        async with SessionLocal() as s:
            row = await s.get(am.NodeRun, "n-gate")
            row.started_at = _ago(30)
            await s.commit()
            run = await s.get(am.WorkflowRun, "run-sw")
            n = await workflow_engine._watch_stalled(s, run)
            text = pushed[0][1]["text"] if pushed else ""
            chk("人工关超一天提醒一次", n == 1 and len(pushed) == 1, (n, pushed))
            chk("提醒里有任务名、等了多久、去哪处理",
                "卡住的活" in text and "30 小时" in text and "人审专区" in text, text)
        async with SessionLocal() as s:
            ev = (await s.execute(select(models.TaskEvent).where(
                models.TaskEvent.task_id == "t-sw",
                models.TaskEvent.kind == "plugin.stalled"))).scalars().all()
            chk("时间线记了 plugin.stalled", len(ev) == 1, ev)

        # Suppress duplicate notifications within half a day.
        pushed.clear()
        async with SessionLocal() as s:
            run = await s.get(am.WorkflowRun, "run-sw")
            n = await workflow_engine._watch_stalled(s, run)
            chk("★提醒过就不再每分钟刷屏", n == 0 and not pushed, (n, pushed))

        # Notify after one hour at a machine gate with machine-specific actions.
        pushed.clear()
        async with SessionLocal() as s:
            s.add(am.NodeRun(id="n-q", run_id="run-sw", node_key="q", node_type="quality",
                             attempt=1, state="waiting_external",
                             idempotency_key="run-sw:q:1", started_at=_ago(3)))
            await s.commit()
            run = await s.get(am.WorkflowRun, "run-sw")
            n = await workflow_engine._watch_stalled(s, run)
            text = pushed[0][1]["text"] if pushed else ""
            chk("机器关 3 小时不动就提醒（比人工关急）", n == 1, (n, pushed))
            chk("机器关提醒给的是机器侧动作（执行机/重试）",
                "执行机" in text and "重试这一关" in text, text)

        # Preserve status so intervention remains a human decision.
        async with SessionLocal() as s:
            row = await s.get(am.NodeRun, "n-gate")
            run = await s.get(am.WorkflowRun, "run-sw")
            task = await s.get(models.Task, "t-sw")
            chk("★只提醒不改状态", row.state == "waiting_human"
                and run.state == "running" and task.status == "doing",
                (row.state, run.state, task.status))
    finally:
        realtime.hub.publish = real_pub

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
