"""Automation routers keep authorization views, metadata and legacy imports."""
import importlib
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI, HTTPException
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin, admin_schedules, personal_models, personal_schedules, tasks
from app.auth import sign_token
from app.db import Base, get_session
from app.deps import current_client
from app.services import schedules

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


def route_names(routes):
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            yield from route_names(included.routes)
        else:
            yield route.name


class ScheduleRouterDomainTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="team", name="Team"),
                models.OrgUnit(id="outside", name="Outside"),
                models.Role(id="operator", name="Operator", permissions=["task.dispatch"]),
                models.Role(id="reader", name="Reader", permissions=["task.view"]),
                models.User(id="manager", username="manager", org_id="team", role_id="operator", is_active=True),
                models.User(id="reader", username="reader", org_id="team", role_id="reader", is_active=True),
                models.Client(id="device", user_ref="manager", auth_state="active"),
            ])
            # Ownership snapshots resolve the already enrolled device in the database.
            await session.flush()
            session.add_all([
                models.AiSchedule(id="own", title="Own", owner_client_id="device", org_id="team"),
                models.AiSchedule(id="hidden", title="Hidden", owner_client_id="other", org_id="outside"),
            ])
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(admin.router)
        self.app.include_router(tasks.router)

        async def db():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://isolated")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def request(self, method, path, who="manager", **kwargs):
        headers = {"Authorization": "Bearer " + sign_token(who, 1)} if who else {}
        return await self.http.request(method, "/api/v1/admin" + path, headers=headers, **kwargs)

    async def test_admin_route_order_and_python_aliases(self):
        expected = ["list_automation_templates", "save_automation_templates", "list_all_repos",
                    "list_ai_schedules", "create_ai_schedule", "update_ai_schedule",
                    "delete_ai_schedule", "list_ai_schedule_runs", "run_ai_schedule"]
        names = list(route_names(admin.router.routes))
        start = names.index(expected[0])
        self.assertEqual(names[start:start + len(expected)], expected)
        for name in expected:
            if name != "list_all_repos":
                self.assertIs(getattr(admin, name), getattr(admin_schedules, name))
        schema = self.app.openapi()
        for path, operations in schema["paths"].items():
            if path.startswith("/api/v1/admin/ai-schedules") or path.endswith("/automation-templates"):
                for operation in operations.values():
                    self.assertEqual(operation["tags"], ["admin"])

    async def test_schedule_payloads_keep_admin_identity_private(self):
        async with self.sessions() as session:
            schedule = await session.get(models.AiSchedule, "own")
            personal = tasks._my_sch_api(schedule)
            administrative = admin._sch_api(schedule)
        self.assertEqual(set(administrative) - set(personal), {"ownerClientId", "createdByName"})
        self.assertEqual(personal, {k: v for k, v in administrative.items() if k in personal})
        self.assertEqual(administrative["ownerClientId"], "device")
        self.assertEqual(tasks._iso_utc("invalid"), "")
        with self.assertRaises(AttributeError):
            admin._iso_utc_dt("invalid")

    async def test_every_admin_automation_endpoint_keeps_permission_guard(self):
        paths = [("GET", "/automation-templates"), ("PUT", "/automation-templates"),
                 ("GET", "/ai-schedules"), ("POST", "/ai-schedules"),
                 ("PUT", "/ai-schedules/own"), ("DELETE", "/ai-schedules/own"),
                 ("GET", "/ai-schedules/own/runs"), ("POST", "/ai-schedules/own/run")]
        for method, path in paths:
            with self.subTest(method=method, path=path):
                anonymous = await self.request(method, path, who=None)
                denied = await self.request(method, path, who="reader")
                self.assertEqual(anonymous.status_code, 401, anonymous.text)
                self.assertEqual(denied.status_code, 403, denied.text)

    async def test_admin_scope_and_legacy_patch_surface(self):
        result = await self.request("GET", "/ai-schedules")
        self.assertEqual([row["id"] for row in result.json()], ["own"])
        hidden = await self.request("GET", "/ai-schedules/hidden/runs")
        self.assertEqual(hidden.status_code, 404, hidden.text)
        with patch.object(admin, "_sch_apply", side_effect=HTTPException(400, "patched")) as apply:
            result = await self.request("POST", "/ai-schedules", json={})
        self.assertEqual(result.status_code, 400, result.text)
        apply.assert_called_once()
        denied = AsyncMock(side_effect=HTTPException(404, "patched scope"))
        with patch.object(admin, "_scoped_ai_schedule", denied):
            result = await self.request("GET", "/ai-schedules/own/runs")
        self.assertEqual(result.status_code, 404, result.text)
        denied.assert_awaited_once()

    async def test_run_history_reads_preserve_receipts_without_committing(self):
        async with self.sessions() as session:
            client = await session.get(models.Client, "device")
            session.add(models.AiSchedule(id="personal", title="Personal", owner_client_id="device"))
            await session.flush()
            for sid in ("own", "personal"):
                session.add(models.AiScheduleRun(id=sid, schedule_id=sid, owner_client_id="device",
                                                 task_id="legacy-task", state="running"))
            await session.commit()
        self.app.dependency_overrides[current_client] = lambda: client
        headers = {"Authorization": "Bearer " + sign_token("manager", 1)}
        commits = []
        event.listen(self.engine.sync_engine, "commit", commits.append)
        for path, sid in (("/api/v1/admin/ai-schedules/own/runs", "own"),
                          ("/api/v1/schedules/personal/runs", "personal")):
            with self.subTest(path=path):
                commits.clear()
                for _ in range(2):
                    response = await self.http.get(path, headers=headers)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual([(row["id"], row["state"]) for row in response.json()["items"]],
                                     [(sid, "running")])
                async with self.sessions() as session:
                    run = await session.get(models.AiScheduleRun, sid)
                    self.assertEqual((run.state, run.task_id), ("running", "legacy-task"))
                self.assertEqual(commits, [])

    async def test_admin_history_limit_matches_the_number_of_returned_runs(self):
        async with self.sessions() as session:
            session.add_all([
                models.AiScheduleRun(id=f"run-{i}", schedule_id="own", state="succeeded")
                for i in range(201)
            ])
            await session.commit()
        path = "/ai-schedules/own/runs"
        for params, count in (({}, 20), ({"limit": 1}, 1), ({"limit": 200}, 200)):
            with self.subTest(params=params):
                response = await self.request("GET", path, params=params)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(len(response.json()["items"]), count)
        for limit in (0, 201):
            with self.subTest(limit=limit):
                response = await self.request("GET", path, params={"limit": limit})
                self.assertEqual(response.status_code, 422, response.text)

    async def test_personal_router_order_aliases_and_auth(self):
        names = list(route_names(tasks.router.routes))
        expected = ["my_schedules", "my_schedule_templates", "automation_conversation_inbox",
                    "claim_automation_conversation", "acknowledge_automation_conversation",
                    "preflight_my_schedule", "create_my_schedule", "update_my_schedule",
                    "delete_my_schedule", "my_schedule_runs", "run_my_schedule"]
        start = names.index(expected[0])
        self.assertEqual(names[start - 1:start + len(expected) + 1],
                         ["set_my_skills", *expected, "get_tasks"])
        for name in expected:
            self.assertIs(getattr(tasks, name), getattr(personal_schedules, name))
        start = names.index("my_models")
        self.assertEqual(names[start - 1:start + 4],
                         ["list_ai_agents", "my_models", "put_my_models", "test_my_model", "ai_dispatch_preview"])
        for name in ("my_models", "put_my_models", "test_my_model"):
            self.assertIs(getattr(tasks, name), getattr(personal_models, name))
        paths = [("GET", "/schedules"), ("GET", "/schedules/templates"),
                 ("POST", "/automation-conversations/inbox"),
                 ("POST", "/automation-conversations/run/claim"),
                 ("POST", "/automation-conversations/run/state"),
                 ("POST", "/schedules/preflight"), ("POST", "/schedules"),
                 ("PUT", "/schedules/own"), ("DELETE", "/schedules/own"),
                 ("GET", "/schedules/own/runs"), ("POST", "/schedules/own/run"),
                 ("GET", "/my-models"), ("PUT", "/my-models"), ("POST", "/my-models/test")]
        for method, path in paths:
            response = await self.http.request(method, "/api/v1" + path)
            self.assertEqual(response.status_code, 401, response.text)

    async def test_personal_ownership_and_helper_patch_survive_extraction(self):
        async def device():
            async with self.sessions() as session:
                return await session.get(models.Client, "device")

        self.app.dependency_overrides[current_client] = device
        listed = await self.http.get("/api/v1/schedules")
        self.assertEqual([row["id"] for row in listed.json()], ["own"])
        hidden = await self.http.get("/api/v1/schedules/hidden/runs")
        self.assertEqual(hidden.status_code, 404, hidden.text)
        with patch.object(schedules, "validate_execution", AsyncMock()), \
                patch.object(schedules, "capability_save_blocker", return_value=None):
            created = await self.http.post("/api/v1/schedules", json={
                "title": "New", "ownerClientId": "other", "assigneeId": "local:pi"})
            self.assertEqual(created.status_code, 200, created.text)
            sid = created.json()["id"]
            updated = await self.http.put("/api/v1/schedules/" + sid,
                                          json={"title": "Edited", "ownerClientId": "other"})
            self.assertEqual(updated.status_code, 200, updated.text)
        async with self.sessions() as session:
            saved = await session.get(models.AiSchedule, sid)
            self.assertEqual((saved.title, saved.owner_client_id), ("Edited", "device"))
        denied = AsyncMock(side_effect=HTTPException(404, "patched ownership"))
        with patch.object(tasks, "_my_sch", denied):
            result = await self.http.get("/api/v1/schedules/own/runs")
        self.assertEqual(result.status_code, 404, result.text)
        denied.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
