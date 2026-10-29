"""Retired Gerrit settings cannot dispatch, merge, read credentials or replay."""
import importlib.util
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from app.services import scm_support as scm


class RetiredScmTests(unittest.TestCase):
    def test_application_imports_without_removed_execution_modules(self):
        from app.main import app
        from app.connectors import REGISTRY
        for name in ("gerrit_client", "gerrit_flow", "gerrit_review", "gerrit_nodes", "gerrit_autopilot"):
            self.assertIsNone(importlib.util.find_spec("app.services." + name))
        self.assertNotIn("gerrit", REGISTRY)
        self.assertIn("gitlab", REGISTRY)
        self.assertGreater(len(app.routes), 50)

    def test_old_configuration_has_terminal_configuration_failure(self):
        from app.services import workflow_contracts
        for value in ("gerrit", " Gerrit ", NS(scm="gerrit"), {"scm": "gerrit"}):
            with self.subTest(value=value), self.assertRaises(scm.RetiredScmError) as raised:
                scm.require_active(value)
            failure = workflow_contracts.failure_output(raised.exception.failure_kind)
            self.assertTrue(workflow_contracts.terminal_failure(failure))
            self.assertTrue(workflow_contracts.rework_forbidden(failure))
        for value in ("gitlab", "git", None, NS(scm="git")):
            scm.require_active(value)

    def test_generic_review_and_cicd_remain_valid_and_old_auto_review_is_rejected(self):
        scm.require_workflow([{"type": "ai_review"}, {"type": "merge"},
                              {"type": "publish", "config": {"mode": "cicd"}}])
        with self.assertRaises(scm.RetiredScmError):
            scm.require_workflow([{"type": "ai_review", "config": {"mode": "auto"}}])

    def test_prompt_cannot_reintroduce_review_push_commands(self):
        from app.services import ai_prompts
        with self.assertRaises(scm.RetiredScmError):
            ai_prompts.dev_flow("main", True, "fixture", scm="gerrit")
        self.assertNotIn("refs/for", ai_prompts.dev_flow("main", True, "fixture", scm="git"))


class RetiredExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_pending_watches_keep_receipts_without_loading_task_or_replaying(self):
        from app.services import workflow_engine
        session = AsyncMock()
        for watch in ("gerrit-review", "gerrit-merge"):
            node = NS(state="waiting_external", output={"watch": watch, "change": 42, "patchset": 3})
            await workflow_engine._poll_node(session, NS(task_id="fixture"), node)
            self.assertEqual(node.state, "failed")
            self.assertEqual(node.output["change"], 42)
            self.assertEqual(node.output["patchset"], 3)
            self.assertEqual(node.output["failureKind"], "configuration")
            self.assertIsNotNone(node.finished_at)
        session.get.assert_not_awaited()
        terminal = NS(state="succeeded", output={"watch": "gerrit-merge"})
        self.assertFalse(scm.stop_legacy_watch(terminal))
        self.assertEqual(terminal.state, "succeeded")

    async def test_entire_legacy_flow_is_blocked_before_first_ai_node(self):
        from app import automation_models as am, models
        from app.services import workflow_engine
        node, run = NS(state="queued", node_key="implement", node_type="ai"), NS(task_id="task")
        session = AsyncMock()
        session.get.side_effect = lambda model, key: {am.NodeRun: node, am.WorkflowRun: run,
                                                       models.Task: NS(id=key)}[model]
        version = NS(workflow={"nodes": [{"key": "implement", "type": "ai"},
                                         {"key": "review", "type": "ai_review", "config": {"mode": "auto"}}]})
        with patch.object(workflow_engine, "_version", new=AsyncMock(return_value=version)), \
                patch.object(workflow_engine, "_execute_ai", new_callable=AsyncMock) as execute:
            with self.assertRaises(scm.RetiredScmError):
                await workflow_engine._execute_node(session, NS(node_run_id="n", run_id="r"))
        execute.assert_not_awaited()
        session.commit.assert_not_awaited()

    async def test_old_catalog_rejected_before_credentials_or_leases(self):
        from app.services import repository_catalog as catalog
        session = AsyncMock()
        session.get.return_value = NS(type="gerrit")
        with patch.object(catalog, "_runtime_config", new_callable=AsyncMock) as config, \
                patch.object(catalog.resource_leases, "acquire", new_callable=AsyncMock) as lease:
            for operation in (lambda: catalog.verify_pull_account(session, "old"),
                              lambda: catalog.sync_integration(session, "old"),
                              lambda: catalog.branches(session, NS(integration_id="old")),
                              lambda: catalog.create_mapping(session, NS(id="p"), NS(provider="gerrit"), {}),
                              lambda: catalog.copy_mapping(session, NS(scm="gerrit"), NS(id="p"), {})):
                with self.assertRaises(scm.RetiredScmError):
                    await operation()
        config.assert_not_awaited()
        lease.assert_not_awaited()

    async def test_merge_rejected_before_authorization_or_git(self):
        from app.services import code_delivery as delivery
        repo = NS(scm="gerrit")
        with patch.object(delivery, "repo_for", new=AsyncMock(return_value=repo)), \
                patch.object(delivery, "read_state", new=AsyncMock(return_value={})), \
                patch.object(delivery, "_task_git_creds", new_callable=AsyncMock) as creds, \
                patch.object(delivery.resource_leases, "acquire", new_callable=AsyncMock) as lease, \
                patch.object(delivery.release_control, "merge_authorization", new_callable=AsyncMock) as auth:
            for operation in (lambda: delivery.check(None, NS(id="fixture")),
                              lambda: delivery.merge_approved(None, NS(id="fixture")),
                              lambda: delivery.ship(None, NS(id="fixture"), repo, "main")):
                with self.assertRaises(scm.RetiredScmError):
                    await operation()
        creds.assert_not_awaited()
        lease.assert_not_awaited()
        auth.assert_not_awaited()

    async def test_explicit_old_repo_never_falls_back_to_another_gitlab_repo(self):
        from app.services import code_delivery as delivery
        old = NS(id="old", scm="gerrit")
        active = NS(id="gitlab", scm="git", git_url="https://git.example.test/r.git", merge_branch="main")
        rows = MagicMock()
        rows.scalars.return_value.all.return_value = [active, old]
        session = AsyncMock()
        session.execute.return_value = rows
        with patch.object(delivery.task_code_targets, "get", new=AsyncMock(return_value=None)):
            with self.assertRaises(scm.RetiredScmError):
                await delivery.repo_for(session, NS(id="task", project_id="p", repo_id="old"))
            self.assertIs(await delivery.repo_for(session, NS(id="task", project_id="p", repo_id="gitlab")), active)

    async def test_admin_creation_rejects_old_scm_without_storing_repository(self):
        from app.api import admin
        session = AsyncMock()
        session.get.return_value = NS(org_id="org")
        with self.assertRaises(HTTPException) as raised:
            await admin.add_repo("p", {"name": "fixture", "scm": "gerrit"}, NS(), session)
        self.assertEqual(raised.exception.status_code, 400)
        session.add.assert_not_called()
        session.commit.assert_not_awaited()

    async def test_old_integrations_can_be_disabled_but_not_reenabled(self):
        from app.services import aggregation
        legacy, session = NS(type="gerrit", enabled=True), AsyncMock()
        session.get.return_value = legacy
        with self.assertRaises(scm.RetiredScmError):
            await aggregation.create_integration(session, "legacy", "gerrit")
        with self.assertRaises(scm.RetiredScmError):
            await aggregation.update_integration(session, "old", enabled=True)
        with patch.object(aggregation, "integration_to_api", return_value={"enabled": False}):
            self.assertFalse((await aggregation.update_integration(session, "old", enabled=False))["enabled"])
        self.assertFalse(legacy.enabled)


if __name__ == "__main__":
    unittest.main()
