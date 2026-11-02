"""Installation facts stay distinct from dispatch readiness and probe history."""
from __future__ import annotations

import copy
import sys
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from app.services import agent_setup, harness2_lifecycle, harness2_runtime, local_base, managed_agents


class AgentSetupStateTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.bin = self.stub(agent_setup, "_bin_of", sys.executable)
        self.stub(agent_setup, "_package_files", [])
        self.pkg = self.stub(agent_setup, "_pkg_version", "")
        self.active = self.stub(managed_agents, "_read_active", "")
        self.managed = self.stub(managed_agents, "managed_binary", "")
        self.issue = self.stub(managed_agents, "runtime_issue", "")
        self.version = self.stub(agent_setup, "_cached_version_probe", "1.2.3")
        self.stub(agent_setup.agent_npm_runtime, "package_engine", "")
        self.stub(agent_setup, "node_env", {"why": ""})
        self.stub(agent_setup, "_npm_root", "")
        self.stub(agent_setup, "_auth_probe", ("authed", "Account ready"))
        self.stub(harness2_runtime, "is_bundled", True)
        self.disabled = self.stub(harness2_lifecycle, "disabled_issue", "")
        self.executor = self.stub(local_base, "_opencode_bin", sys.executable)
        self.stack.enter_context(patch.object(agent_setup, "_short", side_effect=AssertionError("Real process")))
        self.stack.enter_context(patch.object(managed_agents, "install", side_effect=AssertionError("Install")))

    def stub(self, obj, name, value):
        return self.stack.enter_context(patch.object(obj, name, return_value=value))

    def detect(self, key="opencode", **kwargs):
        item = agent_setup.detect(key, probes=kwargs.pop("probes", {}), **kwargs)
        self.assertIn(item["state"], {"missing", "ready", "nollm", "unauthed"})
        return item

    def test_absent_runtime_has_no_presence_or_damage(self):
        self.bin.return_value = ""
        item = self.detect()
        self.assertFalse(item["installed"])
        self.assertFalse(item.get("present"))
        self.assertEqual(item.get("setupState"), "missing")
        self.assertEqual(item["warnNow"], "")
        self.version.assert_not_called()

    def test_unknown_codex_auth_cannot_dispatch_through_an_old_hub(self):
        from app.services import ai_remote
        with patch.object(agent_setup, "_auth_probe", return_value=("", "")), \
                patch.object(agent_setup, "_runtime_issue", return_value=""):
            item = self.detect("codex")
        self.assertTrue(item["installed"])
        self.assertEqual(item["auth"], "unauthed")
        self.assertEqual(item["authStatus"], "unknown")
        self.assertEqual(item["setupState"], "unknown")
        self.assertFalse(ai_remote._agent_usable(item))

    def test_missing_managed_executable_preserves_record_and_reports_broken(self):
        self.bin.return_value = ""
        self.active.return_value = "1.18.18"
        item = self.detect()
        self.assertEqual(item["version"], "1.18.18")
        self.assertEqual(item["verFrom"], "managed-record")
        self.assertTrue(item["present"])
        self.assertFalse(item["installed"])
        self.assertEqual(item["setupState"], "broken")
        self.assertTrue(item["runtimeIssue"])
        self.assertEqual(item["why"], item["runtimeIssue"])
        self.version.assert_not_called()

    def test_missing_npm_executable_preserves_package_record(self):
        self.bin.return_value = ""
        self.pkg.return_value = "0.25.0"
        item = self.detect("qwen")
        self.assertEqual(item["version"], "0.25.0")
        self.assertEqual(item["verFrom"], "pkg")
        self.assertTrue(item["present"])
        self.assertFalse(item["installed"])
        self.assertEqual(item["setupState"], "broken")

    def test_managed_startup_failure_is_not_advertised_even_without_dependency_issue(self):
        for record in ("", "1.18.18"):
            with self.subTest(record=record):
                self.active.return_value = record
                self.version.return_value = ""
                item = self.detect()
                self.assertFalse(item["installed"])
                self.assertTrue(item["present"])
                self.assertEqual(item["setupState"], "broken")
                self.assertEqual(item["version"], record)
                self.assertTrue(item["runtimeIssue"])

    def test_metadata_warning_does_not_make_working_npm_cli_broken(self):
        item = self.detect("qwen")
        self.assertTrue(item["installed"])
        self.assertTrue(item["present"])
        self.assertEqual(item["setupState"], "ready")
        self.assertEqual(item["runtimeIssue"], "")
        self.assertTrue(item["warnNow"])
        self.assertEqual(item["verFrom"], "cli")

    def test_harness_cannot_dispatch_when_its_executor_fails_version_probe(self):
        self.version.return_value = ""
        item = self.detect("harness2")
        self.assertFalse(item["installed"])
        self.assertEqual(item.get("setupState"), "broken")

    def test_incomplete_execution_dependency_is_broken_and_not_dispatchable(self):
        self.issue.return_value = "Required execution dependency is missing"
        for key in ("opencode", "harness2"):
            with self.subTest(key=key):
                item = self.detect(key)
                self.assertFalse(item["installed"])
                self.assertTrue(item["present"])
                self.assertEqual(item["setupState"], "broken")
                self.assertEqual(item["runtimeIssue"], self.issue.return_value)

    def test_bundled_harness_without_executor_needs_setup_not_repair(self):
        self.executor.return_value = ""
        item = self.detect("harness2")
        self.assertEqual(item["version"], harness2_runtime.version())
        self.assertTrue(item["present"])
        self.assertFalse(item["installed"])
        self.assertEqual(item["setupState"], "setup")
        self.assertEqual(item["warnNow"], "")
        self.assertIn("装上", item["why"])

    def test_explicit_harness_disable_wins_over_missing_executor(self):
        self.disabled.return_value = "Harness disabled by user"
        self.executor.return_value = ""
        item = self.detect("harness2")
        self.assertFalse(item["installed"])
        self.assertTrue(item["present"])
        self.assertEqual(item["setupState"], "disabled")
        self.assertEqual(item["why"], self.disabled.return_value)
        self.assertEqual(item["warnNow"], "")

    def test_missing_harness_core_is_broken_despite_existing_python(self):
        self.stub(harness2_runtime, "is_bundled", False)
        item = self.detect("harness2")
        self.assertFalse(item["installed"])
        self.assertFalse(item["present"])
        self.assertEqual(item["setupState"], "broken")

    def test_model_and_auth_requirements_keep_legacy_states(self):
        item = self.detect(has_model=False)
        self.assertTrue(item["installed"])
        self.assertEqual(item["setupState"], "nollm")
        self.stub(agent_setup, "_auth_probe", ("unauthed", "Please sign in"))
        # The native executable has its own version probe; the ACP entry is a
        # separate installation component and cannot stand in for that file.
        with (patch.object(agent_setup, "_version_of", return_value=("2.1.316", "cli", "")),
              patch.object(agent_setup, "_runtime_issue", return_value="")):
            item = self.detect("claude")
        self.assertTrue(item["installed"])
        self.assertEqual(item["setupState"], "unauthed")

    def test_saved_probe_is_historical_and_never_changes_installation_facts(self):
        for ok in (True, False):
            for missing in (True, False):
                with self.subTest(ok=ok, missing=missing):
                    self.bin.return_value = "" if missing else sys.executable
                    saved = {"opencode": {"ok": ok, "detail": "Old probe", "at": 123}}
                    original = copy.deepcopy(saved)
                    item = self.detect(probes=saved)
                    self.assertEqual(item.get("setupState"), "missing" if missing else "ready")
                    self.assertTrue(item["probe"].get("historical"))
                    self.assertEqual(item["probe"]["ok"], ok)
                    self.assertEqual(saved, original)
                    self.assertIsNot(item["probe"], saved["opencode"])


if __name__ == "__main__":
    unittest.main()
