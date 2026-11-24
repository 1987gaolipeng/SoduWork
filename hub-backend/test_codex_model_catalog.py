"""Cold discovery of the selected native Codex catalog without a live account."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from app.services import agent_setup, codex_account_models, codex_model_catalog as catalog


class CodexModelCatalogTests(unittest.TestCase):
    def test_native_cli_projects_bundled_and_scoped_overrides_through_isolated_home(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            source.mkdir()
            (source / "config.toml").touch()
            cache = source / "models_cache.json"
            commands = []
            probe_homes = []

            def native(executable, args, env, deadline, limit):
                self.assertEqual(executable, "selected-codex.exe")
                self.assertNotIn("CODEX_CONFIG", env)
                self.assertNotIn("NODE_OPTIONS", env)
                self.assertNotIn("OPENAI_API_KEY", env)
                home = Path(env["CODEX_HOME"])
                probe_homes.append(home)
                self.assertNotEqual(home, source)
                self.assertEqual(env["CODEX_SQLITE_HOME"], str(home))
                self.assertFalse((home / "config.toml").exists())
                commands.append(args)
                if args == ["--version"]:
                    return b"codex-cli 0.1.0\n"
                args = args[args.index("debug"):]
                self.assertIn(args, (["debug", "models"], ["debug", "models", "--bundled"]))
                snapshot = home / "models_cache.json"
                self.assertEqual(snapshot.exists(), "--bundled" not in args)
                rows = [{"slug": "native-default", "visibility": "list", "base_instructions": "omitted",
                         "display_name": "Native model", "supported_reasoning_levels": [{"effort": "high"}],
                         "default_reasoning_level": "high"}, {"slug": "private-review", "visibility": "hide"}]
                if snapshot.exists():
                    overrides = json.loads(snapshot.read_text(encoding="utf-8"))
                    self.assertNotIn("unrelated", overrides)
                    rows.extend(overrides["models"])
                return json.dumps({"models": rows}).encode()

            with patch.object(agent_setup, "_bin_of", return_value="selected-codex.exe"), \
                    patch.object(catalog, "_run", side_effect=native), \
                    patch.dict(os.environ, CODEX_HOME=str(source), OPENAI_API_KEY="unused", NODE_OPTIONS="unused"):
                for writer in (None, "other-version", "0.1.0"):
                    with self.subTest(writer=writer):
                        commands.clear()
                        baseline = None
                        if writer:
                            baseline = json.dumps({"client_version": writer, "unrelated": "ignored", "models": [
                                {"slug": "from-account", "display_name": "Account model", "visibility": "list"}]})
                            cache.write_text(baseline)
                        result = codex_account_models.list_models(str(root))
                        expected = ["native-default", "from-account"] if writer == "0.1.0" else ["native-default"]
                        self.assertEqual([r["id"] for r in result["models"]], expected)
                        self.assertEqual(result["models"][0], {"id": "native-default", "label": "Native model",
                                         "reasoningLevels": ["high"], "defaultReasoning": "high"})
                        self.assertTrue(result["catalogAvailable"])
                        self.assertFalse(result["retryable"])
                        self.assertEqual(result["source"], "codex-native")
                        self.assertEqual(len(commands), 2 if writer else 1)
                        self.assertEqual(cache.read_text() if cache.exists() else None, baseline)
                        self.assertTrue(all(not path.exists() for path in probe_homes))
                self.assertFalse((root / "agents").exists())

    def test_unknown_command_retries_but_can_use_same_version_account_metadata(self):
        def run(executable, args, *unused):
            if args == ["--version"]:
                return b"codex-cli 2"
            return b"not a JSON model list"

        with patch.object(catalog, "_run", side_effect=run):
            self.assertEqual(catalog.discover("cli.exe", {}), (None, ""))
            self.assertEqual(catalog.discover("cli.exe", {"client_version": "2", "models": []}),
                             ([], "codex-account-cache"))
            self.assertEqual(catalog.discover("cli.exe", {"client_version": "1", "models": []}), (None, ""))

    def test_an_unverified_cache_cannot_hide_bundled_catalog(self):
        def run(executable, args, env, *unused):
            if args == ["--version"]:
                raise ValueError("The version probe failed")
            self.assertIn("--bundled", args)
            self.assertFalse((Path(env["CODEX_HOME"]) / "models_cache.json").exists())
            return b'{"models":[{"slug":"bundled"}]}'

        with patch.object(catalog, "_run", side_effect=run):
            rows, source = catalog.discover("cli.exe", {"client_version": "1", "models": [{"slug": "wrong"}]})
        self.assertEqual((rows, source), ([{"slug": "bundled"}], "codex-native"))

    def test_windows_rejects_shell_wrappers_before_launch(self):
        with patch.object(catalog.os, "name", "nt"), patch.object(catalog, "_run") as run:
            for path in ("codex.cmd", "codex.ps1", "codex.bat", "codex"):
                self.assertEqual(catalog.discover(path, {}), (None, ""))
            run.assert_not_called()

    def test_bounded_child_and_pipe_cleanup(self):
        with tempfile.TemporaryDirectory() as home:
            env = catalog._environment(home)
            with self.assertRaises(ValueError):
                catalog._run(sys.executable, ["-c", "import sys; sys.stdout.write('x' * 5000)"],
                             env, time.monotonic() + 5, 128)
            started = time.monotonic()
            with self.assertRaises(ValueError):
                catalog._run(sys.executable, ["-c", "import time; time.sleep(30)"], env, started + 0.3, 128)
            self.assertLess(time.monotonic() - started, 10)
            self.assertEqual(catalog._run(sys.executable, ["-c", "print('ok')"],
                                          env, time.monotonic() + 5, 128).strip(), b"ok")

    def test_switching_account_while_discovering_discards_results(self):
        with patch.object(codex_account_models.codex_account_home, "model_catalog_home", side_effect=["first", "second"]), \
                patch.object(agent_setup, "_bin_of", return_value="selected-codex.exe"), \
                patch.object(catalog, "discover", return_value=([{"slug": "old-account"}], "codex-native")):
            result = codex_account_models.list_models("unused", "existing")
        self.assertFalse(result["catalogAvailable"])
        self.assertTrue(result["retryable"])
        self.assertEqual(result["models"], [])

    def test_cache_replaced_in_the_same_account_directory_discards_pending_result(self):
        with tempfile.TemporaryDirectory() as home:
            file = Path(home) / "models_cache.json"
            file.write_text('{"client_version":"1","models":[]}')

            def replace(*unused):
                file.write_text('{"client_version":"1","models":[{"slug":"different"}]}')
                return [{"slug": "previous"}], "codex-native"

            with patch.dict(os.environ, CODEX_HOME=home), \
                    patch.object(agent_setup, "_bin_of", return_value="selected-codex.exe"), \
                    patch.object(catalog, "discover", side_effect=replace):
                result = codex_account_models.list_models(home)
            self.assertTrue(result["retryable"])
            self.assertFalse(result["catalogAvailable"])
            self.assertEqual(result["models"], [])


if __name__ == "__main__":
    unittest.main()
