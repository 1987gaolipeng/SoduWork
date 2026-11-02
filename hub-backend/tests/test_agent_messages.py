"""Compatibility tests for machine-readable Agent presentation descriptors."""
from __future__ import annotations

import unittest

from app.services.agent_messages import decorate, decorate_many, descriptor, status_descriptor


class AgentMessageDescriptorTests(unittest.TestCase):
    def test_descriptor_is_bounded_and_keeps_fallback(self):
        item = descriptor("agent.ready", "ready", params={"agent": "pi"})
        self.assertEqual(item, {"key": "agent.ready", "params": {"agent": "pi"}, "fallback": "ready"})
        self.assertLessEqual(len(item["key"]), 120)
        self.assertLessEqual(len(item["fallback"]), 1000)

    def test_status_descriptor_uses_setup_state_before_legacy_state(self):
        item = status_descriptor({"key": "claude", "name": "Claude Code", "setupState": "unauthed",
                                  "state": "ready"}, fallback="Sign in first")
        self.assertEqual(item["key"], "agent.auth.required")
        self.assertEqual(item["params"]["agent"], "claude")
        self.assertEqual(item["fallback"], "Sign in first")

    def test_decorate_preserves_legacy_copy_and_adds_nonbreaking_fields(self):
        original = {"key": "kimi", "name": "Kimi Code", "state": "missing", "why": "Install it",
                    "warnNow": "Node is unavailable", "blurb": "Kimi summary"}
        result = decorate(original)
        self.assertEqual(result["why"], original["why"])
        self.assertEqual(result["warnNow"], original["warnNow"])
        self.assertEqual(result["whyMessage"]["key"], "agent.setup.missing")
        self.assertEqual(result["whyMessage"]["fallback"], "Install it")
        self.assertEqual(result["warnMessage"]["key"], "agent.runtime.issue")
        self.assertEqual(result["copy"]["blurb"]["key"], "agent.kimi.blurb")
        self.assertEqual(original.get("whyMessage"), None)

    def test_decorate_many_does_not_crash_on_legacy_malformed_rows(self):
        rows = decorate_many([{"key": "pi", "state": "ready"}, None, "legacy"])
        self.assertEqual(rows[0]["whyMessage"]["key"], "agent.ready")
        self.assertIsNone(rows[1])
        self.assertEqual(rows[2], "legacy")


if __name__ == "__main__":
    unittest.main()
