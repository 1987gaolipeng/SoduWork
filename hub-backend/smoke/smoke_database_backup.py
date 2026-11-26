"""Offline backup/verify/restore smoke test; never touches configured databases."""
from __future__ import annotations

from contextlib import closing
import json
from pathlib import Path
import shutil
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


def expect_sidecar_refusal(backup: Path, target: Path, *, force: bool = False) -> None:
    """Require a refusal that directs the operator to a clean destination."""
    try:
        restore_database(backup, url(target), confirm_target=str(target.resolve()), force=force)
    except BackupError as exc:
        ok("new database path" in str(exc), "missing recovery guidance for a journaled target")
    else:
        raise AssertionError(f"restore accepted a journaled destination: {target.name}")


with tempfile.TemporaryDirectory(prefix="soduwork-backup-") as directory:
    root = Path(directory)
    source = root / "source.db"
    with closing(sqlite3.connect(source)) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
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
    sibling = root / "restored.db.restore-tmp"
    sibling.write_bytes(b"existing file")
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

    # Capture an offline database with a committed update still in its WAL.
    offline = root / "offline.db"
    wal = root / "offline.db-wal"
    with closing(sqlite3.connect(source)) as writer:
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("UPDATE proof SET value='target-only'")
        writer.commit()
        shutil.copyfile(source, offline)
        shutil.copyfile(root / "source.db-wal", wal)
    before = (offline.read_bytes(), wal.read_bytes())
    expect_sidecar_refusal(backup, offline, force=True)
    ok((offline.read_bytes(), wal.read_bytes()) == before, "restore modified the original database or WAL")
    ok(sibling.is_file() and sibling.read_bytes() == b"existing file", "restore overwrote a sibling file")
    with closing(sqlite3.connect(offline)) as connection:
        ok(connection.execute("SELECT value FROM proof").fetchone() == ("target-only",),
           "the original committed update was lost")
        connection.execute("PRAGMA journal_mode=DELETE")

    # Once the target is clean, force must still replace its old contents.
    restore_database(backup, url(offline), confirm_target=str(offline.resolve()), force=True)
    with closing(sqlite3.connect(offline)) as connection:
        ok(connection.execute("SELECT value FROM proof").fetchone() == ("preserved",),
           "a clean forced restore did not install the backup")

    for suffix in ("-wal", "-shm", "-journal"):
        missing = root / f"missing{suffix}.db"
        sidecar = missing.with_name(missing.name + suffix)
        sidecar.write_bytes(b"keep")
        expect_sidecar_refusal(backup, missing)
        ok(not missing.exists() and sidecar.read_bytes() == b"keep", "restore changed an orphan sidecar")

    for invalid_size in ("abc", float("inf"), True, backup.stat().st_size + 0.5):
        manifest.write_text(json.dumps({**payload, "size": invalid_size}), encoding="utf-8")
        try:
            verify_backup(backup)
        except BackupError:
            ok(True, "invalid database manifest size reported as a backup error")
        else:
            raise AssertionError("invalid database manifest size passed verification")
    manifest.write_text(json.dumps({**payload, "size": str(payload["size"])}), encoding="utf-8")
    ok(verify_backup(backup)["size"] == str(payload["size"]), "legacy integer strings still verify")

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
