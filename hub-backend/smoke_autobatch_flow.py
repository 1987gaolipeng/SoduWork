# -*- coding: utf-8 -*-
"""Offline autobatch-to-plugin tests covering approved bindings, source-task milestones, duplicate
prevention, repository concurrency limits, and completion propagation. Use local validation
nodes without AI or external calls and verify cyclic task links terminate safely.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-autobatchflow.db")
SMOKE_PROJECT_NAME = os.environ.get("SMOKE_PROJECT_NAME", "示例社区")
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
from app.services import autobatch, task_status, workflow_engine  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:260] if extra else ""))


def _bug(i, **kw):
    return models.Task(
        id=f"bug-{i}", integration_id="integ-tp", external_id=f"TP-{i}",
        origin="testplat", title=f"茶经第 {i} 页样式错位", note=f"复现：打开第 {i} 页",
        status="todo", owner_client_id="c-owner", repo_id="r-flow",
        project_id="p-flow", **kw)


async def seed():
    await init_db()
    async with SessionLocal() as s:
        s.add(models.Client(id="c-owner", name="负责人桌宠"))
        s.add(models.Project(id="p-flow", name=SMOKE_PROJECT_NAME, owner_user_id="u1"))
        # Omit ai_work_dir because a bound delivery plugin resolves its own executor.
        s.add(models.Repo(id="r-flow", project_id="p-flow", name="仿真前端",
                          git_url="https://x/r.git", default_branch="develop",
                          merge_branch="develop"))
        s.add(models.Integration(id="integ-tp", name="测试平台", type="testplat",
                                 ingest_token="ingest_smoke"))
        for i in (1, 2, 3):
            s.add(_bug(i))
        s.add(am.Plugin(id="pl-flow", key="software-delivery", name="交付流程", enabled=True))
        s.add(am.PluginVersion(
            id="pv-flow", plugin_id="pl-flow", version="9.9.9", checksum="x",
            trust_state="approved", enabled=True,
            workflow={"nodes": [{"key": "check", "type": "validate",
                                 "config": {"rules": []}}]}))
        s.add(am.PluginBinding(id="pb-flow", plugin_id="pl-flow", version_id="pv-flow",
                               org_id=None, project_id="p-flow", enabled=True))
        # The unbound control case also lacks ai_work_dir and must explain both missing paths.
        s.add(models.Project(id="p-old", name="老项目", owner_user_id="u1"))
        s.add(models.Repo(id="r-old", project_id="p-old", name="老工程",
                          git_url="https://x/o.git", default_branch="main",
                          merge_branch="main"))
        s.add(models.Task(id="bug-o1", integration_id="integ-tp", external_id="TP-o1",
                          origin="testplat", title="老工程 bug 甲", status="todo",
                          owner_client_id="c-owner", repo_id="r-old", project_id="p-old"))
        s.add(models.Task(id="bug-o2", integration_id="integ-tp", external_id="TP-o2",
                          origin="testplat", title="老工程 bug 乙", status="todo",
                          owner_client_id="c-owner", repo_id="r-old", project_id="p-old"))
        await s.commit()


async def main():
    await seed()

    # Verify grouping and dispatch gates.
    async with SessionLocal() as s:
        groups = await autobatch.group(s)
        g = next((x for x in groups if x["repoId"] == "r-flow"), None)
        chk("攒够 3 条 -> 堆 ready", g is not None and g["ready"], g)
        chk("★绑了交付流程插件：没配 ai_work_dir 也放行（老闸门只管老链路）",
            g is not None and g["flowBindingId"] == "pb-flow"
            and not (g.get("aiWorkDir") or "").strip(), g)
        old = next((x for x in groups if x["repoId"] == "r-old"), None)
        chk("没绑插件也没配目录 -> 说全两样不派",
            old is not None and not old["ready"]
            and "既没绑交付流程插件" in old["reason"], old)

    # Start a real plugin run.
    async with SessionLocal() as s:
        out = await autobatch.run_once(s, dry=False)
        r = next((x for x in out["results"] if x["repoId"] == "r-flow"), None)
        chk("★归堆走插件路径派发成功", r is not None and r.get("dispatched")
            and r.get("flow") and r.get("runId"), r)
        batch_id, run_id = (r or {}).get("batchId", ""), (r or {}).get("runId", "")

    async with SessionLocal() as s:
        batch = await s.get(models.Task, batch_id)
        chk("壳任务建立（标题带条数与工程）",
            batch is not None and "合并修复 3 条" in batch.title, batch and batch.title)
        chk("壳正文逐条带标题与描述（AI 不用凭标题猜）",
            batch is not None and "茶经第 2 页样式错位" in (batch.note or "")
            and "复现：打开第 3 页" in (batch.note or ""))
        ms = list((await s.execute(select(models.Milestone).where(
            models.Milestone.task_id == batch_id))).scalars().all())
        chk("每条源 bug 一条里程碑（src_task_id 挂对）",
            {m.src_task_id for m in ms} == {"bug-1", "bug-2", "bug-3"},
            [m.src_task_id for m in ms])
        evs = list((await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == "bug-1",
            models.TaskEvent.kind == "ai.batched"))).scalars().all())
        chk("源 bug 记 ai.batched（防重键）", len(evs) == 1, len(evs))

        # Advance scheduler and outbox ticks through the actual engine path.
        run = await s.get(am.WorkflowRun, run_id)
        for _ in range(4):
            if run.state in ("succeeded", "failed", "cancelled"):
                break
            await workflow_engine.tick(s)
            await s.refresh(run)
        chk("run 走完（validate 经 tick 执行成功）", run.state == "succeeded", run.state)

    async with SessionLocal() as s:
        batch = await s.get(models.Task, batch_id)
        chk("壳任务被引擎兜底办结", batch is not None and batch.status == "done",
            batch and batch.status)
        bugs = [await s.get(models.Task, f"bug-{i}") for i in (1, 2, 3)]
        chk("★★壳办结 -> 三条源 bug 联动办结（批次回流）",
            all(b is not None and b.status == "done" for b in bugs),
            [b and b.status for b in bugs])
        ev2 = list((await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == "bug-2",
            models.TaskEvent.kind == "ai.batch_done"))).scalars().all())
        chk("回流记 ai.batch_done（带批次号）",
            len(ev2) == 1 and (ev2[0].detail or {}).get("batchId") == batch_id,
            [(x.kind, x.detail) for x in ev2])

    # Verify duplicate prevention and repository concurrency protection.
    async with SessionLocal() as s:
        s.add(_bug(4))
        await s.commit()
        groups = await autobatch.group(s)
        g = next((x for x in groups if x["repoId"] == "r-flow"), None)
        chk("已回流的不再归堆：只剩 1 条新 bug -> 不派",
            g is not None and not g["ready"] and "只有 1 条" in g["reason"], g)
    async with SessionLocal() as s:
        # An unfinished batch with a source task in this repository blocks another batch there.
        s.add(models.Task(id="shell-busy", title="在跑的壳", status="doing",
                          owner_client_id="c-owner", project_id="p-flow"))
        s.add(models.Milestone(task_id="shell-busy", seq=0, title="x", accept="",
                               src_task_id="bug-4"))
        s.add(_bug(5))
        s.add(_bug(6))
        await s.commit()
        groups = await autobatch.group(s)
        g = next((x for x in groups if x["repoId"] == "r-flow"), None)
        chk("同工程并行闸对插件路径照防", g is not None and not g["ready"]
            and "没干完的批次" in g["reason"], g)

    # Verify completion propagation tolerates cyclic batch links.
    async with SessionLocal() as s:
        s.add(models.Task(id="shell-a", title="壳甲", status="doing", owner_client_id="c-owner"))
        s.add(models.Task(id="shell-b", title="壳乙", status="doing", owner_client_id="c-owner"))
        s.add(models.Milestone(task_id="shell-a", seq=0, title="a", accept="", src_task_id="shell-b"))
        s.add(models.Milestone(task_id="shell-b", seq=0, title="b", accept="", src_task_id="shell-a"))
        await s.commit()
        a = await s.get(models.Task, "shell-a")
        okk = await task_status.mark(s, a, "done", engine=True, why="冒烟")
        await s.commit()
        b = await s.get(models.Task, "shell-b")
        chk("互挂成环的壳办结不递归爆栈，两个都收口",
            okk and a.status == "done" and b.status == "done",
            (a.status, b.status))

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
