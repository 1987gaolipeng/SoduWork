"""Native-runtime event regression, no model calls or live account needed."""
import json
import os
from pathlib import Path
import subprocess
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tempfile
import unittest
from unittest.mock import patch
from app.services import runtime_messages as rm, local_stream as stream, execution_event_policy as policy

def parse(message, run):
    return rm.augment(message, run, stream._items_from(message, run))

def fake_agent():
    def send(value):
        print(json.dumps(value), flush=True)
    for line in sys.stdin:
        packet = json.loads(line)
        method = packet.get("method")
        result = {}
        if method == "initialize":
            result = {"protocolVersion": 1, "agentCapabilities": {}}
        elif method == "session/new":
            result = {"sessionId": "fixture"}
        elif method == "session/prompt":
            for update in [
                {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "inspect"}},
                {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": " twice"}},
                {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": " twice"}},
                {"sessionUpdate": "tool_call", "toolCallId": "write-1", "title": "Write", "kind": "edit",
                 "rawInput": {"filePath": "result.md", "content": "must not expose file body"}},
                {"sessionUpdate": "tool_call_update", "toolCallId": "write-1", "status": "failed"},
                {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "done"}},
                {"sessionUpdate": "usage_update", "used": 4096, "size": 8192},
            ]:
                send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "fixture", "update": update}})
            result = {"stopReason": "end_turn"}
        send({"jsonrpc": "2.0", "id": packet["id"], "result": result})
    return 0

