"""Explicit disposable PostgreSQL regression for NUL-bearing replay events.

Set SODUWORK_EVENT_TEST_POSTGRES_URL to an independently provisioned database
named soduwork_event_test_<12-32 lowercase hex>. Never loads .env or calls a model.
Only this script's random schema is created/dropped; the caller owns the database.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
from pathlib import Path
import re
import sys
from types import SimpleNamespace
import uuid
from unittest.mock import patch

import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool


def checked_url(raw):
    try:
        url = make_url(raw)
    except Exception:
        raise ValueError("An explicit disposable PostgreSQL URL is required") from None
    if (url.drivername != "postgresql+asyncpg" or not url.host or url.query
            or not re.fullmatch(r"soduwork_event_test_[0-9a-f]{12,32}", url.database or "")):
        raise ValueError("Require asyncpg, explicit host, no query overrides, and an event test database")
    return url


async def exercise(url):
    from app import db, models, automation_models as am
    from app.services import execution_sessions as events, runner_event_delivery as delivery
    from app.services.runner_event_outbox import snapshot_digest

    checks = []

    def expect(condition, label):
        if not condition:
            raise AssertionError(label)
        checks.append(label)

    schema = "event_probe_" + uuid.uuid4().hex
    admin = create_async_engine(url, poolclass=NullPool)
    engine = None
    created = False
    runner = SimpleNamespace(id="fixture-runner", boot_id="fixture-boot",
                             client_id="fixture-client", org_id="", host="fixture", version="1")
    try:
        async with admin.begin() as conn:
            expect(await conn.scalar(sa.text("select current_database()")) == url.database,
                   "explicit disposable database")
            await conn.execute(sa.schema.CreateSchema(schema))
            created = True
        engine = create_async_engine(url, connect_args={"server_settings": {
            "search_path": schema, "statement_timeout": "10000", "lock_timeout": "5000"}})
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as conn:
            expect(await conn.scalar(sa.text("select current_schema()")) == schema, "isolated schema")
            await conn.run_sync(db.Base.metadata.create_all)
        async with sessions() as session:
            session.add_all([
                models.Client(id=runner.client_id, auth_state="active"),
                am.RunnerNode(id=runner.id, client_id=runner.client_id, org_id="",
                              auth_state="active", management_state="disabled"),
                models.Task(id="fixture-task", title="Event persistence regression", status="doing",
                            owner_client_id=runner.client_id),
                am.ExecutionSession(task_id="fixture-task", ref="fixture-ref", runner_id=runner.id,
                                    runner_client_id=runner.client_id, state="running", metadata_={"round": 1}),
                models.TaskEvent(task_id="fixture-task", kind="ai.dispatched", actor="fixture",
                                 detail={"ref": "fixture-ref", "runnerId": runner.id}),
            ])
            await session.commit()

        # Establish that the database really rejects the original input, then
        # roll back that transaction before exercising the production boundary.
        async with sessions() as session:
            try:
                await session.execute(sa.text("select cast(:value as text)"), {"value": "bad\x00text"})
            except sa.exc.DBAPIError as error:
                expect("22021" == getattr(error.orig, "sqlstate", None), "PostgreSQL reproduces NUL rejection")
            else:
                raise AssertionError("Database unexpectedly accepted a NUL text parameter")
            await session.rollback()

        snapshot = {"ref": "fixture-ref", "taskId": "fixture-task", "state": "running",
                    "round": 1, "seq": 3, "items": [
                        {"seq": 1, "kind": "out", "text": "first"},
                        {"seq": 3, "kind": "out", "text": "third"}]}
        message = {"version": 1, "runnerId": runner.id, "bootId": runner.boot_id,
                   "ref": snapshot["ref"], "streamId": "a" * 32, "deliverySeq": 1,
                   "snapshot": snapshot, "digest": snapshot_digest(snapshot)}
        async with sessions() as session:
            ack, _ = await delivery.ingest(session, runner, message)
            await session.commit()
            expect(ack["persistedThrough"] == 1, "gap does not advance the replay watermark")

        snapshot["items"] = [{"seq": 2, "kind": "out", "tool": "r" * 119 + "\x00",
            "text": "before\x00after\\u0000\n\t中文", "full": "full\x00output",
            "streamId": "stream\x00id", "callId": "call\x00id", "isError": False,
            "arguments": {"path": "path\x00name"}, "services": [{"name": "service\x00name"}]}]
        message.update(deliverySeq=2, digest=snapshot_digest(snapshot))
        original = copy.deepcopy(message)
        async with sessions() as session:
            ack, _ = await delivery.ingest(session, runner, message)
            await session.commit()
        expect(message == original and ack["digest"] == original["digest"], "original packet and digest unchanged")
        expect(ack["persistedThrough"] == 3, "NUL-bearing missing event closes the gap")
        async with sessions() as session:
            await delivery.ingest(session, runner, message)
            task = await session.get(models.Task, "fixture-task")
            live = {"ok": True, "runnerId": runner.id, "seq": 4, "items": [
                {"seq": 4, "kind": "k" * 31 + "\x00", "text": "live\x00event"}]}
            original_live = copy.deepcopy(live)
            retained = await events.ingest_live_snapshot(session, task, "fixture-ref", live)
            expect(retained is not None, "registered Runner is authorized for live-read sync")
            await session.commit()
            expect(live == original_live, "live-read sync does not mutate Runner input")
        async with sessions() as session:
            row = (await session.scalars(sa.select(am.ExecutionSession))).one()
            stored = (await session.scalars(sa.select(am.ExecutionEvent).order_by(am.ExecutionEvent.seq))).all()
            expect([e.seq for e in stored] == [1, 2, 3, 4] and row.persisted_seq == 4,
                   "delivery replay and live-read sync retain each event once")
            item = stored[1]
            expect(item.text == "before␀after\\u0000\n\t中文" and item.tool == "r" * 119 + "␀",
                   "visible NUL keeps Unicode, whitespace, literal escapes and varchar limits")
            expect(item.detail["full"] == "full␀output"
                   and item.detail["arguments"] == {"path": "path␀name"}
                   and item.detail["services"] == [{"name": "service␀name"}]
                   and item.detail["isError"] is False, "nested display metadata is safely retained")
            expect(stored[3].kind == "k" * 31 + "␀" and row.delivery_digest == original["digest"],
                   "kind limit and transport receipt survive live sync")
            page = await events.read_task(session, task.id, "fixture-ref", contiguous=True)
            expect([e["seq"] for e in page["items"]] == [1, 2, 3, 4] and not page["historyGap"],
                   "client replay reads the repaired contiguous history")
    finally:
        if engine is not None:
            await engine.dispose()
        await db.engine.dispose()
        if created:
            async with admin.begin() as conn:
                await conn.execute(sa.schema.DropSchema(schema, cascade=True))
                expect(await conn.scalar(sa.text("select to_regnamespace(:name)"), {"name": schema}) is None,
                       "fixture schema removed")
        await admin.dispose()
    print(json.dumps({"ok": True, "dialect": "postgresql", "checks": checks, "modelCalls": 0}))


if __name__ == "__main__":
    url = checked_url(os.environ.get("SODUWORK_EVENT_TEST_POSTGRES_URL"))
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.config import Settings
    settings = Settings(_env_file=None, database_url=url.render_as_string(hide_password=False),
                        auth_secret="isolated-event-regression", admin_pass="isolated-event-regression")
    with patch("app.config.get_settings", return_value=settings):
        asyncio.run(exercise(url))
