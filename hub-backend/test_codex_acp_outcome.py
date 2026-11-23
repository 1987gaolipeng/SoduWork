"""Codex ACP failures must not become successful turns or replay user work."""
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.services import acp_bridge as bridge, codex_acp_outcome as outcome, runner_sources


def prompt_result(item, version=1):
    return {"stopReason": "end_turn", "_meta": {"jetbrains": {"air": {
        "version": version, "sessionFailure": item,
    }}}}


class CodexAcpOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-codex-outcome-")
        self.addCleanup(self.temp.cleanup)
        environment = patch.dict(os.environ, {
            "SODUWORK_APPROVAL_CHANNEL": "", bridge.runtime_images.ENV_KEY: "",
        })
        environment.start()
        self.addCleanup(environment.stop)

    def fixture(self, agent, result):
        acp = bridge.AcpBridge([], self.temp.name, agent, "readonly", session_id="retained-session")
        prompts = []

        def request(method, params):
            if method == "initialize":
                capabilities = params["clientCapabilities"]
                self.assertEqual(capabilities["_meta"], outcome.capabilities(agent)["_meta"])
                self.assertTrue(capabilities["auth"]["_meta"]["gateway"])
                self.assertFalse(capabilities["fs"]["writeTextFile"])
                self.assertFalse(capabilities["terminal"])
                return {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}
            self.assertEqual(params["sessionId"], "retained-session")
            if method == "session/load":
                return {}
            self.assertEqual(method, "session/prompt")
            prompts.append(params["prompt"][0]["text"])
            self.assertEqual(len(prompts), 1, "A failed Codex turn must not be replayed automatically")
            return result

        return acp, request, prompts

    def test_only_codex_agents_advertise_the_supported_failure_extension(self):
        expected = {"_meta": {"terminal_output_delta": True,
                              "jetbrains": {"air": {"version": 1, "capabilities": ["sessionFailure"]}}}}
        for agent in ("codex", "codex-harness"):
            self.assertEqual(outcome.capabilities(agent), expected)
            changed = outcome.capabilities(agent)
            changed["_meta"]["jetbrains"]["air"]["capabilities"].append("unimplemented")
            self.assertEqual(outcome.capabilities(agent), expected)
        for agent in ("qwen", "kimi", "opencode", "dsh", "acp", "codex-other"):
            self.assertEqual(outcome.capabilities(agent), {})
            self.assertEqual(outcome.failure(agent, prompt_result({"severity": "error", "title": "foreign"})), "")

    def test_terminal_errors_keep_bounded_diagnostics_and_have_a_missing_title_fallback(self):
        for agent in ("codex", "codex-harness"):
            self.assertEqual(outcome.failure(agent, prompt_result({"severity": "error", "title": "  Provider rejected request  "})),
                             "Provider rejected request")
            for title in (None, "", " \n", {}, 17):
                message = outcome.failure(agent, prompt_result({"severity": "error", "title": title}))
                self.assertIn("执行失败", message)
            message = outcome.failure(agent, prompt_result({"severity": "error", "title": "x" * 3000}))
            self.assertEqual(len(message), 2000)
            self.assertTrue(message.endswith("…"))

    def test_typed_failure_with_invalid_shape_version_or_severity_fails_closed(self):
        for version in (None, True, "1", 0, 2):
            with self.subTest(version=version):
                self.assertIn("失败信息无效", outcome.failure("codex", prompt_result({"severity": "error"}, version)))
        for item in (None, False, [], "failure", {}, {"severity": "unknown"}, {"severity": None}):
            with self.subTest(item=item):
                self.assertIn("失败信息无效", outcome.failure("codex-harness", prompt_result(item)))

    def test_warning_and_absent_failure_do_not_override_success(self):
        for result in (prompt_result({"severity": "warning", "title": "A recovered retry"}), {},
                       {"stopReason": "end_turn", "_meta": {"quota": {"token_count": 3}}},
                       {"_meta": {"jetbrains": {"air": {"version": 1, "other": "value"}}}}):
            self.assertEqual(outcome.failure("codex", result), "")

    def test_real_bridge_rejects_terminal_failures_before_permission_settlement(self):
        for agent in ("codex", "codex-harness"):
            for item in ({"severity": "error", "title": "Synthetic provider failure"}, None):
                with self.subTest(agent=agent, item=item):
                    acp, request, prompts = self.fixture(agent, prompt_result(item))
                    with patch.object(acp, "start"), patch.object(acp, "request", side_effect=request), \
                            patch.object(acp.access, "apply"), patch.object(bridge, "_emit"), \
                            patch.object(acp.transition, "complete", wraps=acp.transition.complete) as complete:
                        with self.assertRaises(bridge.BridgeError):
                            acp.run("Original synthetic task")
                    self.assertEqual(prompts, ["Original synthetic task"])
                    complete.assert_not_called()

    def test_warning_and_success_preserve_one_prompt_and_the_saved_session(self):
        for agent in ("codex", "codex-harness"):
            for result in ({"stopReason": "end_turn"}, prompt_result({"severity": "warning", "title": "Recovered"})):
                with self.subTest(agent=agent, result=result):
                    acp, request, prompts = self.fixture(agent, result)
                    with patch.object(acp, "start"), patch.object(acp, "request", side_effect=request), \
                            patch.object(acp.access, "apply"), patch.object(bridge, "_emit"):
                        self.assertEqual(acp.run("Original synthetic task"), 0)
                    self.assertEqual(prompts, ["Original synthetic task"])
                    self.assertEqual(acp.session_id, "retained-session")

    def test_main_emits_the_real_failure_once_and_closes_without_retry(self):
        for agent in ("codex", "codex-harness"):
            with self.subTest(agent=agent):
                acp, request, prompts = self.fixture(agent, prompt_result({"severity": "error", "title": "Synthetic provider failure"}))
                args = SimpleNamespace(agent=["fixture"], cwd=self.temp.name, agent_name=agent,
                                       permission="readonly", session="retained-session", terminal=False)
                output = io.StringIO()
                with patch.object(acp, "start"), patch.object(acp, "request", side_effect=request), \
                        patch.object(acp.access, "apply"), patch.object(bridge, "_parse", return_value=args), \
                        patch.object(bridge, "_utf8_stdio"), patch.object(bridge, "AcpBridge", return_value=acp), \
                        patch.object(bridge.sys, "stdin", io.StringIO("Original synthetic task")), \
                        patch.object(bridge.sys, "stdout", output), patch.object(acp, "close", wraps=acp.close) as close:
                    self.assertEqual(bridge.main(), 2)
                events = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertEqual([event["error"] for event in events if event.get("error")],
                                 [{"name": "AcpBridgeError", "message": "Synthetic provider failure"}])
                self.assertEqual(prompts, ["Original synthetic task"])
                close.assert_called_once_with()

    def test_runner_source_closure_includes_the_typed_failure_parser(self):
        backend = Path(__file__).resolve().parent
        self.assertIn(Path(outcome.__file__), runner_sources.build_inputs(backend, backend.parent))

    def test_real_bridge_retains_command_output_and_prefers_explicit_tool_errors(self):
        acp = bridge.AcpBridge([], self.temp.name, "codex-harness", "readonly")
        events = []
        with patch.object(bridge, "_emit", side_effect=events.append):
            acp._update(tool_update("command", sessionUpdate="tool_call", title="Run command", kind="execute"))
            acp._update(delta("command", "first "))
            acp._update(delta("command", "ignored", terminal_id="other"))
            acp._update(delta("command", "second", status="completed"))
            acp._update(tool_update("failed", sessionUpdate="tool_call", title="Failed tool", kind="execute"))
            acp._update(delta("failed", "partial stdout"))
            acp._update(tool_update("failed", status="failed", content=[{
                "type": "content", "content": {"type": "text", "text": "Actual native tool error"}}]))
        ended = [event for event in events if event.get("type") == "tool_execution_end"]
        self.assertEqual([(event["toolCallId"], event["result"], event["isError"]) for event in ended],
                         [("command", "first second", False), ("failed", "Actual native tool error", True)])
        self.assertFalse(acp.transition.busy())


