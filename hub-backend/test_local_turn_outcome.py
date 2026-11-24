"""Real stream/settlement entrypoints with isolated state; no model or DB calls."""
import json
import os
import subprocess
import sys
import threading
import time
import tempfile
import unittest
import uuid
from unittest.mock import patch

_data = tempfile.TemporaryDirectory(prefix="soduwork-test-truncated-")
with patch.dict(os.environ, {"DATABASE_URL": "sqlite+aiosqlite:///:memory:",
                             "SODUWORK_DATA_ROOT": _data.name}):
    from app.services import ai_local, local_base, local_stream, local_turn_outcome, model_errors
    from app.services.local_base import _RUNS


class TurnOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-turn-outcome-")
        self.addCleanup(self.temp.cleanup)
        environment = patch.dict(os.environ, {"DATABASE_URL": "sqlite+aiosqlite:///:memory:",
                                               "SODUWORK_DATA_ROOT": self.temp.name})
        environment.start()
        self.addCleanup(environment.stop)
        # Archives outlive _RUNS entries. Patch the cached store aliases too,
        # because another test module may have imported them before this one.
        for module in (local_base, local_stream, ai_local):
            store = patch.object(module, "_STORE", os.path.join(self.temp.name, "local-runs"))
            store.start()
            self.addCleanup(store.stop)
        self.ref = "isolated-truncated-" + uuid.uuid4().hex
        self.run = {"state": "running", "cli": "pi", "ws": self.temp.name,
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

    def test_codex_account_model_rejection_requires_a_new_selection_and_never_replays(self):
        from app.services import codex_acp_outcome
        self.run.update(cli="codex", cliSid="retained-session", timedOut="late watchdog")
        terminal = {"overflow": True, "outputTruncated": True}
        error = {"type": "invalid_request_error", "code": "model_not_found",
                 "message": "The 'desktop-model' model is not supported when using Codex with a ChatGPT account."}
        event = {"error": {"name": "AcpBridgeError", "message": "400 " + json.dumps({"error": error})}}
        local_stream._on_line(self.ref, json.dumps(event), terminal)
        with patch("app.services.local_ctx._recover_overflow") as recover, patch.object(local_stream, "_resume") as resume:
            local_stream._finish(self.ref, 2, terminal, "")
        recover.assert_not_called()
        resume.assert_not_called()
        self.assertEqual(self.run["state"], "failed")
        self.assertEqual(self.run["failureKind"], "native_model_unavailable")
        self.assertEqual(self.run["error"], codex_acp_outcome.ACCOUNT_MODEL_UNAVAILABLE)
        self.assertEqual(self.run["cliSid"], "retained-session")
        self.assertFalse(codex_acp_outcome.account_model_rejected("codex-harness", event))
        self.assertFalse(codex_acp_outcome.account_model_rejected("codex", {"type": "error", "message": error["message"]}))
        self.assertFalse(codex_acp_outcome.account_model_rejected("codex", {"error": {"name": "AcpBridgeError",
                         "message": "authentication required"}}))
        self.assertTrue(codex_acp_outcome.account_model_rejected("codex", {"type": "turn.failed", "error": error}))

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

    def test_pi_model_404_survives_stream_settlement_and_session_projection(self):
        terminal = {}
        message = {"role": "assistant", "content": [], "stopReason": "error",
                   "errorMessage": "404 status code (no body)"}
        for event in ({"type": "message_end", "message": message},
                      {"type": "turn_end", "message": message},
                      {"type": "agent_end", "messages": [message]}):
            local_stream._on_line(self.ref, json.dumps(event), terminal)
        self.finish(terminal).assert_not_called()
        page = ai_local.session_sync({}, self.ref)
        self.assertTrue(page["ok"])
        self.assertEqual(page["status"], "failed")
        self.assertIn("HTTP 404", page["error"])
        self.assertIn("切换可用模型", page["error"])

    def test_device_transfer_receipt_requires_a_settled_terminal_run(self):
        self.run["eventDestination"] = "local"
        for state in ("done", "failed", "stopped", "interrupted"):
            with self.subTest(state=state):
                self.run.update(state=state, proc=None, stopping=False)
                self.assertEqual(ai_local.session_sync({}, self.ref)["deviceTransfer"],
                                 {"schemaVersion": 1, "quiescent": True})
        for state in ("running", "queued", "dispatching", "recovering", "unknown", None):
            with self.subTest(state=state):
                self.run["state"] = state
                self.assertFalse(ai_local.session_sync({}, self.ref)["deviceTransfer"]["quiescent"])

    def test_device_transfer_stopped_does_not_bypass_cleanup_queue_or_approval(self):
        self.run.update(state="stopped", eventDestination="local")
        for field, value in (("stopping", True), ("detached", True), ("proc", object()),
                             ("_launchPending", {"cancelled": True}), ("_hostCleanup", object()),
                             ("queue", ["retained follow-up"]), ("goalUserPending", "retained goal input"),
                             ("contextCompacting", True), ("_accessTransition", {"phase": "preparing"}),
                             ("pendingPermissions", [{"id": "approval"}]), ("permissionWaiting", True)):
            with self.subTest(field=field):
                self.run[field] = value
                receipt = ai_local.session_sync({}, self.ref)["deviceTransfer"]
                self.assertEqual(receipt, {"schemaVersion": 1, "quiescent": False})
                self.run.pop(field)
                self.assertTrue(ai_local.session_sync({}, self.ref)["deviceTransfer"]["quiescent"])

    def test_device_transfer_goal_must_be_complete_without_unsettled_tools(self):
        self.run.update(state="done", eventDestination="local", goalContract={"objective": "Retain this goal"})
        for state in (None, "active", "reviewing", "paused", "blocked", "failed", "unknown"):
            with self.subTest(state=state):
                self.run["goalState"] = {"status": state}
                self.assertFalse(ai_local.session_sync({}, self.ref)["deviceTransfer"]["quiescent"])
        for state in ("completed", "disabled"):
            with self.subTest(state=state):
                self.run["goalState"] = {"status": state, "pending": {}}
                self.assertTrue(ai_local.session_sync({}, self.ref)["deviceTransfer"]["quiescent"])
                self.run["goalState"]["pending"] = {"tool-call": {"tool": "write"}}
                self.assertFalse(ai_local.session_sync({}, self.ref)["deviceTransfer"]["quiescent"])
        self.run.pop("goalState")
        self.assertFalse(ai_local.session_sync({}, self.ref)["deviceTransfer"]["quiescent"])

    def test_device_transfer_archive_only_or_missing_run_never_claims_quiescence(self):
        _RUNS.pop(self.ref)
        with patch.object(ai_local, "_read_events", return_value=[{"seq": 1, "text": "retained"}]):
            receipt = ai_local.session_sync({}, self.ref)
            self.assertEqual(receipt["status"], "unknown")
            self.assertEqual(receipt["deviceTransfer"], {"schemaVersion": 1, "quiescent": False})
        with patch.object(ai_local, "_read_events", return_value=[]):
            receipt = ai_local.session_sync({}, self.ref)
            self.assertFalse(receipt["ok"])
            self.assertFalse(receipt["deviceTransfer"]["quiescent"])

    def test_strict_history_distinguishes_absent_archive_from_unreadable_partial_and_empty(self):
        _RUNS.pop(self.ref)
        cfg = {"historyRead": True}
        folder = os.path.join(ai_local._STORE, self.ref)
        os.makedirs(ai_local._STORE, exist_ok=True)
        missing = ai_local.session_sync(cfg, self.ref)
        self.assertEqual((missing.get("code"), missing.get("ref")), ("NATIVE_HISTORY_MISSING", self.ref))
        self.assertFalse(os.path.exists(folder))
        self.assertNotEqual(ai_local.session_sync(cfg, self.ref, since=1).get("code"), "NATIVE_HISTORY_MISSING")
        os.mkdir(folder)
        journal = os.path.join(folder, "events.jsonl")
        for contents in ["", "invalid JSON\n", '{"seq":1,"kind":"user","text":"keep"}\ninvalid\n']:
            with self.subTest(contents=contents):
                with open(journal, "w", encoding="utf-8") as out:
                    out.write(contents)
                self.assertEqual(ai_local.session_sync(cfg, self.ref).get("code"), "NATIVE_HISTORY_UNAVAILABLE")
        with patch.object(ai_local, "_read_events", side_effect=PermissionError):
            self.assertEqual(ai_local.session_sync(cfg, self.ref).get("code"), "NATIVE_HISTORY_UNAVAILABLE")

    def test_device_transfer_requires_trusted_local_or_proven_legacy_event_ownership(self):
        from app.services.dispatch_identity import execution_ref
        self.run.update(state="done", eventDestination="local")
        self.assertTrue(ai_local.session_sync({}, self.ref)["deviceTransfer"]["quiescent"])
        for destination in ("hub", "unknown", "", None, False):
            with self.subTest(destination=destination):
                self.run["eventDestination"] = destination
                self.assertFalse(ai_local.session_sync({}, self.ref)["deviceTransfer"]["quiescent"])
        self.run.pop("eventDestination")
        self.assertFalse(ai_local.session_sync({}, self.ref)["deviceTransfer"]["quiescent"])
        self.run["taskId"] = "chat-transfer-legacy"
        legacy_ref = execution_ref("chat:" + self.run["taskId"] + ":" + self.run["cli"])
        _RUNS[legacy_ref] = self.run
        self.addCleanup(lambda: _RUNS.pop(legacy_ref, None))
        self.assertTrue(ai_local.session_sync({}, legacy_ref)["deviceTransfer"]["quiescent"])
        self.assertFalse(ai_local.session_sync({}, self.ref)["deviceTransfer"]["quiescent"])
        self.run["eventDestination"] = "hub"
        self.assertFalse(ai_local.session_sync({}, legacy_ref)["deviceTransfer"]["quiescent"])

    def test_model_diagnostics_classify_without_publishing_provider_body(self):
        for value, expected in (
            ('401 {"secret":"private-key"}', "请检查模型授权"),
            ({"error": {"status": 403, "message": "Bearer private-key"}}, "模型请求被拒绝（HTTP 403）"),
            ({"error": {"status": 403, "code": "1113", "message": "private-key"}}, "供应商错误码 1113"),
            ('404 status code (no body)', "HTTP 404"),
            ('429 {"error":{"code":"limited","message":"private-key"}}', "HTTP 429"),
            ('502 <html>private-key https://internal.test</html>', "HTTP 502"),
            ('Error status_code: 422 private-key', "HTTP 422"),
            ('fetch failed private-key', "暂时不可用"),
            ('unrecognized private-key', "模型调用失败"),
        ):
            with self.subTest(value=value):
                public = model_errors.public_failure(value)
                self.assertIn(expected, public)
                self.assertNotIn("private-key", public)
                self.assertNotIn("internal.test", public)

    def test_unclassified_pi_403_projects_only_the_safe_refusal_in_the_runner_receipt(self):
        terminal = {}
        message = {"role": "assistant", "content": [], "stopReason": "error",
                   "errorMessage": '403 {"error":{"message":"Bearer fixture-key https://fixture.invalid fixture-prompt"}}'}
        for event in ({"type": "message_end", "message": message},
                      {"type": "turn_end", "message": message},
                      {"type": "agent_end", "messages": [message]}):
            local_stream._on_line(self.ref, json.dumps(event), terminal)
        self.finish(terminal).assert_not_called()
        page = ai_local.session_sync({}, self.ref)
        self.assertEqual(page["status"], "failed")
        self.assertEqual(page["error"], "模型请求被拒绝（HTTP 403）")

    def test_pi_error_never_overwrites_an_unrelated_terminal_failure(self):
        terminal = {"isError": True, "result": "execution policy rejected"}
        local_turn_outcome.observe("pi", {"type": "message_end", "message": {
            "role": "assistant", "stopReason": "error", "errorMessage": "404"}}, terminal)
        self.assertEqual(terminal, {"isError": True, "result": "execution policy rejected"})

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
        self.assertEqual(self.run["exit"], -9, "retain the actual process exit for diagnostics")
        self.assertNotIn("piSettledByWatchdog", self.run, "cleanup ownership is consumed once")

    def test_watchdog_marker_cannot_hide_real_failures_or_later_events(self):
        cases = [
            ("unmarked kill", {"piSettledByWatchdog": False}, {}, "", "failed"),
            ("other agent", {"cli": "codex"}, {}, "", "failed"),
            ("no current candidate", {"piFinalResponseAt": 0}, {}, "", "failed"),
            ("no final response", {}, {"piFinalResponse": False}, "", "failed"),
            ("model error", {}, {"isError": True, "result": "model rejected"}, "", "failed"),
            ("transport error", {}, {}, "transport failed", "failed"),
            ("truncated output", {}, {"outputTruncated": True}, "", "failed"),
            ("permission denied", {"permissionDenied": True}, {}, "", "failed"),
            ("policy violation", {"executionPolicyViolation": {"reason": "policy blocked"}}, {}, "", "failed"),
            ("explicit stop", {"stopping": True}, {}, "", "stopped"),
            ("timeout exhausted", {"timedOut": "fixture timeout", "stallRetries": 99}, {}, "", "failed"),
        ]
        for name, changes, fields, error, expected in cases:
            with self.subTest(name=name):
                self.run.clear()
                self.run.update(state="running", cli="pi", ws=self.temp.name, seq=0, lines=[], cfg={},
                                artifactMode="files", expectedOutputPaths=[], piSettledByWatchdog=True)
                terminal = self.event("stop")
                self.run.update(changes)
                terminal.update(fields)
                with patch.object(local_stream, "_resume", return_value={"ok": True}) as resume:
                    local_stream._finish(self.ref, -9, terminal, error)
                resume.assert_not_called()
                self.assertEqual(self.run["state"], expected)
                self.assertNotIn("piSettledByWatchdog", self.run)
        # A subsequent event invalidates the earlier candidate even if the
        # watchdog marker was already set during its cleanup race.
        self.run.update(state="running", cli="pi", piSettledByWatchdog=True,
                        stopping=False, permissionDenied=False, executionPolicyViolation={})
        terminal = self.event("stop")
        local_stream._on_line(self.ref, json.dumps({"type": "agent_settled"}), terminal)
        local_stream._finish(self.ref, -9, terminal, "")
        self.assertEqual(self.run["state"], "failed")

    def test_real_process_final_response_watchdog_cleanup_settles_successfully(self):
        from app.services import local_process
        source = (
            "import json,time; print(json.dumps({'type':'message_end','message':"
            "{'role':'assistant','stopReason':'stop','content':"
            "[{'type':'text','text':'Synthetic final answer'}]}}),flush=True); time.sleep(45)")
        child = subprocess.Popen(
            [sys.executable, "-u", "-c", source], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL, text=True, encoding="utf-8",
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
               else {"start_new_session": True}))
        observed = []
        ready = threading.Event()
        def read_first_line():
            observed.append(child.stdout.readline())
            ready.set()
        reader = threading.Thread(target=read_first_line, daemon=True)
        reader.start()
        before = set(local_process._THREADS)
        try:
            self.assertTrue(ready.wait(5), "synthetic process must emit its final response")
            self.assertTrue(observed[0], "child exited before emitting a response")
            self.run.update(proc=child, pid=child.pid, started=time.time(), lastOut=time.time(),
                            expectedOutputPaths=[])
            terminal = {}
            local_stream._on_line(self.ref, observed[0], terminal)
            self.assertTrue(terminal["piFinalResponse"])
            local_process._watchdog(self.ref, child, finish=local_stream._finish,
                                    kill_tree=local_stream._kill_tree)
            code = child.wait(timeout=20)
            self.assertNotEqual(code, 0, "the real hung process must be killed by the watchdog")
            for thread in set(local_process._THREADS) - before:
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive(), "watchdog must finish after its owned kill")
            self.assertTrue(self.run.get("piSettledByWatchdog"))
            local_stream._finish(self.ref, code, terminal, "")
            self.assertEqual(self.run["state"], "done")
            self.assertEqual(self.run["error"], "")
            self.assertEqual(self.run["exit"], code)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            child.stdout.close()
            child.stderr.close()
            reader.join(timeout=1)

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

    def dsh_step(self, terminal, reason, **extra):
        self.run["cli"] = "dsh"
        local_stream._on_line(self.ref, json.dumps({"type": "step_finish",
            "part": {"reason": reason}, **extra}), terminal)

    def test_dsh_exhausted_output_is_incomplete_without_a_second_local_recovery(self):
        for code in (0, 2):
            with self.subTest(code=code):
                self.run.update(state="running", cli="dsh", cliSid="retained-native-session", queue=[])
                terminal = {}
                self.dsh_step(terminal, "max_tokens")
                self.assertTrue(terminal.get("outputTruncated"))
                self.assertEqual(local_turn_outcome.recovery(self.run, terminal), {},
                                 "the ACP bridge owns DSH's bounded continuation")
                with patch.object(local_stream, "_resume") as resume:
                    local_stream._finish(self.ref, code, terminal, "")
                resume.assert_not_called()
                page = ai_local.session_sync({}, self.ref)
                self.assertEqual(page["status"], "failed")
                self.assertEqual(page["failureKind"], "execution_incomplete")
                self.assertEqual(page["error"], local_turn_outcome.TRUNCATED)
                self.assertEqual(page["cliSid"], "retained-native-session")
                self.assertEqual(self.run["exit"], code)
                self.assertEqual(self.run.get("completionRetries", 0), 0)
                self.assertNotIn("AcpBridgeError", json.dumps(page, ensure_ascii=False))

    def test_kimi_and_qwen_explicit_output_limit_survives_exit_and_preserves_session(self):
        for cli in ('kimi', 'qwen'):
            for failed in (False, True):
                with self.subTest(cli=cli, failed=failed):
                    self.run.update(state='running', cli=cli, cliSid='retained-native', queue=[])
                    self.run.pop('failureKind', None)
                    terminal = {}
                    local_stream._on_line(self.ref, json.dumps({'type': 'step_finish',
                        'part': {'reason': 'max_tokens'}}), terminal)
                    if failed:
                        local_stream._on_line(self.ref, json.dumps({'error': {
                            'name': 'AcpBridgeError', 'message': 'synthetic transport failure'}}), terminal)
                    with patch.object(local_stream, '_resume') as resume:
                        local_stream._finish(self.ref, 2, terminal, '')
                    resume.assert_not_called()
                    self.assertEqual(self.run['state'], 'failed')
                    self.assertEqual(self.run['cliSid'], 'retained-native')
                    if failed:
                        self.assertIn('synthetic transport failure', self.run['error'])
                        self.assertNotEqual(self.run.get('failureKind'), 'execution_incomplete')
                    else:
                        self.assertEqual(self.run['failureKind'], 'execution_incomplete')
                        self.assertEqual(self.run['error'], local_turn_outcome.TRUNCATED)

    def test_dsh_successful_native_continuation_clears_only_output_truncation(self):
        terminal = {}
        self.dsh_step(terminal, "max_tokens")
        self.dsh_step(terminal, "stop")
        self.assertNotIn("outputTruncated", terminal)
        self.assertNotIn("piFinalResponse", terminal)
        self.finish(terminal).assert_not_called()
        self.assertEqual(self.run["state"], "done")
        self.assertEqual(self.run["error"], "")

    def test_dsh_context_watermarks_and_intermediate_steps_do_not_settle_output(self):
        terminal = {}
        self.dsh_step(terminal, "max_tokens", contextOnly=True)
        self.assertNotIn("outputTruncated", terminal)
        self.dsh_step(terminal, "max_tokens")
        for reason, extra in (("stop", {"contextOnly": True}), ("tool-calls", {}), (None, {})):
            self.dsh_step(terminal, reason, **extra)
            self.assertTrue(terminal.get("outputTruncated"))

    def test_dsh_protocol_failure_overrides_truncation_before_or_after_later_events(self):
        error = {"error": {"name": "AcpBridgeError", "message": "synthetic ACP transport failure"}}
        for error_first in (False, True):
            with self.subTest(error_first=error_first):
                self.run.update(state="running", cli="dsh", queue=[])
                terminal = {}
                if error_first:
                    local_stream._on_line(self.ref, json.dumps(error), terminal)
                self.dsh_step(terminal, "max_tokens")
                if not error_first:
                    local_stream._on_line(self.ref, json.dumps(error), terminal)
                else:
                    self.dsh_step(terminal, "stop")
                self.assertNotIn("outputTruncated", terminal)
                self.assertTrue(terminal["isError"])
                with patch.object(local_stream, "_resume") as resume:
                    local_stream._finish(self.ref, 2, terminal, "")
                resume.assert_not_called()
                self.assertEqual(self.run["state"], "failed")
                self.assertIn("synthetic ACP transport failure", self.run["error"])
                self.assertNotEqual(self.run.get("failureKind"), "execution_incomplete")

    def test_dsh_execution_host_failure_overrides_native_output_limit(self):
        terminal = {}
        self.dsh_step(terminal, "max_tokens")
        with patch.object(local_stream, "_resume") as resume:
            local_stream._finish(self.ref, 2, terminal, "synthetic execution host cleanup failed")
        resume.assert_not_called()
        self.assertEqual(self.run["state"], "failed")
        self.assertIn("synthetic execution host cleanup failed", self.run["error"])
        self.assertNotEqual(self.run.get("failureKind"), "execution_incomplete")

    def test_pi_and_opencode_protocol_errors_override_earlier_or_later_truncation(self):
        for cli in ("pi", "opencode"):
            error = ({"type": "error", "error": {"name": "APIError", "data": {
                "message": "synthetic transport failure"}}} if cli == "opencode" else {
                "error": {"name": "SyntheticProtocolError", "message": "synthetic transport failure"}})
            for error_first in (False, True):
                with self.subTest(cli=cli, error_first=error_first):
                    self.run.update(state="running", cli=cli, queue=[], failureKind="")
                    terminal = {}
                    def observe(reason):
                        event = ({"type": "message_end", "message": {
                            "role": "assistant", "stopReason": reason}}
                            if cli == "pi" else {"type": "step_finish", "part": {"reason": reason}})
                        local_stream._on_line(self.ref, json.dumps(event), terminal)
                    if error_first:
                        local_stream._on_line(self.ref, json.dumps(error), terminal)
                    observe("length")
                    if error_first:
                        self.assertNotIn("outputTruncated", terminal)
                        observe("stop")
                    else:
                        local_stream._on_line(self.ref, json.dumps(error), terminal)
                    self.assertNotIn("outputTruncated", terminal)
                    with patch.object(local_stream, "_resume") as resume:
                        local_stream._finish(self.ref, 2, terminal, "")
                    resume.assert_not_called()
                    self.assertEqual(self.run["state"], "failed")
                    self.assertIn("synthetic transport failure", self.run["error"])
                    self.assertNotEqual(self.run.get("failureKind"), "execution_incomplete")

    def test_pi_model_failure_after_length_prevents_local_recovery_but_retry_can_succeed(self):
        for reason in ("error", "aborted"):
            with self.subTest(reason=reason):
                self.run.update(state="running", cli="pi", queue=[], failureKind="")
                terminal = self.event("length")
                # Pi settles a truncated call as unexecuted, then can start a
                # follow-up model round whose real failure must remain visible.
                for event in ({"type": "tool_execution_start", "toolCallId": "partial-call",
                               "toolName": "write", "args": {}},
                              {"type": "tool_execution_end", "toolCallId": "partial-call",
                               "isError": True, "result": {"content": [{"type": "text",
                               "text": "Tool call was not executed because output was truncated"}]}}):
                    local_stream._on_line(self.ref, json.dumps(event), terminal)
                message = {"role": "assistant", "stopReason": reason,
                           "errorMessage": "404 status code (no body)"}
                for event in ({"type": "message_end", "message": message},
                              {"type": "turn_end", "message": message},
                              {"type": "agent_end", "messages": [message]}):
                    local_stream._on_line(self.ref, json.dumps(event), terminal)
                self.assertNotIn("outputTruncated", terminal)
                self.finish(terminal).assert_not_called()
                self.assertEqual(self.run["state"], "failed")
                self.assertIn("HTTP 404" if reason == "error" else "已中断", self.run["error"])
                self.assertNotEqual(self.run.get("failureKind"), "execution_incomplete")
                # The model can recover inside the same native process; only its
                # own semantic error may be replaced by that successful retry.
                self.run.update(state="running")
                local_stream._on_line(self.ref, json.dumps({"type": "message_end", "message": {
                    "role": "assistant", "stopReason": "stop"}}), terminal)
                self.finish(terminal).assert_not_called()
                self.assertEqual(self.run["state"], "done")

    def test_pi_protocol_failure_takes_ownership_from_retryable_model_error(self):
        terminal = self.event("error")
        self.assertTrue(terminal["piSemanticError"])
        local_stream._on_line(self.ref, json.dumps({"error": {
            "name": "SyntheticProtocolError", "message": "synthetic protocol lost"}}), terminal)
        for reason in ("length", "stop"):
            local_stream._on_line(self.ref, json.dumps({"type": "message_end", "message": {
                "role": "assistant", "stopReason": reason}}), terminal)
        self.assertNotIn("piSemanticError", terminal)
        self.assertNotIn("outputTruncated", terminal)
        self.finish(terminal).assert_not_called()
        self.assertEqual(self.run["state"], "failed")
        self.assertIn("synthetic protocol lost", self.run["error"])

    def test_tool_failures_do_not_clear_model_truncation_or_become_protocol_errors(self):
        events = {
            "pi": {"type": "tool_execution_end", "toolCallId": "failed-tool", "isError": True,
                   "result": {"content": [{"type": "text", "text": "synthetic tool failure"}]}},
            "opencode": {"type": "tool_use", "part": {"type": "tool", "callID": "failed-tool",
                         "state": {"status": "error", "error": "synthetic tool failure"}}},
        }
        for cli, event in events.items():
            with self.subTest(cli=cli):
                self.run.update(cli=cli)
                terminal = {"outputTruncated": True}
                local_stream._on_line(self.ref, json.dumps(event), terminal)
                self.assertTrue(terminal["outputTruncated"])
                self.assertFalse(terminal.get("isError"))


if __name__ == "__main__":
    unittest.main()
