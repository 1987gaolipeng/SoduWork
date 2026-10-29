"""Focused non-network regression tests for collaboration task contracts."""
import unittest
from unittest.mock import AsyncMock, patch

from app.schemas import TaskCreate
from app.services import managed_work_route, work_catalog
from app.services.execution_context import public


class DispatchChoiceTests(unittest.TestCase):
    def test_completion_criteria_survive_remote_runner_and_local_prompt(self):
        from types import SimpleNamespace
        from app.services import ai_local, ai_remote
        from runner_main import _Task
        task = SimpleNamespace(id="requirement", title="Deliver report", note="Research scope",
                               acceptance_criteria=["Include cited sources", "Attach editable report"])
        local_prompt = ai_local._compose(task, {})
        remote_task = _Task(ai_remote._task_payload(task))
        self.assertEqual(remote_task.acceptance_criteria, task.acceptance_criteria)
        self.assertEqual(ai_local._compose(remote_task, {}), local_prompt)
        for criterion in task.acceptance_criteria:
            self.assertIn(criterion, local_prompt)

    def test_only_explicit_unbound_direct_choice_uses_direct(self):
        cases = [
            ({}, False),
            ({"executionContext": {}}, False),
            ({"executionContext": {"strategy": "workflow"}}, False),
            ({"executionContext": {"strategy": "direct"}}, True),
            ({"executionContext": {"strategy": "direct"}, "bindingId": "flow"}, False),
            ({"executionContext": {"strategy": "direct", "plugin": {"bindingId": "flow"}}}, False),
        ]
        for body, expected in cases:
            with self.subTest(body=body):
                self.assertEqual(managed_work_route.direct_requested(body), expected)

    def test_requirement_task_accepts_public_execution_configuration(self):
        value = TaskCreate.model_validate({
            "workRouting": {"executionContext": {"strategy": "direct", "agent": {"id": "local:pi"}, "apiKey": "redacted-test"}},
        })
        saved = public(value.workRouting["executionContext"])
        self.assertEqual(saved["agent"]["id"], "local:pi")
        self.assertNotIn("apiKey", saved)


class TaskContextTests(unittest.IsolatedAsyncioTestCase):
    async def test_recommendation_does_not_erase_chosen_agent_and_model(self):
        with patch.object(work_catalog, "recommend", new=AsyncMock(return_value={})), patch.object(
            work_catalog, "routing_snapshot", return_value={"scenarioKey": "office", "scenarioName": "Office"},
        ):
            result = await work_catalog.enrich_task_data(None, None, {
                "title": "Test", "workRouting": {
                    "executionContext": {
                        "strategy": "direct", "agent": {"id": "local:pi"},
                        "model": "selected-model", "apiKey": "redacted-test",
                    },
                },
            }, org_id="test-org", position_ids=[])
        route = result["workRouting"]
        self.assertEqual(route["selectedStrategy"], "direct")
        self.assertEqual(route["executionContext"]["agent"]["id"], "local:pi")
        self.assertEqual(route["executionContext"]["model"], "selected-model")
        self.assertNotIn("apiKey", route["executionContext"])

    async def test_invalid_metadata_does_not_override_server_recommendation(self):
        with patch.object(work_catalog, "recommend", new=AsyncMock(return_value={})), patch.object(
            work_catalog, "routing_snapshot", return_value={"scenarioKey": "office", "scenarioName": "Office"},
        ):
            result = await work_catalog.enrich_task_data(None, None, {
                "workRouting": {"executionContext": {"strategy": "untrusted", "apiKey": "redacted-test"}},
            }, org_id="test-org", position_ids=[])
        self.assertNotIn("executionContext", result["workRouting"])


if __name__ == "__main__":
    unittest.main()
