"""Regression: backup SQLite URIs must percent-encode reserved path characters."""
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("CLUSTER_REDIS_URL", "")
os.environ.setdefault("AUTH_SECRET", "backup-uri-regression-test-secret-not-for-production")
os.environ.setdefault("ADMIN_PASS", "backup-uri-regression-test-password")

from app.data_backup import _sqlite_integrity, _sqlite_revision


class BackupUriEncodingTest(unittest.TestCase):
    def test_reserved_characters_in_data_path(self):
        # '#', '?' and spaces are reserved in file: URIs. as_posix() leaves them
        # raw, so SQLite truncates the path and opens a different (empty) DB.
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "my data #lab" / "test.db"
            db.parent.mkdir()
            with sqlite3.connect(db) as conn:
                conn.execute("create table alembic_version(version_num varchar(32))")
                conn.execute("insert into alembic_version values ('abc123')")

            _sqlite_integrity(db)
            self.assertEqual(_sqlite_revision(db), "abc123")


if __name__ == "__main__":
    unittest.main()
