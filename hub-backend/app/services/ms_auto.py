"""Public module behavior and service contracts."""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models

log = logging.getLogger("uvicorn.error")

AUTO_NOTE = "自动模式：这一轮跑完且没报错，按计划自动进入下一条（未经人工验收）"


async def _client_of(session: AsyncSession, t) -> models.Client | None:
    cid = getattr(t, "owner_client_id", None)
    return await session.get(models.Client, cid) if cid else None


async def step_task(session: AsyncSession, t) -> dict:
    """Advance an automatic task by one step and return an action summary."""
    from fastapi import HTTPException

    from ..api import tasks as tapi
    from . import ai_exec
    rows = (await session.execute(
        select(models.Milestone).where(models.Milestone.task_id == t.id)
        .order_by(models.Milestone.seq))).scalars().all()
    live = [m for m in rows if m.status != "skipped"]
    if not live:
        return {"act": "skip", "why": "还没有里程碑（先出计划、人确认）"}
    if all(m.status == "done" for m in live):
        return {"act": "done", "why": "里程碑都做完了"}
    client = await _client_of(session, t)
    if client is None:
        return {"act": "skip", "why": "这条需求没有持有人（owner_client_id 空）"}

    doing = next((m for m in live if m.status == "doing"), None)
    if doing is not None:
        # Use the same runner.done completion signal as delivery checks.
        ctx = await ai_exec.load(session)
        ref = await tapi._dispatch_ref(session, t.id)
        if not ref:
            return {"act": "skip", "why": "没有执行单"}
        try:
            info = await asyncio.to_thread(ai_exec.runner_info_sync, ctx, ref)
        except Exception:  # noqa: BLE001
            return {"act": "skip", "why": "查不到执行状态，这轮不动它"}
        if not (info or {}).get("done"):
            return {"act": "wait", "why": f"「{doing.title}」还在跑"}
        if (info or {}).get("failed"):
            # Do not automatically approve failed execution; notify the user.
            from .code_delivery import notify_owner
            await notify_owner(session, t, f"自动模式停在「{doing.title}」：这一轮没干成，去看看")
            return {"act": "halt", "why": f"「{doing.title}」这轮失败了，自动模式停手等人"}
        try:
            await tapi.milestone_verdict(t.id, doing.id,
                                        {"pass": True, "note": AUTO_NOTE, "auto": True},
                                        client, session)
        except HTTPException as e:
            return {"act": "skip", "why": f"自动判被拦：{e.detail}"}
        return {"act": "verdict", "why": f"「{doing.title}」自动判过（未经人工验收）"}

    # Start the next milestone only through run_milestone's existing gates.
    try:
        r = await tapi.run_milestone(t.id, {}, client, session)
    except HTTPException as e:
        return {"act": "skip", "why": f"开下一条被拦：{e.detail}"}
    return {"act": "run", "why": f"开跑第 {r.get('idx')}/{r.get('total')} 条"}


async def sweep(session: AsyncSession) -> dict:
    """Advance every task with automatic mode enabled by one step."""
    rows = (await session.execute(
        select(models.Task).where(models.Task.status.in_(("todo", "doing"))))).scalars().all()
    autos = [t for t in rows if bool(getattr(t, "ms_auto", False))]
    out = []
    for t in autos:
        try:
            r = await step_task(session, t)
        except Exception as e:  # noqa: BLE001 - One task failure must not block other tasks.
            await session.rollback()
            r = {"act": "error", "why": f"{type(e).__name__}: {e}"[:160]}
        out.append({"taskId": t.id, "title": t.title, **r})
        if r.get("act") in ("verdict", "run", "halt"):
            log.info("自动模式 · %s：%s", t.title[:24], r.get("why"))
    return {"tasks": len(autos), "steps": out}


async def tick_loop() -> None:
    """Run the background milestone sweep; when no tasks are enabled, perform only the indexed
    eligibility query.
    """
    from ..config import get_settings
    from ..db import SessionLocal
    gap = max(30, int(getattr(get_settings(), "ms_auto_tick_seconds", 90)))
    log.info("里程碑自动模式巡检启动，间隔 %ss（按任务开关，默认关）", gap)
    while True:
        try:
            async with SessionLocal() as session:
                await sweep(session)
        except asyncio.CancelledError:
            log.info("里程碑自动模式巡检停止")
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("自动模式巡检异常：%s", e)
        await asyncio.sleep(gap)
