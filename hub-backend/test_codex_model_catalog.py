"""Cold discovery of the selected native Codex catalog without a live account."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from app.services import agent_setup, codex_account_home, codex_account_models, codex_model_catalog as catalog


class CodexModelCatalogTests(unittest.TestCase):
    def test_cold_refresh_reads_account_receipt_and_excludes_static_candidates(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            terminal = root / "source"
            terminal.mkdir()
            home = Path(codex_account_home.connected_home(str(root), create=True))
            cache = home / "models_cache.json"
            probe_dirs = []
            account_row = {"slug": "account-model", "display_name": "Account model", "visibility": "list",
                           "supported_reasoning_levels": [{"effort": "high"}], "default_reasoning_level": "high",
                           "base_instructions": "omitted"}
            rows = [account_row, {"slug": "review", "visibility": "hide"}]

            def native(executable, args, env, *unused):
                self.assertEqual(executable, "selected-codex.exe")
                self.assertEqual(env["CODEX_HOME"], str(home))
                scratch = Path(env["TMPDIR"])
                probe_dirs.append(scratch)
                self.assertNotEqual(scratch, home)
                self.assertEqual(env["CODEX_SQLITE_HOME"], str(scratch))
                self.assertFalse((scratch / "auth.json").exists())
                for name in ("OPENAI_API_KEY", "CODEX_CONFIG", "NODE_OPTIONS", "MODEL_PROVIDER"):
                    self.assertNotIn(name, env)
                if args == ["--version"]:
                    return b"codex-cli 0.171.0-alpha.13"
                self.assertEqual(args, ["debug", "models"])
                cache.write_text(json.dumps({"client_version": "0.171.0", "identity": "account-a",
                                             "fetched_at": "2026-11-24T09:00:00Z", "models": rows}))
                return json.dumps({"models": [{"slug": "bundled-unavailable"}, *rows]}).encode()

            with patch.object(agent_setup, "_bin_of", return_value="selected-codex.exe"), \
                    patch.object(catalog, "_run", side_effect=native), \
                    patch.dict(os.environ, CODEX_HOME=str(terminal), OPENAI_API_KEY="unused", NODE_OPTIONS="unused"):
                for previous in (None, {"client_version": "0.142.5", "models": [{"slug": "old-model"}]}):
                    if previous:
                        cache.write_text(json.dumps(previous))
                    result = codex_account_models.list_models(str(root), "new")
                    self.assertTrue(result["catalogAvailable"])
                    self.assertFalse(result["retryable"])
                    self.assertEqual(result["source"], "codex-native")
                    self.assertEqual(result["models"], [{"id": "account-model", "label": "Account model",
                                     "reasoningLevels": ["high"], "defaultReasoning": "high"}])
                self.assertTrue(all(not path.exists() for path in probe_dirs))
                self.assertFalse((root / "agents/codex").exists())
                self.assertEqual(list(terminal.iterdir()), [])

    def test_bundled_menu_cannot_validate_another_accounts_cache_or_an_unsupported_command(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            cache = home / "models_cache.json"
            bundled = [{"slug": "bundled-static"}]
            active = [*bundled, {"slug": "account-b-extra"}]
            cache.write_text(json.dumps({"client_version": "0.171.0", "identity": "account-a",
                                         "models": [*bundled, {"slug": "account-a-extra"}]}))

            def run(executable, args, *unused):
                if args == ["--version"]:
                    return b"codex-cli 0.171.0-alpha.13"
                self.assertEqual(args[:2], ["debug", "models"])
                return json.dumps({"models": bundled if "--bundled" in args else active}).encode()

            with patch.object(catalog, "_run", side_effect=run):
                self.assertEqual(catalog.discover("cli.exe", str(home)), (None, ""))
                cache.unlink()
                self.assertEqual(catalog.discover("cli.exe", str(home)), (None, ""))
            with patch.object(catalog, "_run", side_effect=ValueError("unsupported command")):
                self.assertEqual(catalog.discover("cli.exe", str(home)), (None, ""))

    def test_native_cache_admission_and_visibility_preserve_existing_account_menu(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            cache = home / "models_cache.json"
            baseline = [{"slug": "both", "visibility": "list"}, {"slug": "account-hidden", "visibility": "list"},
                        {"slug": "only-bundled", "visibility": "list"}]
            raw = [{"slug": "both", "visibility": "list"}, {"slug": "account-hidden", "visibility": "hide"},
                   {"slug": "account-only", "visibility": "list"}]

            def run(executable, args, *unused):
                if args == ["--version"]:
                    return b"codex-cli 0.171.0-alpha.13"
                if "--bundled" in args:
                    return json.dumps({"models": baseline}).encode()
                return json.dumps({"models": [*raw, baseline[-1]]}).encode()

            with patch.object(catalog, "_run", side_effect=run):
                for version, expected in (("0.171.0-alpha.13", True), ("0.171.0", True), ("0.171.0-alpha.12", False),
                                          ("0.170.0", False), ("unexpected", False)):
                    with self.subTest(version=version):
                        cache.write_text(json.dumps({"client_version": version, "models": raw}))
                        result, source = catalog.discover("cli.exe", str(home))
                        if expected:
                            self.assertEqual(source, "codex-native")
                            self.assertEqual([r["slug"] for r in result], ["both", "account-only"])
                        else:
                            self.assertEqual((result, source), (None, ""))

    def test_native_removal_of_bundled_models_can_confirm_an_unchanged_cache(self):
        shared = {"both": {"slug": "both", "visibility": "list"}}
        static = {**shared, "static-only": {"slug": "static-only", "visibility": "list"}}
        self.assertTrue(catalog._used_cache(shared, shared, static))
        self.assertFalse(catalog._used_cache(shared, static, static))
        self.assertTrue(catalog._used_cache({}, {}, static))
        self.assertFalse(catalog._used_cache({}, static, static))

    def test_corrupt_empty_or_hidden_cache_can_refresh_without_authorizing_static_models(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            cache = home / "models_cache.json"
            hidden = {"client_version": "1", "models": [{"slug": "review", "visibility": "hide"}]}
            for before in ("{broken", "[]", '{"models":[]}', json.dumps(hidden)):
                for refreshed in (True, False):
                    cache.write_text(before)

                    def native(executable, args, env, *unused):
                        if args == ["--version"]:
                            return b"1"
                        if refreshed and "--bundled" not in args:
                            cache.write_text(json.dumps({"fetched_at": "2026-11-24T09:00:00Z",
                                                        "client_version": "1", "models": [{"slug": "account"}]}))
                            return b'{"models":[{"slug":"fallback"},{"slug":"account"}]}'
                        return b'{"models":[{"slug":"fallback"}]}'

                    with self.subTest(before=before, refreshed=refreshed), patch.object(catalog, "_run", side_effect=native):
                        expected = ([{"slug": "account"}], "codex-native") if refreshed else (None, "")
                        self.assertEqual(catalog.discover("cli.exe", str(home)), expected)

    def test_unsupported_native_command_preserves_default_without_starting_app_server(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            cache = home / "models_cache.json"
            cache.write_text(json.dumps({"client_version": "1.0.0", "models": [{"slug": "cached"}]}))
            commands = []

            def run(executable, args, *unused):
                commands.append(args)
                if args == ["--version"]:
                    return b"codex-cli 1.0.0"
                raise ValueError("Unsupported native debug models command")

            with patch.object(catalog, "_run", side_effect=run):
                self.assertEqual(catalog.discover("cli.exe", str(home)), (None, ""))
            self.assertEqual(commands, [["--version"], ["debug", "models"]])

    def test_upgrade_requires_a_confirmed_missing_catalog_command(self):
        with tempfile.TemporaryDirectory() as temp:
            home = str(Path(temp).resolve())
            for debug, help_text, upgrade in (
                (True, b"Commands:\n  test     test driver", True),
                (True, b"Commands:\n  models   list models", False),
                (False, b"Commands:\n  exec     run", True),
            ):
                def run(executable, args, *unused):
                    if args == ["--version"]:
                        return b"codex-cli 0.90.0"
                    if args == ["debug", "models"] or args == ["debug", "--help"] and not debug:
                        raise catalog._CommandRejected(2)
                    return help_text
                with self.subTest(debug=debug, upgrade=upgrade), patch.object(catalog, "_run", side_effect=run):
                    if upgrade:
                        with self.assertRaisesRegex(catalog.UpgradeRequired, "0.90.0"):
                            catalog.discover("codex.exe", home)
                    else:
                        self.assertEqual(catalog.discover("codex.exe", home), (None, ""))

    def test_cold_catalog_can_report_native_default_only_for_the_bound_signed_in_cli(self):
        with tempfile.TemporaryDirectory() as temp:
            home = str(Path(temp).resolve())
            cli = "codex.exe"
            signed_in = True

            def native(executable, args, env, *unused, **kwargs):
                self.assertEqual(executable, cli)
                self.assertEqual(env["CODEX_HOME"], home)
                if args == ["--version"]:
                    return b"codex-cli 1.0.0"
                if args == ["debug", "models"]:
                    return b'{"models":[{"slug":"bundled"}]}'
                self.assertEqual(args, ["login", "status"])
                self.assertNotIn("OPENAI_API_KEY", env)
                return b"Logged in using ChatGPT" if signed_in else b"Not logged in"

            with patch.object(codex_account_models.codex_account_home, "model_catalog_home", return_value=home), \
                    patch.object(agent_setup, "_bin_of", return_value=cli), patch.object(catalog, "_run", side_effect=native):
                signed = codex_account_models.list_models(home, "chat")
                self.assertTrue(signed.get("nativeDefaultAvailable"))
                self.assertFalse(signed["catalogAvailable"])
                self.assertEqual(signed["models"], [])
                signed_in = False
                self.assertFalse(codex_account_models.list_models(home, "chat").get("nativeDefaultAvailable"))
                signed_in = True
                with patch.object(codex_account_models.codex_account_home, "model_catalog_home",
                                  side_effect=[home, "different"]):
                    self.assertFalse(codex_account_models.list_models(home, "chat").get("nativeDefaultAvailable"))

    def test_cold_native_default_reads_status_from_stderr_without_forwarding_api_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            peer = home / "codex.py"
            peer.write_text("import os, sys\n"
                            "assert 'OPENAI_API_KEY' not in os.environ\n"
                            "if sys.argv[1:] == ['--version']: print('codex-cli 1.0.0')\n"
                            "elif sys.argv[1:] == ['debug', 'models']: print('{\"models\":[]}')\n"
                            "elif sys.argv[1:] == ['login', 'status']: print('Logged in using ChatGPT', file=sys.stderr)\n"
                            "else: sys.exit(2)\n")
            launch = catalog._run

            def native(executable, args, *rest, **kwargs):
                return launch(executable, [str(peer), *args], *rest, **kwargs)

            with patch.dict(os.environ, OPENAI_API_KEY="synthetic"), patch.object(catalog, "_run", side_effect=native):
                self.assertEqual(catalog.discover(sys.executable, str(home), check_default=True),
                                 (None, "codex-native-default"))
            self.assertFalse((home / "models_cache.json").exists())

    def test_explicit_upgrade_is_shared_by_readers_and_reloads_the_new_catalog(self):
        with patch.object(codex_account_models, "_last_upgrade", None), \
                patch.object(codex_account_models.codex_account_home, "model_catalog_home", return_value="home"), \
                patch.object(agent_setup, "_bin_of", return_value="codex.exe"), \
                patch.object(agent_setup, "start_install", return_value="job") as install, \
                patch.object(agent_setup, "job", return_value={"state": "running"}) as job, \
                patch.object(catalog, "discover", side_effect=catalog.UpgradeRequired("codex-cli 0.90.0")) as discover:
            read = codex_account_models.list_models
            self.assertEqual(read("root")["upgradeState"], "update-required")
            install.assert_not_called()
            self.assertEqual(read("root", ensure_compatible=True)["upgradeState"], "updating")
            self.assertEqual(read("root", ensure_compatible=True)["cliVersion"], "0.90.0")
            job.return_value = {"state": "done", "ok": False}
            self.assertEqual(read("root", ensure_compatible=True)["upgradeState"], "update-failed")
            install.assert_called_once_with("codex", "update")
            discover.side_effect = None
            discover.return_value = ([{"slug": "available"}], "codex-native")
            self.assertEqual(read("root")["models"][0]["id"], "available")
            discover.return_value = (None, "")
            self.assertNotIn("upgradeState", read("root", ensure_compatible=True))
            install.assert_called_once()

    def test_windows_rejects_shell_wrappers_before_launch(self):
        with patch.object(catalog.os, "name", "nt"), patch.object(catalog, "_run") as run:
            for path in ("codex.cmd", "codex.ps1", "codex.bat", "codex"):
                self.assertEqual(catalog.discover(path, "unused"), (None, ""))
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
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            home = Path(codex_account_home.connected_home(str(root), create=True))
            file = home / "models_cache.json"
            row = {"slug": "previous", "visibility": "list"}
            before = {"client_version": "1", "identity": "previous", "models": [row]}
            file.write_text(json.dumps(before))

            def replace(executable, args, *unused):
                if args == ["--version"]:
                    return b"codex-cli 1"
                file.write_text(json.dumps({**before, "identity": "different"}))
                return json.dumps({"models": [row]}).encode()

            with patch.dict(os.environ, CODEX_HOME=str(root / "terminal")), \
                    patch.object(agent_setup, "_bin_of", return_value="selected-codex.exe"), \
                    patch.object(catalog, "_run", side_effect=replace):
                result = codex_account_models.list_models(str(root))
            self.assertTrue(result["retryable"])
            self.assertFalse(result["catalogAvailable"])
            self.assertEqual(result["models"], [])


if __name__ == "__main__":
    unittest.main()
