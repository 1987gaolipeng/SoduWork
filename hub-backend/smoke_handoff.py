# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-handoff.db")
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
from app.services import ai_exec, handoff  # noqa: E402

ok = fail = 0
STOPPED = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:240] if extra else ""))


async def _load(_session, force=False):
    return {"name": "local", "cfg": {}}


def _stop(_ctx, ref):
    STOPPED.append(ref)
    return {"ok": True}


ai_exec.load = _load
ai_exec.stop_sync = _stop

WORKFLOW = {"nodes": [{"key": "implement", "type": "ai", "name": "改代码"},
                      {"key": "review", "type": "ai_review", "name": "评审",
                       "dependsOn": ["implement"]}]}


async def _seed(tag: str, *, run_state: str = "", node_state: str = "running",
                node_type: str = "ai", dispatched: bool = False):
    async with SessionLocal() as s:
        s.add(models.Client(id="c-" + tag, name="桌宠", user_ref="u1"))
        s.add(models.Task(id="t-" + tag, title="活 " + tag, status="doing",
                          owner_client_id="c-" + tag))
        if dispatched:
            s.add(models.TaskEvent(task_id="t-" + tag, kind=ai_exec.EV_DISPATCHED,
                                   actor="人", detail={"ref": "ref-" + tag,
                                                      "provider": "local"}))
        if run_state:
            s.add(am.Plugin(id="pl-" + tag, key="k-" + tag, name="流程"))
            s.add(am.PluginVersion(id="pv-" + tag, plugin_id="pl-" + tag, version="1",
                                   checksum="c" + tag, trust_state="approved",
                                   workflow=WORKFLOW))
            s.add(am.WorkflowRun(id="run-" + tag, task_id="t-" + tag, plugin_id="pl-" + tag,
                                 plugin_version_id="pv-" + tag, binding_id="b",
                                 state=run_state))
            s.add(am.NodeRun(id="n-" + tag, run_id="run-" + tag, node_key="implement",
                             node_type=node_type, attempt=1, state=node_state,
                             idempotency_key="k-" + tag,
                             executor={"kind": "ai", "ref": "ref-" + tag,
                                       "provider": "runner", "runnerId": "rn-1"}))
        await s.commit()


async def _do(tag: str, note: str = "", status: str = "done"):
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t-" + tag)
        return await handoff.to_human(s, task, status=status, note=note, actor="张三")


async def _task(tag: str):
    async with SessionLocal() as s:
        return await s.get(models.Task, "t-" + tag)


async def main():
    await init_db()

    # Stop active AI execution and finalize handoff.
    STOPPED.clear()
    await _seed("run", run_state="running", node_state="running")
    r = await _do("run", "codex 环境没装好，我线下改")
    task = await _task("run")
    chk("★AI 跑一半也能断：流程结束、执行器被停、任务收成办结",
        r["ok"] and task.status == "done" and "ref-run" in STOPPED
        and r["endedRuns"] and r["endedRuns"][0]["ok"], (r, task.status))
    chk("原因写进任务结论，事后知道为什么是人做的",
        "线下改" in (task.result or ""), task.result)
    async with SessionLocal() as s:
        kinds = [x.kind for x in (await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == "t-run"))).scalars().all()]
        run = await s.get(am.WorkflowRun, "run-run")
        node = await s.get(am.NodeRun, "n-run")
    chk("时间线记一笔 task.handoff（证据不删，只是到此为止）",
        "task.handoff" in kinds, kinds)
    chk("★证据保留：流程记为已结束、节点保留在案（不是删掉）",
        run.state == "cancelled" and node.state == "cancelled", (run.state, node.state))

    # Finalize waiting work even when the executor cannot be reached.
    STOPPED.clear()

    def _boom(_ctx, ref):
        raise RuntimeError("执行机离线")
    ai_exec.stop_sync = _boom
    await _seed("dead", run_state="waiting_external", node_state="waiting_external")
    r = await _do("dead", "执行机连不上了")
    ai_exec.stop_sync = _stop
    chk("★执行机掉线、会话停不掉，照样能收尾（异常不该把人卡住）",
        r["ok"] and (await _task("dead")).status == "done", r)

    # Handle workflows already in failed state.
    await _seed("dead2", run_state="failed", node_state="failed")
    r = await _do("dead2", "这条不修了，线下沟通")
    chk("★流程已经失败也能收尾（不再卡在「只有进行中的流程可以结束」）",
        r["ok"] and (await _task("dead2")).status == "done" and r["endedRuns"] == [], r)

    # Stop and finalize direct AI work without a workflow.
    STOPPED.clear()
    await _seed("plain", dispatched=True)
    r = await _do("plain", "AI 跑偏了，我自己写", status="cancel")
    chk("★直派活（没流程）也能断：AI 会话被停，任务按选的状态收尾",
        r["ok"] and "ref-plain" in STOPPED
        and (await _task("plain")).status == "cancel", (r, STOPPED))

    # Repeated handoff remains idempotent.
    r2 = await _do("plain", "再点一次")
    chk("重复收尾是幂等的（人会手抖点两下）", r2["ok"], r2)

    print("\n%d PASS / %d FAIL" % (ok, fail))
    return fail


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
