"""Project router extraction keeps the admin HTTP and Python contracts intact."""
import importlib
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin, admin_projects
from app.auth import sign_token
from app.db import Base, get_session

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


PROJECT_ROUTES = (
    ("GET", "/projects", "list_projects"),
    ("GET", "/project-owner-options", "project_owner_options"),
    ("POST", "/projects", "create_project"),
    ("GET", "/ai-projects", "list_ai_projects"),
    ("PUT", "/projects/{pid}", "update_project"),
    ("GET", "/projects/{pid}/repos", "list_repos"),
    ("POST", "/projects/{pid}/repos", "add_repo"),
    ("PUT", "/repos/{rid}", "update_repo"),
    ("DELETE", "/repos/{rid}", "delete_repo"),
    ("GET", "/projects/{pid}", "project_detail"),
    ("POST", "/projects/{pid}/tasks", "add_project_task"),
    ("DELETE", "/projects/{pid}", "delete_project"),
)


def route_names(routes):
    """FastAPI supports both flattened routes and deferred included routers."""
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            yield from route_names(included.routes)
        else:
            yield route.name


class AdminProjectRouterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="team", name="Team"),
                models.OrgUnit(id="child", name="Child", parent_id="team"),
                models.OrgUnit(id="outside", name="Outside"),
                models.Role(id="operator", name="Operator", permissions=["task.view", "task.dispatch"]),
                models.Role(id="reader", name="Reader", permissions=["task.view"]),
                models.Role(id="empty", name="No permissions", permissions=[]),
            ])
            for uid, org, role in (("manager", "team", "operator"),
                                   ("reader", "team", "reader"),
                                   ("owner", "child", "reader"),
                                   ("outsider", "outside", "operator"),
                                   ("empty", "team", "empty")):
                session.add(models.User(id=uid, username=uid, display_name=uid,
                                        org_id=org, role_id=role, is_active=True, auth_version=1))
            session.add_all([
                models.Client(id="box", user_ref="owner", auth_state="active"),
                models.Project(id="project", name="Project", org_id="child", owner_user_id="owner"),
                models.Project(id="hidden", name="Hidden", org_id="outside", owner_user_id="outsider"),
            ])
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(admin.router)

        async def db():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                     base_url="http://isolated")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def request(self, method, path, who="manager", **kwargs):
        headers = {"Authorization": "Bearer " + sign_token(who, 1)} if who else {}
        return await self.http.request(method, "/api/v1/admin" + path, headers=headers, **kwargs)

    async def test_legacy_exports_route_order_and_metadata(self):
        expected = [name for _, _, name in PROJECT_ROUTES]
        names = list(route_names(admin.router.routes))
        start = names.index("list_projects")
        self.assertEqual(names[start - 1:start + len(expected) + 1],
                         ["agent_run_status", *expected, "get_dev_flow"])
        schema = self.app.openapi()
        for method, path, name in PROJECT_ROUTES:
            self.assertEqual(names.count(name), 1)
            self.assertIs(getattr(admin, name), getattr(admin_projects, name))
            operation = schema["paths"]["/api/v1/admin" + path][method.lower()]
            self.assertEqual(operation["tags"], ["admin"])
            self.assertTrue(operation["operationId"].startswith(name + "_"))
        self.assertIs(admin._project_owner, admin_projects._project_owner)
        self.assertIs(admin._repo_api, admin_projects._repo_api)

    async def test_every_extracted_endpoint_keeps_auth_and_permission_guards(self):
        for method, path, _ in PROJECT_ROUTES:
            path = path.replace("{pid}", "project").replace("{rid}", "repo")
            with self.subTest(method=method, path=path):
                unauthorized = await self.request(method, path, who=None)
                self.assertEqual(unauthorized.status_code, 401, unauthorized.text)
                denied = await self.request(method, path, who="empty")
                self.assertEqual(denied.status_code, 403, denied.text)

    async def test_project_listing_owner_choice_and_mutations_stay_in_scope(self):
        listed = await self.request("GET", "/projects")
        self.assertEqual([p["id"] for p in listed.json()], ["project"])
        owners = await self.request("GET", "/project-owner-options")
        self.assertEqual({u["id"] for u in owners.json()}, {"manager", "reader", "owner", "empty"})
        for path in ("/projects/hidden", "/projects/hidden/repos"):
            forbidden = await self.request("GET", path)
            self.assertEqual(forbidden.status_code, 403, forbidden.text)
        forbidden = await self.request("POST", "/projects", json={"name": "New", "ownerUserId": "outsider"})
        self.assertEqual(forbidden.status_code, 403, forbidden.text)
        created = await self.request("POST", "/projects", json={"name": "New", "ownerUserId": "owner"})
        self.assertEqual(created.status_code, 200, created.text)
        async with self.sessions() as session:
            project = await session.get(models.Project, created.json()["id"])
            self.assertEqual((project.org_id, project.owner_user_id), ("child", "owner"))
            audit = (await session.execute(select(models.AuditLog).where(
                models.AuditLog.action == "project.create"))).scalars().one()
            self.assertEqual((audit.actor_id, audit.target_id), ("manager", project.id))

    async def test_shared_scope_helpers_remain_patchable_through_admin(self):
        denied = AsyncMock(side_effect=HTTPException(403, "scope denied"))
        with patch.object(admin, "_assert_org_in_scope", denied):
            result = await self.request("GET", "/projects/project")
        self.assertEqual(result.status_code, 403, result.text)
        denied.assert_awaited_once()
        denied.reset_mock()
        with patch.object(admin, "_assert_user_in_scope", denied):
            result = await self.request("POST", "/projects", json={"name": "New", "ownerUserId": "owner"})
        self.assertEqual(result.status_code, 403, result.text)
        denied.assert_awaited_once()
        with patch.object(admin, "_visible_client_ids", AsyncMock(return_value=set())) as visible:
            result = await self.request("POST", "/projects/project/tasks", json={"title": "New", "target": "box"})
        self.assertEqual(result.status_code, 403, result.text)
        visible.assert_awaited_once()

    async def test_repository_crud_keeps_validation_payloads_and_audit(self):
        invalid = await self.request("POST", "/projects/project/repos",
                                     json={"name": "Backend", "localDir": "../escape"})
        self.assertEqual(invalid.status_code, 400, invalid.text)
        created = await self.request("POST", "/projects/project/repos", json={
            "name": "Backend", "kind": "backend", "branch": "release",
            "localDir": "src\\backend", "gitUrl": "https://git.example.test/backend.git",
        })
        self.assertEqual(created.status_code, 200, created.text)
        repo = created.json()
        self.assertEqual((repo["projectId"], repo["branch"], repo["localDir"]),
                         ("project", "release", "src/backend"))
        rid = repo["id"]
        updated = await self.request("PUT", "/repos/" + rid, json={
            "branch": "", "routeKeywords": [" API ", ""], "routePriority": 500,
            "deployTargets": [{"name": "Staging", "cmd": "./deploy.sh", "auto": True}],
        })
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual((updated.json()["branch"], updated.json()["routeKeywords"],
                          updated.json()["routePriority"]), ("main", ["API"], 100))
        listed = await self.request("GET", "/projects/project/repos")
        self.assertEqual(listed.json(), [updated.json()])
        deleted = await self.request("DELETE", "/repos/" + rid)
        self.assertEqual(deleted.json(), {"ok": True})
        async with self.sessions() as session:
            self.assertIsNone(await session.get(models.Repo, rid))
            events = (await session.execute(select(models.AuditLog.action).where(
                models.AuditLog.target_id == rid))).scalars().all()
            self.assertCountEqual(events, ["repo.create", "repo.update", "repo.delete"])


if __name__ == "__main__":
    unittest.main()
