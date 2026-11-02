"""Codex authorization reuses an existing login and has a bounded lifecycle."""
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from app.services import codex_login_flow as flow


class CodexLoginFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-login-flow-")
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        self.environment = {"CODEX_HOME": self.root}

    def run_flow(self, states, execute=None, jid="fixture"):
        updates = []
        self.assertTrue(flow.reserve(jid, self.root))
        with patch.object(flow, "environment", return_value=self.environment), \
             patch.object(flow.account, "status", side_effect=[(state, "") for state in states]):
            result = flow.run(jid, "native", self.root, publish=updates.append,
                              execute=execute or (lambda *args, **kwargs: 0))
        return result, updates

    def test_existing_login_never_opens_device_authorization(self):
        def forbidden(*args, **kwargs):
            self.fail("Existing login must be reused")
        result, updates = self.run_flow(["authed"], forbidden)
        self.assertTrue(result[0])
        self.assertEqual(updates[-1], {"state": "succeeded", "reused": True})
        self.assertFalse(list(Path(self.root).rglob("auth.json")))

    def test_unknown_auth_is_not_misreported_as_needing_login(self):
        result, updates = self.run_flow([""], lambda *args, **kwargs: self.fail("Unknown is not unauthed"))
        self.assertFalse(result[0])
        self.assertEqual(updates[-1]["state"], "failed")
        self.assertNotIn("userCode", str(updates))
        self.assertEqual(updates[-1]["reason"], "status_unavailable")

    def test_first_connection_prepares_empty_home_before_native_status(self):
        home = Path(self.root) / "new-native-account"
        self.environment = {"CODEX_HOME": str(home)}
        checked, launched, updates = [], [], []

        def status(executable, env):
            self.assertEqual(executable, "native")
            checked.append(Path(env["CODEX_HOME"]).is_dir())
            if not checked[-1]:
                return "", "Native configuration cannot load a missing home"
            return ("authed" if launched else "unauthed"), ""

        def execute(argv, env, emit, timeout, **options):
            self.assertEqual(checked, [True])
            self.assertEqual(list(home.iterdir()), [], "Preparing a home must not create or copy credentials")
            self.assertEqual(argv, ["native", "login", "--device-auth"])
            launched.append(True)
            return 0

        self.assertFalse(home.exists())
        self.assertTrue(flow.reserve("fresh-home", self.root))
        with patch.object(flow, "environment", return_value=self.environment), \
                patch.object(flow.account, "status", side_effect=status):
            result = flow.run("fresh-home", "native", self.root, publish=updates.append, execute=execute)
        self.assertTrue(result[0], result)
        self.assertEqual(checked, [True, True])
        self.assertEqual(updates[-1], {"state": "succeeded", "reused": False})
        self.assertEqual(list(home.iterdir()), [])

    def test_preparing_home_does_not_turn_unknown_status_into_missing_auth(self):
        home = Path(self.root) / "unknown-native-account"
        self.environment = {"CODEX_HOME": str(home)}
        result, updates = self.run_flow([""], lambda *args, **kwargs: self.fail("Unknown cannot start authorization"))
        self.assertFalse(result[0])
        self.assertEqual(updates[-1], {"state": "failed", "reason": "status_unavailable"})
        self.assertTrue(home.is_dir())
        self.assertEqual(list(home.iterdir()), [])

    def test_home_creation_permission_error_has_stable_reason_without_native_launch(self):
        self.environment = {"CODEX_HOME": str(Path(self.root) / "blocked-native-account")}
        self.assertTrue(flow.reserve("blocked-home", self.root))
        updates = []
        with patch.object(flow, "environment", return_value=self.environment), \
                patch.object(flow.os, "makedirs", side_effect=PermissionError("secret path")), \
                patch.object(flow.account, "status") as status, \
                patch.object(flow.account, "_execute") as execute:
            result = flow.run("blocked-home", "native", self.root, publish=updates.append)
        self.assertFalse(result[0])
        self.assertEqual(updates[-1], {"state": "failed", "reason": "access_denied"})
        self.assertNotIn("secret", str(result) + str(updates))
        status.assert_not_called()
        execute.assert_not_called()
        self.assertNotIn("blocked-home", flow._PENDING)

    def test_cancel_during_environment_resolution_prevents_home_creation(self):
        home = Path(self.root) / "cancelled-before-home"
        def environment(data_root):
            self.assertTrue(flow.cancel("cancel-before-home", data_root))
            return {"CODEX_HOME": str(home)}
        self.assertTrue(flow.reserve("cancel-before-home", self.root))
        with patch.object(flow, "environment", side_effect=environment), \
                patch.object(flow.account, "status") as status, \
                patch.object(flow.account, "_execute") as execute:
            result = flow.run("cancel-before-home", "native", self.root, publish=lambda _: None)
        self.assertEqual(result[2], 130)
        self.assertFalse(home.exists())
        status.assert_not_called()
        execute.assert_not_called()

    def test_cancel_during_home_creation_prevents_native_status_and_authorization(self):
        home = Path(self.root) / "cancelled-after-home"
        create = os.makedirs
        def makedirs(path, **kwargs):
            create(path, **kwargs)
            self.assertTrue(flow.cancel("cancel-after-home", self.root))
        self.assertTrue(flow.reserve("cancel-after-home", self.root))
        with patch.object(flow, "environment", return_value={"CODEX_HOME": str(home)}), \
                patch.object(flow.os, "makedirs", side_effect=makedirs), \
                patch.object(flow.account, "status") as status, \
                patch.object(flow.account, "_execute") as execute:
            result = flow.run("cancel-after-home", "native", self.root, publish=lambda _: None)
        self.assertEqual(result[2], 130)
        self.assertTrue(home.is_dir())
        self.assertEqual(list(home.iterdir()), [])
        status.assert_not_called()
        execute.assert_not_called()

    def test_failure_reasons_never_expose_native_stderr(self):
        for error, reason in ((PermissionError("secret path"), "access_denied"),
                              (FileNotFoundError("secret path"), "runtime_missing"),
                              (ValueError("secret token"), "connection_failed")):
            def execute(*args, **kwargs):
                raise error
            with self.subTest(reason=reason):
                result, updates = self.run_flow(["unauthed"], execute)
                self.assertFalse(result[0])
                self.assertEqual(updates[-1], {"state": "failed", "reason": reason})
                self.assertNotIn("secret", str(result) + str(updates))

    def test_discovery_does_not_treat_unknown_native_status_as_authenticated(self):
        from app.services import agent_setup
        with patch.object(flow.account, "selected_home", return_value=""), \
                patch.object(agent_setup, "_bin_of", return_value="fixture"), \
                patch.object(agent_setup, "_account_auth_probe", return_value=("", "")), \
                patch.dict(os.environ, {"OPENAI_API_KEY": "not-proof-of-native-login"}), \
                patch.object(flow.os, "makedirs") as makedirs, \
                patch.object(agent_setup.os.path, "isfile", side_effect=AssertionError("Do not inspect credentials")):
            self.assertEqual(agent_setup._auth_probe("codex"), ("", ""))
        makedirs.assert_not_called()

    def test_device_progress_is_structured_and_never_contains_arbitrary_output(self):
        def execute(argv, env, emit, timeout, **options):
            self.assertEqual(argv, ["native", "login", "--device-auth"])
            self.assertLessEqual(timeout, 300)
            self.assertIsInstance(options["cancel_event"], threading.Event)
            for line in ["Bearer synthetic-secret", "https://evil.invalid/", "https://auth.openai.com/codex/device", "ABCD-EFGH"]:
                emit(line)
            return 0
        result, updates = self.run_flow(["unauthed", "authed"], execute)
        self.assertTrue(result[0])
        waiting = next(item for item in updates if item.get("userCode"))
        self.assertEqual(waiting["verificationUrl"], "https://auth.openai.com/codex/device")
        self.assertEqual(waiting["userCode"], "ABCD-EFGH")
        self.assertIsInstance(waiting["expiresAt"], (int, float))
        self.assertNotIn("synthetic-secret", str(updates))
        self.assertNotIn("evil.invalid", str(updates))
        self.assertEqual(updates[-1], {"state": "succeeded", "reused": False})

    def test_timeout_and_failed_verification_never_report_success(self):
        for index, (code, states, expected) in enumerate([(124, ["unauthed"], "expired"),
                                                        (1, ["unauthed"], "failed"),
                                                        (0, ["unauthed", "unauthed"], "failed")]):
            result, updates = self.run_flow(states, lambda *args, **kw: code, jid=f"case-{index}")
            self.assertFalse(result[0])
            self.assertEqual(updates[-1]["state"], expected)

    def test_cancel_is_bound_to_original_job_and_prevents_any_launch(self):
        self.assertTrue(flow.reserve("first", self.root))
        self.assertFalse(flow.reserve("duplicate", self.root))
        self.assertFalse(flow.cancel("wrong", self.root))
        self.assertTrue(flow.cancel("first", self.root))
        with patch.object(flow, "environment", side_effect=AssertionError("Cancelled before start")):
            result = flow.run("first", "native", self.root, publish=lambda state: None)
        self.assertEqual(result[2], 130)
        self.assertTrue(flow.reserve("next", self.root))
        self.assertFalse(flow.cancel("first", self.root))
        self.assertTrue(flow.cancel("next", self.root))
        flow.run("next", "native", self.root, publish=lambda state: None)

    def test_cancellation_racing_success_wins_before_completion(self):
        def execute(*args, **options):
            flow.cancel("fixture", self.root)
            return 0
        result, updates = self.run_flow(["unauthed"], execute)
        self.assertEqual(result[2], 130)
        self.assertEqual(updates[-1], {"state": "cancelled"})

    def test_cancel_after_commit_is_not_acknowledged_as_successful(self):
        self.assertTrue(flow.reserve("commit", self.root))
        accepted, updates = [], []
        with patch.object(flow.account, "status", return_value=("authed", "")), \
             patch.object(flow.account, "activate", side_effect=lambda root: accepted.append(flow.cancel("commit", root))):
            result = flow.run("commit", "native", self.root, isolated=True, publish=updates.append)
        self.assertTrue(result[0])
        self.assertEqual(accepted, [False])
        self.assertEqual(updates[-1]["state"], "succeeded")

    def test_exception_text_is_not_exposed_and_reservation_is_released(self):
        def fail(*args, **kwargs):
            raise ValueError("secret-token")
        result, updates = self.run_flow(["unauthed"], fail)
        self.assertFalse(result[0])
        self.assertNotIn("secret-token", str(result) + str(updates))
        self.assertTrue(flow.reserve("retry", self.root))
        flow.cancel("retry", self.root)
        flow.run("retry", "native", self.root, publish=lambda state: None)

    def test_default_environment_uses_original_home_without_mutating_parent(self):
        with patch.dict(os.environ, {"CODEX_HOME": self.root, "CODEX_CONFIG": "private-gateway",
                                     "SODUWORK_LLM_KEY": "not-native"}):
            before = dict(os.environ)
            actual = flow.environment(self.root)
            self.assertEqual(actual["CODEX_HOME"], self.root)
            self.assertNotIn("CODEX_CONFIG", actual)
            self.assertNotIn("SODUWORK_LLM_KEY", actual)
            self.assertEqual(dict(os.environ), before)

    def test_private_login_activates_only_after_explicit_verified_success(self):
        for index, (code, expected) in enumerate([(0, True), (1, False), (124, False), (130, False)]):
            jid = f"private-{index}"
            self.assertTrue(flow.reserve(jid, self.root))
            with (patch.object(flow, "environment", side_effect=AssertionError("Original home must not be used")),
                  patch.object(flow.account, "status", side_effect=[("unauthed", ""), ("authed", "")]),
                  patch.object(flow.account, "activate") as activate):
                result = flow.run(jid, "native", self.root, isolated=True,
                    publish=lambda value: None, execute=lambda *args, **kwargs: code)
                self.assertEqual(result[0], expected)
                self.assertEqual(activate.call_count, int(expected))

    def test_service_cancel_preserves_owner_and_does_not_prune_running_login(self):
        from app.services import agent_setup as setup
        with (patch.dict(setup._JOBS, {}, clear=True), patch.dict(flow._PENDING, {}, clear=True),
              patch.object(setup, "_data_root", return_value=self.root), patch.object(setup, "_spawn")):
            jid = setup.start_install("codex", "login-isolated", owner_id="owner")
            for unused in range(35):
                other = setup._new_job("pi", "check")
                setup._done(other, True, "done")
            self.assertIsNotNone(setup.job(jid))
            with self.assertRaises(ValueError):
                setup.cancel_login(jid, owner_id="other")
            self.assertTrue(setup.cancel_login(jid, owner_id="owner")["cancelled"])
            setup._run_codex_login(jid)
            result = setup.job(jid)
            self.assertEqual(result["auth"], {"state": "cancelled"})
            self.assertEqual(result["code"], 130)
            self.assertNotIn("_owner", result)
            self.assertEqual(setup.cancel_login(jid, owner_id="owner")["state"], "done")


if __name__ == "__main__":
    unittest.main()