class MessageTests(unittest.TestCase):
    def test_request_watermark_ignores_partials_and_cumulative_codex_usage(self):
        ref = "context-accounting-fixture"
        run = {"cli": "pi", "lines": [], "segment": 1, "state": "running", "metaAt": float("inf")}
        with patch.dict(stream._RUNS, {ref: run}), patch.object(stream, "_append_raw"), patch.object(stream, "_append_events"), patch.object(stream, "_save_meta"):
            term = {}
            def emit(value):
                stream._on_line(ref, json.dumps(value), term)
            for inp, read in [(1000, 90000), (2000, 95000)]:
                emit({"type": "message_end", "message": {"role": "assistant",
                    "usage": {"input": inp, "cacheRead": read, "output": 10}}})
            self.assertEqual(run["tokens"]["input"], 97000)
            self.assertEqual(run["usage"]["input"], 188000)
            emit({"type": "message_update", "message": {"role": "assistant", "usage": {"input": 0}}})
            self.assertEqual(run["tokens"]["input"], 97000)
            emit({"type": "compaction_start"})
            self.assertEqual(run["tokens"], {})
            emit({"type": "step_finish", "contextOnly": True, "part": {"tokens": {"input": 12000}}})
            self.assertEqual(run["tokens"]["input"], 12000)
            self.assertEqual(run["usage"]["input"], 188000)
            emit({"type": "assistant", "message": {"role": "assistant",
                "content": [{"type": "text", "text": "Claude fixture"}], "usage": {
                    "input_tokens": 1000, "cache_read_input_tokens": 90000,
                    "cache_creation_input_tokens": 5000, "output_tokens": 10}}})
            self.assertEqual(run["tokens"]["input"], 96000)
            run["stopping"] = True
            emit({"type": "turn.completed", "usage": {"input_tokens": 300000, "output_tokens": 30}})
            self.assertEqual(run["tokens"]["input"], 96000)
            run["stopping"] = False
            emit({"type": "turn.completed", "usage": {"input_tokens": 300000, "output_tokens": 30}})
            self.assertEqual(run["tokens"], {})

    def test_context_input_matches_billing_normalization_without_double_cache(self):
        from app.services.local_context_policy import context_input
        for raw in [
            {"input": 1000, "cacheRead": 90000, "cacheWrite": 5000},
            {"input": 0, "cacheRead": 96000},
            {"input": 1000, "cache": {"read": 90000, "write": 5000}},
            {"prompt_tokens": 96000, "prompt_tokens_details": {"cached_tokens": 95000}},
            {"input_tokens": 96000, "cached_input_tokens": 95000},
            {"input_tokens": 96000, "cached_input_tokens": 95000, "cache_write_input_tokens": 0},
            {"input_tokens": 1000, "cache_read_input_tokens": 90000, "cache_creation_input_tokens": 5000},
            {"input": 96000, "cacheRead": 95000, "inputIncludesCache": True},
            {"input": 96000, "cacheRead": 95000, "input_includes_cache": True},
        ]:
            with self.subTest(raw=raw):
                self.assertEqual(context_input(raw), 96000)
                self.assertEqual(context_input(rm.usage(raw)), 96000)
        self.assertEqual(context_input({"prompt_tokens": 56000}), 56000)
        for raw in [{"totalTokens": 100}, {"input": None}, {"input": -1},
                    {"input": True}, {"input": float("inf")}, {"input": "bad"}]:
            with self.subTest(raw=raw):
                self.assertEqual(context_input(raw), 0)

    def test_interrupted_requests_preserve_the_last_report_until_a_new_measurement(self):
        from app.services.local_context_policy import update_usage
        run = {"tokens": {}}
        def finish(reason, usage):
            update_usage(run, {"type": "message_end", "message": {
                "role": "assistant", "stopReason": reason, "usage": usage}})
        zero = {"input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0}
        finish("aborted", zero)
        self.assertEqual(run["tokens"], {})
        run["stopping"] = True
        update_usage(run, {"type": "turn.completed", "usage": {"input_tokens": 4000}})
        self.assertEqual(run["tokens"], {})
        run["stopping"] = False
        finish("stop", {"input": 300, "cacheRead": 1700})
        for usage in (None, {}, zero, {"output": 13}, {"cacheRead": 0, "output": 13},
                      {"input": None, "cacheWrite": 0, "output": 13},
                      {"input": True, "cache": {"read": 0, "write": 0}, "output": 13}):
            for reason in ("aborted", "error"):
                finish(reason, usage)
                self.assertEqual(run["tokens"]["input"], 2000)
        finish("aborted", {"input": 0, "cacheRead": 1250})
        self.assertEqual(run["tokens"]["input"], 1250)
        finish("aborted", {"input": 0, "output": 2})
        self.assertEqual(run["tokens"]["input"], 0)
        finish("stop", {"input": 70})
        finish("aborted", {"input_tokens": 0, "output_tokens": 2})
        self.assertEqual(run["tokens"]["input"], 0)
        run["stopping"] = True
        update_usage(run, {"type": "compaction_end"})
        finish("aborted", zero)
        self.assertEqual(run["tokens"], {})
        run["stopping"] = False
        finish("stop", {"input": 70})
        self.assertEqual(run["tokens"]["input"], 70)

    def test_acp_distinguishes_missing_usage_from_explicit_zero_while_stopping(self):
        from app.services.acp_bridge import AcpBridge
        from app.services.local_context_policy import update_usage
        run = {"tokens": {"input": 2000}, "stopping": True}
        with tempfile.TemporaryDirectory() as cwd, patch("app.services.acp_bridge._emit",
                side_effect=lambda event: update_usage(run, event)):
            bridge = AcpBridge([], cwd, "fixture", "workspace")
            for value in ({}, {"used": None}, {"used": True}, {"used": "invalid"},
                          {"used": -1}, {"used": float("nan")}, {"used": float("inf")}):
                bridge._update({"sessionUpdate": "usage_update", "size": 128000, **value})
                self.assertEqual(run["tokens"]["input"], 2000)
            for value, expected in (("344", 344), (344.0, 344), (0, 0)):
                bridge._update({"sessionUpdate": "usage_update", "size": 128000, "used": value})
                self.assertEqual(run["tokens"]["input"], expected)

    def test_reopening_a_runner_archive_distinguishes_unmeasured_from_measured_zero(self):
        from app.services import local_base, ai_local
        ref = "archived-context-usage"
        for saved, expected in [({"input": 0, "output": 0, "total": 0}, {}),
                                ({"input": 0, "inputIncludesCache": True}, {"input": 0, "inputIncludesCache": True}),
                                ({"input": 1280}, {"input": 1280})]:
            with self.subTest(saved=saved), tempfile.TemporaryDirectory() as directory, \
                    patch.object(ai_local, "_STORE", directory), patch.object(local_base, "_STORE", directory), \
                    patch.dict(local_base._RUNS, clear=True):
                archive = Path(directory, ref)
                archive.mkdir()
                (archive / "meta.json").write_text(json.dumps({
                    "state": "stopped", "cli": "qwen", "ws": directory, "tokens": saved}), encoding="utf-8")
                self.assertEqual(ai_local.session_sync({}, ref)["tokens"], expected)

    def test_pi_delta_identity_end_and_message_usage(self):
        run = {"segment": 1, "lines": []}
        parse({"type": "message_start", "message": {"timestamp": 11}}, run)
        events = []
        for event in [{"type": "thinking_delta", "delta": "word "},
                      {"type": "thinking_delta", "delta": "word "},
                      {"type": "thinking_end", "content": "word word "}]:
            rows = parse({"type": "message_update", "assistantMessageEvent": {**event, "contentIndex": 0}}, run)
            accepted = policy.filter_new(run, rows)
            run["lines"] += accepted
            events += accepted
        self.assertEqual(len(events), 3)
        self.assertEqual([x["done"] for x in events], [False, False, True])
        self.assertEqual(events[0]["streamId"], events[2]["streamId"])
        usage = {"input": 10, "output": 4, "cacheRead": 3}
        self.assertEqual(parse({"type": "message_update", "message": {"role": "assistant", "usage": usage}}, run), [])
        self.assertEqual(parse({"type": "turn_end", "message": {"role": "assistant", "usage": usage}}, run), [])
        rows = parse({"type": "message_end", "message": {"role": "assistant", "usage": usage}}, run)
        self.assertEqual(rows[0]["usage"]["totalTokens"], 17)
        self.assertEqual(rows[0]["usageScope"], "message")

    def test_codex_snapshot_prefixes_and_real_summary_only(self):
        run = {"lines": []}
        for text, kind in [("one", "item.started"), ("one two", "item.updated"), ("one two", "item.completed")]:
            rows = parse({"type": kind, "item": {"type": "reasoning", "id": "r", "summary": [{"type": "summary_text", "text": text}]}}, run)
            accepted = policy.filter_new(run, rows)
            self.assertEqual(len(accepted), 1)
            run["lines"] += accepted
        self.assertEqual(len(policy.visible_items(run["lines"])), 3)
        rows = parse({"type": "item.completed", "item": {"type": "reasoning", "id": "private", "encrypted_content": "opaque"}}, run)
        self.assertEqual(rows[0]["text"], "")
        self.assertEqual(parse({"type": "turn.completed", "usage": {"input_tokens": 20, "cached_input_tokens": 8, "output_tokens": 5}}, run)[0]["usage"]["totalTokens"], 25)

    def test_opencode_thinking_and_cache_tokens(self):
        run = {}
        row = parse({"type": "reasoning", "part": {"id": "r", "text": "public thought", "time": {"start": 1}}}, run)[0]
        self.assertEqual(row["kind"], "thinking")
        self.assertFalse(row["done"])
        row = parse({"type": "reasoning", "part": {"id": "r", "text": "public thought", "time": {"start": 1, "end": 2}}}, run)[0]
        self.assertTrue(row["done"])
        value = rm.usage({"input": 5, "output": 8, "reasoning": 3, "cache": {"read": 20, "write": 10}})
        self.assertEqual(value["totalTokens"], 43)
        self.assertEqual(rm.usage({"input": 0, "output": 0, "reasoning": 7})["output"], 7)
        self.assertEqual(rm.usage({"input": 3, "cache": {"read": "bad", "write": float("inf")}})["input"], 3)

    def test_tool_metadata_and_public_archive_contract(self):
        for message in [
            {"type": "tool_use", "part": {"tool": "write", "callId": "a", "state": {"input": {"filePath": "a.md", "content": "not forwarded"}}}},
            {"type": "message_update", "assistantMessageEvent": {"type": "toolcall_end", "toolCall": {"name": "write", "id": "a", "arguments": {"path": "a.md", "content": "not forwarded"}}}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "write", "id": "a", "input": {"file_path": "a.md", "content": "not forwarded"}}]}},
        ]:
            row = parse(message, {})[0]
            self.assertEqual(row["callId"], "a")
            self.assertNotIn("content", row["arguments"])
            self.assertEqual(rm.public_fields(row)["arguments"], row["arguments"])
        row = parse({"type": "reasoning", "part": {"streamId": "r", "delta": " hi", "done": False}}, {})[0]
        self.assertEqual(rm.public_fields(row), {"streamId": "r", "delta": True, "done": False})
        billing = parse({"type": "step_finish", "part": {"tokens": {"input": 20, "output": 5}}}, {})[0]
        self.assertEqual(rm.public_fields(billing)["usage"]["totalTokens"], 25)

    def test_access_cancellation_survives_public_projection_without_hiding_failures(self):
        from types import SimpleNamespace
        from app.services.execution_sessions import _event_api
        for failed in (False, True):
            raw = {"type": "tool_execution_end", "toolCallId": "withdrawn", "toolName": "Run command",
                   "result": "Original native result", "isError": failed,
                   "state": "cancelled", "cancelReason": "access-change"}
            event = parse(raw, {})[0]
            public = rm.public_fields(event)
            archived = _event_api(SimpleNamespace(seq=2, kind=event["kind"], tool=event["tool"],
                text=event["text"], at=None, detail=public))
            self.assertEqual(archived["isError"], failed)
            self.assertEqual(archived["text"], "Original native result")
            if failed:
                self.assertNotIn("cancelReason", archived)
            else:
                self.assertEqual(archived["state"], "cancelled")
                self.assertEqual(archived["cancelReason"], "access-change")

    def test_context_occupancy_is_never_billed_and_partial_usage_only_once(self):
        ref = "native-message-fixture"
        run = {"cli": "pi", "lines": [], "segment": 1, "state": "running", "metaAt": float("inf")}
        with patch.dict(stream._RUNS, {ref: run}), patch.object(stream, "_append_raw"), patch.object(stream, "_append_events"), patch.object(stream, "_save_meta"):
            term = {}
            stream._on_line(ref, json.dumps({"type": "step_finish", "contextOnly": True, "part": {"tokens": {"input": 4096, "output": 0}}}), term)
            self.assertNotIn("usage", run)
            self.assertEqual(run["tokens"]["input"], 4096)
            for kind in ["message_update", "message_end", "turn_end", "agent_end"]:
                stream._on_line(ref, json.dumps({"type": kind, "message": {"role": "assistant", "usage": {"input": 0, "output": 7}}}), term)
            self.assertEqual(run["usage"]["output"], 7)
            self.assertEqual(len([x for x in run["lines"] if x["kind"] == "usage"]), 1)

    def test_actual_acp_child_emits_live_thoughts_and_context_only(self):
        root = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory(prefix="soduwork-stream-") as cwd:
            command = [sys.executable, str(root / "app/services/acp_bridge.py"),
                       "--cwd", cwd, "--agent-name", "fixture", "--permission", "workspace", "--",
                       sys.executable, str(Path(__file__).resolve()), "--fake-agent"]
            result = subprocess.run(command, input="fixture", text=True, encoding="utf-8", capture_output=True, timeout=20,
                                    creationflags=0x08000000 if os.name == "nt" else 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        thoughts = [x for x in rows if x["type"] == "reasoning"]
        self.assertEqual(len(thoughts), 4)
        self.assertEqual([x["part"]["done"] for x in thoughts], [False, False, False, True])
        self.assertEqual("".join(x["part"].get("delta", "") for x in thoughts), "inspect twice twice")
        tool = next(x for x in rows if x["type"] == "tool_use")
        self.assertEqual(tool["part"]["state"]["input"], {"filePath": "result.md"})
        self.assertEqual(tool["part"]["toolKind"], "edit")
        output = next(x for x in rows if x["type"] == "tool_execution_end")
        self.assertEqual(output["toolCallId"], "write-1")
        self.assertTrue(output["isError"])
        self.assertTrue(next(x for x in rows if x["type"] == "step_finish")["contextOnly"])
        run = {}
        parsed = [item for row in rows for item in parse(row, run)]
        self.assertFalse(any(x["kind"] == "usage" for x in parsed))
        self.assertTrue(any(x["kind"] == "say" and x["text"] == "done" for x in parsed))


    def test_acp_reply_then_thought_preserves_native_order(self):
        from app.services.acp_bridge import AcpBridge
        rows = []
        with tempfile.TemporaryDirectory(prefix="acp-order-") as cwd:
            bridge = AcpBridge([], cwd, "fixture", "workspace")
            with patch("app.services.acp_bridge._emit", rows.append):
                bridge._update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "first reply"}})
                bridge._update({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "next thought"}})
                bridge._flush_message()
        self.assertEqual([x["type"] for x in rows], ["text", "text", "reasoning", "reasoning"])
        self.assertEqual(rows[0]["part"]["text"], "first reply")
        self.assertFalse(rows[0]["part"]["done"])
        self.assertTrue(rows[1]["part"]["done"])
        self.assertTrue(rows[-1]["part"]["done"])


    def test_user_send_time_survives_real_event_archive_and_public_projection(self):
        from app.services import local_base
        from datetime import datetime, timezone
        ref = "timestamp-fixture"
        sent = 1788264000123
        run = {"cli": "pi", "ws": "", "state": "done", "lines": [], "segment": 1, "seq": 0}
        with tempfile.TemporaryDirectory(prefix="soduwork-event-time-") as directory, \
                patch.object(local_base, "_STORE", directory), patch.dict(local_base._RUNS, {ref: run}):
            result = stream.record_user_sync(ref, "question", sent_at=sent)
            self.assertTrue(result["ok"])
            saved = local_base._read_events(ref, 0)
            self.assertEqual(saved[0]["sentAt"], sent)
            self.assertEqual(rm.public_fields(saved[0])["sentAt"], sent)
            self.assertNotEqual(int(datetime.fromisoformat(saved[0]["at"].replace("Z", "+00:00")).timestamp() * 1000), sent)
            self.assertEqual(rm.epoch_ms(float("inf")), 0)
            self.assertEqual(rm.epoch_ms("yesterday"), 0)

if __name__ == "__main__":
    if "--fake-agent" in sys.argv:
        raise SystemExit(fake_agent())
    unittest.main()
