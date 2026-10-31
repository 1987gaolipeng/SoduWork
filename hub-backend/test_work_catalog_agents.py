"""Work scenarios require capabilities, not concrete Agent implementations."""
from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from app.agent_catalog import AGENTS
from app.services import task_execution_options, work_catalog


def scenario(capabilities):
    return {
        "key": "catalog-fixture", "name": "Catalog fixture", "enabled": True,
        "intentHints": ["fixture"], "requiredCapabilities": capabilities,
        "outputContract": {"summary": "Report", "deliverables": ["report.md"],
                           "acceptance": ["Verified"]},
    }


class ScenarioAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_declared_agent_and_legacy_alias_is_rejected_as_a_capability(self):
        with patch.object(work_catalog, "validate_profession_ids", new=AsyncMock(return_value=[])):
            for agent_id in [*AGENTS, "claude", "claude-code", "claudecode", "claude_code",
                             "qwen_code", "codex_harness", "deepseek_harness"]:
                for spelling in [agent_id, agent_id.upper()]:
                    with self.subTest(agent=spelling), self.assertRaisesRegex(ValueError, "不要绑定"):
                        await work_catalog.validate_scenario(None, scenario(["files", spelling]), None)

    async def test_real_custom_capabilities_are_preserved_and_matched_without_an_agent_allowlist(self):
        required = ["files", "terminal", "repository", "enterprise.research", "custom-skill",
                    "claude-notes", "claude.code", "enterprise.claude-code", "qwen_code_docs"]
        with patch.object(work_catalog, "validate_profession_ids", new=AsyncMock(return_value=[])):
            values = await work_catalog.validate_scenario(None, scenario(required), None)
        self.assertEqual(values["required_capabilities"], required)
        seats = [{"cli": "fixture-acp", "cliName": "Fixture ACP", "online": True,
                  "capabilities": {"available": required}}]
        result = task_execution_options.substrate_options(seats, required)
        self.assertTrue(result[0]["available"])
        self.assertEqual(result[0]["name"], "Fixture ACP")
        seats[0]["capabilities"]["available"] = ["files"]
        self.assertFalse(task_execution_options.substrate_options(seats, required)[0]["available"])

    def test_task_picker_uses_shared_agent_order_and_labels(self):
        seats = [{"cli": key, "cliName": key, "online": True,
                  "capabilities": {"available": ["files"]}} for key in reversed(AGENTS)]
        result = task_execution_options.substrate_options(seats, ["files"])
        self.assertEqual([row["cli"] for row in result],
                         sorted(AGENTS, key=lambda key: AGENTS[key].get("order", 999)))
        for row in result:
            self.assertEqual(row["name"], AGENTS[row["cli"]]["displayName"])
            self.assertTrue(row["available"])


if __name__ == "__main__":
    unittest.main()
