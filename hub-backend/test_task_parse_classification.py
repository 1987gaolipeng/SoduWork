"""Isolated requirement-classification contracts without database, service configuration, or real
model loading.
"""
import unittest

from app.services.task_parse_contract import _PARSE_SYSTEM, _sanitize_parsed


class TaskParseClassificationTest(unittest.TestCase):
    def test_business_kinds_survive_the_parser(self):
        for kind in ("requirement", "bug", "ticket", "improvement", "other"):
            with self.subTest(kind=kind):
                self.assertEqual(_sanitize_parsed({"kind": kind}).get("kind"), kind)

    def test_prompt_distinguishes_work_type_issue_kind_and_schedule(self):
        self.assertIn("kind: requirement | bug | ticket | improvement | other", _PARSE_SYSTEM)
        self.assertIn("cadence: once | routine", _PARSE_SYSTEM)
        self.assertNotIn("kind: once | routine", _PARSE_SYSTEM)

    def test_legacy_schedule_output_is_not_a_business_kind(self):
        parsed = _sanitize_parsed({"kind": "routine", "recur": "weekly"})
        self.assertNotIn("kind", parsed)
        self.assertEqual(parsed.get("cadence"), "routine")
        self.assertEqual(parsed["recur"], "weekly")

    def test_business_kind_and_schedule_are_independent(self):
        parsed = _sanitize_parsed({"kind": "bug", "cadence": "routine", "recur": "weekly"})
        self.assertEqual(parsed["kind"], "bug")
        self.assertEqual(parsed.get("cadence"), "routine")
        self.assertNotIn("kind", _sanitize_parsed({"kind": "arbitrary"}))


if __name__ == "__main__":
    unittest.main()
