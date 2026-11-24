"""Regression checks for PR lint comparison against an existing application."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.check_changed_lint import new_findings


class ChangedLintTests(unittest.TestCase):
    def test_existing_finding_shifts_but_changed_import_block_is_checked(self):
        original = b"import sys\nimport os\n\nprint(sys.version, os.name)\n"
        shift = b"# Existing file\n" + original
        self.assertEqual(new_findings("app/example.py", original, shift), [])
        edited = shift.replace(b"import os\n", b"import re\nimport os\n")
        codes = {item["code"] for item in new_findings("app/example.py", original, edited)}
        self.assertEqual(codes, {"I001", "F401"})

    def test_removing_last_use_flags_an_unchanged_import(self):
        before = b"import os\n\nprint(os.name)\n"
        findings = new_findings("app/example.py", before, b"import os\n")
        self.assertEqual([item["code"] for item in findings], ["F401"])

    def test_renamed_file_and_new_finding_of_same_kind(self):
        script = Path(__file__).parent / "scripts" / "check_changed_lint.py"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            app = root / "app"
            app.mkdir()
            old = app / "old file.py"
            old.write_bytes(b"import math\n\n\ndef first():\n    return 1\n")

            def git(*args):
                subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                                *args], cwd=root, check=True, capture_output=True)

            def check(base):
                return subprocess.run([sys.executable, script, base], cwd=root, capture_output=True, text=True)

            git("init", "--quiet")
            git("add", "app")
            git("commit", "--quiet", "-m", "Add fixture")
            git("mv", "app/old file.py", "app/renamed file.py")
            renamed = app / "renamed file.py"
            renamed.write_bytes(b"# New heading\n" + renamed.read_bytes())
            result = check("HEAD")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            renamed.write_bytes(renamed.read_bytes() + b"\n\ndef second():\n    import math\n")
            (app / "new.py").write_bytes(b"print(undefined)\n")
            result = check("HEAD")
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("F401", result.stdout)
            self.assertIn("F821", result.stdout)
            self.assertNotEqual(check("nonexistent-base").returncode, 0)


if __name__ == "__main__":
    unittest.main()
