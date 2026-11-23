"""Keep historical task text and references through schema upgrades."""
from importlib import import_module
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text

from quality_gate import _isolated_env


migration = import_module("migrations.versions.0092_task_text_storage")


class TaskTextMigrationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        self.addCleanup(self.engine.dispose)
        with self.engine.begin() as connection:
            connection.execute(text("PRAGMA foreign_keys=ON"))
            connection.execute(text(
                "CREATE TABLE task (id TEXT PRIMARY KEY, title VARCHAR(200) NOT NULL, "
                "source VARCHAR(120) NOT NULL)"))
            connection.execute(text(
                "CREATE TABLE task_reference (task_id TEXT REFERENCES task(id))"))
            connection.execute(text("CREATE INDEX task_title_reference ON task(title)"))

    def migrate(self, connection, *, downgrade=False):
        with Operations.context(MigrationContext.configure(connection)):
            (migration.downgrade if downgrade else migration.upgrade)()

    def test_sqlite_upgrade_preserves_long_unicode_text_references_and_schema(self):
        title, source = "旧\U0001f642" * 201, "来源\U0001f680" * 121
        with self.engine.begin() as connection:
            connection.execute(text("INSERT INTO task VALUES ('legacy', :title, :source)"),
                               {"title": title, "source": source})
            connection.execute(text("INSERT INTO task_reference VALUES ('legacy')"))
            before = connection.execute(text("SELECT type,name,sql FROM sqlite_master ORDER BY name")).all()
            self.migrate(connection)
            self.migrate(connection)
            after = connection.execute(text("SELECT type,name,sql FROM sqlite_master ORDER BY name")).all()
            self.assertEqual(after, before, "SQLite must not rebuild the referenced task table")
            self.assertEqual(connection.execute(text("SELECT title,source FROM task")).one(), (title, source))
            self.assertEqual(connection.scalar(text("SELECT task_id FROM task_reference")), "legacy")
            self.assertEqual(connection.execute(text("PRAGMA foreign_key_check")).all(), [])
            connection.execute(text("INSERT INTO task VALUES ('replayed', :title, :source)"),
                               {"title": title, "source": source})
            self.assertEqual(connection.scalar(text("SELECT source FROM task WHERE id='replayed'")), source)

    def test_downgrade_refuses_each_oversized_field_without_truncating(self):
        with self.engine.begin() as connection:
            for title, source in (("题" * 201, ""), ("Task", "\U0001f642" * 121)):
                with self.subTest(title_length=len(title), source_length=len(source)):
                    connection.execute(text("DELETE FROM task"))
                    connection.execute(text("INSERT INTO task VALUES ('legacy', :title, :source)"),
                                       {"title": title, "source": source})
                    self.migrate(connection)
                    with self.assertRaisesRegex(RuntimeError, "historical values exceed"):
                        self.migrate(connection, downgrade=True)
                    self.assertEqual(connection.execute(text("SELECT title,source FROM task")).one(),
                                     (title, source))

    def test_downgrade_accepts_exact_unicode_boundaries_and_keeps_references(self):
        title, source = "\U0001f642" * 200, "源" * 120
        with self.engine.begin() as connection:
            connection.execute(text("INSERT INTO task VALUES ('legacy', :title, :source)"),
                               {"title": title, "source": source})
            connection.execute(text("INSERT INTO task_reference VALUES ('legacy')"))
            self.migrate(connection)
            self.migrate(connection, downgrade=True)
            self.migrate(connection)
            self.assertEqual(connection.execute(text("SELECT title,source FROM task")).one(), (title, source))
            self.assertEqual(connection.execute(text("PRAGMA foreign_key_check")).all(), [])

    def test_unversioned_adoption_and_repeated_startup_preserve_old_task_values(self):
        # Exercise the real adoption path, which stamps head and skips upgrades.
        # A subprocess keeps the fixture's settings and engine out of other tests.
        code = textwrap.dedent("""
            import asyncio
            from alembic import command
            from sqlalchemy import create_engine, text
            from app import db, models
            from app.config import get_settings
            from app.schema_migrations import _config, _head_revision

            command.upgrade(_config(), "0090_requirement_creator")
            engine = create_engine(get_settings().database_url.replace("+aiosqlite", ""))
            title, source = "T" * 201, "S" * 121
            with engine.begin() as connection:
                connection.execute(models.Task.__table__.insert().values(
                    id="legacy", title=title, source=source))
                connection.execute(text("DROP TABLE alembic_version"))
            async def adopt():
                try:
                    await db.init_db()
                    await db.init_db()
                finally:
                    await db.engine.dispose()
            asyncio.run(adopt())
            with engine.connect() as connection:
                assert connection.execute(text("SELECT title,source FROM task WHERE id='legacy'")).one() == (title, source)
                assert connection.scalar(text("SELECT version_num FROM alembic_version")) == _head_revision()
            engine.dispose()
            # Adoption and versioned upgrades must agree with ORM metadata.
            # Keep Alembic's normal type comparison enabled for this regression.
            command.check(_config())
        """)
        with tempfile.TemporaryDirectory(prefix="soduwork-task-text-migration-") as directory:
            result = subprocess.run([sys.executable, "-c", code],
                cwd=Path(__file__).resolve().parent,
                env=_isolated_env(os.environ, Path(directory), 1, "legacy-adoption"),
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
