"""Real ACP chunk regression: repeated punctuation must survive every projection."""
import unittest
from app.services import execution_event_policy as policy, runtime_messages


class StreamIdentityTests(unittest.TestCase):
    def test_empty_thought_chunks_do_not_split_anonymous_markdown(self):
        import tempfile
        from unittest.mock import patch
        from app.services.acp_bridge import AcpBridge
        chunks = ["## Delivery\n\n", "A **complete", " sentence**.\n\n",
                  "| Name | Value |\n| --- | --- |\n", "| Example | 1 |\n\n",
                  "```js\n", "const value = 1;\n", "```\n"]
        for agent in ("kimi", "qwen", "dsh", "opencode", "codex", "codex-harness", "acp"):
            with self.subTest(agent=agent), tempfile.TemporaryDirectory() as cwd:
                bridge = AcpBridge([], cwd, agent, "workspace")
                rows = []
                with patch("app.services.acp_bridge._emit", rows.append):
                    for chunk in chunks:
                        # Kimi forwards empty reasoning_content from SSE as ACP thoughts.
                        bridge._update({"sessionUpdate": "agent_thought_chunk",
                                        "content": {"type": "text", "text": ""}})
                        bridge._update({"sessionUpdate": "agent_message_chunk",
                                        "content": {"type": "text", "text": chunk}})
                        self.assertFalse(any(row["part"].get("done") for row in rows))
                    bridge._flush_message()
                self.assertEqual({row["type"] for row in rows}, {"text"})
                self.assertEqual({row["part"]["streamId"] for row in rows}, {"acp:message:1"})
                self.assertEqual("".join(row["part"]["text"] for row in rows), "".join(chunks))
                self.assertEqual([row["part"]["done"] for row in rows], [False] * len(chunks) + [True])

    def test_nonempty_thought_still_separates_anonymous_messages(self):
        import tempfile
        from unittest.mock import patch
        from app.services.acp_bridge import AcpBridge
        for thought in ("Check the result.", " \n"):
            with self.subTest(thought=thought), tempfile.TemporaryDirectory() as cwd:
                bridge = AcpBridge([], cwd, "kimi", "workspace")
                rows = []
                with patch("app.services.acp_bridge._emit", rows.append):
                    for kind, text in [("agent_message_chunk", "Before."),
                                       ("agent_thought_chunk", thought),
                                       ("agent_message_chunk", "After.")]:
                        bridge._update({"sessionUpdate": kind, "content": {"type": "text", "text": text}})
                    bridge._flush_message()
                text = [row["part"] for row in rows if row["type"] == "text"]
                reasoning = [row["part"] for row in rows if row["type"] == "reasoning"]
                self.assertEqual([(row["streamId"], row["done"]) for row in text],
                                 [("acp:message:1", False), ("acp:message:1", True),
                                  ("acp:message:2", False), ("acp:message:2", True)])
                self.assertEqual("".join(row["delta"] for row in reasoning), thought)
                self.assertTrue(reasoning[-1]["done"])

    def test_empty_thoughts_preserve_tool_and_turn_boundaries(self):
        import tempfile
        from unittest.mock import patch
        from app.services.acp_bridge import AcpBridge
        with tempfile.TemporaryDirectory() as cwd:
            bridge = AcpBridge([], cwd, "kimi", "workspace")
            rows = []
            with patch("app.services.acp_bridge._emit", rows.append):
                for boundary in ("tool", "turn"):
                    bridge._update({"sessionUpdate": "agent_message_chunk",
                                    "content": {"type": "text", "text": "Before " + boundary}})
                    bridge._update({"sessionUpdate": "agent_thought_chunk",
                                    "content": {"type": "text", "text": ""}})
                    if boundary == "tool":
                        bridge._update({"sessionUpdate": "tool_call", "toolCallId": "read-1",
                                        "title": "Read", "kind": "read", "rawInput": {"path": "result.txt"}})
                    else:
                        bridge._flush_message()
                bridge._update({"sessionUpdate": "agent_message_chunk",
                                "content": {"type": "text", "text": "Next turn."}})
                bridge._flush_message()
            text = [row["part"] for row in rows if row["type"] == "text"]
            self.assertEqual([row["streamId"] for row in text if row["done"]],
                             ["acp:message:1", "acp:message:2", "acp:message:3"])
            tool_index = next(i for i, row in enumerate(rows) if row["type"] == "tool_use")
            self.assertEqual(rows[tool_index - 1]["part"], {
                "streamId": "acp:message:1", "text": "", "delta": "", "done": True})
            self.assertFalse(any(row["type"] == "reasoning" for row in rows))

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
