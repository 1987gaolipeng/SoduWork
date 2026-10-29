"""Current Runner finish truth: isolated real event parser and settlement."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

_data = tempfile.TemporaryDirectory(prefix="soduwork-dialogue-outcome-")
os.environ["SODUWORK_DATA_ROOT"] = _data.name
from app.services import local_base, local_stream


class DialogueOutcomeTests(unittest.TestCase):
    def setUp(self):
        store = patch.object(local_base, "_STORE", _data.name)
        store.start()
        self.addCleanup(store.stop)
        self.ref = "isolated-dialogue-outcome"
        self.run = {"cli": "codex", "state": "running", "ws": _data.name,
                    "conversationMode": "adaptive", "seq": 0, "turnStartSeq": 0,
                    "lines": [], "cfg": {}, "artifactMode": "files"}
        local_base._RUNS[self.ref] = self.run
        self.addCleanup(lambda: local_base._RUNS.pop(self.ref, None))

    def finish(self, events, code=0):
        terminal = {}
        for event in events:
            local_stream._on_line(self.ref, json.dumps(event), terminal)
        with patch.object(local_stream, "_resume", return_value={"ok": True}) as resume:
            local_stream._finish(self.ref, code, terminal, "")
        return resume

    def text(self, value):
        return {"type": "item.completed", "item": {"type": "agent_message", "text": value}}

    def test_input_tokens_without_output_is_not_a_completed_reply(self):
        resumed = self.finish([{"type": "turn.completed", "usage": {
            "input_tokens": 20, "output_tokens": 0}}])
        resumed.assert_not_called()
        self.assertEqual(self.run["state"], "failed")
        self.assertEqual(self.run.get("failureKind"), "execution_no_output")

    def test_interactive_clarification_is_never_answered_for_the_user(self):
        resumed = self.finish([self.text("Which folder should I use?")])
        resumed.assert_not_called()
        self.assertEqual(self.run["state"], "done")

    def test_previous_question_does_not_complete_or_resume_new_empty_turn(self):
        self.run.update(seq=7, turnStartSeq=7, lines=[
            {"seq": 6, "kind": "say", "text": "Which folder should I use?"},
            {"seq": 7, "kind": "user", "text": "Please use this workspace"}])
        resumed = self.finish([])
        resumed.assert_not_called()
        self.assertEqual(self.run["state"], "failed")
        self.assertEqual(self.run.get("failureKind"), "execution_no_output")

    def test_thinking_without_answer_is_incomplete_and_keeps_user_queue(self):
        self.run["queue"] = ["next real user prompt"]
        resumed = self.finish([{"type": "item.completed", "item": {
            "type": "reasoning", "id": "thought-1", "text": "Planning the response"}},
            {"type": "turn.completed", "usage": {"input_tokens": 20, "output_tokens": 10}}])
        resumed.assert_not_called()
        self.assertEqual(self.run["state"], "failed")
        self.assertEqual(self.run.get("failureKind"), "execution_incomplete")
        self.assertEqual(self.run["queue"], ["next real user prompt"])
        self.assertTrue(any(x.get("kind") == "thinking" for x in self.run["lines"]))

    def test_output_tokens_without_delivered_content_are_not_success(self):
        resumed = self.finish([{"type": "turn.completed", "usage": {
            "input_tokens": 20, "output_tokens": 12}}])
        resumed.assert_not_called()
        self.assertEqual(self.run.get("failureKind"), "execution_no_output")

    def test_real_answer_or_tool_activity_remains_successful(self):
        for item in ({"type": "agent_message", "text": "Your result is ready"},
                     {"type": "command_execution", "id": "call-1", "command": "pwd"}):
            with self.subTest(item=item):
                self.run.update(state="running", lines=[], seq=0)
                self.finish([{"type": "item.completed", "item": item}]).assert_not_called()
                self.assertEqual(self.run["state"], "done")

    def test_unattended_question_recovery_remains_bounded(self):
        self.run["conversationMode"] = "goal"
        resumed = self.finish([self.text("Which folder should I use?")])
        resumed.assert_called_once()
        self.run.update(state="running", turnStartSeq=self.run["seq"])
        self.finish([self.text("Should I use the current directory?")]).assert_not_called()

    def test_existing_failure_and_manual_stop_are_not_reclassified(self):
        for stopped in (False, True):
            with self.subTest(stopped=stopped):
                self.run.update(state="running", stopping=stopped)
                self.finish([{"type": "turn.failed", "error": {"message": "provider failure"}}], 1).assert_not_called()
                self.assertEqual(self.run["state"], "stopped" if stopped else "failed")
                self.assertNotEqual(self.run.get("failureKind"), "execution_no_output")

    def test_nonzero_exit_without_provider_error_still_has_a_reason(self):
        self.finish([], 17).assert_not_called()
        self.assertEqual(self.run["state"], "failed")
        self.assertIn("17", self.run["error"])

    def test_legacy_interactive_archive_does_not_auto_answer(self):
        self.run.pop("conversationMode")
        self.run.update(seq=1, turnStartSeq=1, lines=[{"seq": 1, "kind": "user", "text": "hello"}])
        self.finish([self.text("Which folder should I use?")]).assert_not_called()

    def test_old_question_from_unattended_previous_round_is_not_reused(self):
        self.run.update(conversationMode="goal", seq=2, turnStartSeq=2,
                        lines=[{"seq": 2, "kind": "say", "text": "Which folder?"}])
        self.finish([]).assert_not_called()


if __name__ == "__main__":
    unittest.main()
