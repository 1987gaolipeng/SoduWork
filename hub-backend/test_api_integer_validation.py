"""JSON integer validation, including legacy strings and hostile numeric values."""
import unittest

from fastapi import HTTPException

from app.api.input_validation import INT32_MAX, INT32_MIN, parse_integer


class IntegerValidationTests(unittest.TestCase):
    def test_exact_integers_and_legacy_decimal_strings(self):
        cases = [(0, 0), (INT32_MIN, INT32_MIN), (INT32_MAX, INT32_MAX),
                 ("  +12  ", 12), ("-09", -9), ("-0", 0),
                 (str(INT32_MIN), INT32_MIN), (str(INT32_MAX), INT32_MAX),
                 ("0" * 5000 + "1", 1)]
        for value, expected in cases:
            with self.subTest(value=str(value)[:40]):
                result = parse_integer(value, field="sort")
                self.assertEqual(result, expected)
                self.assertIs(type(result), int)

    def test_rejects_non_integer_types_and_out_of_range(self):
        values = [True, False, 3.0, 3.5, float("inf"), float("-inf"),
                  float("nan"), {}, [], {"value": 1}, [1],
                  "abc", "3.5", "1e3", "1_000", " ", "+", "--1",
                  "\u0661", INT32_MIN - 1, INT32_MAX + 1,
                  str(INT32_MIN - 1), str(INT32_MAX + 1),
                  2**63, 10**100, "9" * 5000, b"1"]
        for value in values:
            with self.subTest(value=str(value)[:40]):
                with self.assertRaises(HTTPException) as caught:
                    parse_integer(value, field="sort", default=0)
                self.assertEqual(caught.exception.status_code, 400)

    def test_only_explicit_defaults_accept_missing_or_empty_text(self):
        for value in (None, ""):
            with self.subTest(value=value):
                self.assertEqual(parse_integer(value, field="sort", default=5), 5)
                with self.assertRaises(HTTPException):
                    parse_integer(value, field="sort")
        self.assertEqual(parse_integer(0, field="retryDelayMinutes", default=5), 0)


if __name__ == "__main__":
    unittest.main()
