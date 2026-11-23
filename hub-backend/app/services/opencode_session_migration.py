"""Move one Runner-owned OpenCode history without opening the personal database."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile


class OpenCodeSessionMigrationError(RuntimeError):
    """A safe, actionable failure that does not expose personal paths or records."""


class _UnstableSnapshot(Exception):
    pass


class _SnapshotCleanupError(OpenCodeSessionMigrationError):
    pass


_RETRY = "Close personal OpenCode applications and retry this conversation. The original history is unchanged."
_SCHEMA = "This legacy OpenCode database is not compatible with the managed version. The original history is unchanged."
_TIMEOUT = 30
_REQUIRED = {
    "session": {"id", "project_id", "directory"},
    "project": {"id", "worktree"},
    "message": {"id", "session_id", "data"},
    "part": {"id", "session_id", "message_id", "data"},
}


def _quoted(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _columns(connection, table: str) -> set[str]:
    return {row[1] for row in connection.execute(f"PRAGMA table_info({_quoted(table)})")}


def _tables(connection) -> set[str]:
    return {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def _same_workspace(stored: str, workspace: str) -> bool:
    return bool(stored and os.path.isabs(stored) and os.path.isabs(workspace)
                and os.path.normcase(os.path.realpath(stored)) == os.path.normcase(os.path.realpath(workspace)))


def _check_workspace(row: dict, workspace: str) -> None:
    if not _same_workspace(row.get("directory", ""), workspace):
        raise OpenCodeSessionMigrationError(
            "The stored OpenCode session does not match this conversation's workspace. The original history is unchanged.")


def _fingerprint(path: Path):
    try:
        before = path.stat()
    except FileNotFoundError:
        return None
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    after = path.stat()
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    if identity(before) != identity(after):
        raise _UnstableSnapshot
    return (*identity(after), digest.hexdigest())


def _journal_active(source: Path) -> bool:
    try:
        return source.with_name(source.name + "-journal").stat().st_size > 0
    except FileNotFoundError:
        return False


@contextmanager
def _temporary_snapshot():
    temporary = tempfile.TemporaryDirectory(prefix="soduwork-opencode-migration-")
    failure = None
    try:
        yield Path(temporary.name)
    except BaseException as error:
        failure = error
        raise
    finally:
        try:
            temporary.cleanup()
        except OSError as error:
            reason = str(failure) if isinstance(failure, OpenCodeSessionMigrationError) else "OpenCode history was not restored."
            raise _SnapshotCleanupError(
                reason + " Temporary history cleanup failed; close OpenCode applications and retry.") from error


@contextmanager
def _snapshot(source: Path):
    # SQLite mode=ro can still write shared-memory sidecars. Only regular file
    # reads touch the personal source; SQLite opens this disposable copy instead.
    with _temporary_snapshot() as temporary:
        for _ in range(3):
            snapshot = temporary / "source.db"
            wal = source.with_name(source.name + "-wal")
            try:
                if _journal_active(source):
                    raise OpenCodeSessionMigrationError(_RETRY)
                before = (_fingerprint(source), _fingerprint(wal))
                if before[0] is None:
                    raise OpenCodeSessionMigrationError(
                        "The original OpenCode database is missing. Restore its location before retrying this conversation.")
                shutil.copyfile(source, snapshot)
                copied_wal = snapshot.with_name(snapshot.name + "-wal")
                if before[1] is not None:
                    shutil.copyfile(wal, copied_wal)
                else:
                    copied_wal.unlink(missing_ok=True)
                after = (_fingerprint(source), _fingerprint(wal))
                copied = (_fingerprint(snapshot), _fingerprint(copied_wal))
                stable = (before == after and not _journal_active(source)
                        and all((original is None and clone is None) or
                                (original is not None and clone is not None and original[-1] == clone[-1])
                                for original, clone in zip(before, copied)))
            except (FileNotFoundError, _UnstableSnapshot):
                continue
            if stable:
                yield snapshot
                return
        raise OpenCodeSessionMigrationError(_RETRY)


def _session_family(connection, session_id: str) -> list[dict]:
    first = connection.execute("SELECT * FROM session WHERE id = ?", (session_id,)).fetchone()
    if first is None:
        return []
    sessions = [dict(first)]
    seen = {session_id}
    if "parent_id" in _columns(connection, "session"):
        for session in sessions:
            for child in connection.execute("SELECT * FROM session WHERE parent_id = ?", (session["id"],)):
                if child["id"] not in seen:
                    seen.add(child["id"])
                    sessions.append(dict(child))
    return sessions


def _has_v2_history(connection, sessions: list[dict]) -> bool:
    tables = _tables(connection)
    for table in ("session_message", "session_input", "session_context_epoch"):
        if table not in tables:
            continue
        if "session_id" not in _columns(connection, table):
            raise OpenCodeSessionMigrationError(_SCHEMA)
        for session in sessions:
            if connection.execute(f"SELECT 1 FROM {_quoted(table)} WHERE session_id = ? LIMIT 1",
                                  (session["id"],)).fetchone():
                return True
    if "event" in tables and {"aggregate_id", "type"} <= _columns(connection, "event"):
        for session in sessions:
            if connection.execute("SELECT 1 FROM event WHERE aggregate_id = ? AND type GLOB ? LIMIT 1",
                                  (session["id"], "session.next.*")).fetchone():
                return True
    return False


def _has_v1_messages(connection, session_id: str) -> bool:
    return ("message" in _tables(connection) and bool(connection.execute(
        "SELECT 1 FROM message WHERE session_id = ? LIMIT 1", (session_id,)).fetchone()))


def _read_payload(source: Path, session_id: str, workspace: str) -> dict:
    with _snapshot(source) as snapshot:
        connection = sqlite3.connect(snapshot)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA trusted_schema = OFF")
            tables = _tables(connection)
            if any(table not in tables or not columns <= _columns(connection, table)
                   for table, columns in _REQUIRED.items()):
                raise OpenCodeSessionMigrationError(_SCHEMA)
            sessions = _session_family(connection, session_id)
            if not sessions:
                raise OpenCodeSessionMigrationError(
                    "The original OpenCode session is missing. Restore its history before retrying this conversation.")
            _check_workspace(sessions[0], workspace)
            if _has_v2_history(connection, sessions):
                raise OpenCodeSessionMigrationError(_SCHEMA)
            payload = {"session": sessions, "project": [], "message": [], "part": [], "todo": []}
            projects = set()
            for session in sessions:
                if session.get("workspace_id") or session.get("revert"):
                    raise OpenCodeSessionMigrationError(
                        "This legacy OpenCode session has native workspace or undo state that cannot be moved safely. "
                        "The original history is unchanged.")
                # Permissions must come from the current Runner turn. Do not carry
                # personal sharing settings or project startup commands across.
                for key in ("permission", "share_url"):
                    if key in session:
                        session[key] = None
                project_id = session["project_id"]
                if project_id not in projects:
                    row = connection.execute("SELECT * FROM project WHERE id = ?", (project_id,)).fetchone()
                    if row is None:
                        raise OpenCodeSessionMigrationError(_SCHEMA)
                    project = {key: value for key, value in dict(row).items()
                               if key in {"id", "worktree", "vcs", "time_created", "time_updated", "time_initialized"}}
                    if "sandboxes" in row.keys():
                        project["sandboxes"] = "[]"
                    payload["project"].append(project)
                    projects.add(project_id)
                sid = session["id"]
                messages = [dict(row) for row in connection.execute("SELECT * FROM message WHERE session_id = ?", (sid,))]
                parts = [dict(row) for row in connection.execute("SELECT * FROM part WHERE session_id = ?", (sid,))]
                message_ids = {row["id"] for row in messages}
                if any(row["message_id"] not in message_ids for row in parts):
                    raise OpenCodeSessionMigrationError(_SCHEMA)
                for rows, field, valid in ((messages, "role", {"user", "assistant"}), (parts, "type", None)):
                    for row in rows:
                        data = json.loads(row["data"])
                        if (not isinstance(data, dict) or not isinstance(data.get(field), str)
                                or not data[field] or (valid is not None and data[field] not in valid)):
                            raise OpenCodeSessionMigrationError(_SCHEMA)
                payload["message"].extend(messages)
                payload["part"].extend(parts)
                if "todo" in tables:
                    if "session_id" not in _columns(connection, "todo"):
                        raise OpenCodeSessionMigrationError(_SCHEMA)
                    payload["todo"].extend(dict(row) for row in connection.execute(
                        "SELECT * FROM todo WHERE session_id = ?", (sid,)))
            return payload
        finally:
            connection.close()


@contextmanager
def _target_lock(target: Path):
    # SQLite's OS lock is released on process exit, including interrupted setup.
    # A separate private database also serializes native schema initialization.
    gate = sqlite3.connect(target.with_name(target.name + ".soduwork-migrate-lock"), timeout=_TIMEOUT)
    try:
        gate.execute("BEGIN IMMEDIATE")
        yield
    finally:
        gate.rollback()
        gate.close()


def _existing(connection, session_id: str, workspace: str) -> bool:
    if "session" not in _tables(connection):
        return False
    row = connection.execute("SELECT directory FROM session WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        return False
    _check_workspace({"directory": row[0]}, workspace)
    return True


def _check_empty_target_source(source: Path | None, session_id: str, workspace: str) -> None:
    # An empty managed session can be legitimate. Block only when the matching
    # legacy history proves that continuing it would discard existing context.
    if source is None or not source.is_file():
        return
    conflict = ""
    try:
        with _snapshot(source) as snapshot:
            connection = sqlite3.connect(snapshot)
            connection.row_factory = sqlite3.Row
            try:
                connection.execute("PRAGMA trusted_schema = OFF")
                sessions = _session_family(connection, session_id)
                if not sessions or not _same_workspace(sessions[0].get("directory", ""), workspace):
                    return
                if _has_v2_history(connection, sessions):
                    conflict = _SCHEMA
                elif _has_v1_messages(connection, session_id):
                    conflict = ("The private OpenCode session is missing its original message history. "
                                "Restore the original history before retrying; the private database was not replaced.")
            finally:
                connection.close()
    except _SnapshotCleanupError:
        raise
    except (OpenCodeSessionMigrationError, OSError, sqlite3.Error):
        # Unavailable personal storage cannot revoke an established private SID.
        return
    if conflict:
        raise OpenCodeSessionMigrationError(conflict)


def _has_session(target: Path, session_id: str, workspace: str, source: Path | None = None) -> bool:
    if not target.is_file():
        return False
    connection = sqlite3.connect(target.as_uri() + "?mode=ro", uri=True, timeout=_TIMEOUT)
    connection.row_factory = sqlite3.Row
    try:
        if not _existing(connection, session_id, workspace):
            return False
        if _has_v2_history(connection, _session_family(connection, session_id)):
            raise OpenCodeSessionMigrationError(_SCHEMA)
        has_messages = _has_v1_messages(connection, session_id)
    finally:
        connection.close()
    if not has_messages:
        _check_empty_target_source(source, session_id, workspace)
    return True


def _initialize(target: Path, env: dict, executable: str) -> None:
    initialization = dict(env)
    for key in list(initialization):
        if key.upper() in {"OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"}:
            del initialization[key]
    initialization.update(OPENCODE_CONFIG_CONTENT='{"plugin":[],"mcp":{}}', OPENCODE_PURE="1",
                          OPENCODE_DISABLE_PROJECT_CONFIG="1", OPENCODE_DISABLE_AUTOUPDATE="1",
                          OPENCODE_DISABLE_MODELS_FETCH="1")
    # The fixed CLI's db command has instance:false: no workspace bootstrap,
    # plugins, model request, or project configuration is needed to create schema.
    result = subprocess.run([executable, "db", "SELECT 1", "--format", "json"], env=initialization,
                            cwd=target.parent, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=_TIMEOUT,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    if result.returncode:
        raise OpenCodeSessionMigrationError(
            "OpenCode could not initialize its private history database. Retry after repairing the managed runtime.")


def _insert(connection, table: str, row: dict) -> None:
    columns = _columns(connection, table)
    if not set(row) <= columns:
        raise OpenCodeSessionMigrationError(_SCHEMA)
    names = list(row)
    connection.execute(f"INSERT INTO {_quoted(table)} ({', '.join(map(_quoted, names))}) "
                       f"VALUES ({', '.join('?' for _ in names)})", [row[name] for name in names])


def _import_payload(target: Path, payload: dict, session_id: str, workspace: str) -> None:
    connection = sqlite3.connect(target, timeout=_TIMEOUT)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("BEGIN IMMEDIATE")
        if _existing(connection, session_id, workspace):
            return
        tables = _tables(connection)
        if any(table not in tables or not columns <= _columns(connection, table)
               for table, columns in _REQUIRED.items()):
            raise OpenCodeSessionMigrationError(_SCHEMA)
        for row in payload["project"]:
            existing = connection.execute("SELECT worktree FROM project WHERE id = ?", (row["id"],)).fetchone()
            if existing and not (existing[0] == row["worktree"] or _same_workspace(existing[0], row["worktree"])):
                raise OpenCodeSessionMigrationError(
                    "The stored OpenCode project conflicts with the private workspace. The original history is unchanged.")
            if not existing:
                _insert(connection, "project", row)
        imported = set()
        for row in payload["session"]:
            if _existing(connection, row["id"], row["directory"]):
                continue
            _insert(connection, "session", row)
            imported.add(row["id"])
        for table in ("message", "part", "todo"):
            for row in payload[table]:
                if row["session_id"] in imported:
                    _insert(connection, table, row)
        connection.commit()
    finally:
        connection.rollback()
        connection.close()


def migrate_session(env: dict, session_id: str, workspace: str, executable: str) -> None:
    """Preserve an authorized legacy SID; callers must establish Runner ownership."""
    if not session_id:
        return
    try:
        raw_target = env.get("OPENCODE_DB", "")
        raw_source = env.get("SODUWORK_OPENCODE_LEGACY_DB", "")
        if not raw_target or not os.path.isabs(raw_target):
            raise OpenCodeSessionMigrationError("OpenCode's private history directory is not configured.")
        target = Path(raw_target).resolve()
        source = Path(raw_source).expanduser() if raw_source else None
        if source is not None:
            # Relative OPENCODE_DB values were resolved by the vendor process in
            # its conversation workspace, not by the Runner's own working directory.
            source = (source if source.is_absolute() else Path(workspace) / source).resolve()
        if source is not None and (source == target or
                                   (source.exists() and target.exists() and os.path.samefile(source, target))):
            raise OpenCodeSessionMigrationError("OpenCode's private and personal history locations must be separate.")
        if _has_session(target, session_id, workspace, source):
            return
        if source is None:
            raise OpenCodeSessionMigrationError(
                "The original OpenCode database location is unavailable. Restore it before retrying this conversation.")
        payload = _read_payload(source, session_id, workspace)
        # The full temporary source snapshot is gone before any vendor process.
        target.parent.mkdir(parents=True, exist_ok=True)
        with _target_lock(target):
            if _has_session(target, session_id, workspace, source):
                return
            _initialize(target, env, executable)
            _import_payload(target, payload, session_id, workspace)
    except OpenCodeSessionMigrationError:
        raise
    except (OSError, sqlite3.Error, ValueError, TypeError, subprocess.SubprocessError) as error:
        raise OpenCodeSessionMigrationError(
            "OpenCode could not safely restore this conversation's history. " + _RETRY) from error
