"""Milestone fields remain on their own lines when the model leaves values blank."""
import unittest

from app.services.ai_task_text import parse_plan


class PlanFieldTests(unittest.TestCase):
    def parse(self, fields):
        return parse_plan("### 里程碑 1\n标题：实现需求\n" + fields)[0]

    def test_blank_acceptance_does_not_become_repository_field(self):
        plan = self.parse("验收：\n工程：backend\n可并行：否")
        self.assertEqual(plan["accept"], "")
        self.assertEqual(plan["repo"], "backend")

    def test_blank_repository_does_not_become_parallel_field(self):
        plan = self.parse("验收：运行检查\n工程： \t\n可并行：是")
        self.assertEqual(plan["repo"], "")
        self.assertTrue(plan["parallelOk"])

    def test_blank_parallel_field_does_not_consume_following_prose(self):
        plan = self.parse("工程：-\n可并行：\n可以在完成后继续下一步")
        self.assertFalse(plan["parallelOk"])
        self.assertEqual(plan["repo"], "")

    def test_multiple_blank_fields_and_crlf_remain_empty(self):
        plan = self.parse("验收：\r\n工程：\r\n可并行：否\r\n")
        self.assertEqual(plan["accept"], "")
        self.assertEqual(plan["repo"], "")
        self.assertFalse(plan["parallelOk"])

    def test_markdown_fields_and_alternate_names_still_parse(self):
        plan = self.parse("- **完成标准**：`checks pass`\n* **仓库**：`backend`\n- **并行**：yes")
        self.assertEqual(plan["accept"], "checks pass")
        self.assertEqual(plan["repo"], "backend")
        self.assertTrue(plan["parallelOk"])

    def test_milestones_do_not_borrow_each_others_values(self):
        plans = parse_plan("### 里程碑 1\n标题：First\n验收：\n工程：\n"
                           "### 里程碑 2\n标题：Second\n验收：tests pass\n工程：client")
        self.assertEqual(len(plans), 2)
        self.assertEqual((plans[0]["accept"], plans[0]["repo"]), ("", ""))
        self.assertEqual((plans[1]["accept"], plans[1]["repo"]), ("tests pass", "client"))


if __name__ == "__main__":
    unittest.main()
