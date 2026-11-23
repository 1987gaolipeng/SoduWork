"""Removed execution runtimes cannot run, while their archived history survives."""
from copy import deepcopy
import importlib.util
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from app.agent_catalog import AGENTS, gateway_model_kinds
from app.services import acp_agents, agent_setup, ai_local, local_base, local_ctx, runner_hub


class RetiredAgentTests(unittest.TestCase):
    def test_active_catalog_and_runtime_profiles_agree(self):
        expected = {"pi", "codex", "codex-harness", "opencode", "qwen", "dsh", "kimi"}
        self.assertEqual(set(AGENTS), expected)
        self.assertEqual(set(local_base._PROFILES), expected)
        self.assertEqual(set(agent_setup._SPECS), expected)
        for key in ("claude", "harness2"):
            self.assertNotIn(key, acp_agents.CATALOG)
            self.assertNotIn("local:" + key, gateway_model_kinds())
            self.assertFalse(agent_setup.can_uninstall(key))
        for name in ("harness2_runtime", "harness2_bridge", "harness2_native",
                     "harness2_engine", "claude_runtime", "agent_native_install"):
            self.assertIsNone(importlib.util.find_spec("app.services." + name))

    def test_retired_install_and_probe_do_not_start_jobs_or_read_credentials(self):
        with patch.object(agent_setup, "_new_job", side_effect=AssertionError("Created a retired job")):
            for key in ("claude", "harness2"):
                for action in ("install", "update", "check", "uninstall"):
                    with self.subTest(key=key, action=action), self.assertRaisesRegex(ValueError, "选择其他底座"):
                        agent_setup.start_install(key, action)
                with self.assertRaisesRegex(ValueError, "选择其他底座"):
                    agent_setup.start_probe(key, {})
                with self.assertRaisesRegex(ValueError, "选择其他底座"):
                    agent_setup.detect(key)
                self.assertFalse(agent_setup.configure(key, {})["ok"])

    def test_stale_runner_inventory_cannot_restore_removed_seats(self):
        rows = [{"key": key, "version": "fixture"} for key in ("claude", "harness2", "qwen")]
        original = deepcopy(rows)
        self.assertEqual(runner_hub.clean_agent_inventory(rows), [rows[-1]])
        self.assertEqual(rows, original)

    def test_retired_dispatch_rejects_explicit_and_default_selections(self):
        for key in ("claude", "harness2"):
            for explicit in (False, True):
                with self.subTest(key=key, explicit=explicit):
                    result = ai_local._dispatch_sync_once(
                        {"local_cli": key}, SimpleNamespace(),
                        assignee={"id": "local:" + key} if explicit else None)
                    self.assertFalse(result["ok"])
                    self.assertEqual(result["code"], "AGENT_UNAVAILABLE")
                    self.assertIn("选择其他底座", result["error"])

    def test_retired_resume_preserves_history_model_and_permissions(self):
        for key in ("claude", "harness2"):
            row = {"cli": key, "cliSid": "previous-native-session", "state": "done",
                   "taskId": "original-task", "model": "original-model",
                   "accessPolicy": {"mode": "readonly", "revision": 4},
                   "lines": [{"kind": "say", "text": "Saved original response"}],
                   "cfg": {"local_cli": key, "llm": {"model": "original-model"}}}
            original = deepcopy(row)
            with patch.dict(local_base._RUNS, {"retired-session": row}, clear=True):
                result = local_ctx.prepare_resume("retired-session", "Continue", {})
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "AGENT_UNAVAILABLE")
            self.assertIn("原会话历史已保留", result["error"])
            self.assertEqual(row, original)


    def test_stale_cloud_inventory_is_hidden_without_mutating_stored_rows(self):
        from app.automation_models import RunnerNode
        from app.services import cloud_environments
        rows = [{"key": key} for key in ("claude", "harness2", "qwen")]
        node = RunnerNode(id="cloud-fixture", agents=deepcopy(rows), host="Fixture", os="macos")
        with patch.object(cloud_environments, "_status", return_value=("offline", "Offline")):
            result = cloud_environments.public(node, None)
        self.assertEqual([row["id"] for row in result["agents"]], ["qwen"])
        self.assertFalse({"claude", "harness2"} & {row["id"] for row in result["availableAgents"]})
        self.assertEqual(node.agents, rows)


class RetiredAgentApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_retired_setup_requests_cannot_reach_credentials_or_remote_runners(self):
        from fastapi import HTTPException
        from app.api import agents
        owner = SimpleNamespace(id="fixture-owner", agent_models={"claude": "old-model"})
        session = SimpleNamespace(commit=AsyncMock())
        with (patch.object(agents, "_pick_runner", side_effect=AssertionError("Retired request reached Runner")),
              patch.object(agents.model_catalog, "resolve_for_agent", new=AsyncMock()) as resolve):
            for key in ("claude", "harness2"):
                for endpoint in (agents.put_agent_model, agents.post_agent_probe, agents.post_agent_configure):
                    with self.subTest(key=key, endpoint=endpoint.__name__), self.assertRaises(HTTPException) as raised:
                        await endpoint({"key": key}, owner, session)
                    self.assertEqual(raised.exception.status_code, 404)
                    self.assertIn("选择其他底座", raised.exception.detail)
                with self.assertRaises(HTTPException):
                    await agents.post_agent_install({"key": key}, owner)
            resolve.assert_not_awaited()
            session.commit.assert_not_awaited()
            self.assertEqual(owner.agent_models, {"claude": "old-model"})


    async def test_legacy_heartbeat_cannot_restore_retired_inventory(self):
        import asyncio
        from contextlib import ExitStack
        import json
        from app.api import runner_ws
        from app.services import cluster_runtime, runner_registry
        from tests.test_runner_heartbeat_persistence import _session_factory

        incoming = asyncio.Queue()
        resolved = asyncio.get_running_loop().create_future()
        rows = [{"key": key} for key in ("claude", "harness2", "qwen")]

        class Socket:
            client = SimpleNamespace(host="127.0.0.1")
            headers = {}
            accept = AsyncMock()
            send_json = AsyncMock()
            close = AsyncMock()

            async def receive_json(self):
                return {"op": "hello", "runnerId": "retired-inventory-fixture"}

            async def receive(self):
                return await incoming.get()

        socket = Socket()
        runner = runner_hub._Runner(socket, {"runnerId": "retired-inventory-fixture", "agents": rows})
        self.assertEqual(runner.agents, [rows[-1]])
        runner._waiters["inventory-barrier"] = resolved
        runner.send = AsyncMock()
        session = SimpleNamespace(commit=AsyncMock())
        with ExitStack() as stack:
            for target, name, replacement in (
                (runner_ws, "SessionLocal", _session_factory(session)),
                (runner_ws, "_auth", AsyncMock(return_value=(True, ""))),
                (runner_ws, "authenticated_identity", AsyncMock(return_value=True)),
                (runner_hub, "add", lambda *args: runner),
                (runner_registry, "record", AsyncMock()),
                (cluster_runtime, "register", AsyncMock()),
                (runner_ws, "_reconcile_runner_restart", AsyncMock()),
                (runner_ws, "_drop_runner", AsyncMock()),
                (runner_ws, "_persist_runner_heartbeat", AsyncMock(return_value=True)),
            ):
                stack.enter_context(patch.object(target, name, replacement))
            handler = asyncio.create_task(runner_ws.runner_ws(socket))
            try:
                await incoming.put({"text": json.dumps({"op": "beat", "agents": rows})})
                await incoming.put({"text": json.dumps({"op": "reply", "id": "inventory-barrier",
                                                       "ok": True, "data": {}})})
                await asyncio.wait_for(asyncio.shield(resolved), 2)
                self.assertEqual(runner.agents, [rows[-1]])
                self.assertTrue(runner.inventory_ready)
                self.assertEqual(rows, [{"key": "claude"}, {"key": "harness2"}, {"key": "qwen"}])
                await incoming.put({"type": "websocket.disconnect"})
                await asyncio.wait_for(handler, 2)
            finally:
                handler.cancel()
                await asyncio.gather(handler, return_exceptions=True)
                if not resolved.done():
                    resolved.cancel()


if __name__ == "__main__":
    unittest.main()
