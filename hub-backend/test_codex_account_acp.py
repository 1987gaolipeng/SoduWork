"""Account Codex routing, credential isolation and recoverable transport contract."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from app.services import access_policy, access_transition, acp_agents, codex_account_acp as account
from app.services import local_base, local_ctx
from app.services.acp_access import BridgeAccess
import test_acp_permission_inputs as permission_inputs


class AccountPermissionInputsTests(permission_inputs.CodexPermissionInputsTests):
    """Run the real permission-envelope suite under account Codex identity too."""
    def setUp(self):
        super().setUp()
        self.access.agent_name = "codex"


class AccountAcpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-account-acp-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.work.mkdir()
        self.policy = access_policy.normalize({"schema": access_policy.SCHEMA,
            "mode": "standard", "revision": 1, "workspaceRoot": str(self.work)})

    def test_versioned_start_uses_acp_and_legacy_start_and_resume_stay_exec(self):
        prof = local_base._PROFILES["codex"]
        cfg = {"accessPolicy": self.policy}
        args = prof["start"]("new", "work", str(self.work), cfg)
        self.assertEqual(cfg[account.TRANSPORT_KEY], account.TRANSPORT)
        self.assertEqual(args[:2], ["--soduwork-session", ""])
        with patch.object(account, "runtime_issue", return_value=""), patch.object(account, "adapter_bin", return_value="acp"):
            command = local_base._command_argv("native-codex", args, str(self.work), cfg, prof)
        self.assertIn("codex", command)
        self.assertEqual(command[-2:], ["--", "acp"])
        self.assertNotIn("danger-full-access", command)
        self.assertNotIn("approval_policy=never", command)
        self.assertEqual(prof["resume"]("saved-acp", "work", str(self.work), cfg)[:2], ["--soduwork-session", "saved-acp"])
        self.assertEqual(prof["start"]("legacy", "work", str(self.work), {})[0], "exec")
        self.assertEqual(prof["resume"]("old", "work", str(self.work), {})[:3], ["exec", "resume", "old"])
        with self.assertRaisesRegex(ValueError, "Codex"):
            prof["resume"]("old-exec", "work", str(self.work), {"accessPolicy": self.policy})

    def test_account_environment_ignores_company_gateway_and_preserves_personal_login(self):
        cfg = {account.TRANSPORT_KEY: account.TRANSPORT, "accessPolicy": self.policy,
               "llm": {"key": "company-secret", "base": "https://company.invalid", "model": "managed"}}
        original = {"OPENAI_API_KEY": "personal-key"}
        env = {"CODEX_HOME": "isolated-account-home", "DEFAULT_AUTH_REQUEST": "company-auth",
               "CODEX_CONFIG": "company-config", "MODEL_PROVIDER": "custom-gateway",
               "SODUWORK_LLM_KEY": "company-secret", "OPENAI_API_KEY": "plugin-key",
               "OPENAI_BASE_URL": "https://company.invalid", "INITIAL_AGENT_MODE": "agent-full-access"}
        with patch.dict(os.environ, original, clear=True):
            account.prepare_env(env, cfg, "native-codex")
        self.assertEqual(env["OPENAI_API_KEY"], "personal-key")
        self.assertEqual(env["CODEX_HOME"], "isolated-account-home")
        self.assertEqual(env["CODEX_PATH"], "native-codex")
        self.assertEqual(env["INITIAL_AGENT_MODE"], "read-only")
        for key in ["DEFAULT_AUTH_REQUEST", "MODEL_PROVIDER", "SODUWORK_LLM_KEY", "OPENAI_BASE_URL"]:
            self.assertNotIn(key, env)
        self.assertNotIn("company", json.dumps(env))
        with patch.dict(os.environ, {}, clear=True):
            account.prepare_env(env, cfg, "native-codex")
        self.assertNotIn("OPENAI_API_KEY", env)

    def test_native_modes_require_ack_and_account_permissions_use_same_broker(self):
        channel = json.dumps({"url": "http://127.0.0.1:1", "token": "fixture", "policy": self.policy})
        access = BridgeAccess(channel, agent_name="codex")
        class Bridge:
            agent_name = "codex"
            session_id = "native-id"
            def request(self, method, args):
                self.called = (method, args)
                return {}
        bridge = Bridge()
        calls = []
        access.call = lambda endpoint, payload: calls.append((endpoint, payload)) or {"ok": True}
        modes = {"modes": {"availableModes": [{"id": v} for v in ["read-only", "agent", "agent-full-access"]]}}
        for mode, native in [("standard", "agent"), ("readonly", "read-only"), ("full", "agent-full-access")]:
            access.mode = mode
            access.apply(bridge, modes)
            self.assertEqual(bridge.called, ("session/set_mode", {"sessionId": "native-id", "modeId": native}))
        with self.assertRaisesRegex(Exception, "requested permission mode"):
            access.apply(bridge, {"modes": {"availableModes": []}})
        self.assertEqual(len(calls), 3)

    def test_legacy_transport_policy_changes_are_rejected_before_state_mutation(self):
        run = {"cli": "codex", "cliSid": "exec-id", "ws": str(self.work), "state": "done", "cfg": {}}
        with patch.dict(local_base._RUNS, {"legacy": run}):
            for call in [access_policy.schedule, access_transition.apply]:
                result = call("legacy", self.policy, 0)
                self.assertFalse(result["ok"])
                self.assertNotIn("accessPolicy", run)
            result = local_ctx.prepare_resume("legacy", "continue", {"accessPolicy": self.policy})
            self.assertEqual(result["code"], "ACCESS_TRANSPORT_MIGRATION_REQUIRED")
            self.assertEqual(run["cliSid"], "exec-id")
            self.assertEqual(run["state"], "done")

    def test_transport_marker_survives_disk_without_saving_credentials(self):
        cfg = {account.TRANSPORT_KEY: account.TRANSPORT, "accessPolicy": self.policy,
               "llm": {"key": "never-persist"}}
        run = {"cli": "codex", "cliSid": "acp-id", "ws": str(self.work), "state": "done", "cfg": cfg,
               "accessPolicy": self.policy}
        with patch.dict(local_base._RUNS, {"account": run}), patch.object(local_base, "_STORE", str(self.root / "runs")):
            local_base._save_meta("account")
            raw = Path(local_base._store_dir("account"), "meta.json").read_text(encoding="utf-8")
            self.assertEqual(json.loads(raw)["codexTransport"], account.TRANSPORT)
            self.assertNotIn("never-persist", raw)
            local_base._RUNS.pop("account")
            restored = local_base.rehydrate("account")
            self.assertEqual(restored["cfg"][account.TRANSPORT_KEY], account.TRANSPORT)
            self.assertEqual(account.legacy_policy_issue(restored, self.policy), "")

    def test_snapshot_without_cfg_preserves_marker_but_explicit_legacy_start_clears_it(self):
        run = {"cli": "codex", "codexTransport": account.TRANSPORT, "state": "done"}
        with patch.dict(local_base._RUNS, {"snapshot": run}), patch.object(local_base, "_STORE", str(self.root / "runs")):
            local_base._save_meta("snapshot")
            self.assertEqual(run["codexTransport"], account.TRANSPORT)
            run["cfg"] = {}
            account.start_args("legacy-new", "work", str(self.work), run["cfg"])
            local_base._save_meta("snapshot")
            self.assertEqual(run["codexTransport"], "")

    def test_completed_turn_scrubs_credentials_but_next_turn_restores_same_acp_session(self):
        from app.services import local_stream
        run = {"cli": "codex", "cliSid": "native-acp-saved", "codexTransport": account.TRANSPORT,
               "ws": str(self.work), "state": "done", "round": 1, "mode": "work",
               "accessPolicy": self.policy, "cfg": {account.TRANSPORT_KEY: account.TRANSPORT,
               "llm": {"key": "must-disappear"}, "runtimeSecrets": {"token": "secret"}}}
        with patch.dict(local_base._RUNS, {"completed": run}), \
             patch.object(local_ctx, "_save_meta"), patch.object(local_stream, "_spawn") as spawn, \
             patch.dict(local_base._PROFILES["codex"], {"bin": lambda: "codex"}):
            local_stream._scrub_runtime_config("completed")
            self.assertEqual(run["cfg"], {account.TRANSPORT_KEY: account.TRANSPORT})
            # Also recover already-scrubbed records created before this fix.
            run["cfg"] = {}
            result = local_ctx.prepare_resume("completed", "second user turn", {"accessPolicy": self.policy})
            self.assertTrue(result["ok"], result)
            self.assertEqual(run["round"], 2)
            self.assertEqual(spawn.call_args.args[1][:2], ["--soduwork-session", "native-acp-saved"])
            self.assertEqual(run["cfg"][account.TRANSPORT_KEY], account.TRANSPORT)
            self.assertNotIn("llm", run["cfg"])

    def test_fresh_marker_cannot_upgrade_a_legacy_execution(self):
        run = {"cli": "codex", "cliSid": "old-exec", "ws": str(self.work), "state": "done", "cfg": {}}
        with patch.dict(local_base._RUNS, {"legacy-marker": run}):
            result = local_ctx.prepare_resume("legacy-marker", "next", {
                "accessPolicy": self.policy, account.TRANSPORT_KEY: account.TRANSPORT})
        self.assertEqual(result["code"], "ACCESS_TRANSPORT_MIGRATION_REQUIRED")
        self.assertEqual(run["cfg"], {})

    def test_actual_env_builder_protects_isolated_home_from_plugin_env(self):
        from app.services import codex_runtime_home
        cfg = {account.TRANSPORT_KEY: account.TRANSPORT, "accessPolicy": self.policy,
               "runtimeSecrets": {"CODEX_HOME": "PLUGIN_HOME", "OPENAI_API_KEY": "PLUGIN_KEY"}}
        with patch.dict(os.environ, {"PLUGIN_HOME": "untrusted", "PLUGIN_KEY": "plugin-key"}, clear=True), \
             patch.object(codex_runtime_home, "prepare", return_value="isolated-account"), \
             patch.object(local_base, "_codex_bin", return_value="native-codex"):
            env = local_base._env_for(local_base._PROFILES["codex"], cfg, runtime_ref="account")
        self.assertEqual(env["CODEX_HOME"], "isolated-account")
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertEqual(env["CODEX_PATH"], "native-codex")

    def test_codex_install_includes_shared_permission_adapter_without_removing_it_on_uninstall(self):
        from app.services import agent_setup
        commands = []
        with patch.object(agent_setup, "node_env", return_value={"ok": True, "nodePath": "node", "npmPath": "npm"}), \
             patch.object(agent_setup.agent_npm_runtime, "environment", return_value={}), \
             patch.object(agent_setup.agent_npm_runtime, "activate_environment"), \
             patch.object(agent_setup, "_stream", side_effect=lambda jid, argv, **kw: (commands.append(argv) or (0, ""))), \
             patch.object(agent_setup, "_say"), patch.object(agent_setup, "_done"), \
             patch.object(agent_setup, "_runtime_issue", return_value=""), \
             patch.object(agent_setup, "_pkg_version", return_value="1.0"), \
             patch.object(agent_setup, "_bin_of", return_value="native"), \
             patch.object(agent_setup, "_short", return_value="1.0"):
            agent_setup._run_npm("fixture", "codex", "update")
            agent_setup._run_npm("fixture", "codex", "uninstall")
        self.assertEqual([argv[-1] for argv in commands[:2]], ["@openai/codex", account.PACKAGE])
        self.assertEqual(commands[-1][-3:], ["uninstall", "-g", "@openai/codex"])

    def test_missing_adapter_fails_actionably_without_falling_back_to_exec(self):
        with patch.object(account, "adapter_bin", return_value=""):
            issue = account.runtime_issue()
            self.assertIn("Codex", issue)
            with self.assertRaisesRegex(RuntimeError, "Codex"):
                account.command_argv("native", ["--soduwork-session", ""], str(self.work),
                                     {"accessPolicy": self.policy, account.TRANSPORT_KEY: account.TRANSPORT})


if __name__ == "__main__":
    unittest.main()
