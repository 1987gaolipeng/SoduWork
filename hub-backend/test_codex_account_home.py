"""Native account login never transfers credentials through the Runner."""
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from app.services import codex_account_home as account, codex_runtime_home as runtime


class AccountHomeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-account-home-")
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name

    def activate(self):
        return account.login("native-codex", self.root, say=lambda line: None,
                             execute=lambda argv, env, emit, timeout: 0,
                             status=lambda exe, env: ("authed", "fixture"))

    def test_login_success_selects_private_home_without_reading_source_auth(self):
        calls = []
        with patch.object(runtime, "_sync_auth", side_effect=AssertionError("credentials read")):
            result = account.login("native-codex", self.root, say=calls.append,
                execute=lambda argv, env, emit, timeout: (
                    self.assertEqual(argv, ["native-codex", "login", "--device-auth"]) or
                    self.assertLessEqual(timeout, 300) or 0),
                status=lambda exe, env: ("authed", "fixture"))
            self.assertTrue(result[0])
            env = {"CODEX_HOME": "unreadable-personal-home"}
            selected = runtime.prepare(env, self.root, "new-chat")
        self.assertEqual(selected, account.selected_home(self.root))
        self.assertEqual(env["CODEX_HOME"], selected)
        self.assertFalse(list(Path(self.root).rglob("auth.json")))

    def test_failed_or_unverified_login_does_not_change_selection(self):
        for exit_code, state in [(1, "authed"), (124, "authed"), (0, "unauthed"), (0, "")]:
            result = account.login("native", self.root, say=lambda line: None,
                execute=lambda *args: exit_code, status=lambda *args: (state, ""))
            self.assertFalse(result[0])
            self.assertEqual(account.selected_home(self.root), "")

    def test_existing_conversation_keeps_legacy_home_and_new_ones_bind(self):
        with patch.object(runtime, "_sync_auth") as sync:
            previous = runtime.prepare({}, self.root, "old-chat")
        self.assertTrue(self.activate()[0])
        with patch.object(runtime, "_sync_auth") as sync:
            self.assertEqual(runtime.prepare({}, self.root, "old-chat"), previous)
            sync.assert_called_once()
            env_a, env_b = {}, {}
            first = runtime.prepare(env_a, self.root, "new-chat-a")
            second = runtime.prepare(env_b, self.root, "new-chat-b")
        self.assertEqual(first, second)
        self.assertNotEqual(env_a["TEMP"], env_b["TEMP"])
        self.assertNotEqual(env_a["TEMP"], first)

    def test_binding_survives_missing_global_selection(self):
        self.activate()
        expected = runtime.prepare({}, self.root, "new-chat")
        account.durable_file.remove(account._selection_file(self.root))
        with patch.object(runtime, "_sync_auth", side_effect=AssertionError("must retain binding")):
            self.assertEqual(runtime.prepare({}, self.root, "new-chat"), expected)

    def test_failed_new_binding_can_retry_without_becoming_a_legacy_conversation(self):
        self.activate()
        with patch.object(account.durable_file, "write_bytes", side_effect=OSError("fixture write failure")):
            with self.assertRaises(OSError):
                runtime.prepare({}, self.root, "binding-retry")
        with patch.object(runtime, "_sync_auth", side_effect=AssertionError("must not copy credentials")):
            self.assertEqual(runtime.prepare({}, self.root, "binding-retry"),
                             account.account_home(self.root))

    def test_committed_wal_survives_a_late_binding_write_failure(self):
        self.activate()
        def commit_then_fail(path, value):
            account.durable_file._append(Path(path), value)
            raise OSError("fixture cleanup failure after commit")
        with patch.object(account.durable_file, "write_bytes", side_effect=commit_then_fail):
            with self.assertRaises(OSError):
                runtime.prepare({}, self.root, "binding-committed")
        with patch.object(runtime, "_sync_auth", side_effect=AssertionError("must retain committed home")):
            self.assertEqual(runtime.prepare({}, self.root, "binding-committed"),
                             account.account_home(self.root))

    def test_incomplete_binding_wal_never_falls_back_to_legacy_credentials(self):
        self.activate()
        def incomplete_write(path, value):
            Path(str(path) + ".wal").write_bytes(b"SODUWORK-DURABLE-1\n")
            raise OSError("fixture interruption before commit")
        with patch.object(account.durable_file, "write_bytes", side_effect=incomplete_write):
            with self.assertRaises(OSError):
                runtime.prepare({}, self.root, "binding-incomplete")
        with patch.object(runtime, "_sync_auth", side_effect=AssertionError("must not copy credentials")):
            with self.assertRaisesRegex(RuntimeError, "会话登录目录"):
                runtime.prepare({}, self.root, "binding-incomplete")

    def test_concurrent_login_is_rejected_without_another_process(self):
        nested = []
        def execute(*args):
            nested.append(account.login("native", self.root, say=lambda line: None,
                execute=lambda *args: self.fail("second process")))
            return 0
        result = account.login("native", self.root, say=lambda line: None,
            execute=execute, status=lambda *args: ("authed", ""))
        self.assertTrue(result[0])
        self.assertFalse(nested[0][0])

    def test_only_official_verification_url_and_device_code_are_visible(self):
        shown = []
        for line in ["https://auth.openai.com/codex/device", "  ABCD-EFGH  ",
                     "Bearer secret-token", "https://evil.invalid/codex/device",
                     "https://auth.openai.com/codex/device?token=secret",
                     "{\"access_token\":\"secret\"}"]:
            account.login_progress(line, shown.append)
        self.assertEqual(shown, ["https://auth.openai.com/codex/device", "ABCD-EFGH"])

    def test_error_does_not_expose_exception_text_or_activate(self):
        lines = []
        def fail(*args):
            raise ValueError("secret credential bytes")
        result = account.login("native", self.root, say=lines.append, execute=fail)
        self.assertFalse(result[0])
        self.assertNotIn("secret", str(result) + str(lines))
        self.assertEqual(account.selected_home(self.root), "")

    def test_status_uses_selected_home_and_cannot_fall_back_to_personal_login(self):
        from app.services import agent_setup
        self.activate()
        seen = []
        def probe(key, exe, **options):
            seen.append(options["env"]["CODEX_HOME"])
            return "", "unrecognized"
        with patch.object(agent_setup, "_data_root", return_value=self.root), \
             patch.object(agent_setup, "_bin_of", return_value="native"), \
             patch.object(agent_setup, "_account_auth_probe", side_effect=probe), \
             patch.dict(os.environ, {"OPENAI_API_KEY": "unrelated-personal-key"}):
            result = agent_setup._auth_probe("codex")
        self.assertEqual(result[0], "unauthed")
        self.assertEqual(seen, [account.account_home(self.root)])

    def test_login_action_is_codex_only_and_never_runs_npm(self):
        from app.services import agent_setup
        from app.services import codex_login_flow
        with patch.object(agent_setup, "_spawn") as spawn, \
             patch.object(agent_setup, "_data_root", return_value=self.root), \
             patch.dict(agent_setup._JOBS, {}, clear=True), \
             patch.dict(codex_login_flow._PENDING, {}, clear=True):
            jid = agent_setup.start_install("codex", "login")
            spawn.assert_called_once_with(jid, agent_setup._run_codex_login)
            for key in ["codex-harness", "pi", "opencode", "harness2"]:
                with self.assertRaises(ValueError):
                    agent_setup.start_install(key, "login")

    def test_native_status_environment_is_private_and_does_not_mutate_parent(self):
        from app.services import cli_account_auth
        class Process:
            returncode = 0
            stdout = "Logged in using ChatGPT"
            stderr = ""
        original = dict(os.environ)
        with patch.object(cli_account_auth.subprocess, "run", return_value=Process()) as run:
            self.assertEqual(cli_account_auth.probe("codex", "native",
                env={"CODEX_HOME": "private", "NODE_OPTIONS": "injected"})[0], "authed")
        self.assertEqual(run.call_args.kwargs["env"], {"CODEX_HOME": "private"})
        self.assertEqual(dict(os.environ), original)

    def test_real_child_output_is_filtered_and_deadline_closes_the_process(self):
        env = account.environment(self.root, create=True)
        lines = []
        code = ("import os,time;print('https://auth.openai.com/codex/device',flush=True);"
                "print('ABCD-EFGH',flush=True);print('Bearer synthetic-secret',flush=True);"
                "os.close(1);os.close(2);time.sleep(30)")
        started = time.monotonic()
        result = account._execute([sys.executable, "-c", code], env,
            lambda line: account.login_progress(line, lines.append), 1)
        self.assertEqual(result, 124)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(lines, ["https://auth.openai.com/codex/device", "ABCD-EFGH"])

    def test_real_child_early_exit_finishes_without_waiting_for_login_deadline(self):
        env = account.environment(self.root, create=True)
        started = time.monotonic()
        result = account._execute([sys.executable, "-c", "raise SystemExit(3)"], env,
                                  lambda line: None, 300)
        self.assertEqual(result, 3)
        self.assertLess(time.monotonic() - started, 10)

    def test_real_child_cancel_closes_before_deadline(self):
        cancelled = threading.Event()
        started = time.monotonic()
        result = account._execute([sys.executable, "-c",
            "import time; print('ready',flush=True);time.sleep(30)"],
            account.environment(self.root, create=True), lambda line: cancelled.set(),
            300, cancel_event=cancelled)
        self.assertEqual(result, 130)
        self.assertLess(time.monotonic() - started, 10)

    def test_private_account_chat_and_status_do_not_borrow_environment_api_key(self):
        from app.services import codex_account_acp, local_base
        self.activate()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "personal-key", "CODEX_API_KEY": "other-key",
                                    "CODEX_ACCESS_TOKEN": "temporary-personal-token"}):
            env = account.environment(self.root)
            self.assertFalse("OPENAI_API_KEY" in env, "OPENAI_API_KEY must be absent")
            self.assertFalse("CODEX_API_KEY" in env, "CODEX_API_KEY must be absent")
            self.assertNotIn("CODEX_ACCESS_TOKEN", env)
            env["OPENAI_API_KEY"] = "plugin-key"
            env["CODEX_API_KEY"] = "plugin-key"
            env["CODEX_ACCESS_TOKEN"] = "plugin-token"
            with patch.object(local_base, "_data_root", return_value=self.root):
                codex_account_acp.prepare_env(env,
                    {codex_account_acp.TRANSPORT_KEY: codex_account_acp.TRANSPORT}, "native")
        self.assertFalse("OPENAI_API_KEY" in env, "OPENAI_API_KEY must be absent")
        self.assertFalse("CODEX_API_KEY" in env, "CODEX_API_KEY must be absent")
        self.assertNotIn("CODEX_ACCESS_TOKEN", env)
        self.assertEqual(env["CODEX_SQLITE_HOME"], account.account_home(self.root))

    def test_private_account_credentials_are_isolated_for_both_transports(self):
        from app.services import codex_account_acp, local_base
        self.activate()
        credentials = ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN")
        for transport in ("", codex_account_acp.TRANSPORT):
            with self.subTest(transport=transport), \
                 patch.dict(os.environ, {key: "host-fixture" for key in credentials}, clear=True), \
                 patch.object(local_base, "_data_root", return_value=self.root):
                env = account.environment(self.root)
                for key in credentials:
                    self.assertFalse(key in env, key + " must be absent")
                    env[key] = "plugin-fixture"
                env["CODEX_SQLITE_HOME"] = "plugin-fixture-directory"
                codex_account_acp.prepare_env(env, {codex_account_acp.TRANSPORT_KEY: transport}, "native")
                for key in credentials:
                    self.assertFalse(key in env, key + " must be absent")
                self.assertEqual(env["CODEX_SQLITE_HOME"], account.account_home(self.root))

    def test_plugin_secret_mappings_cannot_override_private_account_authentication(self):
        from app.services import codex_account_acp, local_base
        self.activate()
        targets = ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL")
        for transport in ("", codex_account_acp.TRANSPORT):
            with self.subTest(transport=transport), \
                 patch.dict(os.environ, {"SODUWORK_SYNTHETIC_PLUGIN_SECRET": "fixture-only"}, clear=True), \
                 patch.object(local_base, "_data_root", return_value=self.root), \
                 patch.object(local_base, "_codex_bin", return_value="native"), \
                 patch.object(runtime, "_sync_auth", side_effect=AssertionError("credentials read")):
                cfg = {codex_account_acp.TRANSPORT_KEY: transport,
                       "runtimeSecrets": {key: "SODUWORK_SYNTHETIC_PLUGIN_SECRET" for key in targets}}
                env = local_base._env_for(local_base._PROFILES["codex"], cfg,
                                          runtime_ref="plugin-injection-" + transport)
                for key in targets:
                    self.assertFalse(key in env, key + " must be absent")
                self.assertEqual(env["CODEX_HOME"], account.account_home(self.root))

    def test_retained_pipe_and_failed_kill_cannot_hold_login_forever(self):
        from app.services import acp_process
        for exited in (True, False):
            with self.subTest(exited=exited):
                release, completed = threading.Event(), threading.Event()
                class Pipe:
                    def readline(self, size):
                        release.wait(10)
                        completed.set()
                        return ""
                class Process:
                    pid = 12345678
                    stdin = stderr = None
                    stdout = Pipe()
                    returncode = 0 if exited else None
                    def poll(self):
                        return self.returncode
                started = time.monotonic()
                failure = None if exited else acp_process.ProcessCleanupError("fixture kill failure")
                try:
                    with patch.object(account.subprocess, "Popen", return_value=Process()), \
                         patch.object(acp_process, "kill_process_tree", side_effect=failure):
                        with self.assertRaises(acp_process.ProcessCleanupError):
                            account._execute(["fixture"], {"CODEX_HOME": self.root}, lambda line: None, 1)
                    self.assertLess(time.monotonic() - started, 4)
                finally:
                    release.set()
                    self.assertTrue(completed.wait(1))

    def test_linked_state_directory_is_rejected_before_login_launch(self):
        class Info:
            st_mode = 0
            st_reparse_tag = 0xA0000003
        with patch.object(account.os, "lstat", return_value=Info()):
            result = account.login("native", self.root, say=lambda line: None,
                execute=lambda *args: self.fail("linked account directory launched"))
        self.assertFalse(result[0])

    def test_damaged_mode_never_falls_back_to_personal_source(self):
        self.activate()
        account.durable_file.write_bytes(account._selection_file(self.root), b"broken")
        with patch.object(runtime, "_sync_auth", side_effect=AssertionError("source read")):
            with self.assertRaisesRegex(RuntimeError, "独立登录设置"):
                runtime.prepare({}, self.root, "new-chat")


if __name__ == "__main__":
    unittest.main()
