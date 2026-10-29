"""Classification regressions through actual parsing and MCP proposal paths with substituted
dependencies.
"""
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ["AUTH_SECRET"] = "isolated-task-classification-20261016"
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from app.api import task_mcp
from app.services import tasks, work_catalog, llm


class ClassificationEntryTests(unittest.IsolatedAsyncioTestCase):
    async def test_parser_keeps_kind_and_work_scenario_independent(self):
        for kind in ("requirement", "bug", "ticket", "improvement", "other"):
            scene = {"key": "development", "name": "软件研发", "defaultPluginKey": "delivery"}
            with self.subTest(kind=kind), \
                 patch.object(work_catalog, "catalog_for_user", AsyncMock(return_value={"scenarios": [scene]})), \
                 patch.object(tasks, "_flow_choices", AsyncMock(return_value=[])), \
                 patch.object(tasks, "_repo_choices", AsyncMock(return_value=[])), \
                 patch.object(tasks, "_parse_with_my_model", AsyncMock(return_value=json.dumps({"kind": kind, "scene": "development"}))), \
                 patch.object(llm, "chat", AsyncMock()) as fallback:
                parsed = await tasks.parse_task_text(object(), "修复软件问题", SimpleNamespace(user_ref=None))
                self.assertEqual(parsed["kind"], kind)
                self.assertEqual(parsed["scene"], "development")
                fallback.assert_not_awaited()

    async def test_mcp_proposal_preserves_classification_without_creating_task(self):
        with patch.object(tasks, "create_task", AsyncMock()) as create:
            for kind in ("requirement", "bug", "ticket", "improvement", "other"):
                proposed = await task_mcp._call_tool("task_propose", {
                    "title": "分类验证", "kind": kind, "workScenarioKey": "development",
                    "note": "材料" * 2100 + "保留尾部", "agentId": "old-choice", "flow": "old-flow",
                }, object(), object())
                self.assertEqual(proposed["proposal"]["kind"], kind)
                self.assertNotIn("workScenarioKey", proposed["proposal"])
                self.assertTrue(proposed["proposal"]["note"].endswith("保留尾部"))
            create.assert_not_awaited()

    def test_proposal_schema_requests_classification_and_leaves_execution_to_receiver(self):
        tool = next(item for item in task_mcp._TOOLS if item["name"] == "task_propose")
        fields = tool["inputSchema"]["properties"]
        self.assertEqual(fields["kind"]["enum"], ["requirement", "bug", "ticket", "improvement", "other"])
        self.assertNotIn("workScenarioKey", fields)
        self.assertNotIn("agentId", fields)
        self.assertNotIn("flow", fields)


if __name__ == "__main__":
    unittest.main()
