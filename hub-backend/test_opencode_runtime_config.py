"""Managed OpenCode configuration and native state stay separate from personal data."""
from __future__ import annotations

import json
import ntpath
import os
from pathlib import Path
import posixpath
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from app.services import acp_bridge, local_base, runner_sources


class OpenCodeRuntimeConfigTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-opencode-config-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.personal = self.root / "personal" / "opencode" / "opencode.json"
        self.personal.parent.mkdir(parents=True)
        self.personal.write_bytes(b"invalid personal config: PRIVATE-FIXTURE")
        self.environment = {
            "SODUWORK_DATA_ROOT": str(self.root / "runner"),
            "XDG_CONFIG_HOME": str(self.personal.parent.parent),
            "HOME": str(self.root / "home"),
            "XDG_DATA_HOME": str(self.root / "native-data"),
            "XDG_STATE_HOME": str(self.root / "native-state"),
            "XDG_CACHE_HOME": str(self.root / "native-cache"),
            "OPENCODE_DB": str(self.root / "native.db"),
            "OPENCODE_CONFIG": str(self.personal),
            "OPENCODE_CONFIG_DIR": str(self.personal.parent),
            "OPENCODE_CONFIG_CONTENT": '{"model":"company/fixture","permission":{"edit":"deny"}}',
            "SODUWORK_APPROVAL_CHANNEL": "",
            "PYTHONDONTWRITEBYTECODE": "1",
        }

    def assert_config(self, env):
        expected = self.root / "runner" / "agents" / "opencode" / "config"
        self.assertEqual(Path(env["XDG_CONFIG_HOME"]), expected)
        self.assertTrue(expected.is_dir())
        self.assertEqual(list(expected.iterdir()), [])
        self.assertFalse(env.get("OPENCODE_CONFIG"))
        self.assertFalse(env.get("OPENCODE_CONFIG_DIR"))
        self.assertEqual(env["HOME"], self.environment["HOME"])
        base = expected.parent
        for key, folder in (("XDG_DATA_HOME", "data"), ("XDG_STATE_HOME", "state"),
                            ("XDG_CACHE_HOME", "cache")):
            self.assertEqual(Path(env[key]), base / folder)
            self.assertTrue(Path(env[key]).is_dir())
        self.assertEqual(Path(env["OPENCODE_DB"]), base / "data" / "opencode" / "opencode.db")
        self.assertEqual(self.personal.read_bytes(), b"invalid personal config: PRIVATE-FIXTURE")

    def test_config_override_names_are_removed_case_insensitively(self):
        from app.services.opencode_runtime_config import prepare_environment
        env = {**self.environment, "OpenCode_Config": str(self.personal),
               "opencode_config_dir": str(self.personal.parent)}
        prepare_environment(env, str(self.root / "runner"))
        self.assertFalse(any(key.upper() in {"OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"}
                             for key in env))
        self.assertEqual(env["OPENCODE_CONFIG_CONTENT"], self.environment["OPENCODE_CONFIG_CONTENT"])
        self.assert_config(env)

    def test_parent_environment_isolates_personal_config_and_native_state(self):
        cfg = {"llm": {"base": "http://127.0.0.1/v1", "key": "fixture", "model": "fixture"},
               "runtimeSecrets": {"XDG_CONFIG_HOME": "FIXTURE_CONFIG_OVERRIDE"}}
        with patch.dict(os.environ, {**self.environment,
                                     "FIXTURE_CONFIG_OVERRIDE": str(self.personal.parent.parent)}):
            env = local_base._env_for(local_base._PROFILES["opencode"], cfg)
        self.assert_config(env)
        self.assertEqual(json.loads(env["OPENCODE_CONFIG_CONTENT"])["model"], "company/fixture")
        self.assertNotIn("agent", json.loads(env["OPENCODE_CONFIG_CONTENT"]))

    def test_repeated_preparation_keeps_one_database_and_legacy_source(self):
        from app.services.opencode_runtime_config import prepare_environment
        env = dict(self.environment)
        prepare_environment(env, str(self.root / "runner"))
        prepared = dict(env)
        # Simulate the ACP subprocess after the parent replaced its XDG paths.
        with patch.dict(os.environ, env, clear=True):
            prepare_environment(env)
        self.assertEqual(env, prepared)
        self.assertEqual(env["SODUWORK_OPENCODE_LEGACY_DB"], self.environment["OPENCODE_DB"])

    def test_legacy_default_and_case_insensitive_overrides_are_isolated(self):
        from app.services.opencode_runtime_config import prepare_environment
        env = dict(self.environment)
        del env["OPENCODE_DB"]
        prepare_environment(env, str(self.root / "runner"))
        self.assertEqual(Path(env["SODUWORK_OPENCODE_LEGACY_DB"]),
                         Path(self.environment["XDG_DATA_HOME"]) / "opencode" / "opencode.db")
        env = {**self.environment, "Opencode_Db": str(self.root / "override.db"),
               "xdg_data_home": str(self.root / "override-data")}
        prepare_environment(env, str(self.root / "runner"))
        self.assertNotIn("Opencode_Db", env)
        self.assertNotIn("xdg_data_home", env)
        self.assertEqual(env["SODUWORK_OPENCODE_LEGACY_DB"], str(self.root / "override.db"))
        self.assert_config(env)

    def test_equivalent_private_path_does_not_become_its_own_legacy_source(self):
        from app.services.opencode_runtime_config import prepare_environment
        env = dict(self.environment)
        prepare_environment(env, str(self.root / "runner"))
        private = Path(env["OPENCODE_DB"])
        alternate = str(private.parent / ".." / "opencode" / private.name)
        env["OPENCODE_DB"] = alternate.replace("\\", "/").upper() if os.name == "nt" else alternate
        prepare_environment(env, str(self.root / "runner"))
        self.assertEqual(env["SODUWORK_OPENCODE_LEGACY_DB"], self.environment["OPENCODE_DB"])
        self.assertEqual(env["OPENCODE_DB"], str(private))

    def test_managed_directory_links_cannot_redirect_into_personal_state(self):
        from app.services.opencode_runtime_config import prepare_environment
        for folder in ("config", "data", "state", "cache", "config/opencode", "data/opencode",
                       "state/opencode", "cache/opencode", ""):
            with self.subTest(folder=folder or "agent root"):
                runner = self.root / ("runner-" + folder.replace("/", "-") + "-links")
                target = self.root / ("personal-" + folder.replace("/", "-") + "-state")
                target.mkdir()
                sentinel = target / "personal-marker"
                sentinel.write_bytes(b"original-personal-state")
                link = runner / "agents" / "opencode" / folder
                link.parent.mkdir(parents=True)
                link.symlink_to(target, target_is_directory=True)
                env = dict(self.environment)
                with self.assertRaisesRegex(OSError, "OpenCode") as caught:
                    prepare_environment(env, str(runner))
                self.assertNotIn(str(self.root), str(caught.exception))
                self.assertEqual(list(target.iterdir()), [sentinel])
                self.assertEqual(sentinel.read_bytes(), b"original-personal-state")
                self.assertEqual(env, self.environment, "Rejected paths cannot become the next prepared environment")

    def test_new_session_database_links_cannot_open_personal_history(self):
        from app.services.opencode_runtime_config import prepare_environment
        source = Path(self.environment["OPENCODE_DB"])
        source.write_bytes(b"original-personal-database")
        for kind in ("symbolic", "hard"):
            with self.subTest(kind=kind):
                runner = self.root / ("runner-" + kind)
                database = runner / "agents/opencode/data/opencode/opencode.db"
                database.parent.mkdir(parents=True)
                if kind == "symbolic":
                    database.symlink_to(source)
                else:
                    os.link(source, database)
                env = dict(self.environment)
                with self.assertRaisesRegex(OSError, "OpenCode") as caught:
                    prepare_environment(env, str(runner))
                self.assertNotIn(str(self.root), str(caught.exception))
                self.assertEqual(source.read_bytes(), b"original-personal-database")
                self.assertEqual(env, self.environment)

    def test_unknown_hard_link_target_is_rejected_even_without_a_legacy_override(self):
        from app.services.opencode_runtime_config import prepare_environment
        source = self.root / "other-personal.db"
        source.write_bytes(b"original-personal-database")
        database = self.root / "runner/agents/opencode/data/opencode/opencode.db"
        database.parent.mkdir(parents=True)
        os.link(source, database)
        env = dict(self.environment)
        del env["OPENCODE_DB"]
        with self.assertRaisesRegex(OSError, "OpenCode"):
            prepare_environment(env, str(self.root / "runner"))
        self.assertEqual(source.read_bytes(), b"original-personal-database")

    def test_known_sqlite_destination_links_cannot_modify_personal_files(self):
        from app.services.opencode_runtime_config import prepare_environment
        for database in ("opencode.db", "opencode.db.soduwork-migrate-lock"):
            for suffix in ("", "-wal", "-shm", "-journal"):
                for kind in ("symbolic", "hard"):
                    with self.subTest(database=database, suffix=suffix, kind=kind):
                        name = database + suffix + "-" + kind
                        runner = self.root / ("runner-" + name)
                        source = self.root / ("personal-" + name)
                        source.write_bytes(b"original-personal-sqlite-file")
                        destination = runner / "agents/opencode/data/opencode" / (database + suffix)
                        destination.parent.mkdir(parents=True)
                        if kind == "symbolic":
                            destination.symlink_to(source)
                        else:
                            os.link(source, destination)
                        env = dict(self.environment)
                        with self.assertRaisesRegex(OSError, "OpenCode") as failure:
                            prepare_environment(env, str(runner))
                        self.assertNotIn(str(self.root), str(failure.exception))
                        self.assertEqual(source.read_bytes(), b"original-personal-sqlite-file")
                        self.assertEqual(env, self.environment)

    def test_known_sqlite_destination_directories_are_rejected(self):
        from app.services.opencode_runtime_config import prepare_environment
        for database in ("opencode.db", "opencode.db.soduwork-migrate-lock"):
            for suffix in ("", "-wal", "-shm", "-journal"):
                with self.subTest(database=database, suffix=suffix):
                    runner = self.root / ("runner-directory-" + database + suffix)
                    destination = runner / "agents/opencode/data/opencode" / (database + suffix)
                    destination.mkdir(parents=True)
                    env = dict(self.environment)
                    with self.assertRaisesRegex(OSError, "OpenCode"):
                        prepare_environment(env, str(runner))
                    self.assertEqual(env, self.environment)

    def test_regular_sqlite_destinations_remain_unchanged_during_environment_preparation(self):
        from app.services.opencode_runtime_config import prepare_environment
        runner = self.root / "runner-regular-databases"
        folder = runner / "agents/opencode/data/opencode"
        folder.mkdir(parents=True)
        files = []
        for database in ("opencode.db", "opencode.db.soduwork-migrate-lock"):
            for suffix in ("", "-wal", "-shm", "-journal"):
                destination = folder / (database + suffix)
                destination.write_bytes(b"regular-private-sqlite-file")
                files.append(destination)
        env = dict(self.environment)
        prepare_environment(env, str(runner))
        expected = dict(env)
        prepare_environment(env)
        self.assertEqual(env, expected)
        for path in files:
            self.assertEqual(path.read_bytes(), b"regular-private-sqlite-file")

    def test_canonical_history_and_lock_paths_cannot_hide_companion_hard_links(self):
        from app.services.opencode_runtime_config import prepare_environment
        for suffix in ("-wal", "-shm", "-journal", ".soduwork-migrate-lock",
                       ".soduwork-migrate-lock-wal", ".soduwork-migrate-lock-shm",
                       ".soduwork-migrate-lock-journal"):
            with self.subTest(suffix=suffix):
                runner = self.root / ("runner-canonical-history" + suffix)
                database = runner / "agents/opencode/data/opencode/opencode.db"
                database.parent.mkdir(parents=True)
                actual = database.with_name("actual-native.db")
                actual.write_bytes(b"private-history-fixture")
                database.symlink_to(actual)
                source = self.root / ("external-canonical-history" + suffix)
                source.write_bytes(b"original-personal-sqlite-file")
                os.link(source, actual.with_name(actual.name + suffix))
                env = dict(self.environment)
                with self.assertRaisesRegex(OSError, "OpenCode"):
                    prepare_environment(env, str(runner))
                self.assertEqual(source.read_bytes(), b"original-personal-sqlite-file")
                self.assertEqual(env, self.environment)

    def test_canonical_migration_lock_cannot_hide_companion_hard_links(self):
        from app.services.opencode_runtime_config import prepare_environment
        for suffix in ("-wal", "-shm", "-journal"):
            with self.subTest(suffix=suffix):
                runner = self.root / ("runner-canonical-lock" + suffix)
                database = runner / "agents/opencode/data/opencode/opencode.db"
                database.parent.mkdir(parents=True)
                actual = database.with_name("actual-lock.db")
                actual.write_bytes(b"private-lock-fixture")
                database.with_name(database.name + ".soduwork-migrate-lock").symlink_to(actual)
                source = self.root / ("external-canonical-lock" + suffix)
                source.write_bytes(b"original-personal-sqlite-file")
                os.link(source, actual.with_name(actual.name + suffix))
                env = dict(self.environment)
                with self.assertRaisesRegex(OSError, "OpenCode"):
                    prepare_environment(env, str(runner))
                self.assertEqual(source.read_bytes(), b"original-personal-sqlite-file")
                self.assertEqual(env, self.environment)

    def test_internal_database_aliases_preserve_environment_idempotency(self):
        from app.services.opencode_runtime_config import prepare_environment
        runner = self.root / "runner-database-aliases"
        database = runner / "agents/opencode/data/opencode/opencode.db"
        database.parent.mkdir(parents=True)
        for path in (database, database.with_name(database.name + ".soduwork-migrate-lock")):
            actual = path.with_name("actual-" + path.name)
            actual.write_bytes(b"private-database-fixture")
            path.symlink_to(actual)
        env = dict(self.environment)
        prepare_environment(env, str(runner))
        expected = dict(env)
        prepare_environment(env)
        self.assertEqual(env, expected)

    def test_runner_root_alias_and_internal_directory_alias_preserve_idempotency(self):
        from app.services.opencode_runtime_config import prepare_environment
        actual = self.root / "actual-runner"
        base = actual / "agents/opencode"
        destination = base / "private-data"
        destination.mkdir(parents=True)
        (base / "data").symlink_to(destination, target_is_directory=True)
        runner = self.root / "runner"
        runner.symlink_to(actual, target_is_directory=True)
        env = dict(self.environment)
        prepare_environment(env, str(runner))
        original = dict(env)
        with patch.dict(os.environ, env, clear=True):
            prepare_environment(env)
        self.assertEqual(env, original)
        self.assert_config(env)
        self.assertEqual(Path(env["OPENCODE_DB"]).resolve(), destination / "opencode/opencode.db")

    def child_environment(self, agent, *, guarded=False):
        keys = [*self.environment]
        program = ("import json,os; print(json.dumps({k:os.environ.get(k) for k in "
                   + repr(keys) + "}),flush=True)")
        env = dict(self.environment)
        if guarded:
            env["SODUWORK_APPROVAL_CHANNEL"] = json.dumps({
                "url": "http://127.0.0.1:9", "token": "fixture",
                "policy": {"mode": "readonly", "workspaceRoot": str(self.root)},
            })
        with patch.dict(os.environ, env):
            bridge = acp_bridge.AcpBridge(
                [sys.executable, "-u", "-c", program], str(self.root), agent, "workspace")
            try:
                bridge.start()
                kind, result = bridge.inbox.get(timeout=5)
                self.assertEqual(kind, "message")
                return result
            finally:
                bridge.close()

    def test_child_entry_repairs_old_parent_environment_and_keeps_guard(self):
        env = self.child_environment("opencode", guarded=True)
        self.assert_config(env)
        config = json.loads(env["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual(config["model"], "company/fixture")
        self.assertTrue(config["plugin"])
        self.assertEqual(config["permission"]["edit"], "deny")
        self.assertIsNone(env["SODUWORK_APPROVAL_CHANNEL"])

    def test_other_acp_agents_keep_their_own_config_environment(self):
        from app.services import opencode_runtime_config
        for agent in ("codex", "codex-harness", "qwen", "pi", "dsh"):
            with self.subTest(agent=agent), patch.object(opencode_runtime_config, "prepare_environment") as prepare:
                env = self.child_environment(agent)
                prepare.assert_not_called()
                self.assertEqual(env["XDG_CONFIG_HOME"], self.environment["XDG_CONFIG_HOME"])
                self.assertEqual(env["OPENCODE_CONFIG_CONTENT"], self.environment["OPENCODE_CONFIG_CONTENT"])
                self.assertFalse((self.root / "runner").exists())




    def test_source_bridge_redacts_opencode_invalid_config_diagnostic(self):
        diagnostic = "ConfigJsonError: EndOfFileExpected PRIVATE-FIXTURE apiKey=fixture-secret"
        peer = "import sys; print(" + repr(diagnostic) + ",file=sys.stderr)"
        command = [sys.executable, str(Path(acp_bridge.__file__)),
                   "--agent-name", "opencode", "--cwd", str(self.root),
                   "--", sys.executable, "-u", "-c", peer]
        done = subprocess.run(command, input="fixture", env={**os.environ, **self.environment},
                              capture_output=True, text=True, encoding="utf-8", timeout=10)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertNotIn("PRIVATE-FIXTURE", done.stdout)
        self.assertNotIn("fixture-secret", done.stdout)
        self.assertIn("配置无法解析", done.stdout)
        self.assertEqual(self.personal.read_bytes(), b"invalid personal config: PRIVATE-FIXTURE")

    def test_other_agents_keep_native_config_errors(self):
        message = "ConfigJsonError: EndOfFileExpected fixture"
        for agent in ("codex", "qwen", "pi", "dsh", "codex-harness"):
            self.assertEqual(acp_bridge._friendly_bridge_error(agent, message), message)

    def test_truncated_opencode_config_dump_is_redacted_without_general_json_matching(self):
        messages = [
            "Config file at C:/fixture/opencode.json is not valid JSON(C): "
            "| fixture-secret PRIVATE-FIXTURE",
            "--- JSONC Input --- | fixture-secret PRIVATE-FIXTURE \x00\ufffd",
        ]
        for message in messages:
            with self.subTest(message=message):
                result = acp_bridge._friendly_bridge_error("opencode", message)
                self.assertIn("配置无法解析", result)
                self.assertNotIn("fixture-secret", result)
                self.assertNotIn("PRIVATE-FIXTURE", result)
                for agent in ("codex", "qwen", "pi", "dsh", "codex-harness"):
                    self.assertEqual(acp_bridge._friendly_bridge_error(agent, message), message)
        for message in ("Model response is not valid JSON(C): fixture",
                        "Model response is not valid JSON: fixture",
                        "Could not parse JSON model output: fixture"):
            self.assertEqual(acp_bridge._friendly_bridge_error("opencode", message), message)

    def test_shared_helper_is_in_runner_source_closure(self):
        backend = Path(__file__).resolve().parent
        expected = backend / "app" / "services" / "opencode_runtime_config.py"
        self.assertTrue(expected in runner_sources.build_inputs(backend, backend.parent),
                        "The standalone Runner must package the shared config boundary")

    def test_source_child_default_roots_match_all_three_platform_conventions(self):
        from app.services import opencode_runtime_config as config
        cases = [
            ("nt", "win32", ntpath, r"C:\Users\fixture", {"LOCALAPPDATA": r"C:\AppData"}, r"C:\AppData\soduwork"),
            ("posix", "darwin", posixpath, "/Users/fixture", {}, "/Users/fixture/Library/Application Support/soduwork"),
            ("posix", "linux", posixpath, "/home/fixture", {}, "/home/fixture/.local/share/soduwork"),
            ("posix", "linux", posixpath, "/home/fixture", {"XDG_DATA_HOME": "/data"}, "/data/soduwork"),
        ]
        for name, platform, paths, home, env, expected in cases:
            with self.subTest(platform=platform, env=env):
                path_api = Mock(wraps=paths)
                path_api.expanduser.return_value = home
                fake_os = SimpleNamespace(name=name, environ=env, path=path_api)
                with patch.object(config, "os", fake_os), patch.object(config.sys, "platform", platform):
                    self.assertEqual(config.runner_data_root(), expected)


if __name__ == "__main__":
    unittest.main()
