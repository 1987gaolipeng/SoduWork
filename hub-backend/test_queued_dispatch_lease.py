"""Exercise acknowledged queue leases with real SQLite transactions and a fixed clock."""
import asyncio
import os
import shutil
import tempfile
import unittest
from copy import copy
from datetime import datetime, timedelta, timezone
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app import automation_models as am
from app import models
from app.api import admin, runner_ws, tasks
from app.db import get_session
from app.deps import current_client, current_user
from app.services import (
    ai_exec,
    ai_remote,
    dispatch_reconcile,
    execution_sessions,
    queued_dispatch,
)
from app.services import queued_dispatch_lease as leases
from test_unified_requirements import _schema_template


class QueueLeaseTests(unittest.IsolatedAsyncioTestCase):
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)

    async def asyncSetUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        db = (Path(directory) / "queue.db").as_posix()
        shutil.copyfile(_schema_template(), db)
        engine = create_async_engine("sqlite+aiosqlite:///" + db)
        self.addAsyncCleanup(engine.dispose)
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)
        self.owner = models.Client(id="owner", secret="test", auth_state="active")
        async with self.sessions() as session:
            session.add(self.owner)
            session.add(models.Task(id="task", title="Queue lease", owner_client_id="owner", status="doing"))
            await session.commit()
        self.runner = SimpleNamespace(id="runner", client_id="owner", boot_id="boot-a", caps=["admit1"],
                                      host="fixture", alive=lambda: True, call=AsyncMock(side_effect=self.reply))
        self.enterContext(patch.object(leases, "SessionLocal", self.sessions))
        self.route = self.enterContext(patch.object(leases.runner_hub, "get", return_value=self.runner))
        self.published = self.enterContext(patch.object(runner_ws, "_publish_session_updates", new_callable=AsyncMock))

    def reply(self, op, data, timeout):
        self.assertEqual(op, "job.has")
        self.assertEqual(data["admissionKey"], "dispatch:" + data["ref"])
        return {"ok": True, "data": {**data, "bootId": self.runner.boot_id, "persisted": True,
                "admissionDurable": True, "has": True, "state": "queued", "queuePosition": 1, "queueClass": "task"}}

    async def seed(self, ref="work", *, state="queued", runner_id="runner", client_id="owner", **meta):
        async with self.sessions() as session:
            session.add(am.ExecutionSession(id=ref, ref=ref, task_id="task", state=state, runner_id=runner_id,
                        runner_client_id=client_id, updated_at=self.start, created_at=self.start,
                        metadata_={"runnerBootId": "boot-a", "queued": True, "queuePosition": 1,
                                   "queueClass": "task", **meta}))
            await session.commit()

    async def row(self, ref="work"):
        async with self.sessions() as session:
            return await session.get(am.ExecutionSession, ref)

    async def sweep(self, seconds, *, connected=()):
        await leases.sweep(now=self.start + timedelta(seconds=seconds), connected=connected)

    async def status_client(self):
        app = FastAPI()
        app.include_router(tasks.router)
        app.include_router(admin.router)

        async def db():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[get_session] = db
        app.dependency_overrides[current_client] = lambda: self.owner
        app.dependency_overrides[current_user] = lambda: SimpleNamespace(is_super=True, _perms={"task.view", "task.dispatch"})
        return await self.enterAsyncContext(httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                                              base_url="http://fixture"))

    async def test_exact_probe_boundary_and_healthy_queue_outlives_lease(self):
        await self.seed(admissionKey="")  # Older snapshots may have an empty turn-correlation field.
        await self.sweep(44.999999)
        self.runner.call.assert_not_awaited()
        for count, seconds in enumerate((45, 90, 135), 1):
            await self.sweep(seconds)
            self.assertEqual(self.runner.call.await_count, count)
            row = await self.row()
            self.assertEqual(row.state, "queued")
            self.assertIsNone(row.started_at)
            self.assertNotIn("queueLeaseStatus", row.metadata_)
            self.assertEqual(datetime.fromisoformat(row.metadata_["queueLeaseCheckedAt"]),
                             self.start + timedelta(seconds=seconds))
        self.published.assert_not_awaited()
        self.route.return_value = None
        await self.sweep(224.999999, connected={self.runner.id})
        self.assertNotIn("queueLeaseStatus", (await self.row()).metadata_)
        await self.sweep(225)
        self.assertEqual((await self.row()).metadata_["queueLeaseStatus"], "unconfirmed")

    async def test_ack_gap_reports_once_at_90s_and_reconnect_clears_it(self):
        await self.seed()
        self.route.return_value = None
        await self.sweep(45)
        # An unsuccessful reconnect probe just before expiry must not postpone the notice.
        await self.sweep(89.999999, connected={self.runner.id})
        self.assertNotIn("queueLeaseStatus", (await self.row()).metadata_)
        await self.sweep(90)
        await self.sweep(135)
        row = await self.row()
        self.assertEqual(row.state, "queued")
        self.assertEqual(leases.status_fields(row.state, row.metadata_),
                         {"queueLeaseStatus": "unconfirmed", "queueLeaseReason": "no_runner_ack"})
        self.assertEqual(self.published.await_count, 1)
        self.runner.boot_id = "boot-b"
        self.route.return_value = self.runner
        await self.sweep(136, connected={self.runner.id})
        row = await self.row()
        self.assertEqual(row.state, "queued")
        self.assertEqual(row.metadata_["runnerBootId"], "boot-b")
        self.assertNotIn("queueLeaseStatus", row.metadata_)
        self.assertNotIn("queueLeaseReason", row.metadata_)
        self.assertEqual(self.published.await_count, 2)
        self.assertEqual(self.runner.call.await_count, 1)

    async def test_scope_excludes_followups_terminal_local_and_wrong_runner_owner(self):
        await self.seed("other-round", round=2)
        await self.seed("other-key", admissionKey="comment:other-key")
        await self.seed("terminal", state="done")
        await self.seed("local", runner_id="backend-local")
        await self.seed("other-owner", client_id="previous-owner")
        await self.seed(admissionKey="dispatch:work")
        await self.sweep(45)
        self.runner.call.assert_awaited_once_with("job.has", {"ref": "work", "admissionKey": "dispatch:work"}, timeout=5)
        for ref in ("other-round", "other-key", "terminal", "local", "other-owner"):
            self.assertNotIn("queueLeaseCheckedAt", (await self.row(ref)).metadata_)

    async def test_probe_in_flight_cannot_rewind_newer_terminal_session(self):
        await self.seed()
        started, resume = asyncio.Event(), asyncio.Event()

        async def slow_probe(*args, **kwargs):
            started.set()
            await resume.wait()
            return self.reply(*args, **kwargs)

        self.runner.call.side_effect = slow_probe
        check = asyncio.create_task(self.sweep(90))
        try:
            await asyncio.wait_for(started.wait(), timeout=5)
            async with self.sessions() as session:
                row = await session.get(am.ExecutionSession, "work")
                row.state = "done"
                row.updated_at = self.start + timedelta(seconds=91)
                await session.commit()
        finally:
            resume.set()
            await check
        row = await self.row()
        self.assertEqual(row.state, "done")
        self.assertNotIn("queueLeaseCheckedAt", row.metadata_)
        self.published.assert_not_awaited()

    async def test_outdated_failure_cannot_overwrite_second_hubs_same_boot_renewal(self):
        await self.seed()
        started, resume = asyncio.Event(), asyncio.Event()

        async def delayed_failure(*args, **kwargs):
            started.set()
            await resume.wait()
            return {"ok": False}

        self.runner.call.side_effect = delayed_failure
        first = asyncio.create_task(self.sweep(91))
        try:
            await asyncio.wait_for(started.wait(), timeout=5)
            self.runner.call.side_effect = self.reply
            await self.sweep(92)
        finally:
            resume.set()
            await first
        saved = (await self.row()).metadata_
        self.assertEqual(datetime.fromisoformat(saved["queueLeaseCheckedAt"]), self.start + timedelta(seconds=92))
        self.assertNotIn("queueLeaseStatus", saved)
        self.published.assert_not_awaited()

    async def test_same_round_queue_heartbeat_cannot_renew_after_start_but_followup_can_queue(self):
        for state in ("starting", "running"):
            await self.seed(state, state=state, round=1, queued=False, admissionKey="dispatch:" + state)
            snapshot = {"ref": state, "taskId": "task", "round": 1, "seq": 0, "state": "queued",
                        "queued": True, "admissionKey": "dispatch:" + state, "turnCorrelationVersion": 1}
            async with self.sessions() as session:
                await execution_sessions.ingest_runner_snapshots(session, self.runner, [snapshot])
                await session.commit()
            row = await self.row(state)
            self.assertEqual(row.state, state)
            self.assertNotIn("queueLeaseCheckedAt", row.metadata_)
            async with self.sessions() as session:
                followup = {**snapshot, "round": 2, "admissionKey": "comment:followup"}
                await execution_sessions.ingest_runner_snapshots(session, self.runner, [followup])
                await session.commit()
            row = await self.row(state)
            self.assertEqual((row.state, row.metadata_["round"]), ("queued", 2))
            self.assertNotIn("queueLeaseCheckedAt", row.metadata_)

    async def test_replaced_connection_only_retains_the_same_process_and_owner_receipt(self):
        for boot, client, principal, positive in (("boot-b", "owner", "", True), ("boot-b", "owner", "", False),
                ("boot-a", "other-client", "", True), ("boot-a", "owner", "new-owner", True),
                ("boot-a", "owner", "", True)):
            with self.subTest(boot=boot, client=client, principal=principal, positive=positive):
                ref = f"{boot}-{client}-{principal}-{positive}"
                await self.seed(ref)
                replacement = copy(self.runner)
                replacement.boot_id, replacement.client_id, replacement.owner_user_id = boot, client, principal
                self.route.return_value = self.runner

                async def reply_after_replacement(*args, **kwargs):
                    self.route.return_value = replacement
                    return self.reply(*args, **kwargs) if positive else {"ok": False}

                self.runner.call.side_effect = reply_after_replacement
                candidate = queued_dispatch.Candidate.from_row(await self.row(ref))
                await leases._check(candidate, self.start + timedelta(seconds=91))
                row = await self.row(ref)
                self.assertEqual(row.state, "queued")
                self.assertNotIn("queueLeaseStatus", row.metadata_)
                self.assertEqual("queueLeaseCheckedAt" in row.metadata_,
                                 boot == "boot-a" and client == "owner" and not principal)

    async def test_both_status_routes_scope_the_offline_lease_to_the_current_attempt(self):
        await self.seed()
        async with self.sessions() as session:
            session.add(models.TaskEvent(task_id="task", kind=ai_exec.EV_DISPATCHED, actor="fixture", at=self.start,
                        detail={"ref": "work", "runnerId": self.runner.id, "attemptId": "first"}))
            await session.commit()
        self.route.return_value = None
        await self.sweep(90)
        http = await self.status_client()
        employee, operator = "/api/v1/tasks/task/ai-status", "/api/v1/admin/tasks/task/ai-status"

        async def both():
            device, admin_result = await asyncio.gather(http.get(employee), http.get(operator))
            self.assertEqual(device.status_code, 200, device.text)
            self.assertEqual(admin_result.status_code, 200, admin_result.text)
            return device.json()["runner"], admin_result.json()

        online = self.enterContext(patch.object(leases.runner_hub, "online", return_value=[]))
        for status in await both():
            self.assertEqual(status.get("queueLeaseReason"), "no_runner_ack", status)
        self.assertEqual((await http.get(employee, params={"ref": "work"})).status_code, 502)

        # Live reads reach the normal remote provider. Only the final Runner transport is a fixture.
        self.route.return_value = self.runner
        online.return_value = [self.runner]
        self.enterContext(patch.dict(ai_remote._WHERE, {"work": self.runner.id}, clear=True))

        def live(_runner, operation, data, timeout):
            self.assertIs(_runner, self.runner)
            self.assertEqual(operation, "job.info")
            return {"ok": True, "data": {"ok": True, "taskStatus": "queued", "state": "queued", "queued": True}}

        transport = self.enterContext(patch.object(leases.runner_hub, "call_sync", side_effect=live))
        for status in await both():
            self.assertTrue(status.get("queued"), status)
            self.assertNotIn("queueLeaseReason", status)
        self.assertCountEqual([call.args[2] for call in transport.call_args_list],
                              [{"ref": "work"}, {"ref": "work", "statusPreview": True}])

        # Late readers must not expose an older queued warning after terminal telemetry.
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, "work")
            row.state = "done"
            await session.commit()
        self.route.return_value = None
        online.return_value = []
        for status in await both():
            self.assertNotIn("queueLeaseReason", status)

        async with self.sessions() as session:
            session.add(models.TaskEvent(task_id="task", kind=ai_exec.EV_DISPATCH_UNCERTAIN, actor="fixture",
                        at=self.start + timedelta(seconds=95), detail={"expectedRef": "next", "attemptId": "second",
                        "runnerId": self.runner.id, "runnerBootId": "boot-a"}))
            await session.commit()
        transport.reset_mock()
        self.route.return_value = self.runner
        online.return_value = [self.runner]
        for age in (89.999999, 90):
            clock = self.start + timedelta(seconds=95 + age)
            with patch.object(dispatch_reconcile, "status_for_uncertain", partial(dispatch_reconcile.status_for_uncertain, now=clock)):
                for status in await both():
                    self.assertEqual(status.get("ref"), "next", status)
                    self.assertEqual(status.get("queueLeaseReason"), "no_runner_ack" if age == 90 else None)
                self.assertEqual((await http.get(employee, params={"ref": "work"})).status_code, 409)
                self.assertEqual((await http.get(employee, params={"ref": "next"})).status_code, 502)
                for path in (employee, operator):
                    self.assertEqual((await http.post(path, json={"ref": "work"})).status_code, 409)
                    self.assertEqual((await http.post(path, json={"ref": "next"})).status_code, 502)
        transport.assert_not_called()

    async def test_queued_heartbeat_renews_lease_while_original_dispatch_reply_is_outstanding(self):
        intent = datetime.now(timezone.utc) - timedelta(seconds=92)
        ref = "awaiting-reply"
        async with self.sessions() as session:
            session.add(models.TaskEvent(task_id="task", kind=ai_exec.EV_DISPATCH_STARTED, actor="fixture",
                        at=intent, detail={"dispatchIntentAt": intent.isoformat(), "awaitingDispatchReply": True,
                        "attemptId": "attempt", "expectedRef": ref, "admissionKey": "dispatch:" + ref,
                        "runnerId": self.runner.id, "runnerClientId": self.runner.client_id,
                        "runnerBootId": self.runner.boot_id}))
            await session.commit()
        async with self.sessions() as session:
            updates = await execution_sessions.ingest_runner_snapshots(session, self.runner, [{
                "ref": ref, "taskId": "task", "round": 1, "state": "queued", "queued": True,
                "admissionKey": "dispatch:" + ref, "turnCorrelationVersion": 1, "queuePosition": 2,
            }])
            await session.commit()
            self.assertEqual(len(updates), 1)
            row = await session.scalar(select(am.ExecutionSession).where(am.ExecutionSession.ref == ref))
            heartbeat_at = datetime.fromisoformat(row.metadata_["queueLeaseCheckedAt"])
            row_id = row.id
        self.route.return_value = None
        self.enterContext(patch.object(leases.runner_hub, "online", return_value=[]))
        http = await self.status_client()
        for seconds in (0, 89.999999, 90):
            now = heartbeat_at + timedelta(seconds=seconds)
            with patch.object(dispatch_reconcile, "status_for_uncertain", partial(dispatch_reconcile.status_for_uncertain, now=now)):
                device, operator = await asyncio.gather(http.get("/api/v1/tasks/task/ai-status"),
                                                       http.get("/api/v1/admin/tasks/task/ai-status"))
            self.assertEqual((device.status_code, operator.status_code), (200, 200))
            for status in (device.json()["runner"], operator.json()):
                self.assertEqual(status.get("queueLeaseReason"), "no_runner_ack" if seconds == 90 else None, status)

        for field, value in (("task_id", "other-task"), ("ref", "previous-attempt"), ("runner_id", "other-runner"),
                             ("runner_client_id", "other-owner"), ("state", "done"), ("round", 2),
                             ("admissionKey", "comment:later-turn")):
            with self.subTest(field=field):
                async with self.sessions() as session:
                    row = await session.get(am.ExecutionSession, row_id)
                    if field in {"round", "admissionKey"}:
                        row.metadata_ = {**row.metadata_, field: value}
                    else:
                        setattr(row, field, value)
                    await session.flush()
                    status = await dispatch_reconcile.status_for_uncertain(session, "task", now=heartbeat_at)
                    self.assertEqual(status.get("queueLeaseReason"), "no_runner_ack", status)

        async with self.sessions() as session:
            candidate, = await dispatch_reconcile.candidates(session, now=heartbeat_at)
            attention_at = heartbeat_at + timedelta(seconds=dispatch_reconcile.ATTENTION_AFTER_SECONDS)
            for offset, expected in ((-1, "pending"), (0, "attention")):
                action, _ = await dispatch_reconcile.apply_probe(
                    session, candidate, {"state": "ambiguous", "reason": "offline"},
                    now=attention_at + timedelta(microseconds=offset))
                self.assertEqual(action, expected)


if __name__ == "__main__":
    unittest.main()
