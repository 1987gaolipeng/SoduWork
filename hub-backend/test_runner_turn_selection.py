"""Idle-boundary security and rollback tests; no native process or real model."""
import concurrent.futures
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import local_base, local_stream, runner_turn_selection as switching
from app.services import execution_selection


class RunnerTurnSelectionTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="soduwork-execution-selection-")
        self.path = Path(self.work.name)
        self.ref = "switch-unit"
        self.row = {"cli": "pi", "model": "a", "reasoningEffort": "", "cliSid": "pi-old",
                    "state": "done", "ws": str(self.path), "cfg": {}, "queue": [],
                    "round": 1, "seq": 2, "mode": "work", "title": "Original task",
                    "lines": [{"kind": "user", "text": "Keep the existing file"},
                              {"kind": "say", "text": "Created original.txt"}]}
        local_base._RUNS[self.ref] = self.row
        self.patches = [patch.object(local_base, "_STORE", str(self.path / "archive")),
            patch.object(local_stream, "_spawn"),
            patch.dict(local_base._PROFILES["qwen"], {"bin": lambda: sys.executable})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        local_base._RUNS.pop(self.ref, None)
        for p in reversed(self.patches):
            p.stop()
        self.work.cleanup()

    def cfg(self):
        return {"local_cli": "qwen", "llm": {"model": "b", "base": "http://fixture", "key": "secret-only-memory"},
                "_executionSelection": {"agentId": "qwen", "modelName": "b"}}

    def test_busy_queue_permission_and_transition_are_not_mutated(self):
        for field, value in (("state", "running"), ("state", "recovering"), ("queue", ["queued"]),
                             ("pendingPermissions", [{"id": "approval"}]), ("permissionWaiting", True),
                             ("_accessTransition", {"phase": "preparing"}), ("stopping", True)):
            with self.subTest(field=field, value=value):
                old = dict(self.row)
                self.row[field] = value
                result = switching.resume(self.ref, "next", self.cfg())
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "EXECUTION_SWITCH_BUSY")
                self.assertEqual(self.row["cliSid"], "pi-old")
                self.assertEqual(self.row["cli"], "pi")
                self.row.clear()
                self.row.update(old)

    def test_managed_model_and_agent_must_match_authorization(self):
        for changed in ({"local_cli": "opencode"}, {"llm": {}},
                        {"llm": {"model": "c", "base": "x", "key": "x"}}):
            result = switching.resume(self.ref, "next", {**self.cfg(), **changed})
            self.assertFalse(result["ok"], changed)
            self.assertEqual(self.row["cli"], "pi")

    def test_goal_session_cannot_lose_its_native_executor(self):
        self.row["conversationMode"] = "goal"
        result = switching.resume(self.ref, "next", self.cfg())
        self.assertEqual(result["code"], "EXECUTION_GOAL_ACTIVE")
        self.assertEqual(self.row["cliSid"], "pi-old")

    def test_missing_agent_and_unknown_fields_are_rejected(self):
        with patch.dict(local_base._PROFILES["qwen"], {"bin": lambda: None}):
            self.assertEqual(switching.resume(self.ref, "next", self.cfg())["code"], "EXECUTION_AGENT_UNAVAILABLE")
        with self.assertRaises(execution_selection.SelectionError):
            execution_selection.normalize({"agentId": "qwen", "modelName": "b", "workDir": "elsewhere"})

    def test_switch_cannot_broaden_access_policy(self):
        self.row["accessPolicy"] = {"schema": "soduwork.access-policy/v1", "mode": "readonly",
                                    "revision": 1, "workspaceRoot": str(self.path)}
        from app.services import access_policy
        self.row["accessPolicy"] = access_policy.normalize(self.row["accessPolicy"])
        cfg = self.cfg()
        cfg["accessPolicy"] = {**self.row["accessPolicy"], "mode": "full", "revision": 2}
        result = switching.resume(self.ref, "next", cfg)
        self.assertFalse(result["ok"])
        self.assertEqual(self.row["accessPolicy"]["mode"], "readonly")

    def test_unchanged_selection_retains_ordinary_permission_transition(self):
        self.row.update(cli="qwen", model="b")
        from app.services import access_policy
        self.row["accessPolicy"] = access_policy.normalize({"schema": "soduwork.access-policy/v1", "mode": "readonly", "revision": 1,
                                                            "workspaceRoot": str(self.path)})
        cfg = self.cfg()
        cfg["accessPolicy"] = {**self.row["accessPolicy"], "mode": "full", "revision": 2}
        self.assertEqual(switching.validate(self.ref, cfg["_executionSelection"], cfg)["agentId"], "qwen")
        self.assertIsNone(switching.resume(self.ref, "next", cfg))
        self.assertEqual(self.row["accessPolicy"]["mode"], "readonly")

    def test_rollback_on_scope_failure_preserves_original_executor(self):
        with patch.object(switching.skill_read_scope, "for_run", side_effect=ValueError("scope unavailable")):
            result = switching.resume(self.ref, "next", self.cfg())
        self.assertFalse(result["ok"])
        self.assertEqual(self.row["cliSid"], "pi-old")
        self.assertEqual(self.row["model"], "a")

    def test_success_preserves_history_and_does_not_persist_credentials(self):
        result = switching.resume(self.ref, "next", self.cfg())
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.row["cli"], "qwen")
        self.assertEqual(self.row["model"], "b")
        self.assertEqual(self.row["contextSegments"][0]["sid"], "pi-old")
        self.assertEqual(self.row["lines"][0]["text"], "Keep the existing file")
        self.assertEqual(self.row["ws"], str(self.path))
        metadata = (self.path / "archive" / self.ref / "meta.json").read_text(encoding="utf-8")
        self.assertNotIn("secret-only-memory", metadata)
        self.assertEqual(json.loads(metadata)["cli"], "qwen")

    def test_two_different_switches_cannot_launch_in_parallel(self):
        cfg1, cfg2 = self.cfg(), self.cfg()
        cfg2["_executionSelection"] = {"agentId": "qwen", "modelName": "c"}
        cfg2["llm"] = {**cfg2["llm"], "model": "c"}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(lambda cfg: switching.resume(self.ref, "next", cfg), (cfg1, cfg2)))
        self.assertEqual(sum(bool(r and r.get("ok")) for r in results), 1, results)
        self.assertEqual(local_stream._spawn.call_count, 1)


if __name__ == "__main__":
    unittest.main()
