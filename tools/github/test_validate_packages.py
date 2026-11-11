import os
from pathlib import Path
import tempfile
import unittest

import validate_packages


class PackageValidationTests(unittest.TestCase):
    def test_validation_requires_manual_explicit_repository_and_real_run_identity(self):
        env = dict(GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REPOSITORY="example/fork",
                   PACKAGE_VALIDATION_REPOSITORY="example/fork", GITHUB_SHA="a" * 40, GITHUB_RUN_ID="123")
        self.assertEqual(validate_packages.validation_context(env)["repository"], "example/fork")
        for key, value in [("GITHUB_EVENT_NAME", "pull_request"),
                           ("PACKAGE_VALIDATION_REPOSITORY", "example/upstream"),
                           ("GITHUB_SHA", "missing"), ("GITHUB_RUN_ID", "0")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_packages.validation_context({**env, key: value})

    def test_evidence_rejects_missing_empty_and_symlink_installers(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "installer.exe"
            with self.assertRaises(ValueError):
                validate_packages.fingerprint(target)
            target.write_bytes(b"")
            with self.assertRaises(ValueError):
                validate_packages.fingerprint(target)
            if os.name != "nt":
                target.unlink()
                target.symlink_to(__file__)
                with self.assertRaises(ValueError):
                    validate_packages.fingerprint(target)
