"""CLI setup probes: private subprocess fixtures, no models/accounts/installs."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="soduwork-agent-probe-test-")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-agent-probe-test-secret")

from app.services import agent_setup, local_base


def ndjson(*events):
    return "\n".join(json.dumps(event) for event in events)


def text(value, stream="acp:message:1", done=False):
    return {"type": "text", "part": {"streamId": stream, "text": value,
            "delta": value, "done": done}}


class AgentSetupProbeTests(unittest.TestCase):
    def test_account_codex_probe_uses_the_chat_transport_and_a_private_readonly_home(self):
        from app.services import codex_account_acp as account
        seen = {}
        profile = local_base._PROFILES["codex"]
        def environment(prof, cfg, runtime_ref=""):
            seen.update(cfg=cfg.copy(), runtime_ref=runtime_ref)
            return {"CODEX_PATH": "account-native"}
        def command(executable, args, ws, cfg, prof):
            seen.update(args=args, workspace=ws)
            return ["account-bridge"]
        with (patch.object(agent_setup, "_bin_of", return_value="account-native"),
              patch.object(agent_setup, "_short", return_value="0.164.0"),
              patch.object(agent_setup, "_probe_ws", return_value=_DATA.name),
              patch.object(agent_setup, "_command_argv", side_effect=command),
              patch.object(local_base, "_env_for", side_effect=environment),
              patch.object(agent_setup, "_stream", return_value=(0, ndjson(text(agent_setup._TOKEN, done=True)))),
              patch.object(agent_setup, "_say"), patch.object(agent_setup, "_save_probe"),
              patch.object(agent_setup, "_done")):
            agent_setup._run_probe("account-probe", "codex", {})
        self.assertEqual(seen["cfg"].get(account.TRANSPORT_KEY), account.TRANSPORT)
        self.assertEqual(seen["cfg"]["accessPolicy"]["mode"], "readonly")
        self.assertEqual(seen["cfg"]["accessPolicy"]["workspaceRoot"], os.path.realpath(_DATA.name))
        self.assertTrue(seen["runtime_ref"], "Probes must not reuse a conversation/shared credential home")
        self.assertEqual(seen["args"][:2], ["--soduwork-session", ""])
        self.assertNotIn("exec", seen["args"])
        self.assertNotIn("codex_model", seen["cfg"], "A probe must not silently select another model")

    def test_known_codex_login_error_survives_probe_preparation_without_secret_details(self):
        from app.services import codex_runtime_home as home
        result = {}
        with (patch.object(agent_setup, "_bin_of", return_value="account-native"),
              patch.object(agent_setup, "_short", return_value="0.164.0"),
              patch.object(agent_setup, "_probe_ws", return_value=_DATA.name),
              patch.object(local_base, "_env_for", side_effect=home.CodexLoginError("source-format", "JSONDecodeError")),
              patch.object(agent_setup, "_stream") as stream,
              patch.object(agent_setup, "_say"), patch.object(agent_setup, "_done"),
              patch.object(agent_setup, "_save_probe", side_effect=lambda key, value: result.update(value))):
            agent_setup._run_probe("account-probe", "codex", {})
        self.assertFalse(result["ok"])
        self.assertIn("JSONDecodeError", result["detail"])
        self.assertIn("Runner", result["detail"])
        stream.assert_not_called()

    def test_windows_initialization_error_is_distinct_from_model_or_login_failure(self):
        for code in (3221225794, -1073741502):
            with self.subTest(code=code):
                result = self.run_probe("", code=code)
                self.assertFalse(result["ok"])
                self.assertIn("0xC0000142", result["detail"])
                self.assertIn("DLL", result["detail"])
                self.assertNotIn("密钥", result["detail"])

    def run_probe(self, output, code=0, key="qwen"):
        result = {}
        profile = {"name": "Fixture Agent", "needs_llm": False,
                   "start": lambda *_args: []}
        with (patch.dict(agent_setup._PROFILES, {key: profile}),
              patch.object(agent_setup, "_bin_of", return_value=sys.executable),
              patch.object(agent_setup, "_short", return_value="0.25.0"),
              patch.object(agent_setup, "_probe_ws", return_value=_DATA.name),
              patch.object(agent_setup, "_command_argv", return_value=[sys.executable]),
              patch.object(local_base, "_env_for", return_value={}),
              patch.object(agent_setup, "_stream", return_value=(code, output)),
              patch.object(agent_setup, "_say"),
              patch.object(agent_setup, "_save_probe", side_effect=lambda _key, rec: result.update(rec)),
              patch.object(agent_setup, "_done")):
            agent_setup._run_probe("fixture-job", key, {})
        return result

    def test_acp_chunks_form_one_assistant_answer_for_every_bridge_agent(self):
        output = ndjson(text(agent_setup._TOK_A.rstrip("_")), text("_" + agent_setup._TOK_B), text("", done=True))
        for key in ("qwen", "dsh", "codex-harness", "opencode"):
            with self.subTest(key=key):
                self.assertTrue(self.run_probe(output, key=key)["ok"])

    def test_ansi_and_json_escaping_do_not_break_answer_matching(self):
        escaped = agent_setup._TOKEN.replace("_", r"\u005f", 1)
        for output in (agent_setup._TOK_A + "\x1b[32m" + agent_setup._TOK_B + "\x1b[0m",
                       '{"type":"text","part":{"text":"' + escaped + '"}}',
                       '[INFO] fixture startup\n' + ndjson(text(agent_setup._TOKEN, done=True))):
            with self.subTest(output=output):
                self.assertTrue(self.run_probe(output)["ok"])

    def test_assistant_answer_cannot_override_nonzero_exit_or_terminal_error(self):
        answer = ndjson(text(agent_setup._TOKEN), text("", done=True))
        self.assertFalse(self.run_probe(answer, code=2)["ok"])
        for error in ({"error": {"name": "AcpBridgeError", "message": "failed"}},
                      {"type": "result", "is_error": True, "result": "authentication_failed"},
                      {"type": "turn.failed", "error": {"message": "disconnected"}}):
            with self.subTest(error=error):
                self.assertFalse(self.run_probe(answer + "\n" + ndjson(error))["ok"])

    def test_user_tools_reasoning_and_diagnostic_token_are_never_answers(self):
        for event in ({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": agent_setup._TOKEN}]}},
                      {"type": "tool_execution_end", "result": agent_setup._TOKEN},
                      {"type": "reasoning", "part": {"text": agent_setup._TOKEN}},
                      {"error": {"message": "expected " + agent_setup._TOKEN}},
                      {"type": "session", "note": agent_setup._TOKEN}):
            with self.subTest(event=event):
                self.assertFalse(self.run_probe(ndjson(event))["ok"])

    def test_suffix_only_and_unrelated_streams_remain_failures(self):
        self.assertFalse(self.run_probe(ndjson(text("_" + agent_setup._TOK_B), text("", done=True)))["ok"])
        separate = ndjson(text(agent_setup._TOK_A.rstrip("_"), "one"), text("_" + agent_setup._TOK_B, "two"),
                          text("", "one", True), text("", "two", True))
        self.assertFalse(self.run_probe(separate)["ok"])

    def test_existing_native_assistant_shapes_still_pass(self):
        token = agent_setup._TOKEN
        for event in ({"type": "message_update", "assistantMessageEvent": {"type": "text_end", "content": token}},
                      {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": token}], "stopReason": "stop"}},
                      {"type": "item.completed", "item": {"id": "answer", "type": "agent_message", "text": token}},
                      {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": token}]}},
                      {"type": "result", "is_error": False, "result": token},
                      {"type": "text", "part": {"text": token}}):
            with self.subTest(event=event):
                self.assertTrue(self.run_probe(ndjson(event))["ok"])

    def test_claude_truncation_after_token_is_not_a_successful_probe(self):
        token = agent_setup._TOKEN
        snapshot = {"type": "assistant", "message": {"role": "assistant",
            "content": [{"type": "text", "text": token}], "stop_reason": "max_tokens"}}
        stream = ndjson(
            {"type": "stream_event", "event": {"type": "message_start", "message": {"id": "answer"}}},
            {"type": "stream_event", "event": {"type": "content_block_start", "index": 0,
                "content_block": {"type": "text", "text": token}}},
            {"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}},
            {"type": "stream_event", "event": {"type": "message_delta", "delta": {"stop_reason": "max_tokens"}}},
            {"type": "stream_event", "event": {"type": "message_stop"}})
        for output in (ndjson(snapshot), stream):
            with self.subTest(output=output):
                result = self.run_probe(output)
                self.assertFalse(result["ok"])
                self.assertRegex(result["detail"], "截断|未完成|上限")

    def test_claude_error_result_errors_are_explained_even_without_result_text(self):
        output = ndjson({"type": "result", "subtype": "error_during_execution",
            "is_error": True, "errors": ["gateway HTTP 403: forbidden"]})
        result = self.run_probe(output)
        self.assertFalse(result["ok"])
        self.assertIn("403", result["detail"])
        self.assertIn("权限", result["detail"])

    def test_preparation_or_process_start_failure_replaces_old_probe_success(self):
        for stage in ("environment", "command", "process"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                state = Path(directory) / "probe.json"
                state.write_text(json.dumps({"qwen": {"ok": True, "detail": "old success"}}), encoding="utf-8")
                jid = agent_setup._new_job("qwen", "probe")
                with (patch.object(agent_setup, "_PROBE_FILE", str(state)),
                      patch.object(agent_setup, "_bin_of", return_value=sys.executable),
                      patch.object(agent_setup, "_short", return_value="0.25.0"),
                      patch.dict(agent_setup._PROFILES, {"qwen": {"needs_llm": False}}),
                      patch.object(agent_setup, "_probe_ws", return_value=directory),
                      patch.object(local_base, "_env_for", side_effect=PermissionError("fixture") if stage == "environment" else None, return_value={}),
                      patch.object(agent_setup, "_command_argv", side_effect=FileNotFoundError("fixture") if stage == "command" else None, return_value=[sys.executable]),
                      patch.object(agent_setup, "_stream", side_effect=FileNotFoundError("fixture")),
                      patch.object(agent_setup.log, "exception")):
                    agent_setup._guard(jid, agent_setup._run_probe, "qwen", {})
                    persisted = agent_setup._load_probes()["qwen"]
                self.assertFalse(persisted["ok"], "The page must not keep showing the previous successful test")
                self.assertEqual(agent_setup.job(jid)["state"], "done")
                self.assertFalse(agent_setup.job(jid)["ok"])
                self.assertTrue(persisted["steps"][0]["ok"], "Version success remains separate from runtime failure")

    def test_malformed_protocol_records_finish_as_failures_even_after_a_token(self):
        answer = ndjson(text(agent_setup._TOKEN, done=True))
        for event in ({"type": "assistant", "message": ["invalid"]},
                      {"type": "stream_event", "event": {"type": "message_delta", "delta": ["invalid"]}},
                      {"type": "message_start", "message": "invalid"}):
            with self.subTest(event=event):
                result = self.run_probe(answer + "\n" + ndjson(event))
                self.assertFalse(result["ok"])
                self.assertRegex(result["detail"], "协议|格式")

    def test_broken_json_frame_cannot_be_ignored_after_an_assistant_token(self):
        answer = ndjson(text(agent_setup._TOKEN, done=True))
        broken = '{"type":"result","is_error":true'
        for output in (answer + "\n" + broken, broken + "\n" + answer):
            with self.subTest(output=output):
                result = self.run_probe(output)
                self.assertFalse(result["ok"])
                self.assertRegex(result["detail"], "JSON|协议|格式")

    def test_stream_closes_its_output_and_hides_ansi_wrapped_json(self):
        created = []
        original = agent_setup.subprocess.Popen
        def spawn(*args, **kwargs):
            process = original(*args, **kwargs)
            created.append(process)
            return process
        source = "print('\\x1b[32m{\\\"type\\\":\\\"text\\\"}\\x1b[0m',flush=True)"
        with (patch.object(agent_setup.subprocess, "Popen", side_effect=spawn),
              patch.object(agent_setup, "_say") as say):
            code, output = agent_setup._stream("fixture", [sys.executable, "-c", source],
                                              timeout=3, quiet_re=r"^\s*\{")
        self.assertEqual(code, 0)
        self.assertIn('"type":"text"', output)
        self.assertEqual(say.call_count, 1, "Only the non-secret command heading should be logged")
        self.assertTrue(created[0].stdout.closed)

    def test_stdout_eof_cannot_cancel_the_process_deadline(self):
        # Model pipe EOF while a real private child is still alive. Windows
        # duplicates inherited pipe handles, so closing only fd 1/2 in the
        # child cannot portably force this boundary in a subprocess fixture.
        source = "import time;print('answer',flush=True);time.sleep(10)"
        original, outputs, owned = agent_setup.subprocess.Popen, [], []
        class EndedOutput:
            def __init__(self, output): self.output = output
            def __iter__(self): yield self.output.readline()
            def close(self): self.output.close()
        def spawn(*args, **kwargs):
            process = original(*args, **kwargs)
            if source in args[0]:
                owned.append(process)
                outputs.append(process.stdout)
                process.stdout = EndedOutput(process.stdout)
            return process
        try:
            with (patch.object(agent_setup, "_say"),
                  patch.object(agent_setup.subprocess, "Popen", side_effect=spawn)):
                code, output = agent_setup._stream("fixture", [sys.executable, "-c", source], timeout=1)
        finally:
            for stream in outputs: stream.close()
        self.assertEqual(code, 124, "Closing stdout must not turn a timed-out process into exit-zero success")
        # Windows taskkill itself can take several seconds. Observe actual
        # termination rather than comparing wall time to the child's sleep.
        self.assertNotEqual(owned[0].returncode, 0, "The deadline must terminate the process before its normal exit")
        self.assertIn("answer", output)

    def test_real_acp_bridge_and_stream_pipeline_reassemble_the_fixture_reply(self):
        fake = Path(_DATA.name) / "probe_agent.py"
        chunks = (agent_setup._TOK_A.rstrip("_"), "_" + agent_setup._TOK_B)
        fake.write_text("chunks = " + repr(chunks) + "\n" + '''import json, sys
# ACP is a UTF-8 protocol, including on Windows hosts with a different code page.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
if "--version" in sys.argv:
    print("0.25.0"); raise SystemExit(0)
for raw in sys.stdin:
    message=json.loads(raw); method=message.get("method")
    if method == "initialize":
        result={"protocolVersion":1,"agentCapabilities":{}}
    elif method == "session/new":
        result={"sessionId":"fixture-probe"}
    elif method == "session/prompt":
        for chunk in chunks:
            print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fixture-probe","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":chunk}}}}),flush=True)
        result={"stopReason":"end_turn"}
    else:
        raise AssertionError(method)
    print(json.dumps({"jsonrpc":"2.0","id":message["id"],"result":result}),flush=True)
''', encoding="utf-8")
        bridge = Path(agent_setup.__file__).with_name("acp_bridge.py")
        command = [sys.executable, str(bridge), "--cwd", _DATA.name,
                   "--agent-name", "fixture", "--permission", "readonly", "--",
                   sys.executable, str(fake)]
        result = {}
        profile = {"name": "Fixture Agent", "needs_llm": False,
                   "argv_prefix": lambda: [str(fake)], "start": lambda *_args: []}
        with (patch.dict(agent_setup._PROFILES, {"qwen": profile}),
              patch.object(agent_setup, "_bin_of", return_value=sys.executable),
              patch.object(agent_setup, "_probe_ws", return_value=_DATA.name),
              patch.object(agent_setup, "_command_argv", return_value=command),
              patch.object(local_base, "_env_for", return_value={"SYSTEMROOT": os.environ.get("SYSTEMROOT", "C:/Windows")}),
              patch.object(agent_setup, "_say"),
              patch.object(agent_setup, "_save_probe", side_effect=lambda _key, rec: result.update(rec)),
              patch.object(agent_setup, "_done")):
            agent_setup._run_probe("fixture-real-bridge", "qwen", {})
        self.assertTrue(result["steps"][0]["ok"])
        self.assertTrue(result["ok"], result)


if __name__ == "__main__":
    unittest.main()
