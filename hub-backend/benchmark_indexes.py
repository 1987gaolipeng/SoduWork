"""Isolated PostgreSQL index benchmark, applying the actual migration path."""
import asyncio
import json
import os
import statistics
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

url = os.environ.get("BENCHMARK_DATABASE_URL", "")
if "@127.0.0.1:15489/soduwork_cluster_test" not in url:
    raise SystemExit("Only the dedicated loopback benchmark database is permitted")
os.environ["DATABASE_URL"] = url
os.environ["DB_MIGRATION_MODE"] = "auto"
from sqlalchemy import insert, select, text
from app import models
from app.db import SessionLocal, engine, init_db

QUERY = ("SELECT id,kind,detail,at FROM task_event "
         "WHERE task_id='benchmark-task-000750' ORDER BY at DESC,id DESC LIMIT 30")

async def measure():
    elapsed = []
    async with SessionLocal() as session:
        plan = await session.scalar(text("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + QUERY))
        for _ in range(51):
            started = time.perf_counter()
            rows = (await session.execute(text(QUERY))).all()
            elapsed.append((time.perf_counter() - started) * 1000)
    return {"p50_ms": round(statistics.median(elapsed[1:]), 3),
            "p95_ms": round(sorted(elapsed[1:])[47], 3),
            "ids": [row.id for row in rows], "plan": plan}

async def main():
    async with SessionLocal() as session:
        exists = await session.get(models.TaskEvent, "benchmark-long-trace-00000")
        if exists is None:
            now = datetime(2026, 9, 8, tzinfo=timezone.utc)
            for batch in range(0, 12000, 500):
                await session.execute(insert(models.TaskEvent), [
                    {"id": f"benchmark-long-trace-{i:05d}",
                     "task_id": "benchmark-task-000750", "kind": "ai.progress",
                     "detail": {"text": "tool output " * 30},
                     "at": now + timedelta(milliseconds=i)}
                    for i in range(batch, batch + 500)])
            await session.commit()
    async with engine.begin() as conn:
        await conn.execute(text("ANALYZE task_event"))
    before = await measure()
    await init_db()
    async with engine.begin() as conn:
        await conn.execute(text("ANALYZE task_event"))
    after = await measure()
    assert before["ids"] == after["ids"]
    report = {"scope": "One long task trace, 12000 additional events; same data on both sides",
              "before": before, "after": after}
    Path(sys.argv[1]).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({phase: {key: value for key, value in result.items()
                             if key in ("p50_ms", "p95_ms")}
                      for phase, result in (("before", before), ("after", after))}))
    await engine.dispose()

asyncio.run(main())
