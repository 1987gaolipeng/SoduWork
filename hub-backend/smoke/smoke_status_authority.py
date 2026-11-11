# -*- coding: utf-8 -*-
"""Regression checks for server-owned task status transitions."""
import asyncio
import os
import re
import sys
import tempfile
from pathlib import Path

_TEMP = tempfile.TemporaryDirectory(prefix="soduwork-status-authority-smoke-")
DB = str(Path(_TEMP.name) / "test.db")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = str(Path(_TEMP.name) / "data")
sys.path.insert(0, ".")

from fastapi import HTTPException  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import task_status, tasks as tsvc, team  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


async def main():
    await init_db()
    async with SessionLocal() as s:
        # Create one engine-owned task and one ordinary task.
        s.add(models.Client(id="c-sa", name="测试机"))
        s.add(models.Task(id="t-run", title="引擎在跑", status="doing", owner_client_id="c-sa"))
        s.add(models.Task(id="t-plain", title="普通活", status="todo", owner_client_id="c-sa"))
        ver = am.PluginVersion(id="pv-sa", plugin_id="p1", version="1", checksum="x",
                               trust_state="approved", enabled=True,
                               workflow={"nodes": [{"key": "n", "type": "ai"}]})
        run = am.WorkflowRun(id="r-sa", task_id="t-run", plugin_id="p1",
                             plugin_version_id="pv-sa", binding_id="b1", state="running")
        s.add_all([ver, run])
        await s.commit()

        t_run = await s.get(models.Task, "t-run")
        t_plain = await s.get(models.Task, "t-plain")

        # Verify task_status.mark authorization.
        chk("① 引擎接管中：非引擎写被拒",
            not await task_status.mark(s, t_run, "done", why="测试"))
        chk("① 拒写后状态没动", t_run.status == "doing", t_run.status)
        chk("① 引擎也不能越过交付门禁",
            not await task_status.mark(s, t_run, "done", engine=True)
            and t_run.status == "doing")
        chk("① 普通任务非引擎写照常放行",
            await task_status.mark(s, t_plain, "doing", why="测试") and t_plain.status == "doing")
        chk("① 非法状态拒写", not await task_status.mark(s, t_plain, "shipped"))
        reason = await task_status.rejection(s, t_run, "done")
        chk("① 拒写原因可解释", reason.get("code") == "engine_managed", reason)
        await s.rollback()

        # Verify public entry points share the same status policy.
        frozen = False
        try:
            await tsvc.update_task(s, "c-sa", "t-run", {"status": "done", "note": "改备注"})
        except HTTPException as exc:
            frozen = exc.status_code == 409
        unchanged = await s.get(models.Task, "t-run")
        chk("② 执行中的需求定义不可改，混合命令不改状态",
            frozen and unchanged.status == "doing" and unchanged.note == "")
        await s.rollback()
        api = await tsvc.update_task(s, "c-sa", "t-run", {
            "status": "done",
            "progress": [{"text": "伪完成", "at": 1}],
        })
        chk("② 客户端状态 PATCH：引擎拥有状态权威",
            api is not None and api["status"] == "doing" and api["note"] == "", api)
        chk("② 拒绝结果返回规范原因",
            api["statusTransition"]["code"] == "engine_managed"
            and api["statusTransition"]["applied"] is False, api)
        chk("② 拒绝完成时不写入伪完成进展",
            not any(x.get("text") == "伪完成" for x in api.get("progress") or []), api)
        progress = await tsvc.update_task(s, "c-sa", "t-run", {
            "progress": [{"text": "补充执行进展", "at": 2}],
        })
        chk("② 定义冻结后仍可独立记录执行进展",
            progress["status"] == "doing" and progress["progress"][0]["text"] == "补充执行进展", progress)
        api2 = await tsvc.update_task(s, "c-sa", "t-plain", {"status": "done"})
        chk("② 普通任务 PATCH 照常改状态",
            api2 is not None and api2["status"] == "done"
            and "statusTransition" not in api2, api2)
        invalid_create = False
        try:
            await tsvc.create_task(s, "c-sa", {"title": "非法初态", "status": "shipped"})
        except HTTPException as exc:
            invalid_create = exc.status_code == 400
        chk("② 创建任务不接受脏状态", invalid_create)
        # Team updates require organization and assignee records, so test the shared status service here.
        # set_team_task_status delegates to task_status.mark in team.py.
        src = open("app/services/team.py", encoding="utf-8").read()
        chk("② 团队面板代改状态走 task_status.mark（源码级）",
            "task_status.mark" in src and "engine_managed" in src)

        # Release status ownership after the run ends.
        run = await s.get(am.WorkflowRun, "r-sa")
        run.state = "succeeded"
        s.add(am.NodeRun(id="nr-sa", run_id=run.id, node_key="n", node_type="ai",
                         attempt=1, state="succeeded", output={},
                         idempotency_key="r-sa:n:1"))
        await s.commit()
        t_run = await s.get(models.Task, "t-run")
        chk("③ run 结束后客户端能改状态了",
            await task_status.mark(s, t_run, "done", why="测试") and t_run.status == "done")
        await s.rollback()

    # Reject new direct status writes that bypass the shared service.
    offenders = []
    pat = re.compile(r'^(?!\s*#).*\.status\s*=\s*["\'](todo|doing|done|cancel)["\']')
    for root, _dirs, files in os.walk("app"):
        for fn in files:
            if not fn.endswith(".py"):
                continue
            path = os.path.join(root, fn)
            rel = os.path.relpath(path, "app").replace("\\", "/")
            if rel in ("services/task_status.py",):
                continue
            for i, line in enumerate(open(path, encoding="utf-8"), 1):
                m = pat.match(line)
                if not m:
                    continue
                # Exclude other entities and constructor defaults from task-transition checks.
                if re.search(r"\b(m|st|outbox|row|run|req|dep|node|nr)\.status\s*=", line) \
                        and "t.status" not in line and "task.status" not in line:
                    continue
                offenders.append(f"{rel}:{i}: {line.strip()[:90]}")
    chk("④ app/ 下没有绕过 task_status 的 Task.status 直写", not offenders, offenders)

    print("\nstatus authority smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


async def run():
    try:
        return await main()
    finally:
        # Close aiosqlite workers while their event loop is still alive.
        await engine.dispose()


try:
    sys.exit(asyncio.run(run()))
finally:
    _TEMP.cleanup()
