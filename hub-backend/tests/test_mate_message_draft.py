"""Preserve overlong model-generated @mention summaries by truncating them instead of discarding
them.
"""
import unittest

from fastapi import HTTPException

from app.services import mate_message_draft as drafts


def _raw(**fields):
    import json
    return json.dumps(fields, ensure_ascii=False)


class RenderTests(unittest.TestCase):
    def test_overlong_fields_are_truncated_not_discarded(self):
        """Truncate occasional overlong output instead of returning 502 and requiring a retry."""
        text = drafts.render(_raw(work="w" * 300, progress="p" * 500, next="n" * 400))
        self.assertIn("当前工作：" + "w" * 80, text)
        self.assertIn("工作进展：" + "p" * 200, text)
        self.assertIn("后续安排：" + "n" * 100, text)
        self.assertNotIn("w" * 81, text)

    def test_empty_work_or_progress_still_fails(self):
        with self.assertRaises(HTTPException) as ctx:
            drafts.render(_raw(work="", progress="p" * 10))
        self.assertEqual(ctx.exception.status_code, 502)
        with self.assertRaises(HTTPException):
            drafts.render(_raw(work="w", progress=None))

    def test_markdown_fence_and_clean_still_apply(self):
        text = drafts.render("```json\n" + _raw(work="蓝页改版", progress="见 http://localhost:5176/", next="") + "\n```")
        self.assertIn("蓝页改版", text)
        self.assertNotIn("http://localhost:5176", text)


if __name__ == "__main__":
    unittest.main()
