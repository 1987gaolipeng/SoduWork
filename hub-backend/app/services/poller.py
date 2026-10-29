"""Incremental integration polling shared by manual and scheduled pulls. Run only enabled scheduled
connectors; a zero interval disables background polling. Execute blocking connector.pull calls
in worker threads, then ingest data and persist cursors.
"""
import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..config import get_settings
from ..connectors import get_connector
from ..db import SessionLocal
from . import aggregation as agg

# Use the server logger so polling diagnostics follow the configured log stream.
log = logging.getLogger("uvicorn.error")


async def pull_integration(session: AsyncSession, integ_or_id) -> dict:
    """Pull one Integration object or ID and return the retrieval and ingestion summary."""
    integ = integ_or_id
    if isinstance(integ_or_id, str):
        integ = await session.get(models.Integration, integ_or_id)
    if integ is None:
        return {"ok": False, "reason": "not_found"}
    if not integ.enabled:
        return {"ok": False, "reason": "disabled"}
    conn = get_connector(integ.type)
    if conn is None or not hasattr(conn, "pull"):
        return {"ok": False, "reason": "no_connector", "type": integ.type}
    iid = integ.id
    try:
        config = dict(integ.config or {})
        # Resolve config.mcpRef through the shared HTTP MCP registry.
        # Reuse centrally configured credentials in the connector's resolved MCP configuration.
        # Retain legacy integration-local configuration as a compatibility fallback.
        ref = str(config.get("mcpRef") or "").strip()
        if ref:
            from . import mcp_servers
            rows = await mcp_servers.load(session)
            hit = next((x for x in rows if x.get("name") == ref
                        and x.get("type") == "http" and x.get("enabled")), None)
            if hit is None:
                raise ValueError(f"集成引用的 MCP「{ref}」不存在/未启用/不是 HTTP 型")
            config["mcp"] = {"url": hit["url"], "headers": dict(hit.get("headers") or {}),
                             "keycloak": dict(hit.get("keycloak") or {})}
        # Move blocking HTTP retrieval to the thread pool.
        envelopes, new_cursor = await asyncio.to_thread(conn.pull, config, integ.cursor or {})
        res = await agg.ingest_many(session, integ, envelopes)
        integ.cursor = new_cursor  # Assign a new dictionary to trigger JSON-column change detection.
        integ.last_pull_at = datetime.now(timezone.utc)
        integ.last_pull_ok = True
        integ.last_pull_error = None
        integ.last_pull_count = len(envelopes)
        await session.commit()
        return {"ok": True, "pulled": len(envelopes), **res}
    except Exception as e:  # noqa: BLE001 - Record integration health and return an observable failure result.
        await session.rollback()
        fresh = await session.get(models.Integration, iid)
        if fresh is not None:
            fresh.last_pull_at = datetime.now(timezone.utc)
            fresh.last_pull_ok = False
            fresh.last_pull_error = str(e)[:500]
            await session.commit()
        log.warning("pull failed for integration %s: %s", iid, e)
        return {"ok": False, "reason": "pull_error", "error": str(e)}


async def run_all(session: AsyncSession) -> dict:
    """Pull each enabled schedulable integration once, isolating failures between integrations."""
    res = await session.execute(
        select(models.Integration).where(models.Integration.enabled.is_(True))
    )
    results = []
    for integ in res.scalars().all():
        conn = get_connector(integ.type)
        if conn is None or not getattr(conn, "scheduled", False):
            continue
        try:
            r = await pull_integration(session, integ)
            results.append({"integration": integ.id, "name": integ.name, **r})
        except Exception as e:  # noqa: BLE001 - Isolate individual integration failures.
            log.warning("pull failed for integration %s (%s): %s", integ.id, integ.name, e)
            results.append({"integration": integ.id, "name": integ.name, "ok": False, "error": str(e)})
    return {"integrations": len(results), "results": results}


async def poller_loop() -> None:
    """Run the lifespan polling loop; exit when POLL_INTERVAL_SECONDS is nonpositive."""
    interval = get_settings().poll_interval_seconds
    if interval <= 0:
        log.info("poller 已禁用（POLL_INTERVAL_SECONDS=0）")
        return
    log.info("poller 启动，间隔 %ss", interval)
    while True:
        try:
            async with SessionLocal() as session:
                out = await run_all(session)
            if out["integrations"]:
                log.info("轮询一轮：%s", out)
        except asyncio.CancelledError:
            log.info("poller 停止")
            raise
        except Exception as e:  # noqa: BLE001 - Keep polling after a single iteration fails.
            log.warning("轮询异常：%s", e)
        await asyncio.sleep(interval)
