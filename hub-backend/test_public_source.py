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

    def test_explicit_distribution_profile_and_quality_entry_required(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = {"schema": 1, "id": "opensource-v1", "sourceOnly": True,
                    "excludedFiles": [".gitlab-ci.yml"]}
            marker = root / "tools/distribution/PUBLIC-SOURCE.json"
            marker.parent.mkdir(parents=True)
            marker.write_text(json.dumps(data), encoding="utf-8")
            backend = root / "hub-backend"
            backend.mkdir()
            quality = backend / "quality_manifest.py"
            quality.write_text('# fixture', encoding='utf-8')
            self.assertTrue(is_public_snapshot(root))
            self.assertFalse((marker.parent / 'SOURCE-MANIFEST.json').exists())
            (root / '.gitlab-ci.yml').write_text('# internal fixture', encoding='utf-8')
            self.assertFalse(is_public_snapshot(root))
            (root / '.gitlab-ci.yml').unlink()
            quality.unlink()
            with self.assertRaises(ValueError):
                is_public_snapshot(root)
            data["id"] = "other"
            marker.write_text(json.dumps(data), encoding="utf-8")
            self.assertFalse(is_public_snapshot(root))

    def test_generic_quality_and_delivery_tests_are_not_excluded(self):
        self.assertEqual(len(INTERNAL_SMOKES), 10)
        for name in ("smoke_release.py", "smoke_quality.py", "smoke_approvals.py",
                     "smoke_repository_assets.py", "smoke_deploy.py", "test_optional_services.py"):
            self.assertNotIn(name, INTERNAL_SMOKES)

    def test_invalid_marker_does_not_enable_a_public_profile(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "tools/distribution").mkdir(parents=True)
            (root / 'hub-backend').mkdir()
            (root / 'hub-backend/quality_manifest.py').write_text('# fixture', encoding='utf-8')
            valid = {'schema': 1, 'id': 'opensource-v1', 'sourceOnly': True,
                     'excludedFiles': ['.gitlab-ci.yml']}
            for value in (None, [], {**valid, 'schema': 2}, {**valid, 'sourceOnly': 'true'},
                          {**valid, 'excludedFiles': []}, {**valid, 'excludedFiles': None},
                          {**valid, 'excludedFiles': [None]}):
                (root / "tools/distribution/PUBLIC-SOURCE.json").write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaises(ValueError):
                    is_public_snapshot(root)

    def test_public_checkout_keeps_every_generic_quality_check(self):
        from quality_manifest import RELEASE_SMOKES, audit_manifest
        backend = Path(__file__).resolve().parent
        self.assertTrue(is_public_snapshot(backend.parent))
        self.assertEqual(audit_manifest(backend), [])
        for name in ('smoke_release.py', 'smoke_quality.py', 'test_optional_services.py'):
            self.assertIn(name, RELEASE_SMOKES)
        self.assertFalse(INTERNAL_SMOKES.intersection(RELEASE_SMOKES))
        with tempfile.TemporaryDirectory() as folder:
            errors = audit_manifest(Path(folder), {'release': ('smoke_quality.py',), 'extended': (), 'live': ()})
            self.assertTrue(any('registered smoke files do not exist: smoke_quality.py' in error for error in errors))


if __name__ == "__main__":
    unittest.main()
