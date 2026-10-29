"""Verified database backup and guarded restore for SQLite and PostgreSQL."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
from typing import Any

from sqlalchemy.engine import URL, make_url


MANIFEST_SUFFIX = ".manifest.json"


class BackupError(RuntimeError):
    """Raised when a backup cannot be proven usable."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest_path(backup: Path) -> Path:
    return backup.with_name(backup.name + MANIFEST_SUFFIX)


def _safe_source(url: URL) -> dict[str, Any]:
    return {
        "driver": url.drivername,
        "host": url.host or "",
        "port": url.port,
        "database": url.database or "",
    }


def _write_manifest(backup: Path, engine: str, source: URL, schema_revision: str = "") -> Path:
    payload = {
        "formatVersion": 1,
        "product": "SoduWork",
        "engine": engine,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "source": _safe_source(source),
        "schemaRevision": schema_revision,
        "filename": backup.name,
        "size": backup.stat().st_size,
        "sha256": _sha256(backup),
    }
    manifest = _manifest_path(backup)
    temporary = manifest.with_name(manifest.name + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, manifest)
    return manifest


def _sqlite_path(url: URL) -> Path:
    if not url.database or url.database == ":memory:":
        raise BackupError("An on-disk SQLite database is required")
    return Path(url.database).resolve()


def _sqlite_integrity(path: Path) -> None:
    try:
        with closing(sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)) as connection:
            row = connection.execute("PRAGMA integrity_check").fetchone()
    except sqlite3.Error as exc:
        raise BackupError(f"SQLite backup cannot be opened: {exc}") from exc
    if not row or str(row[0]).lower() != "ok":
        raise BackupError(f"SQLite integrity check failed: {row[0] if row else 'no result'}")


def _sqlite_revision(path: Path) -> str:
    try:
        with closing(sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)) as connection:
            row = connection.execute("SELECT version_num FROM alembic_version").fetchone()
            return str(row[0] if row else "")
    except sqlite3.Error:
        return ""


def _tool(name: str, env_name: str) -> str:
    explicit = os.environ.get(env_name, "").strip()
    if explicit:
        path = Path(explicit).resolve()
        if path.is_file():
            return str(path)
        raise BackupError(f"{env_name} does not point to a file")
    found = shutil.which(name)
    if found:
        return found
    if os.name == "nt":
        root = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "PostgreSQL"
        candidates = sorted(root.glob(f"*/bin/{name}.exe"), reverse=True)
        if candidates:
            return str(candidates[0])
    raise BackupError(f"{name} was not found; install PostgreSQL client tools or set {env_name}")


def _pg_args(url: URL) -> tuple[list[str], dict[str, str]]:
    if not url.database:
        raise BackupError("PostgreSQL database name is required")
    args: list[str] = []
    if url.host:
        args += ["--host", url.host]
    if url.port:
        args += ["--port", str(url.port)]
    if url.username:
        args += ["--username", url.username]
    env = os.environ.copy()
    if url.password:
        env["PGPASSWORD"] = url.password
    return args, env


def _run(args: list[str], env: dict[str, str]) -> None:
    result = subprocess.run(
        args,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=3600,
    )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "database tool failed").strip()
        raise BackupError(message[-2000:])


def backup_database(
    database_url: str,
    output_dir: str | Path,
    *,
    snapshot: str = "",
) -> dict[str, str]:
    url = make_url(database_url)
    folder = Path(output_dir).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    label = Path(url.database or "database").stem.replace(" ", "-") or "database"

    if url.get_backend_name() == "sqlite":
        source = _sqlite_path(url)
        if not source.is_file():
            raise BackupError(f"SQLite source does not exist: {source}")
        backup = folder / f"soduwork-{label}-{stamp}.sqlite3"
        with closing(sqlite3.connect(source)) as source_connection:
            with closing(sqlite3.connect(backup)) as target_connection:
                source_connection.backup(target_connection)
        _sqlite_integrity(backup)
        manifest = _write_manifest(backup, "sqlite", url, _sqlite_revision(backup))
    elif url.get_backend_name() == "postgresql":
        backup = folder / f"soduwork-{label}-{stamp}.dump"
        base_args, env = _pg_args(url)
        args = [
            _tool("pg_dump", "PG_DUMP_BIN"),
            "--format=custom",
            "--no-owner",
            "--no-acl",
            *(["--snapshot", snapshot] if snapshot else []),
            "--file",
            str(backup),
            *base_args,
            str(url.database),
        ]
        _run(args, env)
        verify_backup(backup, allow_missing_manifest=True)
        manifest = _write_manifest(backup, "postgresql", url)
    else:
        raise BackupError(f"Unsupported database engine: {url.get_backend_name()}")

    return {"backup": str(backup), "manifest": str(manifest)}


def verify_backup(backup_path: str | Path, *, allow_missing_manifest: bool = False) -> dict[str, Any]:
    backup = Path(backup_path).resolve()
    if not backup.is_file() or backup.stat().st_size <= 0:
        raise BackupError("Backup file is missing or empty")
    manifest_path = _manifest_path(backup)
    if manifest_path.is_file():
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise BackupError(f"Backup manifest cannot be read: {exc}") from exc
        if payload.get("filename") != backup.name:
            raise BackupError("Manifest filename does not match backup")
        if int(payload.get("size") or -1) != backup.stat().st_size:
            raise BackupError("Backup size does not match manifest")
        if payload.get("sha256") != _sha256(backup):
            raise BackupError("Backup checksum does not match manifest")
        engine = str(payload.get("engine") or "")
    elif allow_missing_manifest:
        payload = {}
        engine = "postgresql" if backup.suffix == ".dump" else "sqlite"
    else:
        raise BackupError("Backup manifest is missing")

    if engine == "sqlite":
        _sqlite_integrity(backup)
    elif engine == "postgresql":
        _run([_tool("pg_restore", "PG_RESTORE_BIN"), "--list", str(backup)], os.environ.copy())
    else:
        raise BackupError(f"Unsupported backup engine: {engine}")
    return payload


def restore_database(
    backup_path: str | Path,
    target_url: str,
    *,
    confirm_target: str,
    force: bool = False,
) -> None:
    backup = Path(backup_path).resolve()
    payload = verify_backup(backup)
    target = make_url(target_url)
    expected = (
        str(_sqlite_path(target))
        if target.get_backend_name() == "sqlite"
        else str(target.database or "")
    )
    if confirm_target != expected:
        raise BackupError("Restore confirmation must exactly match the target database")

    if payload.get("engine") == "sqlite" and target.get_backend_name() == "sqlite":
        destination = _sqlite_path(target)
        if destination.exists() and not force:
            raise BackupError("Restore target already exists; pass force only after preserving it")
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + ".restore-tmp")
        try:
            shutil.copy2(backup, temporary)
            _sqlite_integrity(temporary)
            os.replace(temporary, destination)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        return

    if payload.get("engine") == "postgresql" and target.get_backend_name() == "postgresql":
        if not force:
            raise BackupError("PostgreSQL restore requires force after target confirmation")
        base_args, env = _pg_args(target)
        args = [
            _tool("pg_restore", "PG_RESTORE_BIN"),
            "--exit-on-error",
            "--no-owner",
            "--no-acl",
            "--clean",
            "--if-exists",
            *base_args,
            "--dbname",
            str(target.database),
            str(backup),
        ]
        _run(args, env)
        return

    raise BackupError("Backup and restore target database engines do not match")
