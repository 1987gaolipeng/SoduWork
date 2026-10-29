"""Real filesystem/ZIP compatibility for per-turn local file delivery."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app.services import ai_local


class LocalArtifactContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-artifact-contract-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.run = {"ref": "fixture-run", "ws": str(self.workspace), "seen": set()}

    def write(self, name, body, timestamp):
        full = self.workspace / name
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_bytes(body)
        os.utime(full, (1700000000 + timestamp, 1700000000 + timestamp))

    def test_archive_preserves_directories_exact_bytes_and_live_store_override(self):
        expected = {"index.html": b'<link href="css/site.css">',
                    "css/site.css": b"body { color: blue }", "assets/data.bin": b"\x00\xff"}
        for i, (name, data) in enumerate(expected.items()):
            self.write(name, data, 1000 + i)
        with patch.object(ai_local, "_store_dir", return_value=str(self.root / "archive")) as store:
            bundle = ai_local._bundle_artifact(self.run, ai_local._fresh_entries(self.run))
        store.assert_called_once_with("fixture-run")
        self.assertEqual(bundle["files"], 3)
        filename = self.root / "archive" / "bundles" / bundle["filename"]
        with zipfile.ZipFile(filename) as zipped:
            self.assertEqual({name: zipped.read(name) for name in zipped.namelist()}, expected)

    def test_noise_baseline_and_live_cap_override_keep_the_original_delivery_rules(self):
        self.write("existing.txt", b"unchanged", 1000)
        self.run["seen"] = ai_local._snapshot(str(self.workspace))
        self.write("report.md", b"report", 1001)
        self.write("assets/facts.json", b"{}", 1002)
        self.write(".pytest_cache/CACHEDIR.TAG", b"cache", 1003)
        self.write("application.db", b"private database", 1004)
        entries = ai_local._fresh_entries(self.run)
        # Internal file selections retain native separators; ZIP names use "/".
        selected = os.path.join("assets", "facts.json")
        self.assertEqual([name for name, _ in entries], [selected, "report.md"])
        with patch.object(ai_local, "_ART_CAP", 1):
            self.assertEqual(ai_local._new_files(self.run), [selected])
        self.assertEqual(self.run["artDropped"], 1)

    def test_outside_files_and_symlink_targets_never_enter_a_bundle(self):
        external = self.root / "private.txt"
        external.write_text("private")
        self.assertEqual(ai_local._safe_work_file(self.run, "../private.txt"), "")
        if os.name != "nt":
            (self.workspace / "linked.txt").symlink_to(external)
            self.assertEqual(ai_local._safe_work_file(self.run, "linked.txt"), "")
            self.write("report.md", b"report", 1000)
            self.assertIsNone(ai_local._bundle_artifact(
                self.run, [("linked.txt", 1001), ("report.md", 1000)]))


if __name__ == "__main__":
    unittest.main()
