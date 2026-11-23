"""Task-level continuation policy, using synthetic contracts and native receipts."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import declared_outputs, local_task_goal as goal


class TaskGoalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-task-goal-")
        self.addCleanup(self.temp.cleanup)
        self.contract = {"schemaVersion": 1, "objective": "完成离线帮助中心", "acceptance": "页面链接通过验证"}
        self.run = {"cli": "dsh", "ws": self.temp.name, "seq": 0, "lines": [], "segment": 1}
        self.assertTrue(goal.initialize(self.run, self.contract, now=100))

    @property
    def state(self):
        return self.run["goalState"]

    def rows(self, *rows, native_event=None):
        for row in rows:
            self.run["seq"] += 1
            row["seq"] = self.run["seq"]
        goal.observe(self.run, list(rows), native_event)
        self.run["lines"].extend(rows)

    def tool(self, identity="tool-1", command="check links", output="all links passed", **result):
        self.rows({"kind": "do", "tool": "Bash", "callId": identity, "arguments": {"command": command}},
                  {"kind": "out", "callId": identity, "isError": False, "text": output, **result})

    def next_turn(self):
        self.run["turnStartSeq"] = self.run["seq"]
        goal.begin_turn(self.run)

    def review(self, result="pass", nonce=None, summary="13 页验证通过", gaps=None):
        value = {"schemaVersion": 1, "nonce": nonce or self.state.get("reviewNonce"),
                 "result": result, "summary": summary, "gaps": gaps or []}
        self.rows({"kind": "say", "text": json.dumps(value, ensure_ascii=False)})
        return value

    def enter_review(self):
        self.tool()
        decision = goal.assess(self.run, {}, now=101)
        self.assertEqual(decision["action"], "continue")
        self.assertEqual(self.state["status"], "reviewing")
        self.assertIn(self.state["reviewNonce"], decision["prompt"])
        self.next_turn()

    def test_contract_is_explicit_bounded_and_not_silently_truncated(self):
        for raw in (None, {}, {**self.contract, "schemaVersion": True},
                    {**self.contract, "objective": "x" * 50001},
                    {**self.contract, "acceptance": "x" * 10001},
                    {**self.contract, "budgetMinutes": "240"},
                    {**self.contract, "budgetMinutes": float("nan")}, {**self.contract, "budgetMinutes": 10 ** 400},
                    {**self.contract, "maxSteps": True}, {**self.contract, "maxSteps": 5.5}):
            with self.subTest(raw_type=type(raw).__name__):
                self.assertEqual(goal.normalize(raw), {})
        normalized = goal.normalize(self.contract)
        self.assertEqual((normalized["budgetMinutes"], normalized["maxSteps"]), (240, 1000))
        self.assertEqual(goal.normalize({**self.contract, "objective": "x" * 50000})["objective"], "x" * 50000)

    def test_pi_and_retired_agents_are_unchanged_for_every_entrypoint(self):
        for cli in ("pi", "claude", "harness2", "unknown"):
            with self.subTest(cli=cli):
                run = {**copy.deepcopy(self.run), "cli": cli}
                before = copy.deepcopy(run)
                self.assertFalse(goal.initialize(run, self.contract))
                goal.begin_turn(run)
                goal.observe(run, [{"kind": "do", "callId": "call", "tool": "write"}])
                self.assertEqual(goal.assess(run, {"outputTruncated": True}), {})
                self.assertFalse(goal.control(run, "pause")["ok"])
                self.assertEqual(goal.work_prompt(run, "original"), "original")
                self.assertEqual(goal.snapshot(run), {})
                self.assertEqual(run, before)

    def test_every_supported_harness_requires_independent_successful_review(self):
        for cli in ("codex", "codex-harness", "opencode", "dsh", "kimi", "qwen"):
            with self.subTest(cli=cli):
                self.setUp()
                self.run["cli"] = cli
                self.enter_review()
                # Reused native IDs belong to a new invocation and remain evidence.
                self.tool(command="verify current links")
                self.review()
                decision = goal.assess(self.run, {}, now=102)
                self.assertEqual(decision["action"], "complete")
                self.assertEqual(decision["summary"], "13 页验证通过")
                self.assertFalse(goal.active(self.run))
                self.assertEqual(self.state["steps"], 2)

    def test_claims_thinking_plans_previews_and_cancelled_calls_are_not_progress(self):
        self.rows({"kind": "say", "text": "all finished"}, {"kind": "thinking", "text": "working"},
                  {"kind": "step", "text": "step"}, {"kind": "do", "tool": "Plan"},
                  {"kind": "tool-preparing", "tool": "write", "callId": "preview"})
        self.tool(isError=True)
        self.tool("cancelled", state="cancelled", cancelReason="output-limit")
        self.assertEqual(self.state["progress"], 0)
        self.assertEqual(self.state["steps"], 2)
        self.assertFalse(self.state["pending"])

    def test_unknown_or_failed_tool_result_cannot_certify_review(self):
        self.enter_review()
        self.rows({"kind": "out", "callId": "unknown", "text": "passed", "isError": False})
        self.tool("review-check", isError=True)
        self.review()
        decision = goal.assess(self.run, {}, now=102)
        self.assertEqual(decision["action"], "pause")
        self.assertIn("成功工具验证", decision["reason"])

    def test_successful_write_cannot_substitute_for_independent_validation(self):
        self.enter_review()
        self.rows({"kind": "do", "tool": "write_file", "toolKind": "edit", "callId": "review-write"},
                  {"kind": "out", "callId": "review-write", "isError": False, "text": "saved"})
        self.review()
        self.assertEqual(goal.assess(self.run, {}, now=102)["action"], "pause")

    def test_mutating_tool_kind_overrides_familiar_verification_name(self):
        self.rows({"kind": "do", "tool": "Bash", "toolKind": "edit", "callId": "mutating"},
                  {"kind": "out", "callId": "mutating", "isError": False, "text": "saved"})
        self.assertEqual(self.state["successes"], 1)
        self.assertEqual(self.state["validations"], 0)

    def test_same_file_different_content_is_progress_without_persisting_content(self):
        target = Path(self.temp.name, "page.html")
        for index in range(3):
            self.rows({"kind": "do", "tool": "write_file", "callId": str(index),
                       "arguments": {"path": "page.html"}})
            target.write_text("private file content " + str(min(index, 1)))
            self.rows({"kind": "out", "callId": str(index), "isError": False, "text": "saved"})
        self.assertEqual(self.state["progress"], 2)
        self.assertNotIn("private file content", json.dumps(self.state))

    def test_progress_hash_never_reads_external_paths_or_symlink_targets(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-external-goal-") as outside:
            target = Path(outside, "outside.txt")
            target.write_text("outside")
            alias = Path(self.temp.name, "alias.txt")
            try:
                alias.symlink_to(target)
            except OSError:
                self.skipTest("symbolic links unavailable")
            with patch.object(goal.os, "open", side_effect=AssertionError("external path read")):
                for path in (str(target), "alias.txt"):
                    self.rows({"kind": "do", "tool": "read_file", "callId": path, "arguments": {"path": path}},
                              {"kind": "out", "callId": path, "isError": False, "text": "result"})
            self.assertEqual(goal._file_fingerprints(self.run, ["../not-in-workspace"]), [])

    def test_progress_hash_skips_large_files_and_nonregular_files(self):
        target = Path(self.temp.name, "large.bin")
        with target.open("wb") as handle:
            handle.truncate(2 * 1024 * 1024 + 1)
        with patch.object(goal.os, "open", side_effect=AssertionError("unbounded file read")):
            self.assertEqual(goal._file_fingerprints(self.run, ["large.bin", "."]), [])

    def test_outstanding_tool_prevents_any_automatic_continuation(self):
        self.rows({"kind": "do", "tool": "write", "callId": "pending"})
        decision = goal.assess(self.run, {"outputTruncated": True}, now=101)
        self.assertEqual(decision["action"], "pause")
        self.assertEqual(self.state["outputRecoveries"], 0)

    def test_repeated_tool_results_are_not_new_progress_and_steps_are_not_heartbeats(self):
        self.tool()
        self.rows({"kind": "out", "callId": "tool-1", "isError": False, "text": "all links passed"})
        self.tool("tool-2")
        self.rows({"kind": "step", "text": "thinking"})
        self.assertEqual(self.state["steps"], 2)
        self.assertEqual(self.state["progress"], 1)
        self.assertEqual(self.state["successes"], 2)

    def test_output_recovery_budget_survives_context_relay_serialization_and_goal_turns(self):
        self.tool()
        first = goal.assess(self.run, {"outputTruncated": True}, now=101)
        self.assertEqual(first["action"], "continue")
        self.run = json.loads(json.dumps(self.run))
        self.run["segment"] = 2
        self.next_turn()
        self.tool(command="write next page", output="second page saved")
        self.assertEqual(goal.assess(self.run, {"outputTruncated": True}, now=102)["action"], "continue")
        self.assertEqual(self.state["outputRecoveries"], 2)
        self.next_turn()
        self.tool(command="write final page")
        self.assertEqual(goal.assess(self.run, {}, now=103)["action"], "continue")
        self.next_turn()
        self.tool(command="verify all pages")
        third = goal.assess(self.run, {"outputTruncated": True}, now=104)
        self.assertEqual(third["action"], "pause")
        self.assertEqual(self.state["outputRecoveries"], 2)

    def test_second_output_recovery_requires_new_progress(self):
        self.tool()
        goal.assess(self.run, {"outputTruncated": True}, now=101)
        self.next_turn()
        self.tool("new-id")
        result = goal.assess(self.run, {"outputTruncated": True}, now=102)
        self.assertEqual(result["action"], "pause")
        self.assertEqual(self.state["outputRecoveries"], 1)

    def test_normal_continue_review_cycle_can_exceed_two_rounds_with_progress(self):
        for index in range(4):
            self.tool(str(index), command=f"write page {index}")
            self.assertEqual(goal.assess(self.run, {}, now=101 + index)["action"], "continue")
            self.next_turn()
            self.tool(str(index), command=f"check page {index}")
            self.review("continue", gaps=[f"remaining page {index + 1}"])
            self.assertEqual(goal.assess(self.run, {}, now=101 + index)["action"], "continue")
            self.next_turn()
        self.assertEqual(self.state["continuations"], 8)
        self.assertEqual(self.state["outputRecoveries"], 0)

    def test_two_rounds_without_new_progress_pause(self):
        self.assertEqual(goal.assess(self.run, {}, now=101)["action"], "continue")
        self.next_turn()
        self.review("continue", gaps=["implementation missing"])
        result = goal.assess(self.run, {}, now=102)
        self.assertEqual(result["action"], "pause")
        self.assertIn("连续两轮", result["reason"])

    def test_only_current_assistant_review_can_complete_and_json_is_strict(self):
        self.enter_review()
        self.tool(command="validate")
        self.review(nonce="stale-nonce")
        self.assertEqual(goal.assess(self.run, {}, now=102)["action"], "pause")
        for text in ('{"result":"pass"}', '```json\n{}\n```', '{"schemaVersion":true}', '"pass"'):
            goal.control(self.run, "continue", now=103)
            self.next_turn()
            self.tool(command="new pass " + text)
            goal.assess(self.run, {}, now=104)
            self.next_turn()
            self.tool(command="verify " + text)
            self.rows({"kind": "say", "text": text})
            self.assertEqual(goal.assess(self.run, {}, now=105)["action"], "pause")

    def test_untrusted_review_shape_duplicate_keys_and_depth_fail_closed(self):
        for kind in ([], {}, True, None):
            self.enter_review()
            self.tool(command="verify shape")
            value = {"schemaVersion": 1, "nonce": self.state["reviewNonce"],
                     "result": kind, "summary": "checked", "gaps": []}
            self.rows({"kind": "say", "text": json.dumps(value)})
            self.assertEqual(goal.assess(self.run, {}, now=102)["action"], "pause")
            goal.control(self.run, "continue", now=103)
            self.next_turn()
        self.enter_review()
        self.tool(command="verify duplicate")
        value = self.review()
        self.rows({"kind": "say", "text": json.dumps(value)[:-1] + ', "result": "pass"}'})
        self.assertEqual(goal.assess(self.run, {}, now=104)["action"], "pause")
        goal.control(self.run, "continue", now=105)
        self.next_turn()
        self.enter_review()
        self.rows({"kind": "say", "text": '[' * 1500 + ']' * 1500})
        self.assertEqual(goal.assess(self.run, {}, now=106)["action"], "pause")

    def test_streamed_review_and_hidden_rows_keep_exact_current_verdict(self):
        self.enter_review()
        self.tool(command="verify fresh")
        value = {"schemaVersion": 1, "nonce": self.state["reviewNonce"], "result": "pass", "summary": "verified", "gaps": []}
        text = json.dumps(value)
        for fragment in (text[:40], text[40:]):
            self.rows({"kind": "say", "text": fragment, "streamId": "review", "delta": True, "done": False})
        self.rows({"kind": "say", "text": "", "streamId": "review", "delta": True, "done": True})
        # Integration can hide internal protocol rows after observe has consumed them.
        self.run["lines"] = []
        self.assertEqual(goal.assess(self.run, {}, now=102)["action"], "complete")

    def test_partial_review_or_tool_output_json_is_never_a_verdict(self):
        self.enter_review()
        value = {"schemaVersion": 1, "nonce": self.state["reviewNonce"], "result": "pass", "summary": "verified", "gaps": []}
        self.tool(command="verify", output=json.dumps(value))
        self.rows({"kind": "say", "text": json.dumps(value), "streamId": "review", "delta": True, "done": False})
        self.assertEqual(goal.assess(self.run, {}, now=102)["action"], "pause")

    def test_declared_missing_file_prevents_pass_then_new_file_can_complete(self):
        self.run["expectedOutputPaths"] = ["index.html"]
        self.run["expectedOutputBaseline"] = {}
        self.enter_review()
        self.tool(command="verify expected")
        self.review()
        decision = goal.assess(self.run, {}, now=102)
        self.assertEqual(decision["action"], "continue")
        self.assertEqual(self.state["status"], "working")
        Path(self.temp.name, "index.html").write_text("<!doctype html><title>Help</title>")
        self.next_turn()
        self.tool(command="verify index exists")
        goal.assess(self.run, {}, now=103)
        self.next_turn()
        self.tool(command="validate index content")
        self.review()
        self.assertEqual(goal.assess(self.run, {}, now=104)["action"], "complete")

    def test_unchanged_declared_file_is_not_a_fresh_output(self):
        Path(self.temp.name, "old.html").write_text("old artifact")
        self.run["expectedOutputPaths"] = ["old.html"]
        self.run["expectedOutputBaseline"] = declared_outputs.baseline(self.temp.name, ["old.html"])
        self.enter_review()
        self.tool(command="verify old output")
        self.review()
        self.assertEqual(goal.assess(self.run, {}, now=102)["action"], "continue")

    def test_blocked_review_does_not_trigger_more_work(self):
        self.enter_review()
        self.review("blocked", summary="需要用户提供验收环境", gaps=["环境缺失"])
        result = goal.assess(self.run, {}, now=102)
        self.assertEqual(result["action"], "blocked")
        self.assertNotIn("prompt", result)
        self.assertEqual(goal.assess(self.run, {}, now=103), {})

    def test_hard_boundaries_leave_controller_unchanged(self):
        for fields, terminal in (({"stopping": True}, {}), ({"queue": ["user"]}, {}),
                ({"permissionDenied": True}, {}), ({"pendingPermissions": ["request"]}, {}),
                ({"permissionWaiting": True}, {}), ({"_hostCleanup": {"pending": True}}, {}),
                ({"executionPolicyViolation": {"reason": "denied"}}, {}),
                ({}, {"isError": True}), ({}, {"overflow": True})):
            run = {**copy.deepcopy(self.run), **fields}
            before = copy.deepcopy(run)
            self.assertEqual(goal.assess(run, terminal, now=101), {})
            self.assertEqual(run, before)

    def test_time_step_budget_and_pause_do_not_replenish_on_restore(self):
        self.state["steps"] = 1000
        self.assertIn("步骤", goal.budget_reason(self.run, now=101))
        goal.control(self.run, "pause", now=101)
        self.run = json.loads(json.dumps(self.run))
        self.assertFalse(goal.control(self.run, "continue", now=500)["ok"])
        self.state["steps"] = 999
        self.assertTrue(goal.control(self.run, "continue", now=500)["ok"])
        self.assertEqual(goal.snapshot(self.run, now=501)["elapsedMs"], 2000)
        result = goal.assess(self.run, {}, now=500 + 240 * 60)
        self.assertEqual(result["action"], "pause")
        self.assertFalse(goal.control(self.run, "continue", now=99999)["ok"])

    def test_contract_updates_and_human_steering_do_not_refill_budgets(self):
        self.enter_review()
        self.state["outputRecoveries"] = 1
        self.assertTrue(goal.control(self.run, "continue", now=102)["ok"])
        self.assertEqual(self.state["status"], "working")
        self.assertNotIn("reviewNonce", self.state)
        self.assertEqual(self.state["outputRecoveries"], 1)
        self.assertTrue(goal.initialize(self.run, self.contract, now=102))
        self.assertEqual(self.state["steps"], 1)
        other = {**self.contract, "objective": "a different goal"}
        self.assertFalse(goal.initialize(self.run, other, now=102))
        goal.control(self.run, "disable", now=102)
        self.assertEqual(goal.work_prompt(self.run, "user message"), "user message")
        self.assertFalse(goal.control(self.run, "continue", now=103)["ok"])
        self.assertTrue(goal.initialize(self.run, other, now=103))
        self.assertEqual(self.state["steps"], 0)

    def test_pause_cannot_revive_completed_or_disabled_goal(self):
        for status in ("completed", "disabled"):
            self.state["status"] = status
            self.assertTrue(goal.control(self.run, "pause", now=101)["ok"])
            self.assertEqual(self.state["status"], status)
            self.assertFalse(goal.control(self.run, "continue", now=102)["ok"])

    def test_unknown_native_success_flag_is_not_validation_evidence(self):
        for raw in ({}, {"isError": None}, {"isError": 0}, {"isError": "false"}):
            identity = str(raw)
            self.rows({"kind": "do", "tool": "bash", "callId": identity},
                      {"kind": "out", "callId": identity, "text": "passed", "isError": False},
                      native_event={"type": "tool_execution_end", **raw})
        self.assertEqual(self.state["successes"], 0)
        self.assertEqual(self.state["progress"], 0)

    def test_native_codex_and_opencode_receipts(self):
        self.run["cli"] = "codex"
        self.rows({"kind": "do", "tool": "command_execution", "callId": "item_0", "arguments": {"command": "test"}},
                  native_event={"type": "item.completed", "item": {"id": "item_0", "type": "command_execution",
                                "command": "test", "status": "completed", "exit_code": 0, "aggregated_output": "passed"}})
        self.assertEqual(self.state["successes"], 1)
        self.next_turn()
        self.rows({"kind": "do", "tool": "command_execution", "callId": "item_0"},
                  native_event={"type": "item.completed", "item": {"id": "item_0", "type": "command_execution",
                                "status": "completed", "exit_code": 1, "aggregated_output": "failed"}})
        self.assertEqual(self.state["successes"], 1)
        self.assertFalse(self.state["pending"])
        self.run["cli"] = "opencode"
        self.rows({"kind": "do", "tool": "bash", "callId": "oc-1"},
                  native_event={"type": "tool_use", "part": {"id": "oc-1", "tool": "bash", "state": {"status": "completed", "output": "verified"}}})
        self.assertEqual(self.state["successes"], 2)

    def test_native_codex_plan_items_are_not_pending_tools(self):
        self.run["cli"] = "codex"
        self.rows({"kind": "do", "tool": "todo_list", "callId": "plan"},
                  native_event={"type": "item.completed", "item": {"id": "plan", "type": "todo_list"}})
        self.assertEqual(self.state["steps"], 0)
        self.assertEqual(self.state["pending"], {})

    def test_explicit_user_continue_can_check_uncertain_tool_without_replaying_it(self):
        self.rows({"kind": "do", "tool": "write", "callId": "uncertain"})
        self.assertEqual(goal.assess(self.run, {}, now=101)["action"], "pause")
        self.assertTrue(goal.control(self.run, "continue", now=102)["ok"])
        self.assertFalse(self.state["pending"])
        self.assertEqual(self.state["steps"], 1)
        self.assertIn("读取现有文件", goal.work_prompt(self.run))

    def test_repeated_settlement_does_not_spend_another_continuation(self):
        self.tool()
        goal.assess(self.run, {}, now=101)
        self.assertEqual(goal.assess(self.run, {}, now=101), {})
        self.assertEqual(self.state["continuations"], 1)


if __name__ == "__main__":
    unittest.main()
