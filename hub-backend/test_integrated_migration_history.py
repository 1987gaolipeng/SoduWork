"""Regression checks for the release plus account-isolation Alembic line."""
import io
import unittest
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from unittest.mock import patch

from alembic import command
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext, MigrationStep
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

from app.config import get_settings
from app.models import Client
from app.schema_migrations import _config


class IntegratedMigrationHistoryTests(unittest.TestCase):
    def merge_context(self, dialect, *, downgrade=False, connection=None):
        script = ScriptDirectory.from_config(_config())
        revision = script.get_revision("0067_merge_release_account_ownership")
        step = (MigrationStep.downgrade_from_script if downgrade else MigrationStep.upgrade_from_script)(
            script.revision_map, revision)
        output = io.StringIO()
        options = {"fn": lambda _heads, _context: [step], "script": script}
        if connection is None:
            options.update(as_sql=True, output_buffer=output,
                           starting_rev=revision.revision if downgrade else revision.down_revision)
        context = MigrationContext.configure(connection=connection, dialect_name=dialect, opts=options)
        with Operations.context(context), context.begin_transaction():
            context.run_migrations()
        return output.getvalue()

    def test_postgres_expands_version_column_before_writing_permanent_merge_id(self):
        sql = self.merge_context("postgresql")
        widening = "ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(128)"
        stamp = "UPDATE alembic_version SET version_num='0067_merge_release_account_ownership'"
        self.assertIn(widening, sql)
        self.assertIn(stamp, sql)
        self.assertLess(sql.index(widening), sql.index(stamp), sql)

    def test_postgres_downgrade_keeps_capacity_while_merge_id_is_still_stored(self):
        sql = self.merge_context("postgresql", downgrade=True)
        self.assertNotIn("ALTER TABLE", sql)
        self.assertIn("WHERE alembic_version.version_num = '0067_merge_release_account_ownership'", sql)
        self.assertIn("0065_merge_usage_notifications", sql)
        self.assertIn("0066_schedule_account_ownership", sql)

    def test_sqlite_merge_and_unmerge_preserve_permanent_ids_and_other_data(self):
        engine = create_engine("sqlite://")
        parents = ["0065_merge_usage_notifications", "0066_schedule_account_ownership"]
        try:
            with engine.begin() as connection:
                connection.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)"))
                connection.execute(text("INSERT INTO alembic_version VALUES (:revision)"),
                                   [{"revision": revision} for revision in parents])
                connection.execute(text("CREATE TABLE preserved_data (value TEXT)"))
                connection.execute(text("INSERT INTO preserved_data VALUES ('unchanged')"))
                self.merge_context("sqlite", connection=connection)
                self.assertEqual(list(connection.scalars(text("SELECT version_num FROM alembic_version"))),
                                 ["0067_merge_release_account_ownership"])
                self.merge_context("sqlite", downgrade=True, connection=connection)
                self.assertEqual(sorted(connection.scalars(text("SELECT version_num FROM alembic_version"))), parents)
                self.merge_context("sqlite", connection=connection)
                self.assertEqual(connection.scalar(text("SELECT value FROM preserved_data")), "unchanged")
                self.assertEqual(connection.execute(text("PRAGMA table_info(alembic_version)")).one()[2], "VARCHAR(32)")
        finally:
            engine.dispose()

    def test_release_and_account_lines_have_one_head_and_expected_parents(self):
        script = ScriptDirectory.from_config(_config())
        self.assertEqual(script.get_heads(), ["0069_merge_public_main"])
        expected = {
            "0063_plugin_recommendations": "0062_plugin_recommendation_cover",
            "0063_plugin_recommendation": "0063_plugin_recommendations",
            "0065_merge_feature_branches": ("0063_plugin_recommendations", "0064_usage_attribution"),
            "0063_task_notification_outbox": "0062_plugin_recommendation_cover",
            "0064_usage_attribution": "0063_task_notification_outbox",
            "0065_merge_recommendation_usage": (
                "0064_usage_attribution", "0063_plugin_recommendation"),
            "0063_email_accounts": "0062_plugin_recommendation_cover",
            "0064_repository_issues": "0063_email_accounts",
            "0065_task_account_ownership": "0064_repository_issues",
            "0066_schedule_account_ownership": "0065_task_account_ownership",
            "0067_merge_release_account_ownership": (
                "0065_merge_usage_notifications", "0066_schedule_account_ownership"),
            "0065_merge_usage_notifications": "0065_merge_recommendation_usage",
            "0065_im_transport": ("0064_usage_attribution", "0063_plugin_recommendation"),
            "0066_merge_im_transport": ("0065_im_transport", "0065_merge_recommendation_usage"),
            "0068_merge_notification_account": (
                "0067_merge_release_account_ownership", "0066_merge_im_transport"),
            "0069_merge_public_main": ("0065_merge_feature_branches", "0068_merge_notification_account"),
        }
        for revision, parent in expected.items():
            self.assertEqual(script.get_revision(revision).down_revision, parent, revision)

    def test_both_baselines_can_upgrade_to_the_merge_head(self):
        # The migration tests exercise DDL. This test is intentionally limited
        # to graph traversal so it does not touch a configured business DB.
        script = ScriptDirectory.from_config(_config())
        for baseline in ("0065_merge_recommendation_usage", "0066_schedule_account_ownership",
                         "0065_merge_usage_notifications", "0067_merge_release_account_ownership",
                         "0065_im_transport", "0066_merge_im_transport", "0065_merge_feature_branches",
                         "0068_merge_notification_account"):
            path = list(script.iterate_revisions("0069_merge_public_main", baseline))
            self.assertTrue(path, baseline)

    def test_existing_branch_databases_preserve_personal_configuration(self):
        for baseline in ("0065_merge_usage_notifications", "0066_merge_im_transport",
                         "0067_merge_release_account_ownership", "0065_merge_feature_branches",
                         "0068_merge_notification_account"):
            with self.subTest(baseline=baseline), tempfile.TemporaryDirectory(prefix="smoke-history-") as temp:
                database = Path(temp) / "test.db"
                with patch.dict(os.environ, {"DATABASE_URL": "sqlite+aiosqlite:///" + database.as_posix()}):
                    get_settings.cache_clear()
                    try:
                        command.upgrade(_config(), baseline)
                        engine = create_engine("sqlite:///" + database.as_posix())
                        try:
                            with engine.begin() as connection:
                                connection.execute(Client.__table__.insert().values(
                                    id="fixture-history-device", name="Preserved device",
                                    git_creds={"token": "fixture-history-token"}))
                        finally:
                            engine.dispose()
                        command.upgrade(_config(), "head")
                        command.upgrade(_config(), "head")
                        with closing(sqlite3.connect(database)) as connection:
                            self.assertEqual(connection.execute(
                                "SELECT version_num FROM alembic_version").fetchall(),
                                [("0069_merge_public_main",)])
                            name, raw = connection.execute(
                                "SELECT name, git_creds FROM client WHERE id='fixture-history-device'").fetchone()
                            self.assertEqual(name, "Preserved device")
                            self.assertEqual(json.loads(raw), {"token": "fixture-history-token"})
                            self.assertIsNotNone(connection.execute(
                                "SELECT name FROM sqlite_master WHERE type='table' AND name='im_connection'").fetchone())
                    finally:
                        get_settings.cache_clear()


if __name__ == "__main__":
    unittest.main()
