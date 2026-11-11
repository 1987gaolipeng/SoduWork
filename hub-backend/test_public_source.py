"""The public test boundary must not hide missing internal checkout files."""
import json
from pathlib import Path
import tempfile
import unittest
from public_source import INTERNAL_SMOKES, is_public_snapshot


class PublicSourceTests(unittest.TestCase):
    def test_missing_marker_remains_internal(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertFalse(is_public_snapshot(Path(folder)))

    def test_explicit_distribution_profile_and_quality_inventory_required(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = {"schema": 1, "ok": True, "distribution": "public-source",
                    "files": [{"path": "hub-backend/quality_manifest.py"}]}
            marker = root / "tools/distribution/SOURCE-MANIFEST.json"
            marker.parent.mkdir(parents=True)
            marker.write_text(json.dumps(data), encoding="utf-8")
            self.assertTrue(is_public_snapshot(root))
            data["files"] = []
            marker.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ValueError):
                is_public_snapshot(root)
            data["distribution"] = "other"
            marker.write_text(json.dumps(data), encoding="utf-8")
            self.assertFalse(is_public_snapshot(root))

    def test_generic_quality_and_delivery_tests_are_not_excluded(self):
        self.assertEqual(len(INTERNAL_SMOKES), 10)
        for name in ("smoke/smoke_release.py", "smoke/smoke_quality.py", "smoke/smoke_approvals.py",
                     "smoke/smoke_repository_assets.py", "smoke/smoke_deploy.py", "test_optional_services.py"):
            self.assertNotIn(name, INTERNAL_SMOKES)

    def test_invalid_marker_does_not_enable_a_public_profile(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "tools/distribution").mkdir(parents=True)
            for value in (None, [], {"distribution": "public-source", "files": None}):
                (root / "tools/distribution/SOURCE-MANIFEST.json").write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaises(ValueError):
                    is_public_snapshot(root)


if __name__ == "__main__":
    unittest.main()
