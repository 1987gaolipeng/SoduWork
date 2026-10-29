"""Real Alembic upgrades of isolated SQLite files, including existing account preservation."""
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import closing

_temp = tempfile.TemporaryDirectory(prefix="soduwork-email-migration-")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (Path(_temp.name) / ".smoke-placeholder.db").as_posix()
os.environ["AUTH_SECRET"] = "isolated-email-migration-tests-secret-20261023"
os.environ["SODUWORK_ENV"] = "development"
os.environ["ADMIN_PASS"] = "isolated-admin-test-password"
os.environ["CLUSTER_REDIS_URL"] = ""
from app.config import Settings, get_settings
Settings.model_config["env_file"] = None
from alembic import command
from alembic.script import ScriptDirectory
from app.schema_migrations import _config
from app import models, account_models, account_privacy_models, mail_models
from app.db import Base


class EmailAccountMigrationTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="soduwork-account-schema-")
        self.path = Path(self.folder.name) / ".smoke-account.db"
        os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + self.path.as_posix()
        get_settings.cache_clear()

    def tearDown(self):
        self.folder.cleanup()

    def assert_current_schema(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            revision = db.execute("SELECT version_num FROM alembic_version").fetchone()[0]
            self.assertEqual(revision, ScriptDirectory.from_config(_config()).get_current_head())
            for name, table in Base.metadata.tables.items():
                if name.startswith("account_") or name == "app_user":
                    actual = {row[1] for row in db.execute('PRAGMA table_info("' + name + '")')}
                    self.assertEqual(actual, {col.name for col in table.columns}, name)

    def test_empty_database_upgrade_has_all_account_mail_and_privacy_columns(self):
        command.upgrade(_config(), "head")
        self.assert_current_schema()
        command.upgrade(_config(), "head")
        self.assert_current_schema()

    def test_existing_users_preserved_without_promoting_email_shaped_usernames(self):
        command.upgrade(_config(), "0062_plugin_recommendation_cover")
        with closing(sqlite3.connect(self.path)) as db, db:
            for uid, username in (("old-user", "Old.Person@example.test"), ("legacy-user", "legacy.user")):
                db.execute("INSERT INTO app_user(id,username,password_hash,display_name,org_id,role_id,is_super,is_active,positions,domains,auth_version) "
                           "VALUES(?,?,?,?,?,?,0,1,'[]','[]',7)",
                           (uid, username, "existing-password-hash", "Existing person", "existing-org", "existing-role"))
        command.upgrade(_config(), "head")
        self.assert_current_schema()
        with closing(sqlite3.connect(self.path)) as db, db:
            rows = db.execute("SELECT username,password_hash,org_id,role_id,auth_version,email,email_normalized,email_verified_at,avatar_url FROM app_user ORDER BY id").fetchall()
            self.assertEqual(len(rows), 2)
            for row in rows:
                self.assertEqual(row[1:5], ("existing-password-hash", "existing-org", "existing-role", 7))
                self.assertEqual(row[5:], (None, None, None, ""))
            db.execute("UPDATE app_user SET email_normalized='verified@example.test' WHERE id='old-user'")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE app_user SET email_normalized='verified@example.test' WHERE id='legacy-user'")
        command.downgrade(_config(), "0062_plugin_recommendation_cover")
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("SELECT count(*) FROM app_user").fetchone()[0], 2)
        command.upgrade(_config(), "head")
        self.assert_current_schema()


if __name__ == "__main__":
    unittest.main()
