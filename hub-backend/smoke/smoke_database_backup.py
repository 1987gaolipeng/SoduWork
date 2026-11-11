"""Offline backup/verify/restore smoke test; never touches configured databases."""
from __future__ import annotations

from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile

from app.data_backup import BackupError, backup_database, restore_database, verify_backup


checks = 0


def ok(condition: bool, message: str) -> None:
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


def url(path: Path) -> str:
    return "sqlite+aiosqlite:///" + path.resolve().as_posix()


with tempfile.TemporaryDirectory(prefix="soduwork-backup-") as directory:
    root = Path(directory)
    source = root / "source.db"
    with closing(sqlite3.connect(source)) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num TEXT NOT NULL)")
        connection.execute("INSERT INTO alembic_version VALUES ('0002_automation_baseline')")
        connection.execute("CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        connection.execute("INSERT INTO proof (value) VALUES ('preserved')")
        connection.commit()

    result = backup_database(url(source), root / "backups")
    backup = Path(result["backup"])
    manifest = Path(result["manifest"])
    ok(backup.is_file() and backup.stat().st_size > 0, "backup file was not created")
    ok(manifest.is_file(), "manifest was not created")
    payload = verify_backup(backup)
    ok(payload.get("schemaRevision") == "0002_automation_baseline", "schema revision was not recorded")
    ok(len(str(payload.get("sha256") or "")) == 64, "SHA-256 was not recorded")

    restored = root / "restored.db"
    restore_database(backup, url(restored), confirm_target=str(restored.resolve()))
    with closing(sqlite3.connect(restored)) as connection:
        row = connection.execute("SELECT value FROM proof").fetchone()
    ok(row == ("preserved",), "restored data differs from source")

    try:
        restore_database(backup, url(restored), confirm_target=str(restored.resolve()))
    except BackupError as exc:
        ok("already exists" in str(exc), "existing-target guard returned the wrong error")
    else:
        raise AssertionError("restore overwrote an existing target without force")

    tampered = json.loads(manifest.read_text(encoding="utf-8"))
    tampered["sha256"] = "0" * 64
    manifest.write_text(json.dumps(tampered), encoding="utf-8")
    try:
        verify_backup(backup)
    except BackupError as exc:
        ok("checksum" in str(exc), "tamper detection returned the wrong error")
    else:
        raise AssertionError("tampered manifest passed verification")

print(f"database backup: {checks} checks passed")
