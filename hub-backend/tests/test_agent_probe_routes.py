"""Probe routing keeps native accounts separate from managed model credentials."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-agent-probe-route-fixture")
os.environ.setdefault("ADMIN_PASS", "isolated-agent-probe-route-fixture")
from fastapi import HTTPException
from app.api import agents


class AgentProbeRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.owner = SimpleNamespace(id="fixture-client", user_ref="fixture-owner")
        self.session = object()
        self.managed = {"base": "https://fixture.invalid/v1", "key": "fixture-key",
                        "model": "glm-fixture", "keyFrom": "mine", "fellBackFrom": "removed"}

    async def test_native_backend_probe_omits_managed_credentials_and_model_claims(self):
        with (patch.object(agents.bus, "enabled", False),
              patch.object(agents.runner_hub, "for_client", return_value=None),
              patch.object(agents.model_catalog, "resolve_for_agent",
                           new=AsyncMock(return_value=self.managed)) as resolve,
              patch.object(agents.agent_setup, "start_probe", return_value="native-job") as start):
            result = await agents.post_agent_probe({"key": "codex", "model": "managed-override"},
                                                   self.owner, self.session)
        self.assertEqual(result, {"jobId": "native-job", "model": "",
                                  "fellBackFrom": "", "keyFrom": ""})
        start.assert_called_once_with("codex", {})
        resolve.assert_not_awaited()

    async def test_native_probe_targets_owned_runner_without_managed_model(self):
        runner = SimpleNamespace(id="fixture-runner", client_id=self.owner.id)
        with (patch.object(agents.runner_hub, "get", return_value=runner),
              patch.object(agents.model_catalog, "resolve_for_agent",
                           new=AsyncMock(return_value=self.managed)) as resolve,
              patch.object(agents, "_runner_call", new=AsyncMock(return_value={"jobId": "native-job"})) as rpc,
              patch.object(agents.agent_setup, "start_probe") as local):
            result = await agents.post_agent_probe({"key": "codex", "runnerId": runner.id},
                                                   self.owner, self.session)
        self.assertEqual(result, {"jobId": "runner|fixture-runner|native-job", "model": "",
                                  "fellBackFrom": "", "keyFrom": ""})
        rpc.assert_awaited_once_with(runner, "agent.probe", {"key": "codex", "llm": {}}, timeout=60)
        resolve.assert_not_awaited()
        local.assert_not_called()

    async def test_native_probe_accepts_personal_cloud_runner_of_same_account(self):
        runner = SimpleNamespace(id="cloud-runner", client_id="", owner_user_id=self.owner.user_ref)
        with (patch.object(agents.runner_hub, "get", return_value=runner),
              patch.object(agents.model_catalog, "resolve_for_agent",
                           new=AsyncMock(return_value=self.managed)) as resolve,
              patch.object(agents, "_runner_call", new=AsyncMock(return_value={"jobId": "cloud-job"})) as rpc):
            result = await agents.post_agent_probe({"key": "codex", "runnerId": runner.id},
                                                   self.owner, self.session)
        self.assertEqual(result["jobId"], "runner|cloud-runner|cloud-job")
        self.assertEqual(result["model"], "")
        rpc.assert_awaited_once_with(runner, "agent.probe", {"key": "codex", "llm": {}}, timeout=60)
        resolve.assert_not_awaited()

    async def test_managed_probes_keep_model_resolution_and_selected_execution_machine(self):
        for key in ("pi", "codex-harness"):
            for remote in (False, True):
                runner = SimpleNamespace(id="fixture-runner", client_id=self.owner.id) if remote else None
                with (self.subTest(key=key, remote=remote),
                      patch.object(agents.bus, "enabled", False),
                      patch.object(agents.runner_hub, "for_client", return_value=None),
                      patch.object(agents.runner_hub, "get", return_value=runner),
                      patch.object(agents.model_catalog, "resolve_for_agent",
                                   new=AsyncMock(return_value=self.managed)) as resolve,
                      patch.object(agents, "_runner_call", new=AsyncMock(return_value={"jobId": "managed-job"})) as rpc,
                      patch.object(agents.agent_setup, "start_probe", return_value="managed-job") as local):
                    result = await agents.post_agent_probe({"key": key, "model": "chosen",
                        "runnerId": "fixture-runner" if remote else ""}, self.owner, self.session)
                    self.assertEqual(result, {"jobId": "runner|fixture-runner|managed-job" if remote else "managed-job",
                        "model": "glm-fixture", "fellBackFrom": "removed", "keyFrom": "mine"})
                    resolve.assert_awaited_once_with(self.session, self.owner, key, "chosen")
                    if remote:
                        rpc.assert_awaited_once_with(runner, "agent.probe", {"key": key, "llm": self.managed}, timeout=60)
                        local.assert_not_called()
                    else:
                        local.assert_called_once_with(key, self.managed)
                        rpc.assert_not_awaited()

    async def test_native_probe_rejects_other_owners_runner_without_starting_work(self):
        for runner in (SimpleNamespace(id="foreign-runner", client_id="other-client"),
                       SimpleNamespace(id="foreign-runner", client_id="", owner_user_id="other-owner")):
            with (self.subTest(runner=runner),
                  patch.object(agents.runner_hub, "get", return_value=runner),
                  patch.object(agents.model_catalog, "resolve_for_agent", new=AsyncMock(return_value=self.managed)),
                  patch.object(agents, "_runner_call", new=AsyncMock()) as rpc,
                  patch.object(agents.agent_setup, "start_probe") as local):
                with self.assertRaises(HTTPException) as raised:
                    await agents.post_agent_probe({"key": "codex", "runnerId": runner.id},
                                                  self.owner, self.session)
                self.assertEqual(raised.exception.status_code, 404)
                rpc.assert_not_awaited()
                local.assert_not_called()


if __name__ == "__main__":
    unittest.main()
