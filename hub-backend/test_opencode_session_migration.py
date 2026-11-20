"""Legacy native histories migrate atomically without changing personal storage."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from app.services import opencode_session_migration as migration


SCHEMA = """
CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL, commands TEXT);
CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id),
    parent_id TEXT, directory TEXT NOT NULL, title TEXT, version TEXT, permission TEXT, share_url TEXT,
    workspace_id TEXT, revert TEXT);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id),
    time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id),
    session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
CREATE TABLE todo (session_id TEXT NOT NULL REFERENCES session(id), position INTEGER NOT NULL,
    content TEXT, status TEXT, priority TEXT, PRIMARY KEY (session_id, position));
CREATE TABLE permission (project_id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE account (id TEXT PRIMARY KEY, credential TEXT);
CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, data TEXT);
"""


def create_database(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.executescript(SCHEMA)
    return connection


def add_session(connection, sid: str, workspace: Path, parent=None):
    connection.execute("INSERT INTO session VALUES (?, 'project', ?, ?, ?, '1.18.18', ?, ?, NULL, NULL)",
                       (sid, parent, str(workspace), sid, '{"edit":"allow"}', "https://example.invalid/old-share"))
    connection.execute("INSERT INTO message VALUES (?, ?, 10, 20, ?)",
                       (sid + "-message", sid, json.dumps({"role": "user", "time": {"created": 10}})))
    connection.execute("INSERT INTO part VALUES (?, ?, ?, 10, 20, ?)",
                       (sid + "-part", sid + "-message", sid,
                        json.dumps({"type": "text", "text": "history-for-" + sid})))
    connection.execute("INSERT INTO todo VALUES (?, 0, 'Keep the existing task', 'pending', 'high')", (sid,))


def add_v2_state(connection, sid: str, table: str):
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
            type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_input (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
            prompt TEXT NOT NULL, delivery TEXT NOT NULL, admitted_seq INTEGER NOT NULL,
            promoted_seq INTEGER, time_created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS session_context_epoch (session_id TEXT PRIMARY KEY,
            baseline TEXT NOT NULL, snapshot TEXT NOT NULL, baseline_seq INTEGER NOT NULL);
    """)
    if table == "session_message":
        connection.execute("INSERT INTO session_message VALUES (?, ?, 'user', 1, 10, 10, ?)",
                           (sid + "-v2-message", sid, '{"text":"Retain the newer history"}'))
    elif table == "session_input":
        connection.execute("INSERT INTO session_input VALUES (?, ?, ?, 'steer', 1, NULL, 10)",
                           (sid + "-v2-input", sid, '{"text":"Retain the pending input"}'))
    elif table == "session_context_epoch":
        connection.execute("INSERT INTO session_context_epoch VALUES (?, 'baseline', '{}', 1)", (sid,))
    elif table == "event":
        if "type" not in {row[1] for row in connection.execute("PRAGMA table_info(event)")}:
            connection.execute("ALTER TABLE event ADD COLUMN type TEXT")
        connection.execute("INSERT INTO event (id, aggregate_id, data, type) VALUES (?, ?, '{}', ?)",
                           (sid + "-v2-event", sid, "session.next.prompted"))


class OpenCodeSessionMigrationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="soduwork-migration-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.source = self.root / "personal" / "opencode.db"
        self.target = self.root / "runner" / "data" / "opencode.db"
        self.env = {"OPENCODE_DB": str(self.target), "SODUWORK_OPENCODE_LEGACY_DB": str(self.source)}
        with closing(create_database(self.source)) as connection, connection:
            connection.execute("INSERT INTO project VALUES ('project', ?, 'git', 1, 2, ?, ?)",
                               (str(self.workspace), '["personal-worktree"]', '{"start":"personal-command"}'))
            add_session(connection, "owned", self.workspace)
            add_session(connection, "personal", self.workspace)
            connection.execute("INSERT INTO permission VALUES ('project', 'PERSONAL_PERMISSION')")
            connection.execute("INSERT INTO account VALUES ('private', 'PERSONAL_CREDENTIAL_FIXTURE')")
            connection.execute("INSERT INTO event VALUES ('private-event', 'owned', 'old-sync-event')")
        self.initializations = []

    def initialize(self, target, env, executable):
        self.initializations.append((target, dict(env), executable))
        if not target.exists():
            create_database(target).close()

    def migrate(self, sid="owned", initializer=None):
        with patch.object(migration, "_initialize", side_effect=initializer or self.initialize):
            migration.migrate_session(self.env, sid, str(self.workspace), "managed-opencode")

    def rows(self, table):
        with closing(sqlite3.connect(self.target)) as connection, connection:
            connection.row_factory = sqlite3.Row
            return [dict(row) for row in connection.execute('SELECT * FROM "' + table + '"')]

    def source_files(self):
        return {path.name: (path.stat().st_size, path.stat().st_mtime_ns,
                            hashlib.sha256(path.read_bytes()).hexdigest())
                for path in self.source.parent.iterdir() if path.is_file()}

    def test_only_owned_history_and_children_are_moved_without_personal_state(self):
        with closing(sqlite3.connect(self.source)) as connection, connection:
            add_session(connection, "owned-child", self.workspace, "owned")
        before = self.source_files()
        self.migrate()
        self.assertEqual(self.source_files(), before)
        self.assertEqual({row["id"] for row in self.rows("session")}, {"owned", "owned-child"})
        self.assertEqual({row["session_id"] for row in self.rows("message")}, {"owned", "owned-child"})
        self.assertEqual({json.loads(row["data"])["text"] for row in self.rows("part")},
                         {"history-for-owned", "history-for-owned-child"})
        self.assertEqual(len(self.rows("todo")), 2)
        self.assertTrue(all(row["permission"] is None and row["share_url"] is None for row in self.rows("session")))
        self.assertEqual(self.rows("project")[0]["sandboxes"], "[]")
        self.assertIsNone(self.rows("project")[0]["commands"])
        for table in ("account", "permission", "event"):
            self.assertEqual(self.rows(table), [])

    def test_committed_wal_history_is_retained_without_writing_source_sidecars(self):
        connection = sqlite3.connect(self.source)
        self.addCleanup(connection.close)
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("UPDATE part SET data = ? WHERE session_id = 'owned'",
                           (json.dumps({"type": "text", "text": "newest-wal-history"}),))
        connection.commit()
        self.assertTrue(Path(str(self.source) + "-wal").stat().st_size)
        before = self.source_files()
        self.migrate()
        self.assertEqual(self.source_files(), before)
        self.assertEqual(json.loads(self.rows("part")[0]["data"])["text"], "newest-wal-history")

    def test_snapshot_is_removed_before_native_initialization(self):
        snapshots = []
        original = migration.shutil.copyfile

        def capture(source, target):
            snapshots.append(Path(target))
            return original(source, target)

        def initialize(target, env, executable):
            self.assertTrue(snapshots)
            self.assertTrue(all(not path.parent.exists() for path in snapshots))
            self.initialize(target, env, executable)

        with patch.object(migration.shutil, "copyfile", side_effect=capture):
            self.migrate(initializer=initialize)

    def test_snapshot_cleanup_failure_keeps_original_diagnostic_and_blocks_native_initialization(self):
        for sid in ("owned", "missing-session"):
            with self.subTest(sid=sid):
                directory = tempfile.TemporaryDirectory(prefix="soduwork-cleanup-fixture-")
                cleanup = directory.cleanup
                try:
                    with patch.object(migration.tempfile, "TemporaryDirectory", return_value=directory), \
                            patch.object(directory, "cleanup", side_effect=PermissionError("PRIVATE_TEMP_PATH")):
                        with self.assertRaises(migration.OpenCodeSessionMigrationError) as failure:
                            self.migrate(sid=sid)
                    self.assertIn("Temporary history cleanup failed", str(failure.exception))
                    if sid == "missing-session":
                        self.assertIn("original OpenCode session is missing", str(failure.exception))
                    self.assertNotIn("PRIVATE_TEMP_PATH", str(failure.exception))
                    self.assertFalse(self.target.exists())
                    self.assertEqual(self.initializations, [])
                finally:
                    cleanup()

    def test_existing_private_history_is_not_replaced_by_an_old_source(self):
        self.migrate()
        with closing(sqlite3.connect(self.target)) as connection, connection:
            connection.execute("UPDATE part SET data = ?", (json.dumps({"text": "new private turn"}),))
        self.source.unlink()
        self.migrate()
        self.assertEqual(len(self.initializations), 1)
        self.assertEqual(json.loads(self.rows("part")[0]["data"])["text"], "new private turn")

    def test_source_workspace_must_match_the_runner_record(self):
        self.env["SODUWORK_OPENCODE_LEGACY_DB"] = str(self.source)
        before = self.source_files()
        with patch.object(migration, "_initialize") as initialize:
            with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "does not match"):
                migration.migrate_session(self.env, "owned", str(self.root / "another"), "managed-opencode")
            initialize.assert_not_called()
        self.assertFalse(self.target.exists())
        self.assertEqual(self.source_files(), before)

    def test_existing_target_workspace_is_also_checked(self):
        self.migrate()
        with patch.object(migration, "_read_payload") as read:
            with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "does not match"):
                migration.migrate_session(self.env, "owned", str(self.root / "another"), "managed-opencode")
            read.assert_not_called()

    def test_relative_legacy_database_path_uses_the_original_workspace(self):
        self.env["SODUWORK_OPENCODE_LEGACY_DB"] = os.path.relpath(self.source, self.workspace)
        self.migrate()
        self.assertEqual([row["id"] for row in self.rows("session")], ["owned"])

    def test_existing_project_identity_cannot_rebind_a_different_workspace(self):
        with closing(create_database(self.target)) as connection, connection:
            connection.execute("INSERT INTO project VALUES ('project', ?, NULL, 1, 2, '[]', NULL)",
                               (str(self.root / "different-project"),))
        with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "project conflicts"):
            self.migrate()
        self.assertEqual(self.rows("session"), [])
        self.assertEqual(self.rows("project")[0]["worktree"], str(self.root / "different-project"))

    def test_existing_global_project_accepts_another_owned_legacy_session(self):
        with closing(sqlite3.connect(self.source)) as connection, connection:
            add_session(connection, "second-owned", self.workspace)
            connection.execute("UPDATE project SET id = 'global', worktree = '/'")
            connection.execute("UPDATE session SET project_id = 'global'")
        self.migrate()
        self.migrate("second-owned")
        self.assertEqual({row["id"] for row in self.rows("session")}, {"owned", "second-owned"})
        self.assertEqual(self.rows("project")[0]["id"], "global")
        self.assertEqual(self.rows("project")[0]["worktree"], "/")

    def test_missing_database_or_session_does_not_create_a_new_conversation(self):
        for missing in ("missing-session", "missing-database"):
            with self.subTest(missing=missing):
                if missing == "missing-database":
                    self.env["SODUWORK_OPENCODE_LEGACY_DB"] = str(self.root / "absent.db")
                with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "missing"):
                    self.migrate(sid=missing)
                self.assertFalse(self.target.exists())
        self.assertEqual(self.initializations, [])

    def test_v2_only_schema_fails_without_downgrading_or_initializing(self):
        v2 = self.root / "v2.db"
        with closing(sqlite3.connect(v2)) as connection, connection:
            connection.execute("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
            connection.execute("INSERT INTO session_v2 VALUES ('owned')")
        original = v2.read_bytes()
        self.env["SODUWORK_OPENCODE_LEGACY_DB"] = str(v2)
        with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "not compatible"):
            self.migrate()
        self.assertEqual(v2.read_bytes(), original)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.initializations, [])

    def test_retained_v1_history_in_a_mixed_v2_database_can_be_moved(self):
        with closing(sqlite3.connect(self.source)) as connection, connection:
            connection.execute("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, private_data TEXT)")
            connection.execute("INSERT INTO session_v2 VALUES ('personal-v2', 'PRIVATE_V2')")
        self.migrate()
        self.assertEqual([row["id"] for row in self.rows("session")], ["owned"])

    def test_real_v2_state_for_the_selected_session_or_child_blocks_migration(self):
        with closing(sqlite3.connect(self.source)) as connection, connection:
            add_session(connection, "owned-child", self.workspace, "owned")
        for sid in ("owned", "owned-child"):
            for table in ("session_message", "session_input", "session_context_epoch", "event"):
                with self.subTest(sid=sid, table=table):
                    self.target = self.root / "runner" / (sid + "-" + table + ".db")
                    self.env["OPENCODE_DB"] = str(self.target)
                    with closing(sqlite3.connect(self.source)) as connection, connection:
                        add_v2_state(connection, sid, table)
                    try:
                        before = self.source_files()
                        with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "not compatible"):
                            self.migrate()
                        self.assertEqual(self.source_files(), before)
                        self.assertFalse(self.target.exists())
                        self.assertEqual(self.initializations, [])
                    finally:
                        with closing(sqlite3.connect(self.source)) as connection, connection:
                            for name in ("session_message", "session_input", "session_context_epoch"):
                                connection.execute('DELETE FROM "' + name + '"')
                            connection.execute("DELETE FROM event WHERE id = ?", (sid + "-v2-event",))

    def test_v2_only_history_with_retained_empty_v1_tables_is_rejected(self):
        with closing(sqlite3.connect(self.source)) as connection, connection:
            for table in ("part", "message", "todo"):
                connection.execute('DELETE FROM "' + table + '" WHERE session_id = ?', ("owned",))
            add_v2_state(connection, "owned", "session_message")
        with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "not compatible"):
            self.migrate()
        self.assertFalse(self.target.exists())
        self.assertEqual(self.initializations, [])

    def test_unrelated_real_v2_history_does_not_block_owned_v1_history(self):
        with closing(sqlite3.connect(self.source)) as connection, connection:
            for table in ("session_message", "session_input", "session_context_epoch", "event"):
                add_v2_state(connection, "personal", table)
        self.migrate()
        self.assertEqual([row["id"] for row in self.rows("session")], ["owned"])
        self.assertEqual(json.loads(self.rows("part")[0]["data"])["text"], "history-for-owned")

    def test_existing_empty_target_cannot_hide_newer_or_nonempty_legacy_history(self):
        self.migrate()
        with closing(sqlite3.connect(self.target)) as connection, connection:
            for table in ("part", "message", "todo"):
                connection.execute('DELETE FROM "' + table + '"')
        original = self.target.read_bytes()
        with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "private.*history"):
            self.migrate()
        with closing(sqlite3.connect(self.source)) as connection, connection:
            add_v2_state(connection, "owned", "session_message")
        before = self.source_files()
        with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "not compatible"):
            self.migrate()
        self.assertEqual(self.target.read_bytes(), original)
        self.assertEqual(self.source_files(), before)
        self.assertEqual(len(self.initializations), 1)

    def test_existing_compatible_empty_target_remains_authoritative_without_a_legacy_source(self):
        with closing(sqlite3.connect(self.source)) as connection, connection:
            for table in ("part", "message", "todo"):
                connection.execute('DELETE FROM "' + table + '" WHERE session_id = ?', ("owned",))
        self.migrate()
        self.migrate()
        with closing(sqlite3.connect(self.source)) as connection, connection:
            connection.execute("DELETE FROM session WHERE id = ?", ("owned",))
        self.migrate()
        self.source.unlink()
        self.migrate()
        self.env.pop("SODUWORK_OPENCODE_LEGACY_DB")
        self.migrate()
        self.assertEqual([row["id"] for row in self.rows("session")], ["owned"])
        self.assertEqual(self.rows("message"), [])
        self.assertEqual(len(self.initializations), 1)

    def test_existing_private_v1_history_does_not_consult_newer_personal_state(self):
        self.migrate()
        with closing(sqlite3.connect(self.source)) as connection, connection:
            add_v2_state(connection, "owned", "session_message")
        with patch.object(migration, "_snapshot") as snapshot:
            self.migrate()
        snapshot.assert_not_called()
        self.assertEqual(json.loads(self.rows("part")[0]["data"])["text"], "history-for-owned")
        self.assertEqual(len(self.initializations), 1)

    def test_optional_empty_target_source_check_cannot_ignore_failed_snapshot_cleanup(self):
        self.migrate()
        with closing(sqlite3.connect(self.target)) as connection, connection:
            for table in ("part", "message", "todo"):
                connection.execute('DELETE FROM "' + table + '"')
        directory = tempfile.TemporaryDirectory(prefix="soduwork-empty-source-cleanup-")
        cleanup = directory.cleanup
        try:
            with patch.object(migration.tempfile, "TemporaryDirectory", return_value=directory), \
                    patch.object(directory, "cleanup", side_effect=PermissionError("PRIVATE_TEMP_PATH")):
                with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "cleanup failed") as failure:
                    self.migrate()
            self.assertNotIn("PRIVATE_TEMP_PATH", str(failure.exception))
            self.assertEqual(len(self.initializations), 1)
        finally:
            cleanup()

    def test_existing_private_v2_state_cannot_be_resumed_as_v1(self):
        self.migrate()
        with closing(sqlite3.connect(self.target)) as connection, connection:
            add_v2_state(connection, "owned", "session_input")
        original = self.target.read_bytes()
        with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "not compatible"):
            self.migrate()
        self.assertEqual(self.target.read_bytes(), original)
        self.assertEqual(len(self.initializations), 1)

    def test_unsafe_native_state_is_not_silently_dropped(self):
        for column in ("workspace_id", "revert"):
            with self.subTest(column=column):
                with closing(sqlite3.connect(self.source)) as connection, connection:
                    connection.execute("UPDATE session SET workspace_id = NULL, revert = NULL")
                    connection.execute(f"UPDATE session SET {column} = ? WHERE id = 'owned'", ("native-state",))
                with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "cannot be moved safely"):
                    self.migrate()
                self.assertFalse(self.target.exists())

    def test_malformed_history_is_rejected_before_initialization(self):
        with closing(sqlite3.connect(self.source)) as connection, connection:
            connection.execute("UPDATE part SET data = 'invalid-private-history' WHERE session_id = 'owned'")
        with self.assertRaises(migration.OpenCodeSessionMigrationError) as failure:
            self.migrate()
        self.assertNotIn("invalid-private-history", str(failure.exception))
        self.assertFalse(self.target.exists())

    def test_unrecognized_message_shape_does_not_silently_become_empty_history(self):
        with closing(sqlite3.connect(self.source)) as connection, connection:
            connection.execute("UPDATE message SET data = '{}' WHERE session_id = 'owned'")
        with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "not compatible"):
            self.migrate()
        self.assertEqual(self.initializations, [])

    def test_message_identity_collision_rolls_back_the_whole_import(self):
        with closing(create_database(self.target)) as connection, connection:
            connection.execute("INSERT INTO project VALUES ('private-project', ?, NULL, 1, 2, '[]', NULL)",
                               (str(self.workspace),))
            connection.execute("INSERT INTO session (id, project_id, directory) VALUES ('current', 'private-project', ?)",
                               (str(self.workspace),))
            connection.execute("INSERT INTO message VALUES ('owned-message', 'current', 1, 2, '{}')")
        with self.assertRaises(migration.OpenCodeSessionMigrationError):
            self.migrate()
        self.assertEqual([row["id"] for row in self.rows("session")], ["current"])
        self.assertEqual([row["id"] for row in self.rows("project")], ["private-project"])
        self.assertEqual(self.rows("part"), [])

    def test_changing_source_is_retried_then_rejected_without_initializing(self):
        copies = []
        original = shutil.copyfile

        def changing(source, target):
            result = original(source, target)
            copies.append(Path(target))
            with closing(sqlite3.connect(self.source)) as connection, connection:
                connection.execute("UPDATE session SET title = ? WHERE id = 'owned'", (str(len(copies)),))
            return result

        with patch.object(migration.shutil, "copyfile", side_effect=changing):
            with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "Close personal OpenCode"):
                self.migrate()
        self.assertEqual(len(copies), 3)
        self.assertTrue(all(not path.parent.exists() for path in copies))
        self.assertFalse(self.target.exists())
        self.assertEqual(self.initializations, [])

    def test_active_rollback_journal_is_not_read_or_recovered(self):
        journal = Path(str(self.source) + "-journal")
        journal.write_bytes(b"active-journal-fixture")
        before = self.source_files()
        with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "Close personal OpenCode"):
            self.migrate()
        self.assertEqual(self.source_files(), before)
        self.assertFalse(self.target.exists())

    def test_alias_of_personal_database_is_never_opened_as_private(self):
        self.env["OPENCODE_DB"] = str(self.source)
        before = self.source_files()
        with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "must be separate"):
            self.migrate()
        self.assertEqual(self.source_files(), before)
        self.target.parent.mkdir(parents=True)
        os.link(self.source, self.target)
        self.env["OPENCODE_DB"] = str(self.target)
        with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "must be separate"):
            self.migrate()
        self.assertEqual(self.source_files(), before)

    def test_parallel_requests_initialize_once_and_commit_one_history(self):
        with patch.object(migration, "_initialize", side_effect=self.initialize):
            with ThreadPoolExecutor(max_workers=4) as workers:
                futures = [workers.submit(migration.migrate_session, self.env, "owned",
                                          str(self.workspace), "managed-opencode") for _ in range(4)]
                for future in futures:
                    future.result(timeout=15)
        self.assertEqual(len(self.initializations), 1)
        self.assertEqual([row["id"] for row in self.rows("session")], ["owned"])
        self.assertEqual(len(self.rows("part")), 1)

    def test_interrupted_lock_owner_does_not_prevent_a_later_migration(self):
        self.target.parent.mkdir(parents=True)
        ready = self.root / "locked"
        script = ("from pathlib import Path; import sys,time; "
                  "from app.services.opencode_session_migration import _target_lock; "
                  "guard=_target_lock(Path(sys.argv[1])); guard.__enter__(); "
                  "Path(sys.argv[2]).write_text('locked'); time.sleep(60)")
        child = subprocess.Popen([sys.executable, "-c", script, str(self.target), str(ready)],
                                 cwd=Path(__file__).parent, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 10
            while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(ready.exists(), "The child must acquire the real SQLite lock")
            with patch.object(migration, "_TIMEOUT", 0.05):
                with self.assertRaises(sqlite3.OperationalError):
                    with migration._target_lock(self.target):
                        self.fail("An active process lock must not be stolen")
        finally:
            child.kill()
            child.wait(timeout=10)
        self.migrate()
        self.assertEqual([row["id"] for row in self.rows("session")], ["owned"])

    def test_native_schema_initialization_uses_only_the_private_database(self):
        self.target.parent.mkdir(parents=True)
        env = {**self.env, "OPENCODE_CONFIG": "personal-config", "OPENCODE_CONFIG_DIR": "personal-dir",
               "OPENCODE_CONFIG_CONTENT": '{"plugin":["personal-plugin"]}'}
        with patch.object(migration.subprocess, "run") as run:
            run.return_value.returncode = 0
            migration._initialize(self.target, env, "managed-opencode")
        args, options = run.call_args
        self.assertEqual(args[0], ["managed-opencode", "db", "SELECT 1", "--format", "json"])
        self.assertEqual(options["cwd"], self.target.parent)
        self.assertEqual(options["env"]["OPENCODE_DB"], str(self.target))
        self.assertEqual(json.loads(options["env"]["OPENCODE_CONFIG_CONTENT"]), {"plugin": [], "mcp": {}})
        self.assertNotIn("OPENCODE_CONFIG", options["env"])
        self.assertNotIn("OPENCODE_CONFIG_DIR", options["env"])
        for flag in ("OPENCODE_PURE", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_AUTOUPDATE",
                     "OPENCODE_DISABLE_MODELS_FETCH"):
            self.assertEqual(options["env"][flag], "1")
        self.assertEqual(env["OPENCODE_CONFIG"], "personal-config")

    def test_initialization_failure_keeps_source_and_does_not_import_partial_history(self):
        before = self.source_files()
        with patch.object(migration.subprocess, "run", side_effect=subprocess.TimeoutExpired("fixture", 30)):
            with self.assertRaises(migration.OpenCodeSessionMigrationError) as failure:
                migration.migrate_session(self.env, "owned", str(self.workspace), "managed-opencode")
        self.assertNotIn(str(self.source), str(failure.exception))
        self.assertEqual(self.source_files(), before)
        self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
