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

from app import automation_models as am, models
from app.api import admin, admin_projects
from app.auth import sign_token
from app.db import Base, get_session
from app.services import release_control

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

    async def test_creation_and_rename_reject_duplicate_names_within_owner_org(self):
        base = {"name": "Project", "ownerUserId": "owner"}
        for extra, status in (({"key": "ignored"}, 422), ({}, 409)):
            result = await self.request("POST", "/projects", json={**base, **extra})
            self.assertEqual(result.status_code, status, result.text)
        created = await self.request("POST", "/projects", json={**base, "name": "Other"})
        self.assertEqual(created.status_code, 200, created.text)
        renamed = await self.request("PUT", "/projects/" + created.json()["id"], json={"name": "project"})
        self.assertEqual(renamed.status_code, 409, renamed.text)
        separate = await self.request("POST", "/projects", json={**base, "ownerUserId": "manager"})
        self.assertEqual(separate.status_code, 200, separate.text)

    async def request(self, method, path, who="manager", **kwargs):
        headers = {"Authorization": "Bearer " + sign_token(who, 1)} if who else {}
        return await self.http.request(method, "/api/v1/admin" + path, headers=headers, **kwargs)

    async def _open_merge_approval(self, second_approver):
        async with self.sessions() as session:
            task = models.Task(id="merge-task", title="Release task", project_id="project")
            artifact = am.ArtifactVersion(task_id=task.id, kind="code", checksum="merge-fixture")
            session.add_all([task, artifact, am.ApprovalPolicy(
                id=release_control.POLICY_MERGE, key="merge", name="Two-person merge",
                rules={"required": 2, "approvers": [
                    {"type": "project_owner"}, {"type": "user", "id": second_approver},
                ]},
            )])
            await session.flush()
            request = await release_control.ensure_request(session, task, artifact, "merge")
            await session.commit()
            return request.id

    async def _assigned_users(self, session, request_id):
        return set((await session.scalars(select(am.ApprovalAssignment.user_id).where(
            am.ApprovalAssignment.request_id == request_id))).all())

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

    async def test_owner_change_rejects_a_reroute_that_cannot_reach_quorum(self):
        request_id = await self._open_merge_approval("reader")

        response = await self.request("PUT", "/projects/project",
                                      json={"ownerUserId": "reader", "name": "Renamed"})

        self.assertEqual(response.status_code, 409, response.text)
        detail = response.json()["detail"]
        self.assertIn("需要 2 人", detail)
        self.assertIn("只能分配给 1 人", detail)
        async with self.sessions() as session:
            project = await session.get(models.Project, "project")
            self.assertEqual((project.owner_user_id, project.name), ("owner", "Project"))
            request = await session.get(am.ApprovalRequest, request_id)
            self.assertEqual((request.status, request.required_count), ("pending", 2))
            self.assertEqual(await self._assigned_users(session, request_id), {"owner", "reader"})
            self.assertIsNone(await session.scalar(select(models.TaskEvent.id).where(
                models.TaskEvent.kind == "release.approval_rerouted")))
            self.assertIsNone(await session.scalar(select(models.AuditLog.id).where(
                models.AuditLog.action == "project.update")))

    async def test_owner_change_reroutes_when_two_distinct_approvers_remain(self):
        request_id = await self._open_merge_approval("manager")

        response = await self.request("PUT", "/projects/project", json={"ownerUserId": "reader"})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["ownerUserId"], "reader")
        self.assertEqual(response.json()["pendingRerouted"],
                         {"requests": 1, "assignments": 2, "skipped": 0})
        async with self.sessions() as session:
            self.assertEqual(await self._assigned_users(session, request_id), {"reader", "manager"})

    async def test_owner_change_keeps_assignments_for_partially_decided_approvals(self):
        request_id = await self._open_merge_approval("reader")
        async with self.sessions() as session:
            session.add(am.ApprovalDecision(request_id=request_id, user_id="owner", decision="approve"))
            await session.commit()

        response = await self.request("PUT", "/projects/project", json={"ownerUserId": "reader"})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["pendingRerouted"],
                         {"requests": 0, "assignments": 0, "skipped": 1})
        async with self.sessions() as session:
            self.assertEqual(await self._assigned_users(session, request_id), {"owner", "reader"})

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

    async def test_project_deletion_requires_removing_its_repository_mappings(self):
        async with self.sessions() as session:
            session.add_all([
                models.Task(id="keep", title="Keep this task", owner_client_id="box", project_id="project"),
                models.Repo(id="manual", project_id="project"),
                models.Repo(id="mapped", project_id="project", source_repository_id="catalog"),
                models.Repo(id="unrelated", project_id="hidden"),
            ])
            await session.commit()

        denied = await self.request("DELETE", "/projects/project", who="outsider")
        self.assertEqual(denied.status_code, 403)
        for rid, count in (("manual", 2), ("mapped", 1)):
            response = await self.request("DELETE", "/projects/project")
            self.assertEqual(response.status_code, 409, response.text)
            self.assertIn(f"{count} 个仓库", response.json()["detail"])
            async with self.sessions() as session:
                self.assertIsNotNone(await session.get(models.Project, "project"))
                self.assertEqual((await session.get(models.Task, "keep")).project_id, "project")
                self.assertEqual((await session.get(models.Repo, rid)).project_id, "project")
            removed = await self.request("DELETE", "/repos/" + rid)
            self.assertEqual(removed.status_code, 200, removed.text)

        for _ in range(2):
            response = await self.request("DELETE", "/projects/project")
            self.assertEqual(response.json(), {"ok": True})
        async with self.sessions() as session:
            self.assertIsNone(await session.get(models.Project, "project"))
            self.assertIsNone((await session.get(models.Task, "keep")).project_id)
            self.assertEqual((await session.get(models.Repo, "unrelated")).project_id, "hidden")
            deleted = await session.scalars(select(models.AuditLog.target_id).where(
                models.AuditLog.action == "project.delete"))
            self.assertEqual(deleted.all(), ["project"])

    async def test_all_repository_writers_reject_nonrelative_directories(self):
        from app import automation_models as am
        from app.api import repositories
        self.app.include_router(repositories.router)
        async with self.sessions() as session:
            session.add(am.ScmRepository(
                id="catalog", integration_id="fixture", org_id="child", provider="gitlab",
                external_id="1", full_name="fixture/repo", display_name="Repo",
                clone_url="https://git.example.test/repo.git", default_branch="main"))
            await session.commit()
        created = await self.request("POST", "/projects/project/repos",
                                     json={"name": "Repository", "localDir": "safe/repo"})
        self.assertEqual(created.status_code, 200, created.text)
        rid = created.json()["id"]
        invalid = ["C:/x", "C:x", "D:/x", "a/C:/x", r"a\C:x", r"\rooted",
                   r"\\server\share\x", "/absolute", "../escape", r"a\..\x",
                   "a/.. /x", "a/./x", "a/file:stream", "a\x00b"]
        for index, path in enumerate(invalid):
            for method, endpoint, extra in (
                ("POST", "/projects/project/repos", {"name": "Invalid"}),
                ("PUT", "/repos/" + rid, {"name": "Must not persist"}),
                ("POST", "/projects/project/repos/from-catalog", {"catalogId": "catalog"}),
                ("POST", "/repos/" + rid + "/copy", {"projectId": "project", "branch": f"bad-{index}"}),
            ):
                with self.subTest(path=path, endpoint=endpoint):
                    response = await self.request(method, endpoint, json={**extra, "localDir": path})
                    self.assertEqual(response.status_code, 400, response.text)
        listed = await self.request("GET", "/projects/project/repos")
        self.assertEqual([(r["name"], r["localDir"]) for r in listed.json()],
                         [("Repository", "safe/repo")])
        for path, expected in [(r"src\backend", "src/backend"), ("", ""), (None, "")]:
            response = await self.request("PUT", "/repos/" + rid, json={"localDir": path})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["localDir"], expected)
        # Empty localDir must not turn an arbitrary display name into a raw path.
        response = await self.request("POST", "/projects/project/repos",
                                     json={"name": "C:/display-name", "localDir": ""})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["localDir"], "")
    async def test_repo_update_preserves_custom_dev_flow_steps(self):
        """Updating a repository must keep customized development-flow steps.

        devFlow.steps is a list of {key, title, detail} dicts. update_repo used to
        stringify every override field before normalize(), which turned the list into
        a Python repr string and silently discarded all customized steps on save.
        """
        steps = [
            {"key": "s0", "title": "拉取基线", "detail": "从 {base} 拉取干净副本"},
            {"key": "s1", "title": "QA 自定义步骤", "detail": "执行 {task} 的验证并留证"},
        ]
        created = await self.request("POST", "/projects/project/repos",
                                     json={"name": "Flow", "devFlow": {"steps": steps}})
        self.assertEqual(created.status_code, 200, created.text)
        rid = created.json()["id"]
        self.assertEqual(created.json()["devFlow"]["steps"], steps)
        updated = await self.request("PUT", "/repos/" + rid, json={
            "devFlow": {"steps": steps, "extra": "改完要跑迁移检查"}})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["devFlow"]["steps"], steps)
        self.assertEqual(updated.json()["devFlow"]["extra"], "改完要跑迁移检查")
        # An empty steps list keeps inheriting the default flow: nothing is stored,
        # so the API response omits the key entirely instead of persisting a string.
        inherited = await self.request("PUT", "/repos/" + rid, json={"devFlow": {"steps": []}})
        self.assertEqual(inherited.status_code, 200, inherited.text)
        self.assertEqual(inherited.json()["devFlow"].get("steps", []), [])


if __name__ == "__main__":
    unittest.main()
