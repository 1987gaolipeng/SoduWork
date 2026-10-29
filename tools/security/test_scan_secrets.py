"""Regression checks for exact exceptions and source-boundary enforcement."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock

from tools.security.scan_secrets import download_binary, finding_key, review_findings, source_file


class SecretScanPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-secret-policy-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / "fixture.py").write_text('token = "synthetic-example"\n', encoding="utf-8")
        self.finding = {"File": "fixture.py", "RuleID": "generic-api-key", "StartLine": 1, "EndLine": 1,
                        "Secret": "must-not-appear-in-output", "Match": "must-not-appear-in-output"}
        digest = hashlib.sha256(b'token = "synthetic-example"').hexdigest()
        self.exception = {"path": "fixture.py", "rule": "generic-api-key", "lineSha256": digest,
                          "reason": "Synthetic fixture, not a credential."}

    def test_exact_reviewed_line_passes(self):
        result = review_findings(self.root, [self.finding], [self.exception])
        self.assertTrue(result["ok"])

    def test_changed_or_added_secret_in_same_file_fails(self):
        (self.root / "fixture.py").write_text('token = "changed-value"\n', encoding="utf-8")
        result = review_findings(self.root, [self.finding], [self.exception])
        self.assertFalse(result["ok"])
        self.assertEqual(len(result["unexpected"]), 1)
        self.assertNotIn("must-not-appear", str(result))

    def test_another_rule_or_file_is_not_covered(self):
        changed = {**self.finding, "RuleID": "private-key"}
        self.assertFalse(review_findings(self.root, [changed], [self.exception])["ok"])
        (self.root / "other.py").write_bytes((self.root / "fixture.py").read_bytes())
        changed = {**self.finding, "File": "other.py"}
        self.assertFalse(review_findings(self.root, [changed], [self.exception])["ok"])

    def test_new_finding_on_another_line_of_approved_file_fails(self):
        with (self.root / "fixture.py").open("a", encoding="utf-8") as stream:
            stream.write('other = "another-value"\n')
        extra = {**self.finding, "StartLine": 2, "EndLine": 2}
        result = review_findings(self.root, [self.finding, extra], [self.exception])
        self.assertFalse(result["ok"])
        self.assertEqual(len(result["unexpected"]), 1)

    def test_modified_download_is_rejected_before_extraction(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b"modified download"
        with patch("platform.system", return_value="Windows"), patch("platform.machine", return_value="AMD64"), \
                patch("urllib.request.urlopen", return_value=response), self.assertRaisesRegex(ValueError, "checksum"):
            download_binary(self.root)
        self.assertFalse((self.root / "gitleaks.exe").exists())

    def test_missing_finding_requires_exception_cleanup(self):
        self.assertFalse(review_findings(self.root, [], [self.exception])["ok"])

    def test_traversal_and_external_paths_fail(self):
        for name in ["../fixture.py", "/etc/passwd", "C:/private.txt", ".git/config", "a/../fixture.py"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                source_file(self.root, name)

    def test_invalid_range_and_duplicate_exceptions_fail(self):
        with self.assertRaises(ValueError):
            finding_key(self.root, {**self.finding, "EndLine": 999})
        with self.assertRaises(ValueError):
            review_findings(self.root, [], [self.exception, self.exception])


if __name__ == "__main__":
    unittest.main()
