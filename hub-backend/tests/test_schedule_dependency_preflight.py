"""Device-only plugin readiness must not be inferred from Runner availability."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///.smoke-dependency-preflight.db")
from app.services import schedule_execution as subject


class DependencyPreflightTests(unittest.IsolatedAsyncioTestCase):
    def schedule(self, **changes):
        return SimpleNamespace(owner_client_id="owner-device", personal_plugin_key="method",
                               personal_plugin_version_policy="latest", **changes)

    async def test_online_runner_does_not_prove_local_plugin_or_connector_ready(self):
        source = {"mode": "personal", "state": "ready", "message": "ready",
                  "checks": [{"key": "plugin", "state": "ready"},
                             {"key": "runner", "state": "ready"}],
                  "machine": {"id": "runner"}}
        with patch.object(subject, "_preflight_execution", AsyncMock(return_value=source)):
            result = await subject.preflight_execution(None, self.schedule())
        self.assertEqual(result["state"], "waiting")
        self.assertTrue(result["executionReady"])
        self.assertEqual(result["deviceDependencies"], {
            "ownerClientId": "owner-device", "state": "waiting",
            "plugin": {"key": "method", "versionPolicy": "latest", "version": "", "checksum": ""}})
        self.assertFalse(any(row["key"] == "plugin" and row["state"] == "ready" for row in result["checks"]))

    async def test_offline_reason_is_preserved_while_device_dependencies_are_explicit(self):
        source = {"mode": "personal", "state": "waiting", "message": "Runner offline"}
        with patch.object(subject, "_preflight_execution", AsyncMock(return_value=source)):
            result = await subject.preflight_execution(None, self.schedule())
        self.assertFalse(result["executionReady"])
        self.assertEqual(result["message"], "Runner offline")
        self.assertEqual(result["deviceDependencies"]["state"], "waiting")

    async def test_nonpersonal_and_blocked_results_remain_authoritative(self):
        for source in [{"mode": "direct", "state": "ready"}, {"mode": "plugin", "state": "ready"},
                       {"mode": "personal", "state": "blocked", "message": "invalid snapshot"}]:
            with patch.object(subject, "_preflight_execution", AsyncMock(return_value=source)):
                result = await subject.preflight_execution(None, self.schedule())
            self.assertIs(result, source)
            self.assertNotIn("deviceDependencies", result)

    async def test_pinned_contract_comes_from_normalized_schedule_not_plugin_content(self):
        spec = self.schedule(personal_plugin_version="1.2.3", personal_plugin_checksum="a" * 64)
        spec.personal_plugin_version_policy = "pinned"
        with patch.object(subject, "_preflight_execution", AsyncMock(return_value={"mode": "personal", "state": "ready"})):
            result = await subject.preflight_execution(None, spec)
        self.assertEqual(result["deviceDependencies"]["plugin"]["version"], "1.2.3")
        self.assertEqual(result["deviceDependencies"]["plugin"]["checksum"], "a" * 64)

if __name__ == "__main__":
    unittest.main()
