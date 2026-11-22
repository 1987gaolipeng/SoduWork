"""Exercise list and write contracts on the Hub HTTP routes against isolated SQLite."""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import Depends, FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models, models
from app.db import Base, get_session
from app.deps import current_client, current_user
from app.library_models import LibraryFolder, LibraryItem
from app.api import admin, approvals, clients, deliveries, environments, first_chat, library, runner_ws, tasks, usage, work_catalog
from app.permissions import ALL_KEYS


class HubContractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            for i in range(3):
                key = f"row-{i}"
                user = models.User(id=key, username=key, org_id=key, is_super=i == 0)
                device = models.Client(id=key, user_ref=key, auth_state="active")
                session.add_all([user, device, models.OrgUnit(id=key, name=key),
                                 models.Role(id=key, name=key), models.Domain(id=key, name=key)])
                if i == 0:
                    self.user, self.device = user, device
            await session.flush()
            for i in range(3):
                session.add(models.AiSchedule(id=f"schedule-{i}", title=f"schedule {i}",
                                              owner_client_id="row-1" if i == 2 else "row-0"))
            session.add(models.Project(id="project", name="Fixture", org_id="row-0"))
            session.add(LibraryFolder(id="dir", name="Folder", owner_key="row-0"))
            session.add_all([LibraryItem(id=key, title=key, owner_key=owner) for key, owner in
                             (("file-a", "row-0"), ("file-b", "row-0"), ("private", "row-1"))])
            await session.commit()
        self.user._perms = set(ALL_KEYS)
        api = self.app = FastAPI()
        for router in (admin.router, approvals.router, clients.router, deliveries.router, environments.router, first_chat.router,
                       library.router, runner_ws.router, tasks.router, usage.router, work_catalog.admin_router):
            api.include_router(router)

        async def database():
            async with self.sessions() as session:
                yield session

        api.dependency_overrides[get_session] = database
        api.dependency_overrides[current_user] = lambda: self.user
        api.dependency_overrides[current_client] = lambda: self.device
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=api),
                                      base_url="http://fixture/api/v1/")
        self.addAsyncCleanup(self.http.aclose)

    async def request(self, method, path, expected=200, **kwargs):
        response = await self.http.request(method, path, **kwargs)
        self.assertEqual(response.status_code, expected, (method, path, response.status_code))
        return response.json()

    async def test_first_chat_uses_current_models_and_only_the_signed_in_accounts_recent_report(self):
        async def reporting_device(session=Depends(get_session)):
            return await session.get(models.Client, self.device.id)

        self.app.dependency_overrides[current_client] = reporting_device
        async with self.sessions() as session, session.begin():
            device = await session.get(models.Client, self.device.id)
            device.platform = "linux/x64"
            device.config = {"theme": "light"}
            session.add(models.ModelProvider(id="service", name="Fixture", base_url="https://fixture.invalid/v1",
                                             api_key="fixture-key", enabled=True))
            session.add(models.ModelDef(id="image-only", provider_id="service", name="picture", modality="image"))
        expected = {"providerReady": True, "chatModelReady": False, "runtimeReady": None, "modelReady": None}
        self.assertEqual(await self.request("GET", "admin/first-chat-readiness"), expected)
        async with self.sessions() as session, session.begin():
            session.add(models.ModelDef(id="chat-model", provider_id="service", name="chat", modality="chat"))
        expected["chatModelReady"] = True
        await self.request("PUT", "first-chat-readiness", 422, json={"runtimeReady": "true", "modelReady": True})
        await self.request("PUT", "first-chat-readiness", json={"runtimeReady": True, "modelReady": False})
        self.assertEqual(await self.request("GET", "admin/first-chat-readiness"),
                         {**expected, "runtimeReady": True, "modelReady": False})
        with patch.object(first_chat, "time", return_value=first_chat.time() + first_chat.REPORT_TTL + 1):
            self.assertEqual(await self.request("GET", "admin/first-chat-readiness"), expected)
        async with self.sessions() as session, session.begin():
            device = await session.get(models.Client, self.device.id)
            self.assertEqual(admin._admin_client_config(device.config), {"theme": "light"})
            device.auth_version += 1
        self.assertEqual(await self.request("GET", "admin/first-chat-readiness"), expected)
        await self.request("PUT", "first-chat-readiness", json={"runtimeReady": True, "modelReady": True})
        self.user.id = "row-1"
        self.assertEqual(await self.request("GET", "admin/first-chat-readiness"), expected)
        self.user.is_super = False
        self.user._perms = set()
        await self.request("GET", "admin/first-chat-readiness", 403)

    async def test_delete_distinguishes_missing_resources_from_in_use(self):
        for resource in ("orgs", "roles"):
            path = "admin/" + resource + "/missing"
            await self.request("PATCH", path, expected=404, json={"name": "Missing"})
            await self.request("DELETE", path, expected=404)
        await self.request("DELETE", "admin/orgs/row-0", expected=400)

    async def test_create_deployment_target_reports_required_ids_before_lookup(self):
        for body, field in (({}, "repoId"), ({"repoId": "  "}, "repoId"),
                            ({"repoId": "missing"}, "environmentId"), ({"repoId": "missing", "environmentId": []}, "environmentId")):
            result = await self.request("POST", "admin/deployment-targets", expected=400, json=body)
            self.assertIn(field, result["detail"])
        await self.request("POST", "admin/deployment-targets", expected=404,
                           json={"repoId": "missing", "environmentId": "staging"})

    async def test_admin_and_device_list_windows(self):
        for i in range(2):
            await self.request("POST", "tasks", json={"title": f"task {i}"})
        for path in ("admin/users", "admin/orgs", "admin/roles", "admin/domains",
                     "admin/clients", "tasks", "schedules"):
            with self.subTest(path=path):
                legacy = await self.request("GET", path)
                self.assertIsInstance(legacy, list)
                self.assertEqual(len(legacy), 2 if path in ("tasks", "schedules") else 3)
                seen = []
                for offset in range(len(legacy)):
                    page = await self.request("GET", path, params={"offset": offset, "limit": 1})
                    self.assertEqual(page["total"], len(legacy))
                    self.assertEqual(len(page["items"]), 1)
                    seen.append(page["items"][0]["id"])
                self.assertCountEqual(seen, [row["id"] for row in legacy])
                beyond = await self.request("GET", path, params={"offset": 300})
                self.assertEqual((beyond["items"], beyond["total"]), ([], len(legacy)))
                await self.request("GET", path, 422, params={"limit": 0})
        await self.request("GET", "approvals", 422, params={"limit": 0})
        await self.request("GET", "deliveries", 422, params={"limit": 0})
        for path in ("admin/client-inventory", "admin/clients?paged=1"):
            page = await self.request("GET", path + ("&" if "?" in path else "?") + "pageSize=1")
            self.assertEqual((page["pageSize"], len(page["items"]), page["total"]), (1, 1, 3))
        for mix in ("limit=3&page=1", "offset=0&pageSize=25"):
            response = await self.http.get("admin/client-inventory?" + mix)
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.headers.get("X-Error-Code"), "hub.input.pages")
        self.user.is_super = False
        limited = await self.request("GET", "admin/users?limit=1")
        self.assertEqual(([user["id"] for user in limited["items"]], limited["total"]), (["row-0"], 1))

    async def test_device_search_treats_keywords_as_literal_substrings(self):
        async with self.sessions() as session:
            (await session.get(models.Client, "row-0")).name = "Win_01"
            (await session.get(models.Client, "row-1")).name = "WinX01"
            (await session.get(models.User, "row-1")).display_name = "ops%team"
            (await session.get(models.User, "row-2")).username = r"hq\admin"
            session.add(models.Client(id="dev_special", user_ref="row-2", auth_state="active"))
            await session.commit()
        for route in ("admin/clients", "admin/client-inventory"):
            for term, ids in ((" WIN_01 ", ["row-0"]), ("%", ["row-1"]),
                              ("dev_", ["dev_special"]), ("a%", []),
                              ("\\", ["row-2", "dev_special"])):
                with self.subTest(route=route, term=term):
                    page = await self.request("GET", route, params={"paged": "true", "q": term})
                    self.assertEqual(page["total"], len(ids))
                    self.assertCountEqual([row["id"] for row in page["items"]], ids)
        self.user.is_super = False
        page = await self.request("GET", "admin/clients", params={"paged": "true", "q": "%"})
        self.assertEqual((page["total"], page["items"]), (0, []))

    async def test_library_pages_cross_folder_boundary(self):
        with patch("app.api.library.library_read_cache.ensure_ready", new_callable=AsyncMock):
            first = await self.request("GET", "library?scope=all&limit=2")
            self.assertEqual([f["id"] for f in first["folders"]], ["dir"])
            self.assertEqual([f["id"] for f in first["items"]], ["file-a"])
            last = await self.request("GET", "library?scope=all&offset=2&limit=2")
            self.assertEqual((last["total"], last["folders"], last["items"][0]["id"]), (3, [], "file-b"))
            empty = await self.request("GET", "library?scope=all&offset=50")
            self.assertEqual((empty["total"], empty["folders"], empty["items"]), (3, [], []))

    async def test_task_writes_and_comments(self):
        await self.request("POST", "tasks", 400, json={"title": "invalid", "assigneeUserId": "missing"})
        for value in (True, False):
            await self.request("POST", "tasks", 422, json={"title": "invalid", "due": value})
        await self.request("POST", "team/tasks", 400, json={"title": "invalid", "toInbox": True,
                                                           "assigneeUserId": "missing"})
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.Task)), 0)
        task = await self.request("POST", "tasks", json={"title": "valid", "due": 1900000000000})
        self.assertEqual(task["due"], 1900000000000)
        await self.request("PATCH", f"tasks/{task['id']}", 422, json={"due": False})
        self.assertEqual((await self.request("GET", f"tasks/{task['id']}"))["due"], 1900000000000)
        comments = f"tasks/{task['id']}/comments"
        for body, status in (({}, 422), (False, 422), ("x" * 4001, 400)):
            await self.request("POST", comments, status, json={"body": body})
        await self.request("POST", comments, json={"body": "x" * 4000})
        async with self.sessions() as session:
            stored = (await session.scalars(select(models.TaskComment.body))).all()
            self.assertEqual(stored, ["x" * 4000])

    async def test_catalog_and_environment_inputs(self):
        for body in ({"name": "fixture", "type": "unlisted"},
                     {"name": "fixture", "type": "generic", "config": {"baseUrl": "unsupported://example.invalid"}}):
            await self.request("POST", "admin/integrations", 400, json=body)
        await self.request("POST", "admin/projects/project/repos", 400,
                           json={"name": "fixture", "gitUrl": "file:///fixture"})
        await self.request("POST", "admin/environments", 400,
                           json={"key": "testing", "tier": "unlisted"})
        env = await self.request("POST", "admin/environments", json={"key": "testing", "name": ""})
        self.assertEqual(env["name"], "testing")
        await self.request("PATCH", f"admin/environments/{env['id']}", 400, json={"tier": "unlisted"})
        await self.request("POST", "admin/work-catalog/professions", 400,
                           json={"orgId": "row-0", "name": "Analyst", "category": "unlisted"})

    async def test_users_and_positions_require_an_existing_department(self):
        body = {"username": "candidate", "password": "example-password", "orgId": "missing"}
        self.assertEqual((await self.request("POST", "admin/users", 400, json=body))["detail"], "部门不存在")
        await self.request("POST", "admin/positions", 400, json={"name": "Analyst", "orgId": "missing"})
        await self.request("PATCH", "admin/users/row-1", 400, json={"orgId": "missing"})
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.User, "row-1")).org_id, "row-1")
            self.assertIsNone(await session.scalar(select(models.User).where(models.User.username == "candidate")))
            self.assertIsNone(await session.scalar(select(models.Position)))
        created = await self.request("POST", "admin/users", json={**body, "orgId": "row-0"})
        updated = await self.request("PATCH", f"admin/users/{created['id']}", json={"orgId": "row-1"})
        self.assertEqual(updated["orgId"], "row-1")
        self.assertEqual((await self.request("POST", "admin/positions",
                                            json={"name": "Analyst", "orgId": "row-0"}))["orgId"], "row-0")

    async def test_integration_rejects_unsupported_top_level_fields(self):
        body = {"name": "GitLab", "type": "gitlab"}
        error = await self.request("POST", "admin/integrations", 422, json={**body, "projectId": "project"})
        self.assertIn("projectId", error["detail"][0]["loc"])
        async with self.sessions() as session:
            self.assertIsNone(await session.scalar(select(models.Integration)))
        created = await self.request("POST", "admin/integrations", json=body)
        self.assertEqual(created["name"], "GitLab")

    async def test_environment_selector_uses_registered_tags_in_scope(self):
        async with self.sessions() as session:
            session.add_all([
                automation_models.RunnerNode(id="runner", org_id="row-0", tags=["release"]),
                automation_models.RunnerNode(id="embedded", client_id="row-0", tags=["client"]),
                automation_models.RunnerNode(id="elsewhere", org_id="row-1", tags=["other"]),
                automation_models.RunnerNode(id="personal", org_id="row-0", owner_user_id="row-0", tags=["personal"]),
                automation_models.RunnerNode(id="retired", org_id="row-0", management_state="retired", tags=["old"]),
            ])
            await session.commit()
        body = {"key": "testing", "orgId": "row-0"}
        await self.request("POST", "admin/environments", 422, json={**body, "runnerSelector": {"tags": "test"}})
        env = await self.request("POST", "admin/environments", json={
            **body, "runnerSelector": {"tags": [" RELEASE ", "release", "client"]}})
        self.assertEqual(env["runnerSelector"]["tags"], ["release", "client"])
        path = f"admin/environments/{env['id']}"
        for selector in ("invalid", {"tags": [True]}, {"runnerIds": "runner"}, {"tags": ["ghost"]},
                         {"tags": ["other"]}, {"tags": ["personal"]}, {"tags": ["old"]}):
            with self.subTest(selector=selector):
                await self.request("PATCH", path, 422, json={"runnerSelector": selector})
        async with self.sessions() as session:
            row = await session.get(automation_models.Environment, env["id"])
            self.assertEqual(row.runner_selector["tags"], ["release", "client"])
        cleared = await self.request("PATCH", path, json={"runnerSelector": {"tags": []}})
        self.assertEqual(cleared["runnerSelector"]["tags"], [])

    async def test_usage_window_and_enrollment(self):
        for path in ("usage/me", "admin/usage/overview"):
            for days in (-1, 0, 366, 999999):
                await self.request("GET", path, 422, params={"days": days})
            for days in (1, 365):
                await self.request("GET", path, params={"days": days})
        for body in ({}, {"host": "  "}, {"runnerId": "new-runner"}):
            await self.request("POST", "admin/runners/enroll", 422, json=body)
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(automation_models.RunnerNode)), 0)

        new = await self.request("POST", "admin/runners/enroll", json={"host": "fixture-host", "orgId": "row-0"})
        rotated = await self.request("POST", "admin/runners/enroll", json={"runnerId": new["runnerId"]})
        self.assertTrue(rotated["rotated"])
        self.assertEqual(rotated["runnerId"], new["runnerId"])
