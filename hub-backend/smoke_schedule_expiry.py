# -*- coding: utf-8 -*-
"""Offline schedule-settlement regression reproducing dispatch rollback and expired ORM objects.
Refresh before outcome processing and isolate each tick so failed settlement cannot leave a
schedule perpetually due and bypass retry limits.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

DB = os.path.abspath(".smoke-sch-expiry.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

import sqlalchemy as sa  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import schedules as sch  # noqa: E402

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
    yesterday = datetime.now(timezone.utc) - timedelta(days=1)
    async with SessionLocal() as s:
        s.add(models.Client(id="c-sx", name="机"))
        s.add(models.AiSchedule(id="s-sx", title="会失败的计划", every="daily",
                                at_hour=9, at_minute=0, time_zone="Asia/Shanghai",
                                owner_client_id="c-sx", assignee_id="a-sx",
                                enabled=True, retry_limit=2, retry_delay_minutes=5,
                                created_at=yesterday))
        await s.commit()

    real_run_one = sch.run_one
    real_apply = sch.apply_outcome
    unloaded_at_apply = []

    def spying_apply(srow, out, now=None):
        # Assert the portable object-state invariant rather than relying on one driver's exact exception.
        # Objects entering apply_outcome must have their required columns loaded.
        # Unloaded attributes would trigger invalid async lazy reads under asyncpg.
        unloaded_at_apply.append(set(sa.inspect(srow).unloaded))
        return real_apply(srow, out, now)

    sch.apply_outcome = spying_apply

    async def failing_run_one(session, srow, who="", schedule_run_id="", conversation_title=""):
        # Reproduce rollback during failed dispatch.
        # Rollback expires objects even with expire_on_commit=False.
        # Refresh them before reading schedule attributes.
        # Commit alone would not reproduce that state with the configured session behavior.
        await session.rollback()
        return {"ok": False, "error": "执行机不在线（模拟）"}

    sch.run_one = failing_run_one
    pushed = []
    from app import realtime
    real_pub = realtime.hub.publish

    async def fake_pub(cid, msg, *, user_id=""):
        pushed.append((cid, msg))
    realtime.hub.publish = fake_pub
    try:
        async with SessionLocal() as s:
            out = await sch.tick(s)
            chk("到点的计划被触发了一次", out.get("checked") == 1, out)
        async with SessionLocal() as s:
            row = await s.get(models.AiSchedule, "s-sx")
            chk("★失败也把 last_run_at 落了库（原来炸 greenlet 后什么都没写）",
                row.last_run_at is not None, row.last_run_at)
            chk("失败原因留在计划上", "执行机" in (row.last_error or ""), row.last_error)
            chk("按 retry 策略排了下一次（5 分钟后），不是下一轮 tick 立刻再跑",
                row.next_retry_at is not None and row.retry_count == 1,
                (row.next_retry_at, row.retry_count))
            runs = list((await s.execute(select(models.AiScheduleRun).where(
                models.AiScheduleRun.schedule_id == "s-sx"))).scalars().all())
            chk("★结算进场时对象已刷新（无 unloaded 列；否则 asyncpg 上炸 greenlet）",
                unloaded_at_apply and not unloaded_at_apply[0],
                unloaded_at_apply and sorted(unloaded_at_apply[0]))
            chk("执行记录结算成 failed（不是永远 starting）",
                len(runs) == 1 and runs[0].state == "failed",
                [(r.state, r.trigger) for r in runs])

        chk("★失败当场推给了人（任务不再静静躺在待办里）",
            len(pushed) == 1 and "没能启动" in (pushed[0][1].get("text") or "")
            and "执行机" in (pushed[0][1].get("text") or ""), pushed)

        # An immediate next tick must not redispatch before its retry time.
        async with SessionLocal() as s:
            out2 = await sch.tick(s)
        async with SessionLocal() as s:
            runs = list((await s.execute(select(models.AiScheduleRun).where(
                models.AiScheduleRun.schedule_id == "s-sx"))).scalars().all())
            chk("★下一轮 tick 不再立刻重跑（重试要等满间隔）——风暴止住",
                len(runs) == 1, [(r.state, r.trigger) for r in runs])

        # Retries occur when due and exhaust the configured budget.
        async with SessionLocal() as s:
            row = await s.get(models.AiSchedule, "s-sx")
            row.next_retry_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await s.commit()
        async with SessionLocal() as s:
            await sch.tick(s)
        async with SessionLocal() as s:
            runs = list((await s.execute(select(models.AiScheduleRun).where(
                models.AiScheduleRun.schedule_id == "s-sx"
            ).order_by(models.AiScheduleRun.started_at))).scalars().all())
            chk("到点的重试真的跑了，并按 retry 记账",
                len(runs) == 2 and runs[-1].trigger == "retry",
                [(r.state, r.trigger) for r in runs])
        chk("同一类失败半天只吵一次（重试失败不再重复推）", len(pushed) == 1, len(pushed))
    finally:
        realtime.hub.publish = real_pub
        sch.run_one = real_run_one
        sch.apply_outcome = real_apply

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
