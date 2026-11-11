"""Offline native stream contract, no model or account calls."""
import unittest
from app.services.runtime_claude_messages import items


class ClaudeThinking(unittest.TestCase):
    def setUp(self):
        self.run = {"segment": 1}

    def event(self, kind, parent=None, **payload):
        return items({"type": "stream_event", "parent_tool_use_id": parent,
                      "event": {"type": kind, **payload}}, self.run)

    def test_live_completion_and_final_snapshot_share_identity(self):
        self.event("message_start", message={"id": "m1"})
        start = self.event("content_block_start", index=2, content_block={"type": "thinking", "thinking": ""})[0]
        first = self.event("content_block_delta", index=2, delta={"type": "thinking_delta", "thinking": "检查"})[0]
        second = self.event("content_block_delta", index=2, delta={"type": "thinking_delta", "thinking": "检查"})[0]
        self.assertEqual(start["streamId"], first["streamId"])
        self.assertNotEqual(first["_sourceId"], second["_sourceId"])
        end = self.event("content_block_stop", index=2)[0]
        self.assertTrue(end["done"] and end["delta"])
        final = items({"type": "assistant", "message": {"id": "m1", "content": [
            {"type": "text", "text": "reply"}, {"type": "redacted_thinking", "data": "hidden"},
            {"type": "thinking", "thinking": "检查检查", "signature": "secret"}]}}, self.run)[0]
        self.assertEqual(final["streamId"], first["streamId"])
        self.assertEqual(final["text"], "检查检查")
        self.assertTrue(final["done"])
        self.assertNotIn("signature", final)
        self.assertEqual(self.event("message_stop"), [])

    def test_parent_channels_and_segments_are_separate(self):
        self.event("message_start", message={"id": "root-message"})
        self.event("message_start", parent="child", message={"id": "child-message"})
        child = self.event("content_block_delta", parent="child", index=0,
                           delta={"type": "thinking_delta", "thinking": "child"})[0]
        root = self.event("content_block_delta", index=0,
                          delta={"type": "thinking_delta", "thinking": "root"})[0]
        self.assertNotEqual(root["streamId"], child["streamId"])
        self.assertEqual(len(self.event("message_stop")), 1)
        self.run["segment"] = 2
        self.assertEqual(self.event("content_block_delta", index=0,
                                   delta={"type": "thinking_delta", "thinking": "orphan"}), [])

    def test_plain_text_signatures_and_unrelated_events_do_not_become_thought(self):
        self.assertIsNone(items({"type": "result", "usage": {"output_tokens": 30}}, self.run))
        self.event("message_start", message={"id": "m1"})
        for delta in ({"type": "text_delta", "text": "reply"},
                      {"type": "signature_delta", "signature": "secret"}):
            self.assertEqual(self.event("content_block_delta", index=0, delta=delta), [])
        self.assertEqual(items({"type": "assistant", "message": {"content": [
            {"type": "redacted_thinking", "data": "secret"}]}}, self.run), [])


if __name__ == "__main__":
    unittest.main()
