"""Binding extraction preserves admission hooks and safe public projections."""
import copy
import os
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app.services import plugin_bindings, plugin_service


class PluginBindingContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_readiness_override_still_guards_creation_without_writes(self):
        version = SimpleNamespace(id="v1", plugin_id="plugin", trust_state="approved",
                                  enabled=True, workflow={"nodes": []}, capability_report={})
        plugin = SimpleNamespace(id="plugin", org_id=None)
        session = SimpleNamespace(get=AsyncMock(return_value=version), add=Mock(),
                                  commit=AsyncMock(), flush=AsyncMock(), refresh=AsyncMock())
        blocked = AsyncMock(return_value={"ok": False, "blockers": ["fixture not ready"]})
        with patch.object(plugin_service, "binding_readiness", blocked):
            with self.assertRaisesRegex(ValueError, "fixture not ready"):
                await plugin_service.save_binding(session, plugin, {"versionId": "v1"})
        blocked.assert_awaited_once()
        session.add.assert_not_called()
        session.commit.assert_not_awaited()
        ready = AsyncMock(return_value={"ok": True})
        with patch.object(plugin_service, "binding_readiness", ready):
            binding = await plugin_service.save_binding(
                session, plugin, {"versionId": "v1", "config": {
                    "execution": {"agentKind": "local:pi"}}}, commit=False, flush=False)
        self.assertTrue(binding.enabled)
        self.assertEqual(binding.config, {"agentKind": "local:pi"})
        ready.assert_awaited_once()
        session.commit.assert_not_awaited()
        session.flush.assert_not_awaited()

    def test_public_projection_keeps_legacy_defaults_without_exposing_extensions(self):
        manifest = {"inputs": [
            {"key": "title", "type": "string", "multiline": True, "default": "draft",
             "privateExtension": {"secret": "never public"}},
            {"key": "enabled", "type": "bool", "default": False},
            {"key": "invalid key", "type": "text"},
        ]}
        before = copy.deepcopy(manifest)
        fields = plugin_service.public_inputs(manifest)
        self.assertEqual([(row["key"], row["type"], row["default"]) for row in fields],
                         [("title", "textarea", "draft"), ("enabled", "boolean", False)])
        self.assertTrue(all("privateExtension" not in row for row in fields))
        self.assertEqual(manifest, before)
        self.assertEqual(fields, plugin_bindings.public_inputs(manifest))

    def test_public_route_never_contains_concrete_runner_or_secret_config(self):
        node = {"key": "build", "name": "Build", "type": "ai", "config": {
            "agentKind": "local:pi", "model": "plugin-model", "runnerId": "private-runner"}}
        result = plugin_service.public_workflow_node(node, {"nodeOverrides": {
            "build": {"execution": {"model": "project-model"}}}})
        self.assertEqual((result["route"]["agentKind"], result["route"]["model"],
                          result["route"]["modelSource"]), ("local:pi", "project-model", "project"))
        self.assertNotIn("private-runner", str(result))
        self.assertNotIn("config", result)


if __name__ == "__main__":
    unittest.main()
