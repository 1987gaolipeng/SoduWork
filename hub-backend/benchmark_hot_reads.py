"""Repeatable, isolated AI-team read benchmark. Never accepts a production DB."""
import argparse
import asyncio
import json
import os
import statistics
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
parser.add_argument("--samples", type=int, default=12)
parser.add_argument("--tasks", type=int, default=1500)
args = parser.parse_args()
url = os.environ.get("BENCHMARK_DATABASE_URL", "")
if not url.startswith("postgresql+asyncpg://") or "@127.0.0.1:15489/soduwork_cluster_test" not in url:
    raise SystemExit("Use the dedicated loopback PostgreSQL test container, not a business database.")
os.environ["DATABASE_URL"] = url
from sqlalchemy import event, func, insert, select, text
from app.db import Base, SessionLocal, engine
from app import models, automation_models, project_context_models
from app.api.aidesk import ai_agent_tasks

queries = 0

@event.listens_for(engine.sync_engine, "before_cursor_execute")
def count_queries(*_):
    global queries
    queries += 1

async def main():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with SessionLocal() as session:
        client = await session.get(models.Client, "benchmark-reader")
        if client is None:
            client = models.Client(id="benchmark-reader")
            session.add(client)
            await session.commit()
            now = datetime(2026, 9, 1, tzinfo=timezone.utc)
            await session.execute(insert(models.Task), [
                {"id": f"benchmark-task-{i:06d}", "owner_client_id": client.id,
                 "title": f"Benchmark task {i}", "status": "done" if i % 3 else "doing",
                 "note": "Representative task context " * 40}
                for i in range(args.tasks)])
            for batch in range(0, args.tasks, 100):
                await session.execute(insert(models.TaskEvent), [
                    {"id": f"bench-event-{i:06d}-{j:03d}",
                     "task_id": f"benchmark-task-{i:06d}",
                     "kind": "ai.dispatched" if j % 5 == 0 else "ai.progress",
                     "detail": {"assigneeName": "Pi" if i % 2 else "Codex",
                                "ref": f"ref-{i}-{j}", "assigneeCli": "pi"},
                     "at": now + timedelta(seconds=i * 20 + j)}
                    for i in range(batch, min(batch + 100, args.tasks)) for j in range(20)])
            await session.commit()
        task_count = await session.scalar(select(func.count(models.Task.id)))
        event_count = await session.scalar(select(func.count(models.TaskEvent.id)))
    async with engine.begin() as conn:
        await conn.execute(text("ANALYZE task"))
        await conn.execute(text("ANALYZE task_event"))
    results = {}
    for scope, agent in [("done", ""), ("live", "Pi")]:
        samples, counts = [], []
        result = None
        for _ in range(args.samples + 1):
            global queries
            queries = 0
            begin = time.perf_counter()
            async with SessionLocal() as session:
                result = await ai_agent_tasks(agent=agent, scope=scope, offset=0,
                                             limit=20, client=client, session=session)
            samples.append((time.perf_counter() - begin) * 1000)
            counts.append(queries)
        samples, counts = samples[1:], counts[1:]
        results[f"{scope}:{agent or 'all'}"] = {
            "p50_ms": round(statistics.median(samples), 2),
            "p95_ms": round(sorted(samples)[max(0, int(len(samples) * .95) - 1)], 2),
            "queries": counts, "total": result["total"],
            "ids": [item["id"] for item in result["items"]]}
    async with SessionLocal() as session:
        plan = (await session.execute(text(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM task_event "
            "WHERE task_id='benchmark-task-000750' "
            "ORDER BY at DESC, id DESC LIMIT 30"))).scalar()
    report = {"tasks": task_count, "events": event_count, "samples": args.samples,
              "results": results, "eventTimelinePlan": plan}
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "eventTimelinePlan"}))
    await engine.dispose()

asyncio.run(main())
