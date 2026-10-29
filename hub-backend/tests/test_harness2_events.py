"""ACP error events cannot leak diagnostics or prove a successful Harness² turn."""
from __future__ import annotations

import copy
import io
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

from app.services import acp_bridge, harness2_bridge


class Harness2EventTests(unittest.TestCase):
    private = "fixture-private-key provider-private-body user-private-prompt"

    def test_all_failure_event_shapes_are_replaced_with_fixed_safe_errors(self):
        cases = (
            ({"type": "item.completed", "item": {"type": "error",
               "message": "Invalid ACP stdout: HTTP 401 " + self.private}}, "HTTP 401"),
            ({"error": {"name": "ProviderError", "message": "HTTP 403 " + self.private},
              "diagnostic": self.private}, "HTTP 403"),
            ({"is_error": True, "result": "HTTP 429 " + self.private}, "HTTP 429"),
            ({"type": "error", "message": "EACCES " + self.private}, "EACCES"),
            ({"type": "turn.failed", "error": {"message": "ETIMEDOUT " + self.private}}, "ETIMEDOUT"),
            ({"type": "item.completed", "item": {"type": "error",
               "message": self.private}}, "执行"),
        )
        for raw, category in cases:
            for serialized in (False, True):
                with self.subTest(category=category, serialized=serialized):
                    output = []
                    events = harness2_bridge.ExecutionEvents(output.append)
                    original = copy.deepcopy(raw)
                    events.consume(json.dumps(raw) if serialized else raw)
                    events.mark_completed()
                    self.assertFalse(events.succeeded(0))
                    self.assertEqual(len(output), 1)
                    self.assertEqual(set(output[0]), {"error"})
                    self.assertEqual(output[0]["error"]["name"], "Harness2Error")
                    self.assertIn(category, output[0]["error"]["message"])
                    for private in self.private.split():
                        self.assertNotIn(private, json.dumps(output))
                    self.assertEqual(raw, original)

    def test_normal_messages_tool_results_and_native_session_are_preserved(self):
        output = []
        events = harness2_bridge.ExecutionEvents(output.append)
        normal = [
            {"type": "session", "sessionID": "native-session"},
            {"type": "text", "part": {"text": "User-visible answer", "done": True}},
            {"type": "tool_execution_end", "isError": True, "result": "Tool diagnostic"},
            {"type": "result", "is_error": False, "result": "Complete"},
            {"type": "step_finish", "part": {"tokens": {"input": 2, "output": 3}}},
        ]
        for event in normal:
            events.consume(event)
        events.mark_completed()
        self.assertEqual(output, normal)
        self.assertEqual(events.child_session, "native-session")
        self.assertTrue(events.succeeded(0))

    def test_native_end_turn_after_invalid_stdout_is_not_success(self):
        output = []

        def send(bridge, request):
            method = request.get("method")
            if method == "initialize":
                bridge.inbox.put(("noise", "HTTP 401 " + self.private))
                result = {"protocolVersion": 1}
            elif method == "session/new":
                result = {"sessionId": "native-session"}
            else:
                result = {"stopReason": "end_turn"}
            bridge.inbox.put(("message", {"id": request["id"], "result": result}))

        original_emit = acp_bridge._emit
        with tempfile.TemporaryDirectory() as directory:
            with (patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": ""}),
                  patch.object(acp_bridge.AcpBridge, "start"),
                  patch.object(acp_bridge.AcpBridge, "send", send),
                  patch.object(acp_bridge.AcpBridge, "close")):
                with self.assertRaisesRegex(harness2_bridge.Harness2Error, "HTTP 401"):
                    harness2_bridge.execute("Task", directory, "", "work", False,
                                            sys.executable, output=output.append)
        self.assertIs(acp_bridge._emit, original_emit)
        self.assertTrue(any(row.get("error") for row in output))
        for private in self.private.split():
            self.assertNotIn(private, json.dumps(output))

    def test_main_and_probe_parser_keep_first_specific_error_after_later_noise(self):
        from app.services import agent_setup_probe, harness2_lifecycle, harness2_runtime

        def run(_bridge, _prompt):
            acp_bridge._emit({"type": "item.completed", "item": {
                "type": "error", "message": "HTTP 401 " + self.private}})
            acp_bridge._emit({"type": "error", "message": self.private})
            return 0

        stdout = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            env = {harness2_runtime.MODEL_ENV: '{"key":"fixture-private-key"}',
                   harness2_runtime.ROOT_ENV: directory,
                   harness2_runtime.EXECUTOR_ENV: sys.executable}
            with (patch.dict(os.environ, env, clear=True),
                  patch.object(sys, "stdin", io.StringIO("Task")),
                  patch.object(sys, "stdout", stdout),
                  patch.object(harness2_lifecycle, "disabled_issue", return_value=""),
                  patch.object(harness2_runtime, "prepare_executor_config"),
                  patch("app.services.harness2_engine.refine", return_value="Refined task"),
                  patch.object(acp_bridge.AcpBridge, "run", run),
                  patch.object(acp_bridge.AcpBridge, "close")):
                code = harness2_bridge.main(["--probe", "--cwd", directory])
        self.assertEqual(code, 2)
        _answers, failure = agent_setup_probe._responses(stdout.getvalue())
        self.assertIn("HTTP 401", failure)
        for private in self.private.split():
            self.assertNotIn(private, stdout.getvalue())

    def test_first_error_survives_later_exit_and_blocks_permission_restart(self):
        for tail in (73, acp_bridge.BridgeError("ACP Agent exited early " + self.private)):
            with self.subTest(tail=type(tail).__name__):
                def run(_bridge, _prompt):
                    acp_bridge._emit({"error": {"message": "HTTP 401 " + self.private}})
                    if isinstance(tail, Exception):
                        raise tail
                    return tail

                with tempfile.TemporaryDirectory() as directory:
                    with (patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": ""}),
                          patch.object(acp_bridge.AcpBridge, "run", run),
                          patch.object(acp_bridge.AcpBridge, "close")):
                        with self.assertRaisesRegex(harness2_bridge.Harness2Error, "HTTP 401"):
                            harness2_bridge.execute("Task", directory, "", "work", False,
                                                    sys.executable, output=lambda _event: None)

    def test_clean_permission_restart_keeps_native_control_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            with (patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": ""}),
                  patch.object(acp_bridge.AcpBridge, "run", return_value=73),
                  patch.object(acp_bridge.AcpBridge, "close")):
                self.assertEqual(harness2_bridge.execute(
                    "Task", directory, "", "work", False, sys.executable,
                    output=lambda _event: None), 73)


if __name__ == "__main__":
    unittest.main()