def tool_update(tool_id, **fields):
    return {"sessionUpdate": "tool_call_update", "toolCallId": tool_id, **fields}


def delta(tool_id, text, *, terminal_id=None, **fields):
    return tool_update(tool_id, _meta={"terminal_output_delta": {
        "terminal_id": tool_id if terminal_id is None else terminal_id, "data": text}}, **fields)


class CodexToolOutputTests(unittest.TestCase):
    def test_deltas_are_isolated_by_both_tool_and_terminal_id(self):
        output = outcome.ToolOutput("codex")
        for tool_id in ("a", "b"):
            output.consume(tool_update(tool_id, sessionUpdate="tool_call"))
        output.consume(delta("a", "a1"))
        output.consume(delta("b", "b1"))
        output.consume(delta("a", "foreign", terminal_id="b"))
        output.consume(delta("a", "a2"))
        for meta in (None, [], {"terminal_output_delta": "invalid"},
                     {"terminal_output_delta": {"data": "no-id"}},
                     {"terminal_output_delta": {"terminal_id": "a", "data": 10}},
                     {"terminal_output": {"terminal_id": "a", "data": "unnegotiated"}}):
            output.consume(tool_update("a", _meta=meta))
        self.assertEqual(output.finish(tool_update("a", status="completed")), "a1a2")
        self.assertEqual(output.finish(tool_update("b", status="completed")), "b1")
        self.assertFalse(output.pending)

    def test_non_codex_agents_never_capture_or_change_fallback_content(self):
        for agent in ("qwen", "kimi", "opencode", "dsh", "codex-other", ""):
            with self.subTest(agent=agent):
                output = outcome.ToolOutput(agent)
                output.consume(tool_update("a", sessionUpdate="tool_call", rawOutput="snapshot"))
                output.consume(delta("a", "delta"))
                output.consume(tool_update("a", status="completed", rawOutput="terminal snapshot"))
                self.assertFalse(output.pending)
                self.assertEqual(output.finish(tool_update("a"), "existing content"), "existing content")

    def test_pending_tool_count_and_each_text_are_bounded(self):
        output = outcome.ToolOutput("codex-harness")
        for number in range(output.MAX_TOOLS + 1):
            tool_id = str(number)
            output.consume(tool_update(tool_id, sessionUpdate="tool_call"))
            output.consume(delta(tool_id, "🙂" * (output.MAX_TEXT + 10)))
        self.assertEqual(len(output.pending), 64)
        self.assertNotIn("0", output.pending)
        self.assertTrue(all(len(value) == 20_000 for value in output.pending.values()))
        self.assertLessEqual(sum(map(len, output.pending.values())), 64 * 20_000)
        output.consume(delta("0", "late evicted output"))
        self.assertNotIn("0", output.pending)
        output.consume(delta("64", "does not exceed the cap"))
        self.assertEqual(len(output.pending["64"]), 20_000)
        output.consume(tool_update("64", rawOutput="x" * 30_000))
        self.assertEqual(output.finish(tool_update("64", status="completed")), "x" * 20_000)

    def test_completed_and_failed_calls_release_buffers_and_keep_terminal_delta(self):
        for status in ("completed", "failed"):
            with self.subTest(status=status):
                output = outcome.ToolOutput("codex")
                output.consume(tool_update("a", sessionUpdate="tool_call"))
                output.consume(delta("a", "before-"))
                terminal = delta("a", "end", status=status)
                output.consume(terminal)
                self.assertEqual(output.finish(terminal), "before-end")
                self.assertFalse(output.pending)
                output.consume(delta("a", "late"))
                self.assertFalse(output.pending)
                self.assertEqual(output.finish(terminal), "")

    def test_search_raw_output_is_a_snapshot_and_never_doubled(self):
        output = outcome.ToolOutput("codex-harness")
        output.consume(tool_update("search", sessionUpdate="tool_call"))
        output.consume(delta("search", "match1\n"))
        for snapshot in ("match1\n", "match1\n", "match1\nmatch2\n"):
            output.consume(tool_update("search", rawOutput=snapshot))
        terminal = delta("search", "duplicate-delta", status="completed")
        terminal["rawOutput"] = "match1\nmatch2\n"
        output.consume(terminal)
        self.assertEqual(output.finish(terminal), "match1\nmatch2\n")
        self.assertFalse(output.pending)

    def test_real_content_error_wins_without_retaining_prior_output(self):
        output = outcome.ToolOutput("codex")
        output.consume(tool_update("a", sessionUpdate="tool_call", rawOutput="stdout snapshot"))
        terminal = tool_update("a", status="failed", rawOutput="more stdout")
        output.consume(terminal)
        self.assertEqual(output.finish(terminal, "Permission denied by native tool"),
                         "Permission denied by native tool")
        self.assertFalse(output.pending)

    def test_reused_ids_start_fresh_and_late_unknown_updates_do_not_pollute(self):
        output = outcome.ToolOutput("codex")
        output.consume(tool_update("reused", sessionUpdate="tool_call"))
        output.consume(delta("reused", "old unfinished output"))
        output.consume(tool_update("reused", sessionUpdate="tool_call"))
        output.consume(delta("reused", "new output"))
        self.assertEqual(output.finish(tool_update("reused", status="completed")), "new output")
        output.consume(delta("reused", "late old output"))
        output.consume(delta("unknown", "unowned output"))
        self.assertFalse(output.pending)
        output.consume(tool_update("reused", sessionUpdate="tool_call"))
        output.consume(delta("reused", "third output"))
        terminal = tool_update("unknown", status="failed", rawOutput="standalone failure snapshot")
        output.consume(terminal)
        self.assertEqual(output.finish(terminal), "standalone failure snapshot")
        self.assertEqual(output.finish(tool_update("reused", status="completed")), "third output")
        self.assertFalse(output.pending)

    def test_non_tool_events_and_invalid_tool_ids_cannot_allocate_buffers(self):
        output = outcome.ToolOutput("codex")
        for update in (None, [], {}, {"sessionUpdate": "usage_update", "toolCallId": "a"},
                       tool_update(""), tool_update(1), tool_update(None)):
            output.consume(update)
        self.assertFalse(output.pending)


if __name__ == "__main__":
    unittest.main()
