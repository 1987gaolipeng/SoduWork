# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-runclose.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import workflow_engine  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:260] if extra else ""))


async def main():
    await init_db()
    async with SessionLocal() as s:
        s.add(models.Client(id="c-rc", name="机"))
        # Use a minimal AI-to-tool workflow without publish or deploy_chain nodes.
        s.add(am.PluginVersion(id="pv-rc", plugin_id="pl-rc", version="1", checksum="x",
                               trust_state="approved",
                               workflow={"nodes": [
                                   {"key": "work", "type": "ai"},
                                   {"key": "ping", "type": "tool", "dependsOn": ["work"],
                                    "config": {"tool": "notify", "args": {"message": "m"}}},
                               ]}))
        s.add(models.Task(id="t-rc", title="联动冒烟", status="doing", owner_client_id="c-rc"))
        run = am.WorkflowRun(id="run-rc", task_id="t-rc", plugin_id="pl-rc",
                             plugin_version_id="pv-rc", binding_id="b", state="running")
        s.add(run)
        s.add(am.NodeRun(id="n-w", run_id="run-rc", node_key="work", node_type="ai",
                         attempt=1, state="succeeded", idempotency_key="run-rc:work:1"))
        s.add(am.NodeRun(id="n-p", run_id="run-rc", node_key="ping", node_type="tool",
                         attempt=1, state="succeeded", idempotency_key="run-rc:ping:1"))
        await s.commit()

    async with SessionLocal() as s:
        run = await s.get(am.WorkflowRun, "run-rc")
        await workflow_engine._schedule(s, run)
    async with SessionLocal() as s:
        run = await s.get(am.WorkflowRun, "run-rc")
        task = await s.get(models.Task, "t-rc")
        chk("全节点完成 -> run succeeded", run.state == "succeeded", run.state)
        chk("★没有 publish 节点的插件，run 成功任务也自动办结（新工作流免适配）",
            task.status == "done", task.status)
        chk("完工时间戳盖上", task.actual_end_at is not None)

    # Repeated scheduling after completion remains idempotent.
    async with SessionLocal() as s:
        run = await s.get(am.WorkflowRun, "run-rc")
        await workflow_engine._schedule(s, run)
        task = await s.get(models.Task, "t-rc")
        chk("重复调度幂等（状态不动）", run.state == "succeeded" and task.status == "done")

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
