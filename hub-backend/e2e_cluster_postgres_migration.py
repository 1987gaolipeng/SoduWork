"""Isolated PostgreSQL DDL integration test; only new indexes are rolled back."""
import os
import re
from urllib.parse import urlsplit
url = os.environ.get("DATABASE_URL", "")
parsed = urlsplit(url)
if (parsed.hostname != "127.0.0.1" or parsed.port != 15489
        or not re.fullmatch(r"/\.smoke_cluster_[0-9a-f]{10}", parsed.path)):
    raise SystemExit("Select the isolated cluster fixture database explicitly")
os.environ["CLUSTER_REDIS_URL"] = ""

import asyncio
import json
from alembic import command
from app.db import engine
from app.schema_migrations import _config
from sqlalchemy import text

INDEXES = ("ix_task_owner_state_updated", "ix_task_event_timeline",
           "ix_task_comment_timeline", "ix_workflow_outbox_due",
           "ix_workflow_task_latest", "ix_node_run_attempt",
           "ix_execution_task_latest", "ix_execution_runner_active")


async def facts():
    async with engine.connect() as connection:
        names = list((await connection.execute(text(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' "
            "AND tablename <> 'alembic_version' ORDER BY tablename"
        ))).scalars())
        counts = {}
        for table in names:
            assert re.fullmatch(r"[a-z_]+", table)
            counts[table] = await connection.scalar(text(f'SELECT count(*) FROM "{table}"'))
        indexes = dict((await connection.execute(text(
            "SELECT c.relname, i.indisvalid FROM pg_index i "
            "JOIN pg_class c ON c.oid=i.indexrelid"
        ))).all())
    return counts, indexes


async def main():
    before, _ = await facts()
    await asyncio.to_thread(command.downgrade, _config(), "0036_project_context")
    middle, removed = await facts()
    assert all(name not in removed for name in INDEXES), "Only new indexes are rolled back"
    await asyncio.to_thread(command.upgrade, _config(), "head")
    after, added = await facts()
    assert all(added.get(name) is True for name in INDEXES), "All concurrent indexes are valid"
    await asyncio.to_thread(command.upgrade, _config(), "head")
    repeated, _ = await facts()
    assert before == middle == after == repeated, "Business row counts must not change"
    assert any(before.values()), "Use a populated test fixture, not an empty database"
    print(json.dumps({"passed": True, "indexes": len(INDEXES),
                      "tablesPreserved": len(before),
                      "checks": ["downgrade", "concurrent upgrade", "repeat upgrade", "data preserved"]}))
    await engine.dispose()


asyncio.run(main())
