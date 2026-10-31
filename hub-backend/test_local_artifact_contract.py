"""Real filesystem/ZIP compatibility for per-turn local file delivery."""
import io
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

    def flat_output_status(self, count):
        expected = {}
        for index in range(count):
            name = "output-%02d.md" % index
            expected[name] = bytes((index, 0, 255)) + name.encode("utf-8")
            self.write(name, expected[name], 2000 + index)
        self.assertEqual(len(ai_local._fresh_entries(self.run)), count)
        self.assertEqual(set(ai_local._new_files(self.run)), set(expected))
        self.assertEqual(self.run["artDropped"], 0)
        run = dict(self.run, state="done", artifactMode="files", cli="pi", lines=[])
        with patch.dict(ai_local._RUNS, {run["ref"]: run}), patch.object(
            ai_local, "_store_dir", return_value=str(self.root / "archive")
        ):
            status = ai_local.status_sync({}, run["ref"])
            self.assertTrue(status["ok"])
            attachments = status["attachments"]
            individual = [item for item in attachments if not item["id"].startswith("@bundle/")]
            bundles = [item for item in attachments if item["id"].startswith("@bundle/")]
            self.assertEqual(len(individual), count)
            self.assertEqual({item["filename"] for item in individual}, set(expected))
            for item in individual:
                self.assertEqual(ai_local.fetch_attachment_for_sync({}, run["ref"], item["id"]),
                                 expected[item["filename"]])
            bundled_bytes = [ai_local.fetch_attachment_for_sync({}, run["ref"], item["id"])
                             for item in bundles]
        self.assertEqual(status["artifactsDropped"], 0)
        self.assertEqual(status["artifactsHidden"], 0)
        return status, bundles, bundled_bytes, expected

    def test_up_to_twenty_flat_outputs_remain_individually_downloadable_without_bundle(self):
        for count in (3, 20):
            with self.subTest(files=count):
                status, bundles, bundled_bytes, _expected = self.flat_output_status(count)
                self.assertEqual(len(status["attachments"]), count)
                self.assertEqual(bundles, [])
                self.assertEqual(bundled_bytes, [])
                self.assertEqual(status["artifactsBundled"], 0)
                self.assertFalse((self.root / "archive").exists())

    def test_twenty_one_flat_outputs_expose_individual_files_and_complete_bundle(self):
        status, bundles, bundled_bytes, expected = self.flat_output_status(21)
        self.assertEqual(len(status["attachments"]), 22)
        self.assertEqual(len(bundles), 1)
        self.assertEqual(status["artifactsBundled"], 21)
        self.assertIsNotNone(bundled_bytes[0])
        with zipfile.ZipFile(io.BytesIO(bundled_bytes[0])) as zipped:
            self.assertEqual(len(zipped.namelist()), 21)
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
        self.write("outputs/report.md", b"report", 1000)
        with patch.object(ai_local, "_store_dir", return_value=str(self.root / "archive")) as store:
            self.assertIsNone(ai_local._bundle_artifact(
                self.run, [("../private.txt", 1001), ("outputs/report.md", 1000)]))
        store.assert_not_called()
        if os.name != "nt":
            (self.workspace / "outputs" / "linked.txt").symlink_to(external)
            self.assertEqual(ai_local._safe_work_file(self.run, "outputs/linked.txt"), "")
            with patch.object(ai_local, "_store_dir", return_value=str(self.root / "archive")) as store:
                self.assertIsNone(ai_local._bundle_artifact(
                    self.run, [("outputs/linked.txt", 1001), ("outputs/report.md", 1000)]))
            store.assert_not_called()
        self.assertFalse((self.root / "archive").exists())


if __name__ == "__main__":
    unittest.main()
