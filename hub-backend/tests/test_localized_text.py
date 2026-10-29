"""Direct pure-function tests for shared app.services.localized_text primitives."""
import unittest

from app.services.localized_text import normalize_locales


class NormalizeLocalesTests(unittest.TestCase):
    def test_none_returns_empty(self):
        self.assertEqual(normalize_locales(None, 80), {})

    def test_valid_map_trimmed_and_limited(self):
        out = normalize_locales({"en-US": "  Daily work summary  ", "ja-JP": "毎" * 100}, 80)
        self.assertEqual(out, {"en-US": "Daily work summary", "ja-JP": "毎" * 80})

    def test_empty_values_dropped(self):
        self.assertEqual(normalize_locales({"en-US": "   ", "ja-JP": "ok"}, 80), {"ja-JP": "ok"})

    def test_non_dict_rejected(self):
        with self.assertRaises(ValueError):
            normalize_locales(["en-US"], 80)

    def test_invalid_key_rejected(self):
        with self.assertRaises(ValueError):
            normalize_locales({"not a tag!": "x"}, 80)

    def test_more_than_max_rejected(self):
        tags = {chr(97 + i) * 2: "x" for i in range(9)}
        with self.assertRaises(ValueError):
            normalize_locales(tags, 80)

    def test_custom_max_locales(self):
        tags = {chr(97 + i) * 2: "x" for i in range(3)}
        self.assertEqual(len(normalize_locales(tags, 80, max_locales=3)), 3)
        with self.assertRaises(ValueError):
            normalize_locales(tags, 80, max_locales=2)


if __name__ == "__main__":
    unittest.main()
