"""Invalid model date suggestions must not replace an existing form deadline."""
import unittest

from app.services.task_parse_contract import _sanitize_parsed


class TaskDateTests(unittest.TestCase):
    def test_impossible_calendar_days_are_omitted(self):
        for value in ("2026-02-29", "2026-02-31", "2026-04-31", "2026-13-01",
                      "2026-00-01", "2026-01-00", "0000-01-01"):
            for field in ("due", "start"):
                with self.subTest(field=field, value=value):
                    self.assertNotIn(field, _sanitize_parsed({field: value}))

    def test_valid_dates_and_leap_days_remain_unchanged(self):
        for value in ("2028-02-29", "2026-12-31", "2000-02-29"):
            self.assertEqual(_sanitize_parsed({"due": value, "start": value}),
                             {"due": value, "start": value})

    def test_invalid_reminder_clock_and_calendar_values_are_omitted(self):
        for value in ("2026-08-10T24:00", "2026-08-10T12:60", "2026-02-31T10:00",
                      "2026-13-01T10:00", "0000-01-01T10:00"):
            with self.subTest(value=value):
                self.assertNotIn("remind", _sanitize_parsed({"remind": value}))

    def test_valid_reminders_keep_existing_space_normalization(self):
        self.assertEqual(_sanitize_parsed({"remind": " 2028-02-29 23:59 "}),
                         {"remind": "2028-02-29T23:59"})

    def test_invalid_date_does_not_discard_other_draft_fields(self):
        self.assertEqual(_sanitize_parsed({"title": "Ship", "due": "2026-02-31",
                                           "priority": "high"}),
                         {"title": "Ship", "priority": "high"})

    def test_unsupported_date_formats_still_remain_omitted(self):
        for value in ("2026-2-1", "2026/02/01", "tomorrow", "2026-02-01T12:00Z"):
            with self.subTest(value=value):
                self.assertNotIn("due", _sanitize_parsed({"due": value}))
        self.assertNotIn("remind", _sanitize_parsed({"remind": "2026-02-01T12:00:00"}))


if __name__ == "__main__":
    unittest.main()
