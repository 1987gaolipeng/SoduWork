"""Real 0063 -> 0064 upgrades and ORM schema comparison on temporary SQLite."""
from __future__ import annotations

from contextlib import closing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

_module_temp = tempfile.TemporaryDirectory(prefix="soduwork-issue-migration-import-")
os.environ.update({
    "DATABASE_URL": "sqlite+aiosqlite:///" + (Path(_module_temp.name) / ".smoke-unused.db").as_posix(),
    "AUTH_SECRET": "isolated-repository-migration-test-secret",
    "ADMIN_PASS": "isolated-repository-migration-bootstrap",
    "SODUWORK_ENV": "development", "CLUSTER_REDIS_URL": "",
    "POLL_INTERVAL_SECONDS": "0", "REPOSITORY_SYNC_INTERVAL_SECONDS": "0", "REPORT_AUTO": "false",
})

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect
from app import automation_models, models, repository_issue_models  # register all foreign-key parents
from app.db import Base

ROOT = Path(__file__).resolve().parent
TABLES = {"repository_issue_sync", "repository_issue_member", "repository_issue_link"}


class RepositoryIssueMigrationTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="soduwork-repository-issue-migration-")
        self.path = Path(self.folder.name) / "fixture.db"
        self.env = {**os.environ, "DATABASE_URL": "sqlite+aiosqlite:///" + self.path.as_posix(),
            "AUTH_SECRET": "isolated-migration-child-secret", "ADMIN_PASS": "isolated-migration-child-password"}

    def tearDown(self):
        self.folder.cleanup()

    def migrate(self, direction, target):
        result = subprocess.run([sys.executable, "-m", "alembic", direction, target],
            cwd=ROOT, env=self.env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_schema(self):
        engine = create_engine("sqlite:///" + self.path.as_posix())
        try:
            with engine.connect() as connection:
                inspector = inspect(connection)
                self.assertTrue(TABLES.issubset(inspector.get_table_names()))
                def include(obj, name, type_, reflected, compare_to):
                    table = name if type_ == "table" else getattr(getattr(obj, "table", None), "name", "")
                    return table in TABLES
                def defaults(context, reflected, metadata, inspected_default, metadata_default, rendered_default):
                    # Alembic renders DefaultClause('') as None; compile the
                    # actual SQLite DDL instead so a real missing default fails.
                    expected = connection.dialect.ddl_compiler(connection.dialect, None).get_column_default_string(metadata)
                    def normalized(value):
                        if value is None:
                            return None
                        text = str(value).strip()
                        while text.startswith('(') and text.endswith(')'):
                            text = text[1:-1].strip()
                        return text
                    return normalized(inspected_default) != normalized(expected)
                context = MigrationContext.configure(connection,
                    opts={"compare_type": True, "compare_server_default": defaults, "include_object": include})
                self.assertEqual(compare_metadata(context, Base.metadata), [], "0064 and current ORM differ")
                for table in TABLES:
                    expected = Base.metadata.tables[table]
                    self.assertEqual({row["name"] for row in inspector.get_columns(table)}, {column.name for column in expected.columns})
                    self.assertEqual({row["name"] for row in inspector.get_indexes(table)}, {index.name for index in expected.indexes})
                unique = {tuple(row["column_names"]) for row in inspector.get_unique_constraints("repository_issue_link")}
                self.assertEqual(unique, {("catalog_id", "issue_iid"), ("task_id",)})
                task_fk = next(row for row in inspector.get_foreign_keys("repository_issue_link")
                    if row["constrained_columns"] == ["task_id"])
                self.assertEqual((task_fk["referred_table"], task_fk["options"].get("ondelete")), ("task", "SET NULL"))
                self.assertTrue(next(row for row in inspector.get_columns("repository_issue_link")
                    if row["name"] == "task_id")["nullable"])
        finally:
            engine.dispose()

    def test_upgrade_preserves_existing_accounts_and_matches_metadata(self):
        self.migrate("upgrade", "0063_email_accounts")
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("INSERT INTO app_user(id,username,password_hash,display_name,is_super,is_active,positions,domains,auth_version) "
                "VALUES('existing-user','existing-user','unchanged-hash','Existing',0,1,'[]','[]',7)")
            self.assertFalse(TABLES.intersection(row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")))
        self.migrate("upgrade", "0064_repository_issues")
        self.assert_schema()
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("SELECT version_num FROM alembic_version").fetchone()[0], "0064_repository_issues")
            self.assertEqual(db.execute("SELECT password_hash,auth_version FROM app_user WHERE id='existing-user'").fetchone(), ("unchanged-hash", 7))
            for table in TABLES:
                self.assertEqual(db.execute('SELECT count(*) FROM "' + table + '"').fetchone()[0], 0)
        self.migrate("upgrade", "0064_repository_issues")
        self.assert_schema()

    def test_downgrade_and_reupgrade_only_remove_issue_tables(self):
        self.migrate("upgrade", "0064_repository_issues")
        self.migrate("downgrade", "0063_email_accounts")
        with closing(sqlite3.connect(self.path)) as db, db:
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertFalse(TABLES.intersection(names))
            self.assertTrue({"app_user", "task", "automation_scm_repository"}.issubset(names))
        self.migrate("upgrade", "0064_repository_issues")
        self.assert_schema()


if __name__ == "__main__":
    unittest.main()
