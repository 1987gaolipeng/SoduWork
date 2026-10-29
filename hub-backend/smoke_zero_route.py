# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

_TEMP = tempfile.TemporaryDirectory(prefix="soduwork-zero-route-smoke-")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (Path(_TEMP.name) / "test.db").as_posix()
os.environ["SODUWORK_DATA_ROOT"] = str(Path(_TEMP.name) / "data")
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import workflow_runs, zero_work_route  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS ", name)
    else:
        fail += 1
        print("  FAIL ", name, " << ", str(extra)[:300])


async def main() -> int:
    await init_db()
    async with SessionLocal() as s:
        s.add_all([
            models.Client(id="c-zr", secret="x"),
            models.Task(id="t-zr", title="做个企业网站", owner_client_id="c-zr"),
            models.Task(id="t-zr-repo", title="改代码", owner_client_id="c-zr",
                        repo_id="repo-1"),
            models.Task(id="t-zr-busy", title="在跑的零活", owner_client_id="c-zr"),
            am.Plugin(id="pl-zr", key="ai-errand", name="AI 零活", enabled=True),
            am.PluginVersion(id="pv-zr", plugin_id="pl-zr", version="1.0.0",
                             checksum="zr", trust_state="approved", enabled=True,
                             workflow={"nodes": [{"key": "work", "type": "ai",
                                                  "config": {"prompt": "干活"}}]}),
            am.PluginBinding(id="pb-zr", plugin_id="pl-zr", version_id="pv-zr",
                             enabled=True),
            am.WorkflowRun(id="run-busy", task_id="t-zr-busy", binding_id="pb-zr",
                           plugin_id="pl-zr", plugin_version_id="pv-zr",
                           state="running"),
        ])
        await s.commit()

    calls: list = []
    real_start = workflow_runs.start

    async def fake_start(session, task, binding, inputs, **kwargs):
        calls.append({"task": task.id, "binding": binding.id, **kwargs})
        return am.WorkflowRun(id="run-zr-1", task_id=task.id, binding_id=binding.id,
                              plugin_id=binding.plugin_id,
                              plugin_version_id=binding.version_id, state="queued")

    workflow_runs.start = fake_start
    try:
        async with SessionLocal() as s:
            task = await s.get(models.Task, "t-zr")
            out = await zero_work_route.try_route(
                s, task, aid="local:pi", model="company/coder",
                brief="做个企业网站", actor_id="u1", actor_name="王振义")
            chk("零活 + 组织已启用插件 → 路由进 ai-errand",
                out is not None and out.get("routedPlugin") == "ai-errand"
                and out.get("identifier") == "run-zr-1", out)
            chk("用户点名的执行机与模型原样带过去",
                calls and calls[0]["execution"] == {"agentKind": "local:pi",
                                                    "model": "company/coder"}
                and calls[0]["instruction"] == "做个企业网站", calls)
            events = list((await s.execute(select(models.TaskEvent).where(
                models.TaskEvent.task_id == "t-zr"))).scalars().all())
            chk("留下 plugin.auto_routed 审计事件",
                any(e.kind == "plugin.auto_routed" for e in events),
                [e.kind for e in events])

        async with SessionLocal() as s:
            repo_task = await s.get(models.Task, "t-zr-repo")
            chk("挂了工程的任务不抢（各有其流程）",
                await zero_work_route.try_route(s, repo_task, aid="local:pi") is None)
            task = await s.get(models.Task, "t-zr")
            chk("小队派活不路由",
                await zero_work_route.try_route(s, task, atype="squad") is None)
            busy = await s.get(models.Task, "t-zr-busy")
            reused = await zero_work_route.try_route(s, busy)
            chk("已有在跑的流程：直接续用不重复起",
                reused is not None and reused.get("reused")
                and reused.get("identifier") == "run-busy", reused)

        async with SessionLocal() as s:
            s.add(models.AppSetting(key=zero_work_route.SETTING_KEY, value="off"))
            await s.commit()
            task = await s.get(models.Task, "t-zr")
            chk("开关 off：一切照旧走直派",
                await zero_work_route.try_route(s, task) is None)
            row = await s.get(models.AppSetting, zero_work_route.SETTING_KEY)
            await s.delete(row)
            await s.commit()

        async def broken_start(session, task, binding, inputs, **kwargs):
            raise ValueError("插件运行前检查未通过：演习")

        workflow_runs.start = broken_start
        async with SessionLocal() as s:
            task = await s.get(models.Task, "t-zr")
            chk("流程起不来：静默退回直派（返回 None）",
                await zero_work_route.try_route(s, task, aid="local:pi") is None)
            events = list((await s.execute(select(models.TaskEvent).where(
                models.TaskEvent.task_id == "t-zr",
                models.TaskEvent.kind == "plugin.route_fallback"))).scalars().all())
            chk("退回时留下 plugin.route_fallback 事件（审计能看到没走成流程的原因）",
                len(events) == 1 and "演习" in str(events[0].detail.get("error")),
                [e.detail for e in events])

        workflow_runs.start = fake_start
        async with SessionLocal() as s:
            binding = await s.get(am.PluginBinding, "pb-zr")
            binding.enabled = False
            await s.commit()
            task = await s.get(models.Task, "t-zr")
            chk("组织没启用（无可用绑定）：治理没点头，不路由",
                await zero_work_route.try_route(s, task) is None)
    finally:
        workflow_runs.start = real_start

    print(f"\nzero route smoke: {ok} passed, {fail} failed")
    return 1 if fail else 0


if __name__ == "__main__":
    async def run():
        try:
            return await main()
        finally:
            # Return all aiosqlite worker threads before closing their loop.
            # Otherwise successful assertions can still leave Python alive.
            await engine.dispose()
    try:
        sys.exit(asyncio.run(run()))
    finally:
        _TEMP.cleanup()
