"""Cross-language handoff tests: desktop ZIP -> actual Runner-side filesystem."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

from app.services import portable_workspace as workspace


class PortableWorkspaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="soduwork-portable-")
        root = Path(cls.temporary.name)
        source = root / "source"
        source.mkdir()
        (source / "report.md").write_text("# 已完成第一步\n继续生成最终报告。", encoding="utf-8")
        (source / "assets").mkdir()
        (source / "assets" / "sample.bin").write_bytes(bytes(range(256)))
        cls.source = source
        module = Path(__file__).resolve().parents[1] / "client/main/conversation/portable-workspace.js"
        script = "const fs=require('fs'); require(process.argv[1]).create(process.argv[2],{sessionId:'source-session',adapterId:'pi',goal:'Finish the report',messages:[{role:'user',text:'Keep working'}]}).then(x=>fs.writeFileSync(process.argv[3],x.bytes)).catch(e=>{console.error(e);process.exitCode=1})"
        output = root / "package.zip"
        subprocess.run([shutil.which("node") or "node", "-e", script, str(module), str(source), str(output)], check=True, capture_output=True, timeout=30)
        cls.data = output.read_bytes()
        cls.digest = hashlib.sha256(cls.data).hexdigest()

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def mutation(self, change):
        with zipfile.ZipFile(io.BytesIO(self.data)) as source:
            files = {x.filename: source.read(x) for x in source.infolist()}
        change(files)
        result = io.BytesIO()
        with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        data = result.getvalue()
        return data, hashlib.sha256(data).hexdigest()

    def test_real_desktop_archive_restores_files_and_context_and_retry_keeps_cloud_edits(self):
        with tempfile.TemporaryDirectory() as folder:
            first = workspace.restore(self.data, self.digest, Path(folder), "transfer-1")
            target = Path(first["path"])
            self.assertFalse(first["reused"])
            for source in self.source.rglob("*"):
                if source.is_file():
                    self.assertEqual(source.read_bytes(), (target / source.relative_to(self.source)).read_bytes())
            self.assertEqual(first["manifest"]["source"]["messages"][0]["text"], "Keep working")
            (target / "report.md").write_text("Cloud has continued", encoding="utf-8")
            second = workspace.restore(self.data, self.digest, Path(folder), "transfer-1")
            self.assertTrue(second["reused"])
            self.assertEqual((target / "report.md").read_text(), "Cloud has continued")
            changed, digest = self.mutation(lambda files: files.__setitem__("manifest.json", files["manifest.json"].replace(b"Keep working", b"Another task")))
            with self.assertRaisesRegex(ValueError, "不能替换"):
                workspace.restore(changed, digest, Path(folder), "transfer-1")

    def test_corruption_undeclared_files_and_missing_files_fail_before_creating_workspace(self):
        changes = [lambda f: f.__setitem__("workspace/report.md", b"corrupted"),
                   lambda f: f.__setitem__("workspace/unexpected.txt", b"extra"),
                   lambda f: f.pop("workspace/report.md"),
                   lambda f: f.__setitem__("workspace/../outside", b"escape"),
                   lambda f: f.__setitem__("workspace/.env", b"secret")]
        for change in changes:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as folder:
                data, digest = self.mutation(change)
                with self.assertRaises(ValueError):
                    workspace.restore(data, digest, Path(folder), "transfer-1")
                self.assertEqual(list(Path(folder).iterdir()), [])
        with self.assertRaisesRegex(ValueError, "完整性"):
            workspace.validate(self.data, "0" * 64)

    def test_duplicate_case_alias_and_symlink_entries_are_rejected(self):
        for name, link in [("workspace/REPORT.md", False), ("workspace/report.md", False), ("workspace/link", True)]:
            buffer = io.BytesIO(self.data)
            with zipfile.ZipFile(buffer, "a") as archive:
                item = zipfile.ZipInfo(name)
                if link:
                    item.create_system = 3
                    item.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(item, "outside")
            data = buffer.getvalue()
            with self.assertRaises(ValueError):
                workspace.validate(data, hashlib.sha256(data).hexdigest())

    def test_limits_and_private_source_metadata_are_enforced(self):
        with patch.object(workspace, "MAX_BYTES", 10):
            with self.assertRaises(ValueError):
                workspace.validate(self.data, self.digest)
        def add_secret(files):
            manifest = json.loads(files["manifest.json"])
            manifest["source"]["apiKey"] = "not-portable"
            files["manifest.json"] = json.dumps(manifest).encode()
        data, digest = self.mutation(add_secret)
        with self.assertRaises(ValueError):
            workspace.validate(data, digest)

    def test_existing_target_and_interrupted_extract_are_never_overwritten_or_published(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "handoff-existing"
            target.mkdir()
            (target / "keep.txt").write_text("existing")
            with self.assertRaises(ValueError):
                workspace.restore(self.data, self.digest, Path(folder), "existing")
            self.assertEqual((target / "keep.txt").read_text(), "existing")
            with patch.object(Path, "write_bytes", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    workspace.restore(self.data, self.digest, Path(folder), "new")
            self.assertFalse((Path(folder) / "handoff-new").exists())
            self.assertFalse(list(Path(folder).glob(".handoff-staging-*")))
            self.assertFalse(workspace.restore(self.data, self.digest, Path(folder), "new")["reused"])

    def test_windows_transient_publish_lock_retries_atomic_rename_only(self):
        denied = PermissionError("Windows file scanner is still reading")
        denied.winerror = 5
        rename = Path.rename
        attempts = []
        def locked_once(path, target):
            attempts.append((path, target))
            if len(attempts) == 1:
                raise denied
            return rename(path, target)
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(Path, "rename", locked_once), patch.object(workspace.time, "sleep") as sleep:
            result = workspace.restore(self.data, self.digest, Path(folder), "short-lock")
            self.assertEqual(len(attempts), 2)
            self.assertEqual(attempts[0], attempts[1])
            sleep.assert_called_once_with(.05)
            self.assertEqual((Path(result["path"]) / "report.md").read_bytes(),
                             (self.source / "report.md").read_bytes())
        staged, target = Mock(), Mock()
        target.exists.return_value = False
        staged.rename.side_effect = denied
        with patch.object(workspace.time, "sleep") as sleep, self.assertRaises(PermissionError):
            workspace._publish_workspace(staged, target)
        self.assertEqual(staged.rename.call_count, 6)
        self.assertLess(sum(call.args[0] for call in sleep.call_args_list), 2)
        staged.reset_mock()
        target.exists.return_value = True
        with patch.object(workspace.time, "sleep") as sleep, self.assertRaises(PermissionError):
            workspace._publish_workspace(staged, target)
        self.assertEqual(staged.rename.call_count, 1)
        sleep.assert_not_called()
        staged.reset_mock()
        staged.rename.side_effect = PermissionError("persistent non-Windows permissions")
        target.exists.return_value = False
        with patch.object(workspace.time, "sleep") as sleep, self.assertRaises(PermissionError):
            workspace._publish_workspace(staged, target)
        self.assertEqual(staged.rename.call_count, 1)
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
