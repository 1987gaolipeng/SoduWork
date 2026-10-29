"""CICD publication keeps target priority, exact SHA and failure receipts."""
import json
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app import models
from app.services import cicd_workflow, delivery_evidence
from public_source import is_public_snapshot

private_adapter = unittest.skipIf(is_public_snapshot(), "Public snapshot excludes the private CICD adapter")


class CicdPublicationTests(unittest.IsolatedAsyncioTestCase):
    async def test_environment_target_has_priority_over_node_binding_and_legacy_settings(self):
        session = AsyncMock()
        rows = MagicMock()
        rows.scalars.return_value.all.return_value = [NS(
            id="target", environment_id="preprod", provider="cicd-mcp",
            config={"customer": "environment customer"})]
        session.execute.return_value = rows
        session.get.side_effect = [NS(config={"cicdPublish": {"customer": "binding customer"}}),
                                   NS(value=json.dumps({"repo": {"customer": "legacy customer"}}))]
        target = await cicd_workflow._publish_target(
            session, NS(binding_id="binding"),
            {"config": {"cicd": {"customer": "node customer"}}}, NS(id="repo"))
        self.assertEqual(target, {"customer": "environment customer", "targetId": "target",
                                  "environmentId": "preprod"})

    async def test_legacy_setting_remains_readable_without_review_services(self):
        session = AsyncMock()
        session.get.return_value = NS(value=json.dumps({
            "repo": {"customer": "legacy customer", "environment": "test"}}))
        result = await cicd_workflow.legacy_publish_config(session, NS(id="repo"))
        self.assertEqual(result["customer"], "legacy customer")
        session.get.assert_awaited_once_with(models.AppSetting, "gerrit_publish_targets")

    @private_adapter
    async def test_missing_target_is_rejected_before_any_publication(self):
        from app.services import cicd_publish
        with patch.object(cicd_workflow.task_code_targets, "repo_view", new=AsyncMock(return_value=None)), \
                patch.object(cicd_workflow, "_publish_target", new=AsyncMock(return_value=None)), \
                patch.object(cicd_publish, "publish_task", new_callable=AsyncMock) as publish:
            with self.assertRaisesRegex(ValueError, "发布节点没有可用的 CICD 目标"):
                await cicd_workflow.publish_cicd(AsyncMock(), None, None, None, {})
        publish.assert_not_awaited()

    @private_adapter
    async def test_success_pins_upstream_commit_and_keeps_environment_receipt(self):
        from app.services import cicd_publish
        sha = "a" * 40
        session = AsyncMock()
        nr = NS(node_key="publish", input={"dependencies": {"merge": {"commit": sha}}})
        target = {"customer": "fixture", "environment": "test", "targetId": "target",
                  "environmentId": "preprod", "services": [["service", "main"]]}
        outcome = {"ok": True, "shaOk": True, "artifactSha": sha, "deployStatus": "SUCCESS",
                   "result": {"new_version": "v1", "steps": [{"ok": True}], "deployment_id": "d1"}}
        with patch.object(cicd_workflow.task_code_targets, "repo_view", new=AsyncMock(return_value=NS(id="r"))), \
                patch.object(cicd_workflow, "_publish_target", new=AsyncMock(return_value=target)), \
                patch.object(cicd_publish, "publish_task", new=AsyncMock(return_value=outcome)) as publish, \
                patch.object(cicd_workflow.task_events, "record") as record:
            output = await cicd_workflow.publish_cicd(session, NS(id="run"), NS(id="task"), nr, {})
        self.assertEqual(publish.await_args.kwargs["expect_sha"], sha)
        self.assertEqual(publish.await_args.kwargs["services"], [("service", "main")])
        self.assertEqual(output["artifactSha"], sha)
        self.assertEqual(output["targetId"], "target")
        self.assertEqual(output["environmentId"], "preprod")
        self.assertEqual(output["steps"], [{"ok": True}])
        session.commit.assert_awaited_once()
        record.assert_called_once()

    @private_adapter
    async def test_failed_publication_retains_receipt_and_actual_error(self):
        from app.services import cicd_publish
        session = AsyncMock()
        nr = NS(node_key="publish", input={})
        outcome = {"ok": False, "notBuilt": True, "error": "fixture artifact not built",
                   "result": {"new_version": "candidate", "steps": [{"stage": "build", "ok": False}]}}
        with patch.object(cicd_workflow.task_code_targets, "repo_view", new=AsyncMock(return_value=NS(id="r"))), \
                patch.object(cicd_workflow, "_publish_target", new=AsyncMock(return_value={
                    "customer": "fixture", "services": [["service", "main"]]})), \
                patch.object(cicd_publish, "publish_task", new=AsyncMock(return_value=outcome)), \
                patch.object(cicd_workflow.task_events, "record") as record:
            with self.assertRaisesRegex(ValueError, "fixture artifact not built"):
                await cicd_workflow.publish_cicd(session, NS(id="run"), NS(id="task"), nr, {})
        self.assertEqual(nr.output["version"], "candidate")
        self.assertEqual(nr.output["steps"], outcome["result"]["steps"])
        session.commit.assert_awaited_once()
        record.assert_not_called()


class SharedEvidenceTests(unittest.TestCase):
    def test_incomplete_publication_receipt_does_not_pass(self):
        with self.assertRaisesRegex(ValueError, "steps"):
            delivery_evidence.require_evidence("publish", {"customer": "fixture", "version": "v1",
                                                           "deployStatus": "SUCCESS"})

    def test_complete_receipt_keeps_failed_check_facts(self):
        receipt = {"checks": [{"ok": False, "detail": "real failure"}]}
        self.assertIs(delivery_evidence.require_evidence("verify", receipt), receipt)


if __name__ == "__main__":
    unittest.main()
