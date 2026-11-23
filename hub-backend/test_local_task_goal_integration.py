"""Task goals through real stream, settlement, archive and resume boundaries.

Only the native process launch is substituted; fixtures never call a model.
"""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import Mock, patch

_data = tempfile.TemporaryDirectory(prefix="soduwork-task-goal-import-")
with patch.dict(os.environ, {"DATABASE_URL": "sqlite+aiosqlite:///:memory:",
                             "SODUWORK_DATA_ROOT": _data.name}):
    from app.services import ai_local, local_base as base, local_ctx as ctx
    from app.services import local_stream as stream, local_task_goal as goal


class TaskGoalIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-task-goal-")
        self.addCleanup(self.temp.cleanup)
        for module in (base, stream, ai_local):
            handle = patch.object(module, "_STORE", os.path.join(self.temp.name, "archive"))
            handle.start()
            self.addCleanup(handle.stop)
        self.ref = "task-goal-" + uuid.uuid4().hex
        self.cfg = {"llm": {"base": "http://127.0.0.1", "model": "synthetic-task-goal",
                            "key": "synthetic-task-goal-credential"}}
        self.run = dict(cli="dsh", cliSid="retained-native", ws=self.temp.name,
                        state="running", mode="work", seq=0, segment=1, round=1,
                        turnStartSeq=0, lines=[], queue=[], cfg=copy.deepcopy(self.cfg), usage={},
                        artifactMode="files", conversationMode="goal", overflowTried=1,
                        admissionKey="original-admission", expectedOutputPaths=[])
        base._RUNS[self.ref] = self.run
        self.addCleanup(lambda: base._RUNS.pop(self.ref, None))
        self.contract = dict(schemaVersion=1, objective="Create and verify synthetic output",
                             acceptance="The fixture output is valid", budgetMinutes=5, maxSteps=10)
        self.assertTrue(goal.initialize(self.run, self.contract))
        profile = dict(base._PROFILES["dsh"], bin=lambda: "synthetic-agent", compact=None,
                       start=lambda sid, mode, ws, cfg: [sid, mode],
                       resume=lambda sid, mode, ws, cfg: [sid, mode])
        handle = patch.dict(base._PROFILES, {"dsh": profile})
        handle.start()
        self.addCleanup(handle.stop)

        def launched(*_args, **_kwargs):
            self.run["turnStartSeq"] = self.run["seq"]
            goal.begin_turn(self.run)

        self.spawn = Mock(side_effect=launched)
        handle = patch.object(stream, "_spawn", self.spawn)
        handle.start()
        self.addCleanup(handle.stop)

    def emit(self, event, terminal=None):
        terminal = terminal if terminal is not None else {}
        stream._on_line(self.ref, json.dumps(event), terminal)
        return terminal

    def tool(self, identity="tool-1", *, end=True, success=True, output="verified fixture"):
        self.emit({"type": "tool_execution_start", "toolCallId": identity,
                   "toolName": "read_file", "args": {"path": identity + ".txt"}})
        if end:
            self.emit({"type": "tool_execution_end", "toolCallId": identity,
                       "toolName": "read_file", "isError": not success,
                       "result": {"content": [{"type": "text", "text": output}]}})

    def test_typed_output_limit_resumes_same_native_session_and_keeps_context_budget(self):
        self.tool()
        terminal = self.emit({"type": "step_finish", "part": {"reason": "max_tokens"}})
        stream._finish(self.ref, 2, terminal, "")
        self.spawn.assert_called_once()
        self.assertEqual(self.spawn.call_args.args[1], ["retained-native", "work"])
        self.assertEqual(self.run["round"], 1)
        self.assertEqual(self.run["overflowTried"], 1)
        self.assertEqual(self.run["goalState"]["outputRecoveries"], 1)
        self.assertEqual(self.run["goalState"]["steps"], 1)
        self.assertEqual(self.run["admissionKey"], "original-admission")
        meta = json.loads((Path(base._store_dir(self.ref)) / "meta.json").read_text())
        self.assertEqual(meta["goalState"]["outputRecoveries"], 1)
        self.assertNotIn("cfg", meta)

    def test_unsettled_tool_blocks_automatic_output_recovery(self):
        self.tool(end=False)
        terminal = self.emit({"type": "step_finish", "part": {"reason": "max_tokens"}})
        stream._finish(self.ref, 2, terminal, "")
        self.spawn.assert_not_called()
        self.assertEqual(self.run["state"], "stopped")
        self.assertEqual(self.run["goalState"]["status"], "paused")
        self.assertIn("工具", self.run["error"])
        self.assertEqual(self.run["goalState"]["outputRecoveries"], 0)

    def test_resume_preparation_failure_pauses_goal_without_hiding_error(self):
        profile = {**base._PROFILES["dsh"], "bin": lambda: None}
        with patch.dict(base._PROFILES, {"dsh": profile}):
            stream._finish(self.ref, 0, {}, "")
        self.spawn.assert_not_called()
        self.assertEqual(self.run["state"], "failed")
        self.assertEqual(self.run["goalState"]["status"], "paused")
        self.assertEqual(self.run["goalState"]["reason"], self.run["error"])
        self.assertIn("CLI", self.run["error"])

    def test_disabling_goal_releases_executor_switch_and_restores_dialogue_mode(self):
        from app.services import runner_turn_selection, execution_selection
        self.run["state"] = "stopped"
        wanted = {"agentId": "opencode", "modelName": self.cfg["llm"]["model"], "reasoningEffort": ""}
        profile = {**base._PROFILES["opencode"], "bin": lambda: "fixture-agent", "runtime_issue": None}
        with patch.dict(base._PROFILES, {"opencode": profile}):
            with self.assertRaises(execution_selection.SelectionError) as error:
                runner_turn_selection.validate(self.ref, wanted, self.run["cfg"])
            self.assertEqual(error.exception.code, "EXECUTION_GOAL_ACTIVE")
            self.assertTrue(goal.control(self.run, "disable")["ok"])
            self.assertEqual(self.run["conversationMode"], "adaptive")
            selected = runner_turn_selection.validate(self.ref, wanted, self.run["cfg"])
            self.assertEqual(selected["agentId"], "opencode")

    def test_protocol_failure_after_limit_is_not_recovered(self):
        self.tool()
        terminal = self.emit({"type": "step_finish", "part": {"reason": "max_tokens"}})
        self.emit({"error": {"name": "AcpBridgeError", "message": "synthetic transport failure"}}, terminal)
        stream._finish(self.ref, 2, terminal, "")
        self.spawn.assert_not_called()
        self.assertEqual(self.run["state"], "failed")
        self.assertIn("synthetic transport failure", self.run["error"])
        self.assertEqual(self.run["goalState"]["outputRecoveries"], 0)

    def test_permissions_and_user_queue_take_priority_over_review(self):
        for flag in ("permissionDenied", "permissionWaiting", "pendingPermissions", "goalUserPending"):
            with self.subTest(flag=flag):
                goal.control(self.run, "continue")
                self.run.update(state="running", cfg=copy.deepcopy(self.cfg), **{flag: True})
                self.spawn.reset_mock()
                stream._finish(self.ref, 0, {}, "")
                self.spawn.assert_not_called()
                self.run.pop(flag)
        goal.control(self.run, "continue")
        self.run.update(state="running", queue=["Human correction"], cfg=copy.deepcopy(self.cfg))
        stream._finish(self.ref, 0, {}, "")
        self.spawn.assert_called_once()
        self.assertIn("Human correction", self.spawn.call_args.args[2])
        self.assertFalse(self.spawn.call_args.args[2].startswith("【SoduWork 独立交付复核】"))

    def test_stop_at_recovery_boundary_prevents_the_next_process(self):
        prepare = ctx.prepare_resume

        def stopped_before_resume(ref, text, cfg, **kwargs):
            self.assertEqual(self.run["state"], "recovering")
            self.assertTrue(stream.stop_sync({}, ref)["ok"])
            return prepare(ref, text, cfg, **kwargs)

        with patch.object(ctx, "prepare_resume", side_effect=stopped_before_resume):
            stream._finish(self.ref, 0, {}, "")
        self.spawn.assert_not_called()
        self.assertEqual(self.run["state"], "stopped")
        self.assertEqual(self.run["goalState"]["status"], "paused")

    def test_user_admission_at_recovery_boundary_prevents_automatic_resume(self):
        prepare = ctx.prepare_resume

        def user_before_resume(ref, text, cfg, **kwargs):
            self.run["goalUserPending"] = "new-human-admission"
            return prepare(ref, text, cfg, **kwargs)

        with patch.object(ctx, "prepare_resume", side_effect=user_before_resume):
            stream._finish(self.ref, 0, {}, "")
        self.spawn.assert_not_called()
        self.assertEqual(self.run["state"], "done")
        self.assertEqual(self.run["goalUserPending"], "new-human-admission")

    def test_queued_message_arriving_during_recovery_prevents_automatic_resume(self):
        prepare = ctx.prepare_resume

        def queued_before_resume(ref, text, cfg, **kwargs):
            self.run["queue"] = ["Human message wins"]
            return prepare(ref, text, cfg, **kwargs)

        with patch.object(ctx, "prepare_resume", side_effect=queued_before_resume):
            stream._finish(self.ref, 0, {}, "")
        self.spawn.assert_not_called()
        self.assertEqual(self.run["queue"], ["Human message wins"])

    def test_late_permission_denial_cannot_be_cleared_by_automatic_resume(self):
        prepare = ctx.prepare_resume

        def denied_before_resume(ref, text, cfg, **kwargs):
            self.run["permissionDenied"] = True
            return prepare(ref, text, cfg, **kwargs)

        with patch.object(ctx, "prepare_resume", side_effect=denied_before_resume):
            stream._finish(self.ref, 0, {}, "")
        self.spawn.assert_not_called()
        self.assertTrue(self.run["permissionDenied"])

    def test_completed_work_is_reviewed_before_goal_completion(self):
        self.tool()
        stream._finish(self.ref, 0, {}, "")
        self.assertEqual(self.run["goalState"]["status"], "reviewing")
        self.assertIn("独立交付复核", self.spawn.call_args.args[2])
        nonce = self.run["goalState"]["reviewNonce"]
        self.tool("review-tool")
        self.emit({"type": "text", "part": {"id": "review-message", "text": json.dumps({
            "schemaVersion": 1, "nonce": nonce, "result": "pass",
            "summary": "Verified synthetic output", "gaps": []})}})
        stream._finish(self.ref, 0, {}, "")
        self.assertEqual(self.spawn.call_count, 1)
        self.assertEqual(self.run["goalState"]["status"], "completed")
        self.assertEqual(self.run["state"], "done")

    def test_streamed_review_preserves_verdict_across_empty_close_marker(self):
        stream._finish(self.ref, 0, {}, "")
        self.tool("review-tool")
        text = json.dumps({"schemaVersion": 1, "nonce": self.run["goalState"]["reviewNonce"],
                           "result": "pass", "summary": "Verified fixture", "gaps": []})
        for chunk in (text[:40], text[40:]):
            self.emit({"type": "text", "part": {"streamId": "native-review",
                       "text": chunk, "delta": chunk, "done": False}})
        self.emit({"type": "text", "part": {"streamId": "native-review",
                   "text": "", "delta": "", "done": True}})
        stream._finish(self.ref, 0, {}, "")
        self.assertEqual(self.run["goalState"]["status"], "completed")
        self.assertEqual(self.spawn.call_count, 1)

    def test_untyped_tool_result_cannot_satisfy_review_evidence(self):
        stream._finish(self.ref, 0, {}, "")
        self.tool("untyped-review-tool", end=False)
        self.emit({"type": "tool_execution_end", "toolCallId": "untyped-review-tool",
                   "toolName": "read_file", "result": {"content": [{"type": "text", "text": "unknown"}]}})
        text = json.dumps({"schemaVersion": 1, "nonce": self.run["goalState"]["reviewNonce"],
                           "result": "pass", "summary": "Model claims success", "gaps": []})
        self.emit({"type": "text", "part": {"text": text}})
        stream._finish(self.ref, 0, {}, "")
        self.assertNotEqual(self.run["goalState"]["status"], "completed")
        self.assertEqual(self.run["goalState"]["successes"], 0)
        self.assertEqual(self.spawn.call_count, 1)

    def test_budget_and_retry_counts_survive_archive_rehydration(self):
        self.tool()
        self.run["goalState"].update(outputRecoveries=1, elapsedMs=120000)
        goal.control(self.run, "pause")
        self.run["state"] = "stopped"
        base._save_meta(self.ref)
        previous = copy.deepcopy(self.run["goalState"])
        base._RUNS.pop(self.ref)
        self.run = base.rehydrate(self.ref)
        self.assertEqual(self.run["goalState"], previous)
        self.assertTrue(ctx.prepare_resume(self.ref, "Continue", {**self.cfg, "taskGoalControl": "continue"})["ok"])
        self.assertEqual(self.run["goalState"]["outputRecoveries"], 1)
        self.assertEqual(self.run["goalState"]["steps"], 1)
        self.assertGreaterEqual(goal.snapshot(self.run)["elapsedMs"], 120000)

    def test_missing_reclaimed_model_grant_pauses_without_starting_a_process(self):
        self.run["cfg"] = {}
        stream._finish(self.ref, 0, {}, "")
        self.spawn.assert_not_called()
        self.assertEqual(self.run["state"], "stopped")
        self.assertEqual(self.run["failureKind"], "model_reauthorization")
        self.assertEqual(self.run["goalState"]["status"], "paused")

    def test_time_and_step_budget_pause_before_a_new_turn(self):
        for budget in ("elapsedMs", "steps"):
            with self.subTest(budget=budget):
                self.run.update(state="running", goalContract=None, goalState=None)
                goal.initialize(self.run, self.contract)
                self.run["goalState"][budget] = 300000 if budget == "elapsedMs" else 10
                stream._finish(self.ref, 0, {}, "")
                self.spawn.assert_not_called()
                self.assertEqual(self.run["state"], "stopped")
                self.assertEqual(self.run["goalState"]["status"], "paused")
                self.assertFalse(ctx.prepare_resume(self.ref, "Continue", {"taskGoalControl": "continue"})["ok"])

    def test_disabled_goal_allows_an_ordinary_followup(self):
        goal.control(self.run, "disable")
        self.run["state"] = "stopped"
        self.assertTrue(ctx.prepare_resume(self.ref, "A separate question", {})["ok"])
        self.spawn.assert_called_once()
        self.assertEqual(self.spawn.call_args.args[2], "A separate question")
        self.assertEqual(self.run["goalState"]["status"], "disabled")

    def test_pi_does_not_enter_task_controller_even_with_a_foreign_contract(self):
        self.run["cli"] = "pi"
        before = copy.deepcopy(self.run["goalState"])
        self.tool()
        stream._finish(self.ref, 0, {}, "")
        self.assertEqual(self.run["goalState"], before)
        self.assertEqual(self.run["state"], "done")
        self.spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
