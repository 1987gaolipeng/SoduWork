"""Resolve repository issue foreign keys in fresh processes for every supported import order."""
import os
from pathlib import Path
import subprocess
import sys
import unittest


class RepositoryIssueModelRegistrationTests(unittest.TestCase):
    def test_import_order_preserves_foreign_keys(self):
        backend = Path(__file__).resolve().parent
        for modules in [
            ["app.repository_issue_models"],
            ["app.models", "app.repository_issue_models"],
            ["app.automation_models", "app.repository_issue_models"],
        ]:
            with self.subTest(modules=modules):
                source = """
import importlib
import sys
for name in sys.argv[1:]:
    importlib.import_module(name)
from app.db import Base
from app.repository_issue_models import RepositoryIssueLink, RepositoryIssueMember, RepositoryIssueSync
ordered = [table.name for table in Base.metadata.sorted_tables]
for model in (RepositoryIssueLink, RepositoryIssueMember, RepositoryIssueSync):
    key = next(iter(model.__table__.c.catalog_id.foreign_keys))
    assert key.column.table.name == "automation_scm_repository"
    assert ordered.index(key.column.table.name) < ordered.index(model.__tablename__)
task_key = next(iter(RepositoryIssueLink.__table__.c.task_id.foreign_keys))
assert task_key.column.table.name == "task"
assert task_key.ondelete == "SET NULL"
assert ordered.index("task") < ordered.index(RepositoryIssueLink.__tablename__)
"""
                result = subprocess.run([sys.executable, "-c", source, *modules], cwd=backend,
                                        env={**os.environ, "DATABASE_URL": "sqlite+aiosqlite:///:memory:"},
                                        text=True, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
