"""Exercise the real authenticated integration API against an isolated SQLite database."""
import asyncio
from collections import Counter
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.update(AUTH_SECRET="isolated-stability-load-secret", DATABASE_URL="sqlite+aiosqlite:///:memory:",
                  CLUSTER_REDIS_URL="", ADMIN_PASS="isolated-stability-load-password")

import httpx
from fastapi import FastAPI
from sqlalchemy import event, insert
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models
from app.api import admin
from app.auth import sign_token
from app.db import Base, get_session


async def main():
    with tempfile.TemporaryDirectory(prefix="soduwork-integration-load-") as temporary:
        engine = create_async_engine("sqlite+aiosqlite:///" + str(Path(temporary, "load.sqlite")))
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with sessions() as session:
                session.add(models.User(id="fixture-admin", username="fixture-admin", is_super=True, is_active=True))
                session.add_all([models.Integration(id=str(i), name="Fixture " + str(i), type="generic",
                    ingest_token="fixture-token-" + str(i)) for i in range(1000)])
                await session.commit()
                expected = Counter()
                for start in range(0, 100000, 1000):
                    rows = [{"id": "task-" + str(i), "title": "Isolated load data", "integration_id": str(i % 999)}
                            for i in range(start, start + 1000)]
                    expected.update(row["integration_id"] for row in rows)
                    await session.execute(insert(models.Task), rows)
                await session.commit()
            app = FastAPI()
            app.include_router(admin.router)

            async def isolated_session():
                async with sessions() as session:
                    yield session
            app.dependency_overrides[get_session] = isolated_session
            queries = []

            def record(_connection, _cursor, sql, _parameters, _context, _many):
                queries.append(sql.split()[0])
            event.listen(engine.sync_engine, "before_cursor_execute", record)
            durations = []
            semaphore = asyncio.Semaphore(10)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                    base_url="http://isolated", headers={"Authorization": "Bearer " + sign_token("fixture-admin")}) as client:
                denied = await client.get("/api/v1/admin/integrations", headers={"Authorization": "Bearer invalid"})
                assert denied.status_code == 401
                queries.clear()

                async def request():
                    async with semaphore:
                        started = time.perf_counter()
                        response = await client.get("/api/v1/admin/integrations")
                        assert response.status_code == 200, response.text
                        rows = response.json()
                        assert len(rows) == 1000
                        assert all(row["taskCount"] == expected[row["id"]] for row in rows)
                        assert all("ingestToken" not in row for row in rows)
                        durations.append((time.perf_counter() - started) * 1000)
                started = time.perf_counter()
                await asyncio.gather(*(request() for _ in range(60)))
                elapsed = time.perf_counter() - started
            assert len(queries) == 180, len(queries)
            result = {"ok": True, "boundary": "Real ASGI routes and authentication; disposable SQLite; no network or production DB",
                "integrations": 1000, "tasks": 100000, "requests": 60, "concurrency": 10,
                "sqlPerRequest": len(queries) / 60, "businessSqlPerRequest": 2,
                "p50Ms": round(statistics.median(durations), 2),
                "p95Ms": round(sorted(durations)[56], 2), "requestsPerSecond": round(60 / elapsed, 2)}
            print(json.dumps(result))
        finally:
            await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
