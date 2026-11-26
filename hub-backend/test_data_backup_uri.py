"""Regression: backup SQLite URIs must percent-encode reserved path characters."""
from contextlib import closing
import sqlite3
import tempfile
import unittest
from pathlib import Path


from app.data_backup import _sqlite_integrity, _sqlite_revision


class BackupUriEncodingTest(unittest.TestCase):
    def test_reserved_characters_in_data_path(self):
        # '#', '?' and spaces are reserved in file: URIs. as_posix() leaves them
        # raw, so SQLite truncates the path and opens a different (empty) DB.
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "my data #lab" / "test.db"
            db.parent.mkdir()
            with closing(sqlite3.connect(db)) as conn, conn:
                conn.execute("create table alembic_version(version_num varchar(32))")
                conn.execute("insert into alembic_version values ('abc123')")

            _sqlite_integrity(db)
            self.assertEqual(_sqlite_revision(db), "abc123")


if __name__ == "__main__":
    unittest.main()
