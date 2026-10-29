"""Independent clock for the existing database-owned automation scheduler."""
import asyncio
import logging

log = logging.getLogger("uvicorn.error")


async def tick_loop() -> None:
    """Keep timer work independent of slow or failing delivery/artifact scans.

    The cluster supervisor owns this loop just like the other background jobs.
    schedules.tick retains the authoritative leases and occurrence receipts.
    """
    from ..config import get_settings
    from ..db import SessionLocal
    from . import schedules

    gap = max(60, int(getattr(get_settings(), "delivery_sweep_seconds", 120)))
    log.info("自动化定时调度启动，间隔 %ss", gap)
    while True:
        try:
            async with SessionLocal() as session:
                result = await schedules.tick(session)
            if result.get("fired"):
                log.info("定时派活：触发 %s 条", result["fired"])
        except asyncio.CancelledError:
            log.info("自动化定时调度停止")
            raise
        except Exception:
            log.exception("自动化定时调度异常，下一轮重试")
        await asyncio.sleep(gap)
