"""Backend-managed automation template contract smoke."""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

_db = Path('.smoke-automation-templates.db')
for _suffix in ('', '-shm', '-wal'):
    try:
        (_db.parent / (_db.name + _suffix)).unlink()
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + _db.as_posix()
sys.path.insert(0, ".")

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.services import automation_templates  # noqa: E402


async def main() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with SessionLocal() as session:
        items = await automation_templates.save(session, [{
            "id": "daily-report", "name": "团队日报", "description": "每天整理进展",
            "title": "每日工作总结", "note": "汇总今天的任务、风险和明日计划。",
            "every": "daily", "atHour": 18, "atMinute": 30,
            "requiredCapabilities": ["office"], "retryLimit": 3,
        }])
        await session.commit()
        assert items[0]["id"] == "daily-report"
        assert items[0]["requiredCapabilities"] == ["office"]
        assert (await automation_templates.enabled(session))[0]["name"] == "团队日报"
        try:
            await automation_templates.save(session, [{"id": "bad id", "name": "坏模板"}])
        except ValueError:
            pass
        else:
            raise AssertionError("invalid template id must be rejected")
    await engine.dispose()


try:
    asyncio.run(main())
finally:
    for _suffix in ('', '-shm', '-wal'):
        try:
            (_db.parent / (_db.name + _suffix)).unlink()
        except FileNotFoundError:
            pass
print("automation templates: 4 checks passed")
