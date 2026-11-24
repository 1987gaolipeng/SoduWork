"""Offline mobile review: real Hub/Runner transport and a synthetic reviewer CLI."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
REPORT_NAME = "acceptance-report-0123456789abcdef01234567.json"
MOBILE_REVIEW_TEST = (
    "test_cloud_conversations.CloudConversationTests."
    "test_mobile_automatic_review_real_report_transport_and_settlement"
)


class SyntheticReviewerPromptTests(unittest.TestCase):
    def run_reviewer(self, material, guidance=""):
        prompt = (
            "CLOUD_ACCEPTANCE_TEST\n将报告写入 " + REPORT_NAME +
            "\n固定版本材料：\n" + material + "\n" + guidance +
            "验收人补充说明：\n读取固定文本。"
        )
        with tempfile.TemporaryDirectory(prefix="soduwork-reviewer-prompt-") as directory:
            result = subprocess.run(
                [sys.executable, str(BACKEND / "tests/handoff_vendor_peer.py"), "codex"],
                input=prompt, cwd=directory, capture_output=True, text=True,
                encoding="utf-8", timeout=20,
            )
            report = Path(directory) / REPORT_NAME
            return result, json.loads(report.read_text(encoding="utf-8")) if report.exists() else None

    def material(self, **changes):
        return {
            "artifact": {"manifest": {"text": "Isolated review output"}},
            "criteria": [{"id": "fixed-text"}, {"id": "固定标准"}],
            **changes,
        }

    def assert_report(self, result, report):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["verdict"], "approve")
        self.assertEqual(report["checks"], [
            {"criterion": criterion, "result": "pass", "evidence": "Fixed text: Isolated review output"}
            for criterion in ("fixed-text", "固定标准")
        ])

    def test_legacy_material_and_supplementary_heading(self):
        self.assert_report(*self.run_reviewer(json.dumps(self.material(), ensure_ascii=False)))

    def test_appended_business_timeline_guidance(self):
        guidance = (
            "验收人输入可能引用历史材料；引用或重发不改变原时间；"
            "仅明确新增的业务要求适用本次发送时间。\n"
        )
        self.assert_report(*self.run_reviewer(json.dumps(self.material(), ensure_ascii=False), guidance))

    def test_multiline_material_with_appended_guidance(self):
        material = " \n" + json.dumps(self.material(), ensure_ascii=False, indent=2)
        self.assert_report(*self.run_reviewer(material, "按原始时间核对业务说明。\n"))

    def test_malformed_material_cannot_publish_a_report(self):
        result, report = self.run_reviewer('{"artifact":', "后续提示不修复损坏的材料。\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("JSONDecodeError", result.stderr)
        self.assertIsNone(report)

    def test_changed_fixed_text_cannot_publish_a_report(self):
        material = self.material(artifact={"manifest": {"text": "Different output"}})
        result, report = self.run_reviewer(json.dumps(material), "按固定版本核验。\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("AssertionError", result.stderr)
        self.assertIsNone(report)


def load_tests(loader, tests, pattern):
    # Importing the whole CloudConversationTests class would run unrelated cases.
    tests.addTests(loader.loadTestsFromName(MOBILE_REVIEW_TEST))
    return tests


if __name__ == "__main__":
    unittest.main()
