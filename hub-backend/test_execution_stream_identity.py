"""Real ACP chunk regression: repeated punctuation must survive every projection."""
import unittest
from app.services import execution_event_policy as policy, runtime_messages


class StreamIdentityTests(unittest.TestCase):
    def test_acp_repeated_chunks_survive_and_replay_is_idempotent(self):
        run = {"round": 1, "segment": 1, "lines": []}
        for chunk in ["switch", "-", "101", "8", "-", "amber", " ", " ", "amber"]:
            rows = runtime_messages.items({"type": "text", "part": {
                "streamId": "message-1", "text": chunk, "delta": chunk, "done": False}}, run)
            accepted = policy.filter_new(run, rows)
            self.assertEqual(len(accepted), 1)
            run["lines"].extend(accepted)
            self.assertEqual(policy.filter_new(run, rows), [])
        visible = policy.visible_items(run["lines"] + run["lines"])
        self.assertEqual("".join(row["text"] for row in visible), "switch-1018-amber  amber")

    def test_stream_completion_and_separate_messages_remain_visible(self):
        rows = [
            {"kind": "say", "streamId": "a", "text": "OK", "done": False, "_sourceId": "a:false"},
            {"kind": "say", "streamId": "a", "text": "OK", "done": True, "_sourceId": "a:true"},
            {"kind": "say", "streamId": "b", "text": "OK", "done": True, "_sourceId": "b:true"},
        ]
        self.assertEqual(len(policy.filter_new({"lines": []}, rows)), 3)
        self.assertEqual(len(policy.visible_items(rows + [rows[1]])), 3)


    def test_native_message_survives_interleaved_late_reasoning(self):
        import tempfile
        from unittest.mock import patch
        from app.services.acp_bridge import AcpBridge
        rows = []
        with tempfile.TemporaryDirectory() as cwd:
            bridge = AcpBridge([], cwd, "dsh", "workspace")
            with patch("app.services.acp_bridge._emit", rows.append):
                for kind, text in [("agent_message_chunk", "File has "),
                                   ("agent_thought_chunk", "late reasoning"),
                                   ("agent_message_chunk", "been written.")]:
                    bridge._update({"sessionUpdate": kind, "messageId": "1:3",
                                    "content": {"type": "text", "text": text}})
                bridge._update({"sessionUpdate": "tool_call", "toolCallId": "read-1",
                                "title": "Read", "kind": "read", "rawInput": {"path": "result.txt"}})
                bridge._update({"sessionUpdate": "agent_message_chunk", "messageId": "1:4",
                                "content": {"type": "text", "text": "Verified."}})
                bridge._flush_message()
        text = [row["part"] for row in rows if row["type"] == "text"]
        first = [row for row in text if row.get("streamId") == "1:3"]
        self.assertEqual("".join(row["text"] for row in first), "File has been written.")
        self.assertEqual([row["done"] for row in first], [False, False, True])
        done_at = next(i for i, row in enumerate(rows) if row["type"] == "text" and row["part"].get("done"))
        tool_at = next(i for i, row in enumerate(rows) if row["type"] == "tool_use")
        self.assertLess(done_at, tool_at)
        self.assertEqual(text[-1]["streamId"], "1:4")
        self.assertTrue(text[-1]["done"])

    def test_native_message_change_closes_preceding_stream(self):
        import tempfile
        from unittest.mock import patch
        from app.services.acp_bridge import AcpBridge
        rows = []
        with tempfile.TemporaryDirectory() as cwd:
            bridge = AcpBridge([], cwd, "dsh", "workspace")
            with patch("app.services.acp_bridge._emit", rows.append):
                for ident in ["first", "second"]:
                    bridge._update({"sessionUpdate": "agent_message_chunk", "messageId": ident,
                                    "content": {"type": "text", "text": ident}})
                bridge._flush_message()
        self.assertEqual([(x["part"]["streamId"], x["part"]["done"]) for x in rows],
                         [("first", False), ("first", True), ("second", False), ("second", True)])


if __name__ == "__main__":
    unittest.main()
