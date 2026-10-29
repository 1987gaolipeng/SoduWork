"""Desktop lease ownership at the real Runner process-launch boundary."""
from __future__ import annotations
from contextlib import ExitStack
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix="soduwork-desktop-scope-")
os.environ["SODUWORK_DATA_ROOT"] = DATA.name
from app.services import local_process


class DesktopScopeTests(unittest.TestCase):
    def launch(self, ref, run, env):
        captured, failures = [], []
        finished = threading.Event()
        def process(*args, **kwargs):
            captured.append(kwargs["env"].copy())
            # Stop before launching a native agent or touching any desktop.
            raise RuntimeError("isolated launch boundary reached")
        with ExitStack() as stack:
            for target, value in (
                ("_RUNS", {ref: run}), ("_env_for", lambda *a, **kw: dict(env)),
                ("_command_argv", lambda *a: ["fixture"]), ("_save_meta", lambda *a: None),
                ("_store_dir", lambda *a: DATA.name), ("_append_raw", lambda *a: None)):
                stack.enter_context(patch.object(local_process, target, value))
            stack.enter_context(patch.object(local_process.subprocess, "Popen", process))
            stack.enter_context(patch.object(local_process.local_spool, "prepare", return_value=({"id": "fixture"}, ["fixture"])))
            stack.enter_context(patch.object(local_process.local_spool, "cleanup"))
            stack.enter_context(patch("app.services.access_broker.attach"))
            stack.enter_context(patch("app.services.access_broker.close"))
            local_process.spawn("fixture", [], "", DATA.name, ref, {}, {},
                gate_check=lambda *a: "", on_line=lambda *a, **kw: None,
                finish=lambda *a: (failures.append(a), finished.set()), kill_tree=lambda *a: None)
            self.assertTrue(finished.wait(4), "spawn did not finish within the bounded fixture")
        self.assertEqual(len(captured), 1)
        self.assertEqual(len(failures), 1)
        return captured[0]

    def test_turn_scope_survives_internal_recovery_and_changes_for_next_user(self):
        ref, env = "same-runner-session", {"SODUWORK_DESKTOP_CONTROL_ENDPOINT": "fixture-endpoint.json"}
        initial = self.launch(ref, {"round": 1, "started": 1}, env)
        resumed = self.launch(ref, {"round": 1, "started": 1, "_accessTransition": {}}, env)
        compacted = self.launch(ref, {"round": 1, "started": 200, "segment": 2}, env)
        following = self.launch(ref, {"round": 2, "started": 300}, env)
        key = "SODUWORK_DESKTOP_CONTROL_SCOPE"
        self.assertEqual(initial[key], "runner:same-runner-session:1")
        self.assertEqual(initial[key], resumed[key])
        self.assertEqual(initial[key], compacted[key])
        self.assertEqual(following[key], "runner:same-runner-session:2")
        self.assertEqual(following["SODUWORK_DESKTOP_CONTROL_ENDPOINT"], env["SODUWORK_DESKTOP_CONTROL_ENDPOINT"])

    def test_concurrent_session_identity_cannot_inherit_parent_scope(self):
        env = {"soduwork_desktop_control_scope": "pi:wrong:1", "SODUWORK_DESKTOP_CONTROL_SCOPE": "runner:stale:2"}
        first = self.launch("a", {"round": 3}, env)
        second = self.launch("b", {"round": 3}, env)
        self.assertEqual(first["SODUWORK_DESKTOP_CONTROL_SCOPE"], "runner:a:3")
        self.assertEqual(second["SODUWORK_DESKTOP_CONTROL_SCOPE"], "runner:b:3")
        self.assertNotIn("soduwork_desktop_control_scope", first)
        self.assertEqual(env["soduwork_desktop_control_scope"], "pi:wrong:1")

    def test_headless_runner_does_not_invent_a_desktop_endpoint(self):
        result = self.launch("headless", {}, {})
        self.assertEqual(result["SODUWORK_DESKTOP_CONTROL_SCOPE"], "runner:headless:1")
        self.assertNotIn("SODUWORK_DESKTOP_CONTROL_ENDPOINT", result)


if __name__ == "__main__":
    unittest.main()
