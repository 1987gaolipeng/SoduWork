"""Catalog warnings must become pre-start blockers for repository-bound nodes."""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-workflow-repository-tests")
os.environ.setdefault("ADMIN_PASS", "isolated-workflow-repository-admin")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models, automation_models as am
from app.services import workflow_runs, plugin_readiness, plugin_route_readiness


class WorkflowStartRepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as connection:
            await connection.run_sync(models.Base.metadata.create_all)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.addAsyncCleanup(self.session.close)
        self.task = models.Task(id="task", title="Fixture", status="doing")
        self.version = am.PluginVersion(id="version", plugin_id="plugin", version="1", checksum="fixture", enabled=True,
            trust_state="approved", manifest={}, workflow={"nodes": [{"key": "verify", "type": "quality"}]})
        self.binding = am.PluginBinding(id="binding", plugin_id="plugin", version_id="version", enabled=True)
        self.session.add_all([self.task, self.version, self.binding, am.Plugin(id="plugin", key="fixture", name="Fixture", enabled=True)])
        await self.session.commit()
        context = patch.object(plugin_route_readiness, "context_for_task", AsyncMock(return_value={}))
        context.start()
        self.addCleanup(context.stop)

    async def test_catalog_without_project_can_warn_but_actual_start_rejects(self):
        catalog = await plugin_readiness.binding_readiness(self.session, self.version, None, None)
        self.assertTrue(catalog["ok"])
        self.assertTrue(catalog["warnings"])
        with self.assertRaisesRegex(ValueError, "工程|仓库"):
            await workflow_runs.start(self.session, self.task, self.binding, {}, notify=False)
        self.assertEqual(list((await self.session.scalars(select(am.WorkflowRun))).all()), [])
        self.assertEqual(list((await self.session.scalars(select(am.WorkflowOutbox))).all()), [])

    async def test_multiple_project_repositories_require_an_explicit_target(self):
        self.session.add(models.Project(id="project", name="Fixture"))
        self.task.project_id = "project"
        self.session.add_all([models.Repo(id=rid, name=rid, project_id="project", git_url="https://example.invalid/" + rid, merge_branch="main") for rid in ("one", "two")])
        await self.session.commit()
        with self.assertRaisesRegex(ValueError, "工程|仓库"):
            await workflow_runs.start(self.session, self.task, self.binding, {}, notify=False)
        self.assertEqual(list((await self.session.scalars(select(am.WorkflowRun))).all()), [])

    async def test_file_only_workflow_can_start_without_a_repository(self):
        self.version.workflow = {"nodes": [{"key": "publish", "type": "publish"}]}
        await self.session.commit()
        run = await workflow_runs.start(self.session, self.task, self.binding, {}, notify=False)
        self.assertEqual(run.state, "running")

    async def test_unique_ready_project_repository_is_still_inherited(self):
        self.session.add(models.Project(id="project", name="Fixture"))
        self.task.project_id = "project"
        self.session.add(models.Repo(id="only", name="Only", project_id="project", git_url="https://example.invalid/only", merge_branch="main"))
        await self.session.commit()
        run = await workflow_runs.start(self.session, self.task, self.binding, {}, notify=False)
        self.assertEqual(run.state, "running")
        self.assertEqual(self.task.repo_id, "only")

    async def test_unready_selected_repository_cannot_use_another_ready_repository(self):
        self.session.add(models.Project(id="project", name="Fixture"))
        self.task.project_id = "project"
        self.task.repo_id = "unready"
        self.session.add_all([
            models.Repo(id="ready", name="Ready", project_id="project", git_url="https://example.invalid/ready", merge_branch="main"),
            models.Repo(id="unready", name="Unready", project_id="project", git_url="", merge_branch="main"),
        ])
        await self.session.commit()
        with self.assertRaisesRegex(ValueError, "仓库地址|合并分支"):
            await workflow_runs.start(self.session, self.task, self.binding, {}, notify=False)
        self.assertEqual(list((await self.session.scalars(select(am.WorkflowRun))).all()), [])


if __name__ == "__main__":
    unittest.main()
