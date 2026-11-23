"""Real Runner planning and local Git must respect the configured workspace boundary."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import runner_main
from app.services import ai_local, workdirs


class RepositoryPathBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="repository-boundary-", ignore_cleanup_errors=True)
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "workspace"
        self.root.mkdir()
        self.outside = self.base / "outside"
        self.outside.mkdir()
        self.sentinel = self.outside / "keep.txt"
        self.sentinel.write_bytes(b"user-owned content")
        self.runner = runner_main.Runner.__new__(runner_main.Runner)
        self.runner.work_root = str(self.root)
        self.runner.capability_grants = []
        self.runner._dispatching_refs = set()
        self.runner._skill_inventory = []
        self.runner._skill_catalog = []

    def message(self, path, **workspace):
        return {"op": "job.dispatch", "_admitted": True,
                "dispatchId": uuid.uuid4().hex, "task": {"id": "boundary-task"},
                "ctx": {"workspace": {"workRoot": str(self.root), "repo": {
                    "id": "repo", "name": "Repository", "localDir": path,
                    "gitUrl": "https://invalid.example.test/repo.git", "branch": "main"},
                    **workspace}}}

    async def test_historical_values_rejected_in_runner_before_filesystem_or_git(self):
        paths = ["C:/x", "C:x", "D:/x", "a/C:/x", r"a\C:x", r"\rooted",
                 r"\\server\share\x", "/absolute", "../outside", r"a\..\outside",
                 "a/.. /outside", "a/file:stream", str(self.outside)]
        for path in paths:
            with self.subTest(path=path), patch.object(workdirs, "ensure_repo") as prepare, \
                 patch.object(ai_local, "dispatch_sync") as dispatch:
                result = await self.runner._job(self.message(path))
                self.assertFalse(result["ok"], result)
                self.assertIn("localDir", result["error"])
                prepare.assert_not_called()
                dispatch.assert_not_called()
                self.assertEqual(self.runner._dispatching_refs, set())
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.sentinel.read_bytes(), b"user-owned content")

    def git(self, *args):
        result = subprocess.run(["git", *args], check=True, capture_output=True,
                                text=True, timeout=30)
        return result.stdout.strip()

    @unittest.skipUnless(os.name == "nt", "Native Windows drive semantics")
    async def test_native_cross_drive_dispatch_preserves_outside_files(self):
        other_parent = Path(__file__).resolve().parent
        if other_parent.drive.casefold() == self.root.drive.casefold():
            self.skipTest("Checkout and temporary directory are on the same drive")
        with tempfile.TemporaryDirectory(prefix="cross-drive-", dir=other_parent) as other_root:
            for path in (str(self.outside), self.outside.drive + "relative", str(Path(other_root) / "same-drive"),
                         "nested/" + str(self.outside)):
                with self.subTest(path=path), patch.object(workdirs, "ensure_repo") as prepare:
                    result = await self.runner._job(self.message(path, workRoot=other_root))
                    self.assertFalse(result["ok"], result)
                    prepare.assert_not_called()
            self.assertEqual(list(Path(other_root).iterdir()), [])
        self.assertEqual(self.sentinel.read_bytes(), b"user-owned content")

    async def test_real_clone_worktree_and_explicit_device_path(self):
        source = self.base / "source"
        self.git("init", "--initial-branch=main", str(source))
        (source / "readme.txt").write_text("fixture", encoding="utf-8")
        self.git("-C", str(source), "add", "readme.txt")
        self.git("-C", str(source), "-c", "user.name=Fixture", "-c",
                 "user.email=fixture@example.test", "commit", "-m", "fixture")
        msg = self.message(r"nested\repo")
        msg["ctx"]["workspace"]["repo"]["gitUrl"] = str(source)
        msg["ctx"]["workspacePolicy"] = {"isolated": True, "isolationKey": "attempt-1", "baseRef": "main"}
        with patch.object(ai_local, "dispatch_sync", return_value={"ok": True, "issueId": "fixture"}) as dispatch:
            result = await self.runner._job(msg)
        self.assertTrue(result["ok"], result)
        ctx = dispatch.call_args.args[4]
        target = Path(ctx["repo"]["path"])
        self.assertTrue(ctx["workspacePrepared"])
        self.assertTrue(ctx["workspaceManaged"])
        self.assertTrue(target.is_relative_to(self.root))
        self.assertTrue((target / ".git").is_file())
        self.assertEqual((target / "readme.txt").read_text(), "fixture")
        self.assertTrue((self.root / "nested" / "repo" / ".git").is_dir())
        # Explicitly authorized devicePath is not a relative catalog directory.
        explicit = self.outside / "authorized-repo"
        msg = self.message("unused", devicePath=str(explicit))
        msg["ctx"]["workspace"]["repo"]["gitUrl"] = str(source)
        with patch.object(ai_local, "dispatch_sync", return_value={"ok": True, "issueId": "fixture"}):
            result = await self.runner._job(msg)
        self.assertTrue(result["ok"], result)
        self.assertEqual((explicit / "readme.txt").read_text(), "fixture")
        self.assertEqual(self.sentinel.read_bytes(), b"user-owned content")
        fallback = workdirs.repo_dir(str(self.root), SimpleNamespace(local_dir="", name="C:/display-name"))
        self.assertTrue(Path(fallback).is_relative_to(self.root))

    async def test_existing_link_cannot_redirect_relative_repository(self):
        link = self.root / "redirect"
        if os.name == "nt":
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(self.outside)],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.addCleanup(link.rmdir)
        else:
            link.symlink_to(self.outside, target_is_directory=True)
            self.addCleanup(link.unlink)
        with patch.object(workdirs, "ensure_repo") as prepare:
            result = await self.runner._job(self.message("redirect/repo"))
        self.assertFalse(result["ok"], result)
        self.assertIn("outside", result["error"])
        prepare.assert_not_called()
        self.assertEqual(list(self.outside.iterdir()), [self.sentinel])


if __name__ == "__main__":
    unittest.main()
