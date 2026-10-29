"""Explicit native login stays on the selected authorized execution machine."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
from fastapi import HTTPException
from app.api import agents
from app.services import agent_setup
import runner_main


class CodexLoginRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_routes_only_the_exact_owned_machine_and_job(self):
        runner = SimpleNamespace(id="selected")
        owner = SimpleNamespace(id="owner")
        with (patch.object(agents, "_pick_runner", return_value=runner),
              patch.object(agents, "_runner_call", new=AsyncMock(return_value={
                  "jobId": "native", "cancelled": True, "state": "cancelling"})) as rpc):
            result = await agents.post_agent_install({"key": "codex", "action": "login-cancel",
                "runnerId": "selected", "jobId": "runner|selected|native"}, owner)
            self.assertEqual(result, {"jobId": "runner|selected|native", "cancelled": True,
                                      "state": "cancelling"})
            rpc.assert_awaited_once_with(runner, "agent.install", {
                "key": "codex", "action": "login-cancel", "jobId": "native", "ownerId": "owner"}, timeout=60)
            rpc.reset_mock()
            for invalid in ("", "native", "runner|other|native", "runner|selected|"):
                with self.subTest(invalid=invalid), self.assertRaises(HTTPException):
                    await agents.post_agent_install({"key": "codex", "action": "login-cancel",
                        "runnerId": "selected", "jobId": invalid}, owner)
            rpc.assert_not_awaited()

    async def test_local_cancel_preserves_client_ownership(self):
        owner = SimpleNamespace(id="owner")
        with (patch.object(agents, "_pick_runner", return_value=None),
              patch.object(agent_setup, "cancel_login", return_value={"jobId": "native",
                  "cancelled": False, "state": "done"}) as cancel):
            await agents.post_agent_install({"key": "codex", "action": "login-cancel",
                "jobId": "native"}, owner)
        cancel.assert_called_once_with("native", owner_id="owner")

    async def test_runner_cancel_does_not_create_another_job(self):
        with (patch.object(agent_setup, "cancel_login", return_value={"jobId": "native",
                "cancelled": True, "state": "cancelling"}) as cancel,
              patch.object(agent_setup, "start_install") as start):
            result = await runner_main.Runner._agent(SimpleNamespace(), {"op": "agent.install",
                "key": "codex", "action": "login-cancel", "jobId": "native"})
        self.assertTrue(result["ok"])
        cancel.assert_called_once_with("native", owner_id="")
        start.assert_not_called()

    async def test_hub_rejects_login_for_enterprise_harness_before_routing(self):
        with patch.object(agents, "_pick_runner") as pick:
            with self.assertRaises(HTTPException) as raised:
                await agents.post_agent_install({"key": "codex-harness", "action": "login"}, SimpleNamespace(id="owner"))
        self.assertEqual(raised.exception.status_code, 400)
        pick.assert_not_called()

    async def test_hub_uses_existing_owner_check_and_preserves_selected_machine(self):
        runner = SimpleNamespace(id="selected-runner")
        owner = SimpleNamespace(id="owner")
        with (patch.object(agents, "_pick_runner", return_value=runner) as pick,
              patch.object(agents, "_runner_call", new=AsyncMock(return_value={"jobId": "native-login"})) as rpc,
              patch.object(agent_setup, "start_install") as local):
            result = await agents.post_agent_install({"key": "codex", "action": "login", "runnerId": runner.id}, owner)
        pick.assert_called_once_with(owner, runner.id)
        rpc.assert_awaited_once_with(runner, "agent.install", {"key": "codex", "action": "login", "ownerId": "owner"}, timeout=60)
        self.assertEqual(result["jobId"], "runner|selected-runner|native-login")
        local.assert_not_called()

    async def test_runner_only_allows_explicit_native_login_without_npm(self):
        instance = SimpleNamespace()
        with (patch.object(agent_setup, "start_install", return_value="login-job") as start,
              patch.object(agent_setup, "node_env", side_effect=AssertionError("Native login must not install Node"))):
            rejected = await runner_main.Runner._agent(instance, {"op": "agent.install", "key": "codex-harness", "action": "login"})
            self.assertFalse(rejected["ok"])
            start.assert_not_called()
            accepted = await runner_main.Runner._agent(instance, {"op": "agent.install", "key": "codex", "action": "login"})
            self.assertTrue(accepted["ok"])
            start.assert_called_once_with("codex", "login", owner_id="")

    async def test_local_polling_rejects_other_clients_login(self):
        with patch.dict(agent_setup._JOBS, {"secret-job": {"id": "secret-job", "key": "codex",
            "action": "login", "state": "running", "_owner": "owner",
            "auth": {"state": "waiting", "userCode": "ABCD-EFGH"}}}, clear=True), \
             patch.object(agents.bus, "enabled", False):
            with self.assertRaises(HTTPException) as raised:
                await agents.get_agent_job("secret-job", SimpleNamespace(id="other"))
            self.assertEqual(raised.exception.status_code, 404)
            allowed = await agents.get_agent_job("secret-job", SimpleNamespace(id="owner"))
            self.assertEqual(allowed["auth"]["userCode"], "ABCD-EFGH")
            self.assertNotIn("_owner", allowed)


if __name__ == "__main__":
    unittest.main()
