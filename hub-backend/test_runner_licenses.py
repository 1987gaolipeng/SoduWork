"""Verify Runner notices; full recipe requires requirements-runner-build.txt."""
import importlib.util
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch
from app.services import runner_sources

ROOT = Path(__file__).resolve().parents[1]


class RunnerLicenseTest(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("PyInstaller"),
                         "actual freezing recipe requires the Runner build environment")
    def test_recipe_collects_original_distribution_metadata(self):
        captured = {}

        class AnalysisStub:
            def __init__(self, *args, **kwargs):
                captured.update(kwargs)
                self.pure = self.scripts = self.binaries = self.datas = []

        namespace = {
            "SPECPATH": str(ROOT / "hub-backend"), "Analysis": AnalysisStub,
            "PYZ": lambda *a, **k: None, "EXE": lambda *a, **k: None,
        }
        original_read = Path.read_text
        def read_fixture(path, *args, **kwargs):
            if path == ROOT / "tools/distribution/PUBLIC-SOURCE.json":
                return '{"sourceOnly": true}'
            return original_read(path, *args, **kwargs)
        with patch.dict("os.environ", {"SODUWORK_INTERNAL_BUILD": "0"}), patch.object(Path, "read_text", read_fixture):
            with self.assertRaisesRegex(RuntimeError, "Public Runner distribution is blocked"):
                runpy.run_path(str(ROOT / "hub-backend/runner.spec"), init_globals=namespace)
        self.assertFalse(captured)
        # Notice collection is an internal validation build, never a public release.
        with patch.dict("os.environ", {"SODUWORK_INTERNAL_BUILD": "1"}):
            runpy.run_path(str(ROOT / "hub-backend/runner.spec"), init_globals=namespace)
        metadata = [(Path(source), target) for source, target in captured["datas"] if ".dist-info" in target]
        self.assertTrue(metadata)
        for prefix in ("websockets-", "pyyaml-", "pg8000-", "pymysql-", "pymongo-", "redis-", "cryptography-"):
            matches = [source for source, target in metadata if target.lower().startswith(prefix)]
            self.assertTrue(matches, prefix)
            self.assertTrue(any(p.is_file() and any(word in p.name.lower() for word in ("license", "copying"))
                                for source in matches for p in source.rglob("*")), prefix)
        self.assertIn((str(ROOT / "LICENSE"), "third-party"), captured["datas"])

    def test_project_license_changes_invalidate_runner_freshness(self):
        self.assertIn(ROOT / "LICENSE", runner_sources.build_inputs(ROOT / "hub-backend", ROOT))


if __name__ == "__main__":
    unittest.main()
