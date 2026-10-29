"""Login synchronization uses synthetic credentials and private temporary files."""
import errno
import os
from pathlib import Path
import tempfile
import traceback
import unittest
from unittest.mock import patch

from app.services import codex_runtime_home as home


class CodexLoginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-codex-login-")
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "source"
        self.target = Path(self.temp.name) / "target"
        self.source.mkdir()
        self.target.mkdir()
        self.login = self.target / "auth.json"
        self.data = b'{"auth_mode":"synthetic"}'
        (self.source / "auth.json").write_bytes(self.data)

    def sync(self):
        home._sync_auth(str(self.source), str(self.target))

    def cross_device(self):
        return patch.object(home.os, "replace", side_effect=OSError(errno.EXDEV, "injected"))

    @unittest.skipIf(os.name == "nt", "POSIX symlinks; Windows junctions run in smoke_local_env_guards")
    def test_clean_skill_directory_links_without_following_the_target(self):
        for whole_directory in (False, True):
            with self.subTest(whole_directory=whole_directory):
                runtime = Path(self.temp.name) / str(whole_directory)
                runtime.mkdir()
                skills = runtime / "skills"
                if whole_directory:
                    link = skills
                else:
                    skills.mkdir()
                    (skills / "keep.md").write_text("keep local skill")
                    link = skills / "linked"
                link.symlink_to(self.source, target_is_directory=True)
                home.clean_skills({"CODEX_HOME": str(runtime)})
                self.assertFalse(os.path.lexists(link))
                self.assertEqual((self.source / "auth.json").read_bytes(), self.data)
                if not whole_directory:
                    self.assertEqual((skills / "keep.md").read_text(), "keep local skill")

    def test_initial_and_rotated_login_work_without_rename(self):
        with self.cross_device():
            self.sync()
            self.assertEqual(self.login.read_bytes(), self.data)
            replacement = b'{"auth_mode":"new synthetic"}'
            (self.source / "auth.json").write_bytes(replacement)
            self.sync()
        self.assertEqual(self.login.read_bytes(), replacement)
        self.assertEqual(list(self.target.glob(".auth-*")), [])

    def test_partial_newer_target_is_repaired_instead_of_reusing_mtime(self):
        self.login.write_bytes(b'{"auth_mode":')
        future = self.login.stat().st_mtime + 3600
        os.utime(self.login, (future, future))
        with self.cross_device():
            self.sync()
        self.assertEqual(self.login.read_bytes(), self.data)

    def test_unchanged_bytes_skip_all_writes(self):
        self.login.write_bytes(self.data)
        with patch.object(home, "_write_login", side_effect=AssertionError("unexpected write")):
            self.sync()

    def test_native_token_refresh_survives_subsequent_turns(self):
        with self.cross_device():
            self.sync()
        refreshed = b'{"auth_mode":"synthetic refreshed by Codex"}'
        self.login.write_bytes(refreshed)
        with patch.object(home, "_write_login", side_effect=AssertionError("must preserve refreshed token")):
            self.sync()
        self.assertEqual(self.login.read_bytes(), refreshed)

    def test_explicit_source_change_wins_even_with_older_mtime(self):
        with self.cross_device():
            self.sync()
        replacement = b'{"auth_mode":"different synthetic login"}'
        source = self.source / "auth.json"
        source.write_bytes(replacement)
        old = source.stat().st_mtime - 3600
        os.utime(source, (old, old))
        with self.cross_device():
            self.sync()
        self.assertEqual(self.login.read_bytes(), replacement)

    def test_upgrade_preserves_complete_newer_native_login(self):
        refreshed = b'{"auth_mode":"newer native login"}'
        self.login.write_bytes(refreshed)
        future = self.login.stat().st_mtime + 3600
        os.utime(self.login, (future, future))
        self.sync()
        self.assertEqual(self.login.read_bytes(), refreshed)

    def test_permission_denial_is_not_bypassed_and_retains_previous_login(self):
        self.login.write_bytes(b'{"auth_mode":"previous"}')
        home.durable_file.write_bytes(self.target / '.soduwork-auth-source', b'old source fingerprint')
        with patch.object(home.os, "replace", side_effect=PermissionError(errno.EACCES, "injected")):
            with self.assertRaisesRegex(RuntimeError, "文件访问策略"):
                self.sync()
        self.assertEqual(self.login.read_bytes(), b'{"auth_mode":"previous"}')

    def test_failed_fallback_restores_previous_login_and_does_not_launch(self):
        previous = b'{"auth_mode":"previous"}'
        self.login.write_bytes(previous)
        home.durable_file.write_bytes(self.target / '.soduwork-auth-source', b'old source fingerprint')
        original = home._write_login
        def fail_new(path, data, **kwargs):
            if Path(path) == self.login and data == self.data:
                self.login.write_bytes(b"partial")
                raise OSError(errno.ENOSPC, "injected")
            return original(path, data, **kwargs)
        with self.cross_device(), patch.object(home, "_write_login", side_effect=fail_new):
            with self.assertRaises(RuntimeError):
                self.sync()
        self.assertEqual(self.login.read_bytes(), previous)

    def test_invalid_source_fails_before_replacing_valid_login(self):
        self.login.write_bytes(self.data)
        (self.source / "auth.json").write_bytes(b"not-readable-json")
        with self.assertRaisesRegex(RuntimeError, "登录文件无法读取"):
            self.sync()
        self.assertEqual(self.login.read_bytes(), self.data)

    def test_invalid_source_reports_only_safe_category_without_credential_bytes(self):
        self.login.write_bytes(self.data)
        (self.source / "auth.json").write_bytes(b'{"secret":"synthetic-do-not-log", BROKEN')
        with self.assertRaises(home.CodexLoginError) as raised:
            self.sync()
        self.assertEqual(raised.exception.reason, "source-format")
        self.assertIn("JSONDecodeError", str(raised.exception))
        self.assertNotIn("synthetic-do-not-log", str(raised.exception))
        self.assertTrue(raised.exception.__suppress_context__)
        self.assertEqual(self.login.read_bytes(), self.data)

    def test_unicode_decoder_context_never_leaks_source_bytes_to_logs(self):
        (self.source / "auth.json").write_bytes(b"synthetic-do-not-log\xff")
        try:
            self.sync()
        except home.CodexLoginError:
            formatted = traceback.format_exc()
        else:
            self.fail("Invalid credential bytes must be rejected")
        self.assertIn("UnicodeDecodeError", formatted)
        self.assertNotIn("synthetic-do-not-log", formatted)

    def test_source_permission_failure_reports_system_code_without_fallback(self):
        self.login.write_bytes(self.data)
        original = open
        def read(path, *args, **kwargs):
            if Path(path) == self.source / "auth.json":
                raise PermissionError(errno.EACCES, "synthetic-do-not-log")
            return original(path, *args, **kwargs)
        with patch("builtins.open", side_effect=read), self.assertRaises(home.CodexLoginError) as raised:
            self.sync()
        self.assertEqual(raised.exception.reason, "source-access")
        self.assertIn("PermissionError", str(raised.exception))
        self.assertIn(str(errno.EACCES), str(raised.exception))
        self.assertNotIn("synthetic-do-not-log", str(raised.exception))
        self.assertEqual(self.login.read_bytes(), self.data)

    @unittest.skipUnless(os.name == "nt", "Windows filesystem filter behavior")
    def test_windows_false_missing_source_has_verified_fallback(self):
        error = FileNotFoundError(errno.ENOENT, "injected")
        error.winerror = 2
        original = home.os.replace
        def rename(source, target):
            if Path(target) == self.login:
                raise error
            return original(source, target)
        with patch.object(home.os, "replace", side_effect=rename):
            self.sync()
        self.assertEqual(self.login.read_bytes(), self.data)

    def test_actual_missing_temporary_file_is_not_ignored(self):
        with self.cross_device(), self.assertRaises(OSError):
            home._replace_login(str(self.target / "missing.json"), str(self.login), self.data)
        self.assertFalse(self.login.exists())


if __name__ == "__main__":
    unittest.main()
