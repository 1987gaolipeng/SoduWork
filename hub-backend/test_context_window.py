import unittest

from app.services.context_window import DEFAULT_CONTEXT_WINDOW, normalize, resolve


class ContextWindowTests(unittest.TestCase):
    def test_explicit_value_wins(self):
        self.assertEqual(resolve({"contextWindow": "32k", "id": "unknown"}), {
            "contextWindow": 32000,
            "contextWindowKnown": True,
            "contextWindowEstimated": False,
            "contextWindowSource": "configured",
        })

    def test_suffix_and_catalog_values(self):
        self.assertEqual(resolve({"id": "moonshot-v1-128k"})["contextWindow"], 128000)
        self.assertEqual(resolve({"id": "deepseek-chat"})["contextWindow"], 64000)
        self.assertEqual(resolve({"id": "gpt-4.1"})["contextWindow"], 1_048_576)
        self.assertEqual(resolve({"id": "qwen-max"})["contextWindow"], 131072)

    def test_unknown_value_has_a_bounded_estimate(self):
        resolved = resolve({"provider": "custom", "id": "internal-model"})
        self.assertEqual(resolved["contextWindow"], DEFAULT_CONTEXT_WINDOW)
        self.assertTrue(resolved["contextWindowKnown"])
        self.assertTrue(resolved["contextWindowEstimated"])
        self.assertEqual(resolved["contextWindowSource"], "safe-default")
        self.assertEqual(normalize("not-a-number"), 0)


if __name__ == "__main__":
    unittest.main()
