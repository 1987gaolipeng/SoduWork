"""Opt-in real OpenCode check; all model traffic and native state are fixtures."""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from app.services import acp_bridge, local_base


@unittest.skipUnless(os.environ.get("SODUWORK_TEST_OPENCODE_BIN"), "Requires an explicitly selected installed OpenCode")
class OpenCodeNativeConfigTests(unittest.TestCase):
    def test_native_start_and_resume_ignore_invalid_personal_config(self):
        for native in (False, True):
            with self.subTest(native=native):
                self.check_config(native=native)

    def test_native_and_acp_ignore_explicit_personal_config_overrides(self):
        for override in ("OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"):
            for native in (False, True):
                with self.subTest(override=override, native=native):
                    self.check_config(override=override, native=native)

    def test_new_sessions_do_not_open_personal_v2_database(self):
        for native in (False, True):
            with self.subTest(native=native):
                self.check_config(native=native, personal_v2=True)

    def test_legacy_v1_resume_preserves_history_and_only_selected_session(self):
        for native in (False, True):
            with self.subTest(native=native):
                self.check_config(native=native, legacy=True)

    def test_real_v2_history_cannot_be_imported_as_an_empty_v1_session(self):
        from app.services import opencode_session_migration as migration
        executable = Path(os.environ["SODUWORK_TEST_OPENCODE_BIN"]).resolve()
        with tempfile.TemporaryDirectory(prefix="soduwork-native-v2-migration-") as directory:
            root = Path(directory)
            work, home, personal = root / "work", root / "home", root / "personal"
            for path in (work, home, personal):
                path.mkdir()
            allowed = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE"}
            env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
            env.update({"HOME": str(home), "USERPROFILE": str(home),
                        "OPENCODE_DB": str(personal / "native.db"),
                        "OPENCODE_CONFIG_CONTENT": '{"plugin":[],"mcp":{}}', "OPENCODE_PURE": "1"})
            for key in ("APPDATA", "LOCALAPPDATA", "XDG_DATA_HOME", "XDG_CONFIG_HOME",
                        "XDG_STATE_HOME", "XDG_CACHE_HOME", "TEMP", "TMP"):
                path = root / key if key in {"TEMP", "TMP"} else personal / key
                path.mkdir()
                env[key] = str(path)
            for key in ("OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_MODELS_FETCH",
                        "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_DEFAULT_PLUGINS",
                        "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE"):
                env[key] = "1"
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

            def request(path, body=None):
                data = json.dumps(body).encode() if body is not None else None
                req = urllib.request.Request(f"http://127.0.0.1:{port}" + path, data=data,
                                             headers={"Content-Type": "application/json"})
                with opener.open(req, timeout=10) as response:
                    return json.load(response)

            flags = ({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
                     else {"start_new_session": True})
            with (root / "server.log").open("w+") as log:
                process = subprocess.Popen([str(executable), "serve", "--hostname", "127.0.0.1",
                                            "--port", str(port)], cwd=work, env=env,
                                           stdin=subprocess.DEVNULL, stdout=log, stderr=log, **flags)
                try:
                    deadline = time.monotonic() + 15
                    while True:
                        try:
                            request("/global/health")
                            break
                        except (OSError, ValueError):
                            self.assertIsNone(process.poll(), "The isolated native server exited")
                            self.assertLess(time.monotonic(), deadline, "The isolated native server did not become ready")
                            time.sleep(.1)
                    # The absent provider fails locally after the native input is
                    # promoted, so this check requires no model or provider access.
                    created = request("/api/session", {
                        "model": {"id": "fixture", "providerID": "fixture-unconfigured"}})
                    sid = created["data"]["id"]
                    request("/api/session/" + sid + "/prompt", {
                        "prompt": {"text": "RETAIN-NATIVE-V2-HISTORY"}, "resume": True})
                    deadline = time.monotonic() + 10
                    while True:
                        messages = request("/api/session/" + sid + "/message")["data"]
                        if messages:
                            break
                        self.assertLess(time.monotonic(), deadline, "The native user message was not promoted")
                        time.sleep(.1)
                    self.assertEqual(messages[0]["text"], "RETAIN-NATIVE-V2-HISTORY")
                finally:
                    if process.poll() is None:
                        from app.services.local_stream import _kill_pid_tree
                        _kill_pid_tree(process.pid, process)
                    process.wait(timeout=10)
            with closing(sqlite3.connect(env["OPENCODE_DB"])) as connection:
                for table in ("message", "part"):
                    self.assertEqual(connection.execute(f"SELECT COUNT(*) FROM {table} WHERE session_id = ?",
                                                        (sid,)).fetchone()[0], 0)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM session_message WHERE session_id = ?",
                                                    (sid,)).fetchone()[0], 1)
            before = self.snapshot(personal)
            target = root / "managed" / "opencode.db"
            with self.assertRaisesRegex(migration.OpenCodeSessionMigrationError, "not compatible"):
                migration.migrate_session({**env, "OPENCODE_DB": str(target),
                    "SODUWORK_OPENCODE_LEGACY_DB": env["OPENCODE_DB"]}, sid, str(work), str(executable))
            self.assertFalse(target.exists())
            self.assertEqual(self.snapshot(personal), before)

    @staticmethod
    def snapshot(directory):
        """Observe only fixture bytes and mtimes, including DB WAL/SHM sidecars."""
        return {str(path.relative_to(directory)): (hashlib.sha256(path.read_bytes()).hexdigest(),
                                                   path.stat().st_mtime_ns)
                for path in directory.rglob("*") if path.is_file()}

    def check_config(self, *, override="", native=False, personal_v2=False, legacy=False):
        executable = Path(os.environ["SODUWORK_TEST_OPENCODE_BIN"]).resolve()
        self.assertTrue(executable.is_file())
        calls = []

        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append({"path": self.path, **body})
                chunks = [
                    {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
                     "model": "fixture", "choices": [{"index": 0,
                     "delta": {"role": "assistant", "content": "OK"}, "finish_reason": None}]},
                    {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
                     "model": "fixture", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                     "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
                ]
                payload = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
                           + "data: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        serving = threading.Thread(target=server.serve_forever,
                                   kwargs={"poll_interval": .01}, daemon=True)
        serving.start()
        try:
            with tempfile.TemporaryDirectory(prefix="soduwork-native-opencode-") as directory:
                root = Path(directory)
                work = root / "中文 workspace"
                work.mkdir()
                personal = root / "personal" / "opencode" / "opencode.json"
                personal.parent.mkdir(parents=True)
                original = b"not JSON: PRIVATE-FIXTURE"
                personal.write_bytes(original)
                # Never inherit real HOME, appdata, auth/database/provider state.
                allowed = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE"}
                clean = {key: value for key, value in os.environ.items() if key.upper() in allowed}
                for key in ("APPDATA", "LOCALAPPDATA", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TEMP", "TMP"):
                    target = root / key if key in {"TEMP", "TMP"} else root / "personal" / key
                    target.mkdir()
                    clean[key] = str(target)
                    (target / "fixture-sentinel").write_text(key, encoding="utf-8")
                home = root / "home"
                home.mkdir()
                clean["HOME"] = clean["USERPROFILE"] = str(home)
                clean.update({
                    "SODUWORK_DATA_ROOT": str(root / "runner"),
                    "XDG_CONFIG_HOME": str(personal.parent.parent),
                    "OPENCODE_DB": str(root / "personal" / "native.db"),
                    "OPENCODE_DISABLE_AUTOUPDATE": "1",
                    "OPENCODE_DISABLE_MODELS_FETCH": "1",
                    "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
                    "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
                    "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1",
                    "OPENCODE_DISABLE_CLAUDE_CODE": "1",
                    "OPENCODE_DISABLE_SHARE": "1",
                    "PYTHONUTF8": "1",
                    "PYTHONDONTWRITEBYTECODE": "1",
                })
                inherited = ({override: str(personal if override == "OPENCODE_CONFIG" else personal.parent)}
                             if override else {})
                clean.update(inherited)
                cfg = {"llm": {"base": f"http://127.0.0.1:{server.server_port}/v1",
                               "key": "fixture-key", "model": "fixture", "kind": "openai-compat"}}
                with patch.dict(os.environ, clean, clear=True):
                    env = local_base._env_for(local_base._PROFILES["opencode"], cfg)
                for key in ("HOME", "USERPROFILE"):
                    self.assertEqual(env.get(key), clean.get(key), key)
                managed = root / "runner" / "agents" / "opencode"
                for key, folder in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
                                    ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state")):
                    self.assertEqual(Path(env[key]), managed / folder)
                self.assertEqual(Path(env["OPENCODE_DB"]), managed / "data" / "opencode" / "opencode.db")
                content = json.loads(env["OPENCODE_CONFIG_CONTENT"])
                content["agent"] = {"title": {"disable": True}}
                env["OPENCODE_CONFIG_CONTENT"] = json.dumps(content)
                env.update({"HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
                            "ALL_PROXY": "http://127.0.0.1:9",
                            "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"})
                from tests.opencode_native_dependencies import seed
                seed(executable, root / "runner")
                command = [sys.executable, str(Path(acp_bridge.__file__)), "--cwd", str(work),
                           "--agent-name", "opencode"]
                if native:
                    command = [str(executable), "run", "--format", "json", "--thinking", "--dir", str(work)]
                    suffix = []
                else:
                    suffix = ["--", str(executable), "acp"]
                source = Path(clean["OPENCODE_DB"])
                if personal_v2:
                    # An intentionally incomplete v2 schema would fail migration
                    # if a managed process ever opened the personal database.
                    with closing(sqlite3.connect(source)) as db, db:
                        db.execute("CREATE TABLE session_v2 (id TEXT, directory TEXT)")
                        db.execute("INSERT INTO session_v2 VALUES ('personal-session', ?)", (str(work),))
                        db.execute("CREATE TABLE session_message (id TEXT, session_id TEXT, data TEXT)")
                        db.execute("INSERT INTO session_message VALUES ('personal-message', 'personal-session', 'PRIVATE-FIXTURE')")
                # Emulate an already-running parent using the old environment.
                old_parent = ({**env, **{key: clean[key] for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME",
                               "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_DB")}, **inherited}
                              if not native else env)
                history_marker = "ORIGINAL-LEGACY-CONTEXT" if legacy else "ORIGINAL-MANAGED-CONTEXT"
                original_source = self.snapshot(root / "personal")
                first_command = [*command, *suffix]
                first_env = old_parent
                if legacy:
                    first_command = [str(executable), "run", "--format", "json", "--dir", str(work)]
                    first_env = {**env, "OPENCODE_DB": str(source)}
                first = self.run_turn(first_command, first_env, prompt=f"Remember {history_marker}. Reply OK without tools.")
                sid = next((row.get("sessionID") for row in first if native or row.get("type") == "session"), "")
                if legacy:
                    sid = next((row.get("sessionID") for row in first if row.get("sessionID")), "")
                    self.run_turn(first_command, first_env, prompt="PERSONAL-SAME-WORKSPACE. Reply OK without tools.")
                    other_work = root / "other workspace"
                    other_work.mkdir()
                    self.run_turn([*first_command[:-1], str(other_work)], first_env,
                                  prompt="PERSONAL-OTHER-WORKSPACE. Reply OK without tools.")
                    with closing(sqlite3.connect(source)) as db, db:
                        source_messages = db.execute("SELECT COUNT(*) FROM message WHERE session_id = ?", (sid,)).fetchone()[0]
                        self.assertGreater(source_messages, 0, "The fixture must contain real v1 messages")
                        source_history = {table: dict(db.execute(f"SELECT id, data FROM {table} WHERE session_id = ?", (sid,)))
                                          for table in ("message", "part")}
                        db.execute("CREATE TABLE fixture_private_credentials (value TEXT)")
                        db.execute("INSERT INTO fixture_private_credentials VALUES ('PRIVATE-FIXTURE')")
                    original_source = self.snapshot(root / "personal")
                self.assertTrue(sid.startswith("ses_"))
                before = len(calls)
                if native:
                    from app.services.opencode_session_migration import migrate_session
                    migrate_session(env, sid, str(work), str(executable))
                second = self.run_turn([*command, "--session", sid, *suffix], env,
                                       prompt="Continue the original conversation. Reply OK without tools.")
                self.assertEqual(next((row.get("sessionID") for row in second
                                       if native or row.get("type") == "session"), ""), sid)
                for events in (first, second):
                    self.assertTrue(any(row.get("type") == "text" and
                                        row.get("part", {}).get("text") == "OK" for row in events))
                    self.assertFalse(any(row.get("error") for row in events))
                self.assertEqual(personal.read_bytes(), original)
                self.assertEqual(self.snapshot(root / "personal"), original_source)
                self.assertTrue(Path(env["OPENCODE_DB"]).is_file())
                self.assertIn(history_marker, json.dumps(calls[before:]))
                if legacy:
                    self.assertNotIn("PERSONAL-SAME-WORKSPACE", json.dumps(calls[before:]))
                    self.assertNotIn("PERSONAL-OTHER-WORKSPACE", json.dumps(calls[before:]))
                    with closing(sqlite3.connect(env["OPENCODE_DB"])) as db:
                        self.assertEqual({row[0] for row in db.execute("SELECT id FROM session")}, {sid})
                        self.assertGreater(db.execute("SELECT COUNT(*) FROM message WHERE session_id = ?", (sid,)).fetchone()[0],
                                           source_messages)
                        for table, rows in source_history.items():
                            restored = dict(db.execute(f"SELECT id, data FROM {table} WHERE session_id = ?", (sid,)))
                            self.assertEqual({key: restored.get(key) for key in rows}, rows)
                        self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name = 'fixture_private_credentials'").fetchone())
                self.assertGreaterEqual(len(calls), 2)
                self.assertTrue(all(row["path"] == "/v1/chat/completions" and row.get("model") == "fixture"
                                    and row.get("stream") is True for row in calls))
        finally:
            server.shutdown()
            server.server_close()
            serving.join(2)

    def run_turn(self, command, env, *, prompt="Reply OK without using tools."):
        flags = ({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
                 else {"start_new_session": True})
        process = subprocess.Popen(command, env=env, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", errors="replace", **flags)
        try:
            stdout, stderr = process.communicate(prompt, timeout=40)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)],
                               capture_output=True, timeout=10,
                               creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                from app.services.local_stream import _kill_pid_tree
                _kill_pid_tree(process.pid, process)
            process.communicate(timeout=5)
            self.fail("The local native model fixture timed out")
        self.assertEqual(process.returncode, 0, stdout + stderr)
        self.assertNotIn("PRIVATE-FIXTURE", stdout + stderr)
        self.assertNotIn("fixture-key", stdout + stderr)
        return [json.loads(line) for line in stdout.splitlines() if line.strip()]


if __name__ == "__main__":
    unittest.main()
