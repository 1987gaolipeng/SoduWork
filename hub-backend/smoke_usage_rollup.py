# -*- coding: utf-8 -*-
"""Offline usage aggregation tests with a temporary database. Persist usage, firstStarted, and
model on local ingest_live_snapshot; sum task usage across follow-up, handoff, and redispatch
sessions; aggregate Runner usage, active load, and time windows while retaining idle registered
Runners.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

DB = os.path.abspath(".smoke-usage.db")
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
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import execution_sessions as es, usage_stats  # noqa: E402

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
    now = datetime.now(timezone.utc)
    async with SessionLocal() as s:
        s.add(models.Client(id="c-u1", name="小张"))
        s.add(models.Task(id="t-u1", title="活一", status="doing", owner_client_id="c-u1"))
        s.add(models.Task(id="t-u2", title="活二", status="doing", owner_client_id="c-u1"))
        s.add(am.RunnerNode(id="rA", client_id="c-u1", host="ZHANG-PC",
                            dispatch_mode="accepting", last_seen_at=now))
        s.add(am.RunnerNode(id="rIdle", client_id="", host="IDLE-PC",
                            dispatch_mode="accepting"))
        await s.commit()

        # Create heartbeat sessions for one completed and one running execution.
        runner = SimpleNamespace(id="rA", client_id="c-u1", host="ZHANG-PC")
        await es.ingest_runner_snapshots(s, runner, [
            {"ref": "run:a1", "taskId": "t-u1", "cli": "pi", "model": "m-big",
             "status": "done", "started": now.timestamp() - 600, "ended": now.timestamp() - 60,
             "usage": {"input": 1000, "output": 200, "steps": 5},
             "firstStarted": now.timestamp() - 600, "seq": 3,
             "items": [{"seq": 1, "kind": "out", "text": "x"}]},
            {"ref": "run:a2", "taskId": "t-u1", "cli": "opencode", "model": "m-big",
             "status": "running", "started": now.timestamp() - 300,
             "usage": {"input": 400, "output": 50, "steps": 2},
             "firstStarted": now.timestamp() - 300, "seq": 1, "items": []},
        ])
        await s.commit()

        # The local read-through path must persist usage, firstStarted, and model.
        t1 = await s.get(models.Task, "t-u1")
        live = {"ok": True, "status": "done", "cli": "pi", "items": [],
                "seq": 2, "started": now.timestamp() - 200, "ended": now.timestamp() - 20,
                "usage": {"input": 300, "output": 80, "steps": 3},
                "firstStarted": now.timestamp() - 200, "workDir": "D:/w"}
        await es.ingest_live_snapshot(s, t1, "local:x1", live, {"model": "m-local"})
        await s.commit()
        row = (await s.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == "local:x1"))).scalars().first()
        meta = dict(row.metadata_ or {})
        chk("★本机读穿把 usage 落进库了（以前漏掉）",
            (meta.get("usage") or {}).get("input") == 300, meta)
        chk("★firstStarted / model 也在",
            meta.get("firstStarted") and row.model == "m-local",
            (meta.get("firstStarted"), row.model))
        chk("本机会话归到 backend-local 名下", row.runner_id == "backend-local", row.runner_id)

        # Exclude the older session outside the thirty-day window.
        old = am.ExecutionSession(task_id="t-u2", ref="run:old", runner_id="rA",
                                  state="done", started_at=now - timedelta(days=40),
                                  finished_at=now - timedelta(days=40),
                                  metadata_={"usage": {"input": 9999, "output": 9999}})
        s.add(old)
        # Add a t-u2 session inside the window.
        await es.ingest_runner_snapshots(s, runner, [
            {"ref": "run:b1", "taskId": "t-u2", "cli": "pi", "status": "done",
             "started": now.timestamp() - 100, "ended": now.timestamp() - 10,
             "usage": {"input": 50, "output": 5, "steps": 1}, "seq": 1, "items": []},
        ])
        await s.commit()

        # Verify task usage totals.
        tu = await usage_stats.task_usage(s, "t-u1")
        chk("任务总账：三条会话求和 input=1700 output=330",
            tu["usage"].get("input") == 1700 and tu["usage"].get("output") == 330, tu["usage"])
        chk("任务总账：会话明细齐（含每条的 usage 与用时）",
            tu["sessionCount"] == 3 and all(x["durationMs"] >= 0 for x in tu["sessions"]))

        # Verify Runner aggregates.
        rows = await usage_stats.runner_usage(s, days=30)
        by_id = {x["runnerId"]: x for x in rows}
        ra = by_id.get("rA") or {}
        chk("rA：窗口内 3 条会话（40 天前那条被排除）", ra.get("sessions") == 3, ra)
        chk("rA：token 求和不含窗口外（1450/255）",
            ra.get("usage", {}).get("input") == 1450 and ra.get("usage", {}).get("output") == 255,
            ra.get("usage"))
        chk("rA：当前负载＝1 条 running", ra.get("running") == 1, ra)
        chk("rA：名字用归属人（装了 SoduWork 的同事）", ra.get("name") == "小张", ra.get("name"))
        chk("rA：按 CLI 细分（pi×2 / opencode×1）",
            (ra.get("byCli", {}).get("pi", {}).get("sessions") == 2 and
             ra.get("byCli", {}).get("opencode", {}).get("sessions") == 1), ra.get("byCli"))
        chk("本机执行占一行（backend-local，token 不蒸发）",
            (by_id.get("backend-local") or {}).get("usage", {}).get("input") == 300,
            by_id.get("backend-local"))
        chk("注册过但没干活的 runner 也占一行、全 0",
            by_id.get("rIdle") is not None and by_id["rIdle"]["sessions"] == 0, by_id.get("rIdle"))

        # Verify accounting boundaries.
        acc = {}
        usage_stats.merge_usage(acc, {"input": "abc", "output": None, "cost": "x"})
        chk("垃圾值不炸也不计数", acc == {}, acc)
        chk("cost 按浮点累加", usage_stats.merge_usage(
            {"cost": 0.1}, {"cost": 0.2}).get("cost") == 0.3)

    print("\nusage rollup smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


async def run():
    try:
        return await main()
    finally:
        await engine.dispose()


sys.exit(asyncio.run(run()))
