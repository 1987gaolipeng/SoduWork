"""Stable automation ownership, HTTP isolation and evidence-only migration."""
import importlib
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ.setdefault("AUTH_SECRET", "isolated-schedule-account-test-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-admin-test-password")

import httpx
from fastapi import FastAPI
from sqlalchemy import create_engine, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session
from app import models
from app.api import personal_schedules
from app.db import Base, get_session
from app.deps import current_client
from app.services import schedule_access, schedule_conversations as chats, schedules

for source in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + source.stem)


class OwnershipModels(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.session = Session(self.engine, expire_on_commit=False)
        self.client = models.Client(id="device", user_ref="alice")
        self.other = models.Client(id="other", user_ref="carol")
        self.session.add_all([self.client, self.other])
        self.session.commit()

    def tearDown(self):
        self.session.close()
        self.engine.dispose()

    def test_schedule_and_run_freeze_target_account_and_survive_transfer(self):
        plan = models.AiSchedule(id="plan", owner_client_id="device", created_by="admin", owner_user_id="forged")
        self.session.add(plan)
        self.session.commit()
        self.assertEqual(plan.owner_user_id, "alice")
        run = models.AiScheduleRun(id="run", schedule_id=plan.id, owner_client_id="device", owner_user_id="forged")
        self.session.add(run)
        self.session.commit()
        self.assertEqual(run.owner_user_id, "alice")
        self.client.user_ref = "bob"
        plan.title = "Background update"
        self.session.commit()
        self.assertEqual(plan.owner_user_id, "alice")
        self.assertFalse(schedule_access.is_owner(plan, self.client))
        plan.owner_client_id = "other"
        self.session.commit()
        self.assertEqual(plan.owner_user_id, "carol")
        self.assertEqual((run.owner_client_id, run.owner_user_id), ("device", "alice"))

    def test_inflight_create_and_run_cannot_follow_concurrent_account_or_plan_transfer(self):
        with self.engine.begin() as connection:
            connection.execute(models.Client.__table__.update().where(models.Client.id == "device").values(user_ref="bob"))
        self.session.add(models.AiSchedule(id="race", owner_client_id="device", created_by="alice"))
        with self.assertRaises(models.TaskOwnershipChanged):
            self.session.commit()
        self.session.rollback()
        self.session.refresh(self.client)
        plan = models.AiSchedule(id="plan", owner_client_id="device", created_by="bob")
        self.session.add(plan)
        self.session.commit()
        with self.engine.begin() as connection:
            connection.execute(models.AiSchedule.__table__.update().where(models.AiSchedule.id == plan.id).values(
                owner_client_id="other", owner_user_id="carol"))
        self.session.add(models.AiScheduleRun(id="race-run", schedule_id=plan.id, owner_client_id="device"))
        with self.assertRaises(models.TaskOwnershipChanged):
            self.session.commit()
        self.session.rollback()
        self.assertIsNone(self.session.get(models.AiScheduleRun, "race-run"))

    def test_reinserting_a_rolled_back_occurrence_preserves_its_original_account(self):
        plan = models.AiSchedule(id="plan", owner_client_id="device", created_by="alice")
        self.session.add(plan)
        self.session.commit()
        run = models.AiScheduleRun(id="run", schedule_id=plan.id, owner_client_id="device")
        self.session.add(run)
        self.session.flush()
        self.assertEqual(run.owner_user_id, "alice")
        self.session.rollback()
        plan.owner_client_id = "other"
        self.session.commit()
        self.assertEqual(plan.owner_user_id, "carol")
        self.session.add(run)
        self.session.commit()
        self.assertEqual((run.owner_client_id, run.owner_user_id), ("device", "alice"))

    def test_migration_preserves_delegation_without_claiming_current_login_or_ambiguous_history(self):
        self.session.add_all([models.User(id=uid, username=uid) for uid in ("alice", "bob", "carol", "admin")])
        self.client.user_ref = "bob"
        self.session.commit()
        plans, runs, tasks = models.AiSchedule.__table__, models.AiScheduleRun.__table__, models.Task.__table__
        with self.engine.begin() as connection:
            connection.execute(plans.insert(), [dict(id=name, owner_client_id="device", created_by=creator)
                for name, creator in (("private", "alice"), ("delegated", "admin"), ("unknown", None), ("conflict", "admin"))])
            connection.execute(tasks.insert(), [dict(id=name, owner_client_id="device", owner_user_id=uid)
                for name, uid in (("task-bob", "bob"), ("task-carol", "carol"))])
            connection.execute(runs.insert(), [dict(id=rid, schedule_id=sid, owner_client_id="device", task_id=tid)
                for rid, sid, tid in (("delegated-run", "delegated", "task-bob"),
                    ("conflict-a", "conflict", "task-bob"), ("conflict-b", "conflict", "task-carol"),
                    ("private-run", "private", ""), ("unknown-run", "unknown", ""))])
            connection.execute(runs.insert().values(id="old-device-run", schedule_id="private", owner_client_id="other", task_id=""))
            source = Path(__file__).parent / "migrations/versions/0066_schedule_account_ownership.py"
            spec = importlib.util.spec_from_file_location("schedule_owner_migration", source)
            migration = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(migration)
            migration.migrate_data(connection)
            migration.migrate_data(connection)
            self.assertEqual(dict(connection.execute(select(plans.c.id, plans.c.owner_user_id)).all()),
                {"private": "alice", "delegated": "bob", "unknown": None, "conflict": None})
            self.assertEqual(dict(connection.execute(select(runs.c.id, runs.c.owner_user_id)).all()),
                {"delegated-run": "bob", "conflict-a": "bob", "conflict-b": "carol", "private-run": "alice",
                 "unknown-run": None, "old-device-run": None})


class OwnershipHttp(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add_all([models.User(id="alice", username="alice", is_super=True, is_active=True),
                             models.User(id="bob", username="bob", is_active=True),
                             models.Client(id="device", user_ref="alice", auth_state="active")])
            await session.commit()
            session.add(models.AiSchedule(id="private", title="Alice private", note="Alice confidential input",
                created_by="alice", owner_client_id="device", assignee_id="local:pi"))
            await session.commit()
            session.add(models.AiScheduleRun(id="run", schedule_id="private", owner_client_id="device", state="waiting",
                receipt={"executionMode": chats.PROTOCOL, "conversationInput": {"text": "Alice confidential input"}}))
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(personal_schedules.router, prefix="/api/v1")

        async def db():
            async with self.sessions() as session:
                yield session

        async def authenticated_device():
            async with self.sessions() as session:
                return await session.get(models.Client, "device")

        self.app.dependency_overrides[get_session] = db
        self.app.dependency_overrides[current_client] = authenticated_device
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://isolated")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def login(self, uid):
        async with self.sessions() as session:
            client = await session.get(models.Client, "device")
            client.user_ref = uid
            await session.commit()

    async def test_creation_uses_authenticated_target_and_ignores_supplied_owner(self):
        with patch.object(schedules, "validate_execution", AsyncMock()), \
                patch.object(schedules, "capability_save_blocker", return_value=None):
            response = await self.http.post("/api/v1/schedules", json={"title": "Own", "assigneeId": "local:pi",
                "ownerClientId": "other", "ownerUserId": "bob", "createdBy": "bob"})
        self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as session:
            plan = await session.get(models.AiSchedule, response.json()["id"])
            self.assertEqual((plan.owner_client_id, plan.owner_user_id, plan.created_by), ("device", "alice", "alice"))

    async def test_switch_blocks_every_personal_surface_and_original_login_recovers(self):
        claim = await self.http.post("/api/v1/automation-conversations/run/claim", json={"instanceId": "worker"})
        self.assertEqual(claim.status_code, 200, claim.text)
        await self.login("bob")
        self.assertEqual((await self.http.get("/api/v1/schedules")).json(), [])
        self.assertEqual((await self.http.post("/api/v1/automation-conversations/inbox")).json(), {"items": []})
        attempts = [("GET", "/schedules/private/runs", None), ("PUT", "/schedules/private", {"title": "stolen"}),
                    ("DELETE", "/schedules/private", None), ("POST", "/schedules/private/run", {}),
                    ("POST", "/schedules/preflight", {"scheduleId": "private"}),
                    ("POST", "/automation-conversations/run/claim", {"instanceId": "worker"}),
                    ("POST", "/automation-conversations/run/state", {"instanceId": "worker", "state": "failed"})]
        with patch.object(schedules, "execute_one", AsyncMock()) as execute:
            for method, route, body in attempts:
                response = await self.http.request(method, "/api/v1" + route, **({"json": body} if body is not None else {}))
                self.assertEqual(response.status_code, 404, (route, response.text))
            execute.assert_not_awaited()
        await self.login("alice")
        self.assertEqual([row["id"] for row in (await self.http.get("/api/v1/schedules")).json()], ["private"])
        restored = await self.http.post("/api/v1/automation-conversations/run/claim", json={"instanceId": "worker"})
        self.assertEqual(restored.status_code, 200, restored.text)
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.AiSchedule, "private")).title, "Alice private")
            self.assertEqual((await session.get(models.AiScheduleRun, "run")).state, "waiting")

    async def test_explicit_admin_delegation_and_old_run_history_keep_distinct_accounts(self):
        await self.login("bob")
        async with self.sessions() as session:
            plan = models.AiSchedule(id="delegated", title="Assigned to Bob", created_by="alice", owner_client_id="device")
            session.add(plan)
            await session.commit()
            self.assertEqual(plan.owner_user_id, "bob")
            self.assertTrue(await schedules._account_can_run(session, plan, await session.get(models.Client, "device")))
            # An explicit transfer changes the plan, never historical run ownership.
            await session.execute(models.AiSchedule.__table__.update().where(models.AiSchedule.id == "private").values(owner_user_id="bob"))
            await session.commit()
        ids = [row["id"] for row in (await self.http.get("/api/v1/schedules")).json()]
        self.assertIn("delegated", ids)
        history = await self.http.get("/api/v1/schedules/private/runs")
        self.assertEqual(history.status_code, 200, history.text)
        self.assertEqual(history.json(), {"items": []})
        self.assertEqual((await self.http.post("/api/v1/automation-conversations/run/claim", json={"instanceId": "bob"})).status_code, 404)

    async def test_unattributed_history_never_becomes_the_next_logged_in_accounts_property(self):
        await self.login(None)
        async with self.sessions() as session:
            plan = models.AiSchedule(id="legacy", owner_client_id="device", assignee_id="local:pi")
            session.add(plan)
            await session.commit()
            self.assertIsNone(plan.owner_user_id)
            session.add(models.AiScheduleRun(id="legacy-run", schedule_id=plan.id, owner_client_id="device", state="waiting",
                receipt={"executionMode": chats.PROTOCOL, "conversationInput": {"text": "legacy"}}))
            await session.commit()
        await self.login("bob")
        self.assertEqual((await self.http.get("/api/v1/schedules")).json(), [])
        self.assertEqual((await self.http.post("/api/v1/automation-conversations/inbox")).json(), {"items": []})
        self.assertEqual((await self.http.post("/api/v1/automation-conversations/legacy-run/claim", json={"instanceId": "bob"})).status_code, 404)
        async with self.sessions() as session:
            result = await schedules.run_one(session, await session.get(models.AiSchedule, "legacy"))
            self.assertEqual(result["code"], "SCHEDULE_OWNER_CHANGED")


if __name__ == "__main__":
    unittest.main()
