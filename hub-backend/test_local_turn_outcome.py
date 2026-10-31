"""Real stream/settlement entrypoints with isolated state; no model or DB calls."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
_data = tempfile.TemporaryDirectory(prefix="soduwork-test-truncated-")
os.environ["SODUWORK_DATA_ROOT"] = _data.name
from app.services import local_stream, local_turn_outcome
from app.services.local_base import _RUNS


class TurnOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.ref = "isolated-truncated"
        self.run = {"state": "running", "cli": "pi", "ws": _data.name,
                    "seq": 0, "lines": [], "cfg": {}, "artifactMode": "files",
                    "expectedOutputPaths": ["product-source.zip"]}
        _RUNS[self.ref] = self.run
        self.addCleanup(lambda: _RUNS.pop(self.ref, None))

    def event(self, reason):
        terminal = {}
        local_stream._on_line(self.ref, json.dumps({"type": "message_end", "message": {
            "role": "assistant", "content": [], "stopReason": reason}}), terminal)
        return terminal

    def finish(self, terminal, **changes):
        self.run.update(changes)
        with patch.object(local_stream, "_resume", return_value={"ok": True}) as resume:
            local_stream._finish(self.ref, 0, terminal, "")
        return resume

    def test_zero_exit_truncation_resumes_same_node_without_false_done(self):
        terminal = self.event("length")
        self.assertTrue(terminal["outputTruncated"])
        resume = self.finish(terminal)
        self.assertEqual(self.run["state"], "recovering")
        self.assertEqual(self.run["completionRetries"], 1)
        self.assertEqual(resume.call_args.args[0], self.ref)
        self.assertIn("product-source.zip", resume.call_args.args[1])
        self.assertIn("不代替用户审批", resume.call_args.args[1])
        self.assertTrue(any("模型输出被截断" in x["text"] for x in self.run["lines"]))

    def test_second_truncation_fails_and_keeps_existing_progress(self):
        resume = self.finish(self.event("length"), completionRetries=1)
        resume.assert_not_called()
        self.assertEqual(self.run["state"], "failed")
        self.assertEqual(self.run["failureKind"], "execution_incomplete")
        self.assertIn("输出上限", self.run["error"])

    def test_normal_chat_and_queued_user_input_are_not_repeated(self):
        for changes in ({"expectedOutputPaths": []}, {"queue": ["user follow-up"]}):
            with self.subTest(changes=changes):
                self.run.update(state="running", expectedOutputPaths=["product-source.zip"])
                resume = self.finish(self.event("length"), **changes)
                resume.assert_not_called()
                self.assertEqual(self.run["state"], "failed")

    def test_model_error_is_not_hidden_by_zero_exit(self):
        resume = self.finish(self.event("error"))
        resume.assert_not_called()
        self.assertEqual(self.run["state"], "failed")

    def test_latest_success_replaces_earlier_length_inside_one_process(self):
        terminal = {"outputTruncated": True}
        local_turn_outcome.observe("pi", {"type": "message_end", "message": {
            "role": "assistant", "stopReason": "stop"}}, terminal)
        self.assertNotIn("outputTruncated", terminal)
        self.assertTrue(terminal["piFinalResponse"])
        self.finish(terminal).assert_not_called()
        self.assertEqual(self.run["state"], "done")

    def test_agent_end_stop_does_not_preempt_extension_cleanup(self):
        terminal = {}
        local_stream._on_line(self.ref, json.dumps({"type": "agent_end", "messages": [
            {"role": "assistant", "content": [], "stopReason": "stop"}]}), terminal)
        self.assertNotIn("piFinalResponse", terminal)

    def test_later_pi_events_clear_the_candidate_before_the_grace_expires(self):
        terminal = {}
        local_stream._on_line(self.ref, json.dumps({"type": "message_end", "message": {
            "role": "assistant", "stopReason": "stop"}}), terminal)
        self.assertGreater(self.run.get("piFinalResponseAt", 0), 0)
        local_stream._on_line(self.ref, json.dumps({"type": "agent_settled"}), terminal)
        self.assertNotIn("piFinalResponseAt", self.run)

    def test_watchdog_settlement_accepts_the_killed_pi_exit_code(self):
        terminal = self.event("stop")
        self.run["piSettledByWatchdog"] = True
        with patch.object(local_stream, "_resume", return_value={"ok": True}) as resume:
            local_stream._finish(self.ref, -9, terminal, "")
        resume.assert_not_called()
        self.assertEqual(self.run["state"], "done")

    def test_progress_and_other_agent_events_do_not_mark_truncation(self):
        for cli, kind in (("pi", "message_update"), ("codex", "message_end")):
            terminal = {}
            local_turn_outcome.observe(cli, {"type": kind, "message": {
                "role": "assistant", "stopReason": "length"}}, terminal)
            self.assertEqual(terminal, {})

    def test_internal_model_retry_success_does_not_keep_stale_failure(self):
        terminal = self.event("error")
        local_turn_outcome.observe("pi", {"type": "message_end", "message": {
            "role": "assistant", "stopReason": "stop"}}, terminal)
        self.assertNotIn("isError", terminal)
        self.assertNotIn("result", terminal)
        self.finish(terminal).assert_not_called()
        self.assertEqual(self.run["state"], "done")

    def test_success_never_clears_unrelated_terminal_failure(self):
        terminal = {"isError": True, "result": "transport failed"}
        local_turn_outcome.observe("pi", {"type": "message_end", "message": {
            "role": "assistant", "stopReason": "stop"}}, terminal)
        self.assertTrue(terminal["isError"])
        self.finish(terminal).assert_not_called()
        self.assertEqual(self.run["state"], "failed")

    def test_claude_result_text_only_becomes_error_on_actual_failure(self):
        for failed in (False, True):
            with self.subTest(failed=failed):
                self.run.update(state="running", cli="claude", queue=[], lines=[])
                terminal = {}
                text = "Provider authentication failed" if failed else "Completed the requested work"
                local_stream._on_line(self.ref, json.dumps({"type": "result",
                    "is_error": failed, "result": text}), terminal)
                self.finish(terminal).assert_not_called()
                self.assertEqual(self.run["state"], "failed" if failed else "done")
                self.assertEqual(self.run["error"], text if failed else "")


if __name__ == "__main__":
    unittest.main()
