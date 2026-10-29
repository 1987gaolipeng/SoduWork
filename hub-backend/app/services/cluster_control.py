"""PostgreSQL session locks for startup and legacy periodic supervisors.

An advisory lock has no wall-clock expiry: another Hub cannot start the same
supervisor merely because a slow tick outlived its lease. Losing the database
connection cancels this process' loops before attempting election again.
"""
import asyncio
import contextlib
import logging

from sqlalchemy import text

from ..db import engine
from .cluster_bus import bus

log = logging.getLogger("uvicorn.error")
_BOOTSTRAP_LOCK = 734836211
_SUPERVISOR_LOCK = 734836212
leader = False


@contextlib.asynccontextmanager
async def bootstrap_lock():
    if not bus.enabled:
        yield
        return
    async with engine.connect() as conn:
        await conn.execute(text("SELECT pg_advisory_lock(:key)"), {"key": _BOOTSTRAP_LOCK})
        await conn.commit()
        try:
            yield
        finally:
            try:
                await conn.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": _BOOTSTRAP_LOCK})
                await conn.commit()
            except BaseException:
                await conn.invalidate()
                raise


async def supervise(factories):
    global leader
    while True:
        jobs = []
        try:
            async with engine.connect() as conn:
                acquired = await conn.scalar(text(
                    "SELECT pg_try_advisory_lock(:key)"), {"key": _SUPERVISOR_LOCK})
                await conn.commit()
                if acquired:
                    leader = True
                    jobs = [asyncio.create_task(factory(), name=name)
                            for name, factory in factories]
                    try:
                        while bus.healthy:
                            await asyncio.sleep(2)
                            await asyncio.wait_for(conn.execute(text("SELECT 1")), 3)
                            await conn.commit()
                            for (name, factory), job in zip(factories, list(jobs)):
                                if job.done() and not job.cancelled() and job.exception():
                                    log.error("Cluster supervisor %s failed: %s",
                                              name, type(job.exception()).__name__)
                                    jobs[jobs.index(job)] = asyncio.create_task(factory(), name=name)
                    finally:
                        leader = False
                        for job in jobs:
                            job.cancel()
                        await asyncio.gather(*jobs, return_exceptions=True)
                        try:
                            await conn.execute(text(
                                "SELECT pg_advisory_unlock(:key)"), {"key": _SUPERVISOR_LOCK})
                            await conn.commit()
                        except BaseException:
                            await conn.invalidate()
                            raise
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("Cluster supervisor election unavailable: %s", type(exc).__name__)
        finally:
            leader = False
        await asyncio.sleep(2)
