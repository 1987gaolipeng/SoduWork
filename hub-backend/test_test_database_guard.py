"""Test collection must refuse business DBs before opening a connection."""
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class TestDatabaseGuardTests(unittest.TestCase):
    def run_entry(self, entry, url):
        code = "import sys;sys.argv[0]=" + repr(entry) + ";import app.db;print('guard-accepted')"
        env = {**os.environ, "DATABASE_URL": url, "PYTHONUTF8": "1"}
        env.pop("SMOKE_ALLOW_LIVE_DB", None)
        return subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env,
                              capture_output=True, text=True, encoding="utf-8", timeout=15)

    def test_collectors_reject_nonisolated_database_before_connecting(self):
        for entry in ("test_example.py", "C:/Python/Lib/unittest/__main__.py",
                      "/usr/bin/pytest", "pytest.exe", "smoke_example.py"):
            with self.subTest(entry=entry):
                result = self.run_entry(entry, "postgresql+asyncpg://test-only@127.0.0.1:1/business")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("自动测试不许直连业务库", result.stderr)
                self.assertNotIn("guard-accepted", result.stdout)

    def test_explicit_in_memory_database_is_allowed(self):
        result = self.run_entry("C:/Python/Lib/unittest/__main__.py", "sqlite+aiosqlite:///:memory:")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("guard-accepted", result.stdout)

    def test_new_user_suite_rejects_an_already_bound_engine(self):
        code = "import sys;sys.argv[0]='test_guard.py';import app.db;import test_new_user_data"
        env = {**os.environ, "DATABASE_URL": "sqlite+aiosqlite:///guard-test.db", "PYTHONUTF8": "1"}
        env.pop("SMOKE_ALLOW_LIVE_DB", None)
        result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env,
                                capture_output=True, text=True, encoding="utf-8", timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("in-memory engine", result.stderr)
        self.assertFalse((ROOT / "guard-test.db").exists())


if __name__ == "__main__":
    unittest.main()
