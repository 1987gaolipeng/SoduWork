"""Exercise requirement HTTP dispatch with real target authorization and routing.

Only model configuration and the final Runner transport are isolated fixtures.
No live database, model, Runner process, or user workspace is accessed.
"""
import asyncio
import importlib
import os
import sqlite3
import tempfile
import threading
import uuid
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

os.environ.update(DATABASE_URL="sqlite+aiosqlite:///:memory:",
                  AUTH_SECRET="requirement-routing-isolated-test-secret",
                  ADMIN_PASS="requirement-routing-fixture-password")

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models, automation_models as am
from app.api import tasks
from app.db import get_session
from app.deps import current_client
from app.services import (ai_exec, ai_remote, conversation_handoffs, dispatch_attempts,
                          dispatch_identity, dispatch_reconcile, runner_hub, task_dispatch,
                          task_execution_options)
from test_unified_requirements import _schema_template

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class RequirementRemoteDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Clone the complete schema into a private database for each test.
        # Avoid rebuilding every table through the async driver on every case.
        memory_name = "soduwork_remote_dispatch_" + uuid.uuid4().hex
        anchor = sqlite3.connect(f"file:{memory_name}?mode=memory&cache=shared", uri=True)
        self.addCleanup(anchor.close)
        with closing(sqlite3.connect(_schema_template())) as source:
            source.backup(anchor)
        self.engine = create_async_engine(
            f"sqlite+aiosqlite:///file:{memory_name}?mode=memory&cache=shared&uri=true")
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.client = models.Client(id="phone", user_ref="owner", auth_state="active")
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="team", name="Team"),
                models.User(id="owner", username="owner", org_id="team", is_active=True),
                models.User(id="other", username="other", org_id="team", is_active=True),
                self.client,
                models.Client(id="desktop", user_ref="owner", auth_state="active"),
                models.Client(id="other-device", user_ref="other", auth_state="active"),
                models.Task(id="r3", title="Isolated R3", owner_client_id="phone",
                            owner_user_id="owner", status="todo",
                            work_routing={"requiredAgentCapabilities": ["files", "terminal"]}),
                am.RunnerNode(id="cloud", owner_user_id="owner", org_id="team"),
            ])
            await session.commit()
        self.runner = runner_hub._Runner(None, {
            "runnerId": "cloud", "host": "Cloud fixture", "version": "999.0.0",
            "workRoot": "/isolated/runner", "agents": [{"key": "pi", "name": "Pi"}],
            "skills": [], "caps": ["handoff1"],
            "capabilities": {"schemaVersion": 3, "available": ["files", "terminal"]},
        })
        self.runner.owner_user_id = "owner"
        self.runner.org_id = "team"
        self.runner.ready = True
        self.runner.dispatch_mode = "accepting"
        self.runner.alive = lambda: True
        self.calls = []

        def dispatch(cfg, task, files, picked, extra):
            self.calls.append((cfg, picked, extra))
            return {"ok": True, "issueId": dispatch_identity.execution_ref(extra["dispatchId"]),
                    "runnerId": picked["runnerId"], "runnerClientId": picked["clientId"],
                    "host": picked["host"], "assigneeId": picked["id"],
                    "assigneeCli": "pi", "state": "running"}

        async def model(session, client, ctx, *args, **kwargs):
            return ai_exec.with_llm(ctx, {"base": "http://fixture.invalid", "key": "fixture",
                                          "model": "fixture"}), {}

        self.patches = [
            patch.dict(runner_hub._RUNNERS, {"cloud": self.runner}, clear=True),
            patch("app.services.execution_host_policy.get_settings",
                  return_value=type("Settings", (), {"cloud_execution_runner_ids": "",
                                                       "hub_local_execution_enabled": False})()),
            patch("app.realtime.hub.publish", new_callable=AsyncMock),
            patch.object(ai_exec, "load", new=AsyncMock(return_value={
                "provider": "local", "cfg": {"git": {"token": "fixture-git"}},
            })),
            patch("app.services.task_execution_model.prepare", new=model),
            patch.object(ai_exec, "with_project_context",
                         new=AsyncMock(side_effect=lambda session, extra, *args: extra)),
            patch.object(ai_remote, "dispatch_sync", side_effect=dispatch),
            patch.object(task_dispatch, "_attach_skills", new=AsyncMock()),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        app = FastAPI()
        app.include_router(tasks.router)

        async def db():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[get_session] = db
        app.dependency_overrides[current_client] = lambda: self.client
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture")
        self.addAsyncCleanup(self.http.aclose)

    def body(self, **runner_fields):
        return {"assigneeId": "local:pi", "assigneeType": "agent",
                "executionContext": {"strategy": "direct", "agent": {"id": "local:pi"},
                    "location": {"mode": "remote"},
                    "runner": {"mode": "remote", "runnerId": "cloud", **runner_fields}}}

    async def post(self, body=None):
        return await self.http.post("/api/v1/tasks/r3/ai-dispatch", json=self.body() if body is None else body)

    async def test_catalog_cloud_selection_dispatches_exact_runner_once(self):
        async with self.sessions() as session:
            targets = await conversation_handoffs.targets(session, self.client)
        catalog = task_execution_options.substrate_options(
            [{**target, "cli": target["agentId"], "online": True, "remote": True} for target in targets],
            ["files", "terminal"], self.client.id)
        self.assertEqual(len(catalog), 1)
        location = catalog[0]["locations"][0]
        self.assertEqual(location["runnerKind"], "cloud")
        body = self.body(runnerId=location["runnerId"])
        body["assigneeId"] = catalog[0]["key"]
        response = await self.post(body)
        self.assertEqual(response.status_code, 200, response.text)
        again = await self.post(body)
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(again.json()["issueId"], response.json()["issueId"])
        self.assertEqual(len(self.calls), 1)
        cfg, picked, extra = self.calls[0]
        self.assertEqual(picked["id"], "runner:cloud:pi")
        self.assertEqual(cfg["allowedRunners"], ["cloud"])
        self.assertNotIn("git", cfg)
        async with self.sessions() as session:
            executions = list((await session.scalars(select(am.ExecutionSession))).all())
            self.assertEqual([row.runner_id for row in executions], ["cloud"])
            self.assertEqual((await session.get(models.Task, "r3")).status, "doing")

    async def test_default_device_scope_is_unchanged_without_remote_choice(self):
        response = await self.post({"assigneeId": "local:pi", "assigneeType": "agent"})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertFalse(self.calls)

    async def test_lost_ack_recovers_the_exact_admission_without_restarting_it(self):
        from runner_main import Runner

        with tempfile.TemporaryDirectory() as root, patch(
                "app.services.local_base._data_root", return_value=root):
            runtime = Runner("http://fixture", "", "", "cloud", work_root=root)
            journal = runtime._admission._journal
            try:
                def lose_ack(cfg, task, files, picked, extra):
                    ref = dispatch_identity.execution_ref(extra["dispatchId"])
                    accepted, _, _ = runtime._admission.submit(
                        "dispatch:" + ref, ref, "task", "dispatch", {"task": {"id": task.id}})
                    self.assertTrue(accepted)
                    return {"ok": False, "uncertain": True, "runnerId": "cloud",
                            "runnerBootId": runtime.boot_id, "error": "lost ACK"}

                async def read_receipt(op, payload, timeout):
                    self.assertEqual(op, "job.has")
                    self.assertEqual(payload, {"ref": ref, "admissionKey": "dispatch:" + ref})
                    return await runtime._job({"op": op, **payload})

                with patch.object(ai_remote, "dispatch_sync", side_effect=lose_ack) as dispatch, \
                        patch.object(self.runner, "call", side_effect=read_receipt):
                    response = await self.post()
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertTrue(response.json()["pending"])
                    ref = response.json()["issueId"]
                    now = datetime.now(timezone.utc) + timedelta(minutes=1)
                    async with self.sessions() as session:
                        candidate, = await dispatch_reconcile.candidates(session, now=now)
                    observed = await dispatch_reconcile.probe(candidate)
                    # A delayed queued receipt cannot undo a newer heartbeat.
                    for state in ("running", "done"):
                        with self.subTest(heartbeat=state):
                            async with self.sessions() as session:
                                session.add(am.ExecutionSession(task_id="r3", ref=ref,
                                    runner_id="cloud", state=state, metadata_={"queuePosition": 0}))
                                await session.flush()
                                await dispatch_reconcile.apply_probe(session, candidate, observed)
                                row = await session.scalar(select(am.ExecutionSession))
                                self.assertEqual((row.state, row.metadata_["queuePosition"]), (state, 0))
                                await session.rollback()
                    async with self.sessions() as session:
                        await dispatch_reconcile.apply_probe(session, candidate, observed)
                        await session.commit()
                        row = await session.scalar(select(am.ExecutionSession))
                        self.assertEqual((row.state, row.started_at, row.metadata_["queuePosition"],
                                          row.metadata_["queueClass"]), ("queued", None, 1, "task"))
                    repeated = await self.post()
                    self.assertEqual((repeated.json()["issueId"], repeated.json()["state"]), (ref, "queued"))
                    self.assertEqual(dispatch.call_count, 1)
            finally:
                journal.close()

    async def test_already_persisted_queue_heartbeat_recovers_the_http_receipt(self):
        start = dispatch_attempts.start

        async def heartbeat_before_reply(session, task_id, *args, **kwargs):
            attempt = await start(session, task_id, *args, **kwargs)
            session.add(am.ExecutionSession(task_id=task_id, ref=dispatch_identity.execution_ref(attempt),
                runner_id="cloud", state="queued", metadata_={"queuePosition": 2, "queueClass": "task"}))
            await session.flush()
            return attempt

        with patch.object(dispatch_attempts, "start", side_effect=heartbeat_before_reply), \
                patch.object(ai_remote, "dispatch_sync", return_value={
                    "ok": False, "uncertain": True, "runnerId": "cloud", "error": "lost ACK"}):
            response = await self.post()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["pending"])
        self.assertEqual(response.json()["state"], "queued")

    async def test_hub_interrupted_after_routing_reconciles_without_resending(self):
        self.runner.boot_id = "original-boot"
        with patch.object(ai_remote, "dispatch_sync", side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await self.post()
        now = datetime.now(timezone.utc) + timedelta(seconds=91)
        async with self.sessions() as session:
            item, = await dispatch_reconcile.candidates(session, now=now)
            self.assertEqual((item.runner_id, item.runner_boot_id), ("cloud", "original-boot"))
            self.assertEqual(item.detail["admissionKey"], "dispatch:" + item.expected_ref)
            late = await dispatch_reconcile.status_for_uncertain(session, "r3", now=now)
            self.assertEqual(late, {"ref": item.expected_ref, "queueLeaseStatus": "unconfirmed",
                                    "queueLeaseReason": "no_runner_ack"})
            self.assertEqual(await dispatch_reconcile.status_for_uncertain(
                session, "r3", now=now - timedelta(seconds=30)), {"ref": item.expected_ref})
        negative = {"has": False, "persisted": False, "bootId": self.runner.boot_id}
        with patch.object(self.runner, "call", new=AsyncMock(return_value={"ok": True, "data": negative})):
            result = await dispatch_reconcile.probe(item)
        async with self.sessions() as session:
            action, _ = await dispatch_reconcile.apply_probe(session, item, result, now=now)
            self.assertEqual(action, "pending")  # The original send may still be in progress.
            event = await dispatch_reconcile._latest_state(session, "r3")
            self.assertIsNotNone(dispatch_attempts._existing_receipt(
                event, "todo", None, now + timedelta(hours=1)))
        preparing = {**negative, "has": True, "inflight": True, "ref": item.expected_ref,
                     "admissionKey": "dispatch:" + item.expected_ref}
        with patch.object(self.runner, "call", new=AsyncMock(return_value={"ok": True, "data": preparing})):
            result = await dispatch_reconcile.probe(item)
        async with self.sessions() as session:
            await dispatch_reconcile.apply_probe(session, item, result, now=now)
            await session.commit()
            self.assertEqual(await dispatch_reconcile.status_for_uncertain(
                session, "r3", now=now + timedelta(seconds=89)), {"ref": item.expected_ref})
            self.assertEqual(await dispatch_reconcile.status_for_uncertain(
                session, "r3", now=now + timedelta(seconds=90)), late)
        positive = {**negative, "has": True, "persisted": True, "ref": item.expected_ref,
                    "admissionKey": "dispatch:" + item.expected_ref, "state": "queued", "queuePosition": 1}
        with patch.object(self.runner, "call", new=AsyncMock(return_value={"ok": True, "data": positive})):
            result = await dispatch_reconcile.probe(item)
        async with self.sessions() as session:
            action, _ = await dispatch_reconcile.apply_probe(session, item, result, now=now)
            await session.commit()
            self.assertEqual(action, "confirmed")
            self.assertEqual(await dispatch_reconcile.status_for_uncertain(session, "r3", now=now), {})
        with patch.object(ai_remote, "dispatch_sync") as resend:
            again = await self.post()
            self.assertEqual((again.json()["issueId"], again.json()["state"]), (item.expected_ref, "queued"))
            resend.assert_not_called()

    async def test_late_rpc_reply_keeps_the_confirmation_from_the_worker(self):
        started = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()

        def late_reply(*_):
            loop.call_soon_threadsafe(started.set)
            if not release.wait(15):
                raise AssertionError("timed out waiting for the read-only receipt")
            return {"ok": False, "uncertain": True, "runnerId": "cloud", "error": "lost ACK"}

        with patch.object(ai_remote, "dispatch_sync", side_effect=late_reply) as send:
            request = asyncio.create_task(self.post())
            try:
                await asyncio.wait_for(started.wait(), 10)
                now = datetime.now(timezone.utc) + timedelta(seconds=91)
                async with self.sessions() as session:
                    item, = await dispatch_reconcile.candidates(session, now=now)
                    await dispatch_reconcile.apply_probe(session, item, {"state": "confirmed",
                        "receipt": {"state": "queued", "queuePosition": 3, "queueClass": "task"}}, now=now)
                    await session.commit()
            finally:
                release.set()
            reply = await request
            self.assertEqual((reply.json()["state"], reply.json()["queuePosition"]), ("queued", 3))
            send.assert_called_once()
        async with self.sessions() as session:
            events = (await session.scalars(select(models.TaskEvent.kind).where(
                models.TaskEvent.kind.in_(ai_exec.KINDS_DISPATCH_STATE)))).all()
            self.assertCountEqual(events, [ai_exec.EV_DISPATCH_STARTED, ai_exec.EV_DISPATCHED])

    async def test_offline_selected_target_never_falls_back_to_another_runner(self):
        async with self.sessions() as session:
            session.add(am.RunnerNode(id="alternative", client_id="desktop", org_id="team"))
            await session.commit()
        self.runner.id = "alternative"
        self.runner.owner_user_id = ""
        self.runner.client_id = "desktop"
        self.runner.tags = [runner_hub.CLIENT_TAG]
        with patch.dict(runner_hub._RUNNERS, {"alternative": self.runner}, clear=True):
            async with self.sessions() as session:
                targets = await conversation_handoffs.targets(session, self.client)
                self.assertEqual([row["id"] for row in targets], ["runner:alternative:pi"])
            response = await self.post()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertFalse(self.calls)

    async def test_ownership_change_after_catalog_read_is_rejected(self):
        async with self.sessions() as session:
            self.assertTrue(await conversation_handoffs.targets(session, self.client))
            row = await session.get(am.RunnerNode, "cloud")
            row.owner_user_id = "other"
            await session.commit()
        response = await self.post()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertFalse(self.calls)

    async def test_peer_desktop_owned_by_same_account_is_authorized(self):
        async with self.sessions() as session:
            row = await session.get(am.RunnerNode, "cloud")
            row.owner_user_id = None
            row.client_id = "desktop"
            await session.commit()
        self.runner.owner_user_id = ""
        self.runner.client_id = "desktop"
        self.runner.tags = [runner_hub.CLIENT_TAG]
        response = await self.post(self.body(clientId="desktop"))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.calls[0][1]["clientId"], "desktop")

    async def test_conflicting_location_and_agent_are_rejected(self):
        bodies = [self.body(), self.body(), self.body(clientId="other-device")]
        bodies[0]["executionContext"]["location"]["mode"] = "local"
        bodies[1]["assigneeId"] = "runner:other:pi"
        for body in bodies:
            with self.subTest(body=body):
                response = await self.post(body)
                self.assertEqual(response.status_code, 409, response.text)
        self.assertFalse(self.calls)

    async def test_missing_task_capability_is_rejected(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "r3")
            task.work_routing = {"requiredAgentCapabilities": ["files", "terminal", "browser"]}
            await session.commit()
        response = await self.post()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertFalse(self.calls)


if __name__ == "__main__":
    unittest.main()
