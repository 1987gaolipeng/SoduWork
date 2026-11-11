# -*- coding: utf-8 -*-
"""Offline persisted-routing tests: dispatch creates the session immediately, lookups use the
latest session, restart warms the cache, and heartbeats update the same authoritative record.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-runroute.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from types import SimpleNamespace  # noqa: E402

from sqlalchemy import select  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import ai_remote, execution_sessions as es  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


async def main():
    await init_db()
    async with SessionLocal() as s:
        s.add(models.Client(id="c-rr", name="归属机"))
        s.add(models.Task(id="t-rr", title="路由冒烟", status="doing", owner_client_id="c-rr"))
        s.add(models.Task(id="t-rr2", title="老活（只有事件）", status="doing", owner_client_id="c-rr"))
        await s.commit()

    # Persist execution at dispatch.
    async with SessionLocal() as s:
        t = await s.get(models.Task, "t-rr")
        await es.record_dispatch(s, t, {"issueId": "ref-rr-1", "runnerId": "runner-a",
                                        "host": "PC-A", "assigneeCli": "pi", "provider": "runner"})
        await s.commit()
    async with SessionLocal() as s:
        row = (await s.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == "ref-rr-1"))).scalar_one_or_none()
        chk("派活那一刻执行单就落库（不等心跳）", row is not None
            and row.runner_id == "runner-a" and row.state == "running"
            and row.engine == "pi" and row.host == "PC-A",
            row and (row.runner_id, row.state, row.engine, row.host))

    # Repeated heartbeats for the same ref update one row.
    async with SessionLocal() as s:
        runner = SimpleNamespace(id="runner-a", client_id="c-rr", host="PC-A")
        await es.ingest_runner_snapshots(s, runner, [{
            "ref": "ref-rr-1", "taskId": "t-rr", "cli": "pi", "status": "running",
            "seq": 2, "items": [],
        }])
        await s.commit()
    async with SessionLocal() as s:
        rows = (await s.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == "ref-rr-1"))).scalars().all()
        chk("心跳同 ref 幂等（仍是一行）", len(rows) == 1, len(rows))
        chk("心跳补水进 ai_remote 缓存", ai_remote._WHERE.get("ref-rr-1") == "runner-a",
            dict(ai_remote._WHERE))

    # The latest execution determines current routing.
    async with SessionLocal() as s:
        route = await es.task_runner_route(s, "t-rr")
        chk("task_runner_route 读到 runner 与 ref",
            route == {"runnerId": "runner-a", "ref": "ref-rr-1", "host": "PC-A"}, route)
    # A new backend-local execution clears the previous remote route.
    async with SessionLocal() as s:
        t = await s.get(models.Task, "t-rr")
        await es.record_dispatch(s, t, {"issueId": "ref-rr-2", "runnerId": "backend-local",
                                        "host": "后端执行机", "assigneeCli": "opencode"})
        await s.commit()
    async with SessionLocal() as s:
        route = await es.task_runner_route(s, "t-rr")
        chk("换回本机后路由回空 runnerId（最新执行单说了算）",
            route["runnerId"] == "" and route["ref"] == "ref-rr-2", route)

    # Use dispatch-event details only for legacy tasks without session rows.
    async with SessionLocal() as s:
        s.add(models.TaskEvent(task_id="t-rr2", kind="ai.dispatched", actor="冒烟",
                               detail={"ref": "ref-old", "issueId": "ref-old",
                                       "runnerId": "runner-b", "host": "PC-B"}))
        await s.commit()
    async with SessionLocal() as s:
        route = await es.task_runner_route(s, "t-rr2")
        chk("老活（只有事件）退回 detail 兜底",
            route == {"runnerId": "runner-b", "ref": "ref-old", "host": "PC-B"}, route)

    # Warm only nonterminal remote routes after restart.
    ai_remote._WHERE.clear()
    async with SessionLocal() as s:
        t = await s.get(models.Task, "t-rr")
        await es.record_dispatch(s, t, {"issueId": "ref-done", "runnerId": "runner-c",
                                        "host": "PC-C", "assigneeCli": "pi"})
        await s.commit()
    async with SessionLocal() as s:
        row = (await s.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == "ref-done"))).scalar_one()
        row.state = "done"
        await s.commit()
    async with SessionLocal() as s:
        n = await es.warm_remote_cache(s)
        chk("预热只灌非终态、非本机的执行单（1 条）", n == 1
            and ai_remote._WHERE.get("ref-rr-1") == "runner-a"
            and "ref-done" not in ai_remote._WHERE
            and "ref-rr-2" not in ai_remote._WHERE,
            (n, dict(ai_remote._WHERE)))

    # Verify obsolete routing guesses are absent.
    from app.services import runner_hub
    chk("runner_hub.runner_of_task（扫 term_subs 猜）已删除",
        not hasattr(runner_hub, "runner_of_task"))
    src = open("app/api/term.py", encoding="utf-8").read()
    chk("term.py 不再自行解析 dispatch 事件找机器",
        "last_dispatch_event" not in src and "task_runner_route" in src)

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    rc = asyncio.run(main())
    sys.exit(1 if rc else 0)
