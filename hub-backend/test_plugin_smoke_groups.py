"""Failure propagation, import safety and cleanup for grouped plugin checks."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from plugin_smoke import runner


class PluginSmokeGroupTests(unittest.TestCase):
    def test_aggregate_reports_a_failed_child_and_still_runs_remaining_cases(self):
        calls = []

        def execute(command, **kwargs):
            calls.append((command[-1], kwargs))
            return SimpleNamespace(returncode=1 if command[-1] == "git" else 0)

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = runner.run_groups(("execution", "review"), execute=execute)
        self.assertEqual(result, 1)
        self.assertEqual([case for case, _ in calls], ["receipts", "git", "decisions", "review"])
        self.assertTrue(all(options == {"check": False} for _, options in calls))
        self.assertIn("failed cases: git", output.getvalue())

    def test_case_failure_removes_its_database_and_storage_namespace(self):
        created = []

        async def failure(name, report):
            self.assertEqual(name, "catalog")
            database = os.environ["DATABASE_URL"].removeprefix("sqlite+aiosqlite:///")
            self.assertTrue(database.endswith("/.smoke.db"))
            root = Path(database).parent
            created.append(root)
            Path(database).write_bytes(b"isolated fixture")
            Path(os.environ["SODUWORK_DATA_ROOT"]).mkdir()
            report.check("before unexpected failure", True)
            raise RuntimeError("injected scenario failure")

        output = io.StringIO()
        with patch.dict(os.environ), patch.object(runner, "_run_case", failure), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            result = runner.run_case("catalog")
        self.assertEqual(result, 1)
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())
        self.assertIn("1 passed, 1 failed", output.getvalue())

    def test_import_and_group_listing_do_not_import_application_or_mutate_settings(self):
        source = """import os, sys
before = dict(os.environ)
from smoke import smoke_plugins
assert 'app.db' not in sys.modules
assert os.environ == before
assert smoke_plugins.main(['--list']) == 0
assert 'app.db' not in sys.modules
assert os.environ == before
"""
        result = subprocess.run([sys.executable, "-c", source],
                                cwd=Path(__file__).parent, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("execution: receipts, git, decisions", result.stdout)


if __name__ == "__main__":
    unittest.main()
