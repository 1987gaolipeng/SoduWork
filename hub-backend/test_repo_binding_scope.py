"""Departmental repository binding policy and the normal pending-to-mapped workflow."""

from fastapi import HTTPException
from sqlalchemy import select

from test_user_role_updates import AdminUserTestCase

from app import models
from app.api import repomap


class RepositoryBindingScope(AdminUserTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.app.include_router(repomap.router)
        async with self.sessions.begin() as session:
            role = await session.get(models.Role, "manager")
            role.permissions = ["binding.manage"]
            session.add_all([
                models.Integration(id="source", name="Shared installation"),
                models.Integration(id="child-source", name="Child installation", config={"orgId": "child"}),
                models.Project(id="project", org_id="child"),
                models.Project(id="other-project", org_id="outside"),
                models.Client(id="device", user_ref="target"),
                models.Repo(id="repo", project_id="project", org_id="child"),
            ])
            await session.flush()
            for tid, fields in (
                ("project", {"project_id": "project"}),
                ("account", {"owner_client_id": "device"}),
                ("shared", {"shared_org_id": "child"}),
                ("pool", {"pool_org_id": "team"}),
                ("unmapped", {}),
                ("owned-source", {"integration_id": "child-source"}),
                ("manual", {"project_id": "project", "repo_id": "existing"}),
                ("conflict", {"shared_org_id": "child", "project_id": "other-project"}),
                ("outside", {"shared_org_id": "outside"}),
                ("dangling", {"project_id": "missing", "shared_org_id": "team"}),
            ):
                data = {"integration_id": "source", "ext_repo": "Product", "status": "todo", **fields}
                session.add(models.Task(id=tid, title=tid, **data))
            await session.flush()
            # Changing device login does not rewrite the original execution account.
            client = await session.get(models.Client, "device")
            client.user_ref = "outsider"

    async def test_task_ownership_evidence(self):
        async with self.sessions() as session:
            scoped = set((await session.scalars(repomap._tasks_in_scope({"team", "child"}))).all())
            self.assertEqual({t.id for t in scoped}, {"project", "account", "shared", "pool", "manual", "owned-source"})
            self.assertEqual(len((await session.scalars(repomap._tasks_in_scope(None))).all()), 10)
            self.assertFalse((await session.scalars(repomap._tasks_in_scope(set()))).all())

    async def test_pending_to_mapping_and_retry(self):
        path = "/repo-bindings"
        preview = await self.request("GET", path + "/pending")
        self.assertEqual(preview.status_code, 200, preview.text)
        data = preview.json()
        self.assertEqual(data["total"], 5)
        group = next(g for g in data["items"] if g["integrationId"] == "source")
        self.assertEqual(group["count"], 4)
        self.assertEqual(len(group["samples"]), 3)
        expected = {"project", "account", "shared", "pool"}
        self.assertTrue(all(s["id"] in expected and s["title"] == s["id"] for s in group["samples"]))
        body = {"integrationId": "source", "externalRepo": "product", "repoId": "repo"}
        first = await self.request("POST", path, json=body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["backfilled"], 4)
        retry = await self.request("POST", path, json=body)
        self.assertEqual(retry.json()["id"], first.json()["id"])
        self.assertEqual(retry.json()["backfilled"], 0)
        async with self.sessions() as session:
            rows = await session.scalars(select(models.Task).where(models.Task.repo_id == "repo"))
            self.assertEqual({t.id for t in rows}, expected)
            self.assertEqual((await session.get(models.Task, "manual")).repo_id, "existing")
        removed = await self.request("DELETE", path + "/" + first.json()["id"])
        self.assertTrue(removed.json()["ok"])

    async def test_orphan_policy_and_platform_cleanup(self):
        async with self.sessions.begin() as session:
            with self.assertRaises(HTTPException) as denied:
                await repomap._assert_repo_scope(session, {"team", "child"}, None)
            self.assertEqual(denied.exception.status_code, 403)
            session.add(models.RepoBinding(id="obsolete", integration_id="source", external_repo="archived",
                                           repo_id="retired"))
        response = await self.request("DELETE", "/repo-bindings/obsolete", who="super")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])
