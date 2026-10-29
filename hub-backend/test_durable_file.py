"""Real isolated files and subprocesses; no user data, CLI or model requests."""
import errno
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.services import durable_file, local_spool, local_spool_worker


class DurableFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="soduwork-durable-test-")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "state.record"
        self.wal = Path(str(self.path) + ".wal")

    def cross_device(self):
        return patch.object(durable_file.os, "replace", side_effect=OSError(errno.EXDEV, "injected"))

    def test_normal_atomic_path_does_not_create_compatibility_log(self):
        durable_file.write_bytes(self.path, b"old")
        durable_file.write_bytes(self.path, b"new")
        self.assertEqual(self.path.read_bytes(), b"new")
        self.assertFalse(self.wal.exists())

    def test_staging_preserves_target_extension_and_short_windows_path(self):
        original = durable_file.os.replace
        staged = []
        def replace(source, target):
            staged.append(Path(source))
            self.assertEqual(Path(source).suffix, Path(target).suffix)
            self.assertTrue(durable_file.is_temporary(source))
            self.assertLess(len(Path(source).name), 40)
            return original(source, target)
        for suffix in (".queue", ".status"):
            with self.subTest(suffix=suffix), patch.object(durable_file.os, "replace", side_effect=replace):
                path = self.path.parent / ("a" * 64 + suffix)
                durable_file.write_bytes(path, b"complete")
                self.assertEqual(path.read_bytes(), b"complete")
                self.assertFalse(Path(str(path) + ".wal").exists())
        self.assertTrue(all(not path.exists() for path in staged))

    def test_exdev_preserves_original_and_roundtrips_complete_records(self):
        durable_file.write_bytes(self.path, b"acknowledged old state")
        with self.cross_device():
            durable_file.write_bytes(self.path, b"new state")
        self.assertEqual(self.path.read_bytes(), b"acknowledged old state")
        self.assertEqual(durable_file.read_bytes(self.path), b"new state")
        durable_file.write_bytes(self.path, b"later state")
        self.assertEqual(durable_file.read_bytes(self.path), b"later state")
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])

    def test_other_errors_do_not_enable_fallback_or_overwrite(self):
        self.path.write_bytes(b"original")
        for code in (errno.EACCES, errno.ENOSPC, errno.EIO):
            with self.subTest(code=code), patch.object(durable_file.os, "replace", side_effect=OSError(code, "injected")):
                with self.assertRaises(OSError):
                    durable_file.write_bytes(self.path, b"replacement")
            self.assertEqual(durable_file.read_bytes(self.path), b"original")
            self.assertFalse(self.wal.exists())

    def test_windows_missing_error_with_intact_staging_roundtrips_without_overwriting_old_state(self):
        self.path.write_bytes(b"acknowledged old state")
        error = FileNotFoundError(errno.ENOENT, "injected Windows filter failure")
        error.winerror = 2
        with patch.object(durable_file.os, "replace", side_effect=error):
            durable_file.write_bytes(self.path, b"replacement")
        self.assertEqual(self.path.read_bytes(), b"acknowledged old state")
        self.assertEqual(durable_file.read_bytes(self.path), b"replacement")
        durable_file.write_bytes(self.path, b"later state")
        self.assertEqual(durable_file.read_bytes(self.path), b"later state")
        self.assertFalse(any(durable_file.is_temporary(p) for p in self.path.parent.iterdir()))

    def test_missing_or_changed_staging_does_not_enable_windows_fallback(self):
        self.path.write_bytes(b"original")
        for mode in ("missing", "changed", "posix"):
            def fail(source, _target):
                if mode == "missing":
                    Path(source).unlink()
                elif mode == "changed":
                    Path(source).write_bytes(b"unexpected bytes")
                error = FileNotFoundError(errno.ENOENT, "injected missing file")
                if mode != "posix":
                    error.winerror = 2
                raise error
            with self.subTest(mode=mode), patch.object(durable_file.os, "replace", side_effect=fail):
                with self.assertRaises(FileNotFoundError):
                    durable_file.write_bytes(self.path, b"replacement")
            self.assertEqual(durable_file.read_bytes(self.path), b"original")
            self.assertFalse(self.wal.exists())

    def test_windows_fallback_rejects_symlink_or_unreadable_staging(self):
        error = FileNotFoundError(errno.ENOENT, "injected Windows filter failure")
        error.winerror = 2
        temporary = self.path.parent / "staging.record"
        temporary.write_bytes(b"replacement")
        with patch.object(Path, "is_symlink", return_value=True):
            self.assertFalse(durable_file._rename_fallback(error, temporary, b"replacement"))
        with patch.object(Path, "read_bytes", side_effect=PermissionError("unreadable")):
            self.assertFalse(durable_file._rename_fallback(error, temporary, b"replacement"))

    def test_interruption_at_any_byte_keeps_last_ack_and_retry_discards_only_tail(self):
        with self.cross_device():
            durable_file.write_bytes(self.path, b"first acknowledged")
        previous = self.wal.read_bytes()
        durable_file.write_bytes(self.path, b"second complete payload")
        complete = self.wal.read_bytes()
        for cut in range(len(previous), len(complete)):
            with self.subTest(cut=cut):
                self.wal.write_bytes(complete[:cut])
                self.assertEqual(durable_file.read_bytes(self.path), b"first acknowledged")
        durable_file.write_bytes(self.path, b"retry")
        self.assertEqual(durable_file.read_bytes(self.path), b"retry")
        self.assertTrue(self.wal.read_bytes().startswith(previous))

    def test_interrupted_first_append_preserves_legacy_or_reports_missing(self):
        with self.cross_device():
            durable_file.write_bytes(self.path, b"new")
        complete = self.wal.read_bytes()
        for cut in (0, 5, len(complete) - 1):
            self.wal.write_bytes(complete[:cut])
            with self.assertRaises(FileNotFoundError):
                durable_file.read_bytes(self.path)
            self.path.write_bytes(b"legacy")
            self.assertEqual(durable_file.read_bytes(self.path), b"legacy")
            self.path.unlink()
        durable_file.write_bytes(self.path, b"retry")
        self.assertEqual(durable_file.read_bytes(self.path), b"retry")

    def test_complete_corrupt_record_fails_closed_without_truncating(self):
        with self.cross_device():
            durable_file.write_bytes(self.path, b"protected")
        corrupt = self.wal.read_bytes().replace(b'"size":9', b'"size":8')
        self.wal.write_bytes(corrupt)
        with self.assertRaises(ValueError):
            durable_file.read_bytes(self.path)
        with self.assertRaises(ValueError):
            durable_file.write_bytes(self.path, b"later")
        self.assertEqual(self.wal.read_bytes(), corrupt)

    def test_failed_flush_does_not_acknowledge(self):
        with self.cross_device():
            durable_file.write_bytes(self.path, b"old")
        with patch.object(durable_file.os, "fsync", side_effect=OSError(errno.EIO, "injected")):
            with self.assertRaises(OSError):
                durable_file.write_bytes(self.path, b"unconfirmed")
        self.assertIn(durable_file.read_bytes(self.path), (b"old", b"unconfirmed"))

    def test_interrupted_delete_cannot_resurrect_pre_wal_state(self):
        self.path.write_bytes(b"old queued")
        with self.cross_device():
            durable_file.write_bytes(self.path, b"completed")
        original_unlink = Path.unlink
        def fail_old_file(path, *args, **kwargs):
            if path == self.path:
                raise OSError(errno.EACCES, "injected")
            return original_unlink(path, *args, **kwargs)
        with patch.object(Path, "unlink", fail_old_file):
            with self.assertRaises(OSError):
                durable_file.remove(self.path)
        self.assertEqual(self.path.read_bytes(), b"old queued")
        with self.assertRaises(FileNotFoundError):
            durable_file.read_bytes(self.path)
        durable_file.remove(self.path)
        self.assertFalse(self.path.exists())
        self.assertFalse(self.wal.exists())

    def test_real_child_success_survives_status_rename_exdev_and_cleanup(self):
        spec, _ = local_spool.prepare(self.tmp.name,
            [sys.executable, "-c", "print('isolated-child-completed')"], self.tmp.name)
        empty = self.path.parent / "empty-stdin"
        empty.write_bytes(b"")
        start = local_spool_worker.subprocess.Popen
        children = []
        def launch(*args, **kwargs):
            child = start(*args, **kwargs)
            children.append(child)
            return child
        with empty.open("rb") as source, self.cross_device(), \
                patch.object(local_spool_worker.subprocess, "Popen", side_effect=launch), \
                patch.object(local_spool_worker.sys, "stdin", SimpleNamespace(buffer=source)):
            try:
                code = local_spool_worker.run(str(self.path.parent / spec["manifest"]))
            finally:
                for child in children:
                    for stream in (child.stdin, child.stdout, child.stderr):
                        if stream:
                            stream.close()
        self.assertEqual(code, 0)
        self.assertEqual(local_spool.status_code(self.tmp.name, spec), 0)
        self.assertGreater(local_spool.started_at(self.tmp.name, spec), 0)
        self.assertIn(b"isolated-child-completed", (self.path.parent / spec["stdout"]).read_bytes())
        self.assertTrue((self.path.parent / (spec["status"] + ".wal")).exists())
        local_spool.cleanup(self.tmp.name, spec)
        self.assertEqual(list(self.path.parent.glob("stream-*")), [])

    def test_failed_agent_launch_never_writes_actual_start_marker(self):
        spec, _ = local_spool.prepare(self.tmp.name,
            [str(self.path.parent / "missing-agent-executable")], self.tmp.name)
        self.assertEqual(local_spool.started_at(self.tmp.name, spec), 0)
        with self.assertRaises(OSError):
            local_spool_worker.run(str(self.path.parent / spec["manifest"]))
        self.assertEqual(local_spool.started_at(self.tmp.name, spec), 0)
        local_spool.cleanup(self.tmp.name, spec)

    def test_silent_launch_is_reported_even_when_runner_state_and_output_sequence_do_not_change(self):
        from runner_main import Runner
        from app.services import ai_local
        runner = Runner.__new__(Runner)
        runner._session_marks = {}
        runner._agent_inventory = []
        run = {"ref": "isolated", "taskId": "issue", "state": "running", "seq": 0,
               "cli": "pi", "started": 1, "executionStartedAt": 0}
        with patch.object(ai_local, "console_list_sync", return_value={"runs": [run]}), \
                patch.object(ai_local, "session_sync", return_value={"items": []}):
            initial, marks = runner._session_snapshots()
            self.assertEqual(initial[0]["executionStartedAt"], 0)
            runner._apply_marks(marks)
            self.assertEqual(runner._session_snapshots()[0], [])
            run["executionStartedAt"] = 1730000000
            started, marks = runner._session_snapshots()
            self.assertEqual(started[0]["executionStartedAt"], 1730000000)
            runner._apply_marks(marks)
            self.assertEqual(runner._session_snapshots()[0], [])


if __name__ == "__main__":
    unittest.main()
