"""Public module behavior and service contracts."""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models

log = logging.getLogger("uvicorn.error")


async def sweep(session: AsyncSession) -> dict:
    """Import outputs from completed executions that have not yet returned them. pull_artifacts is
    idempotent, so repeated sweeps need no separate processed flag.
    """
    from . import ai_exec

    rows = (await session.execute(
        select(models.Task).where(models.Task.status.in_(("todo", "doing"))))).scalars().all()
    if not rows:
        return {"checked": 0, "pulled": 0}
    ctx = await ai_exec.load(session)
    if not ai_exec.configured(ctx):
        return {"checked": 0, "pulled": 0, "skipped": "AI 执行没配好"}

    checked = pulled = 0
    for t in rows:
        ev_row = await ai_exec.last_dispatch_event(session, t.id)
        if ev_row is None:
            continue
        ref = (ev_row.detail or {}).get("ref") or (ev_row.detail or {}).get("issueId", "")
        if not ref:
            continue
        try:
            info = await asyncio.to_thread(ai_exec.runner_info_sync, ctx, ref)
        except Exception:                      # noqa: BLE001 - Skip failed status probes without aborting the sweep.
            continue
        if not (info or {}).get("done"):
            continue                           # Wait for execution to finish so partially written outputs are not imported.
        checked += 1
        try:
            s = await asyncio.to_thread(ai_exec.status_sync, ctx, ref)
            if not (s.get("ok") and (s.get("attachments") or s.get("artifactUrl"))):
                continue                       # Executions with only Git commits are handled by the code-delivery sweep.
            out = await ai_exec.pull_artifacts(session, t.id, ctx, s, ref)
            if out.get("files") or out.get("url"):
                pulled += 1
                log.info("产出巡检：把「%s」的产出收回来了（%s 个文件）", t.title, out.get("files"))
        except Exception as e:                 # noqa: BLE001 - One failed task must not stop other imports.
            await session.rollback()
            log.warning("产出巡检失败 %s: %s", t.id, e)
    return {"checked": checked, "pulled": pulled}
