"""Installation recovery uses real package trees and bounded npm boundaries."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services import agent_npm_runtime as npm, agent_npm_network, agent_setup as setup, agent_codex_install
from app.services import agent_setup_runtime as runtime, local_base, managed_agent_network as network


class CodexIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "node_modules"
        self.patches = [patch.object(runtime, "_npm_root", return_value=str(self.root)),
                        patch.object(npm, "private_root", return_value=""),
                        patch.object(npm, "runtime_target", return_value=("win32", "x64"))]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.codex = self.root / "@agentclientprotocol/codex-acp/node_modules/@openai/codex"
        self.write_package(self.codex, "0.160.1")

    def write_package(self, directory, version, *, binary=False):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "package.json").write_text(json.dumps({"version": version}), encoding="utf-8")
        if binary:
            executable = directory / "vendor/x86_64-pc-windows-msvc/bin/codex.exe"
            executable.parent.mkdir(parents=True, exist_ok=True)
            executable.write_bytes(b"fixture native binary")

    def test_codex_resolves_its_nested_native_package_before_stale_global_copy(self):
        self.write_package(self.root / "@openai/codex-win32-x64", "0.148.0-win32-x64", binary=True)
        self.write_package(self.codex / "node_modules/@openai/codex-win32-x64",
                           "0.160.1-win32-x64", binary=True)
        self.assertEqual(runtime._codex_native_version(), "0.160.1-win32-x64")

    def test_metadata_without_the_native_executable_is_incomplete(self):
        self.write_package(self.root / "@openai/codex-win32-x64", "0.160.1-win32-x64")
        self.assertEqual(runtime._codex_native_version(), "")

    def test_personal_codex_native_is_resolved_before_unrelated_global_native(self):
        (self.codex / "package.json").unlink()
        self.write_package(self.root / "@openai/codex", "0.160.1")
        self.write_package(self.root / "@openai/codex-win32-x64", "0.148.0-win32-x64", binary=True)
        self.write_package(self.root / "@openai/codex/node_modules/@openai/codex-win32-x64",
                           "0.160.1-win32-x64", binary=True)
        self.assertEqual(runtime._codex_native_version(), "0.160.1-win32-x64")

    def test_corrupt_closest_package_does_not_fall_through_to_unreachable_global_binary(self):
        self.write_package(self.root / "@openai/codex-win32-x64", "0.160.1-win32-x64", binary=True)
        self.write_package(self.codex / "node_modules/@openai/codex-win32-x64", "0.160.1-win32-x64")
        self.assertEqual(runtime._codex_native_version(), "")


class CodexPackageOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="codex package ownership ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / "node_modules"
        self.personal = self.root / "@openai/codex/package.json"
        self.native = self.root / "@openai/codex-win32-x64"
        self.binary = self.native / "vendor/x86_64-pc-windows-msvc/bin/codex.exe"
        self.binary.parent.mkdir(parents=True)
        self.binary.write_bytes(b"shared native fixture")
        (self.native / "package.json").write_text(
            '{"name":"@openai/codex-win32-x64","version":"0.166.0-win32-x64"}', encoding="utf-8")
        adapter_codex = self.root / "@agentclientprotocol/codex-acp/node_modules/@openai/codex"
        adapter_codex.mkdir(parents=True)
        (adapter_codex / "package.json").write_text(
            '{"name":"@openai/codex","version":"0.166.0"}', encoding="utf-8")
        for item in (
            patch.object(npm, "private_root", return_value=str(self.root)),
            patch.object(npm, "runtime_target", return_value=("win32", "x64")),
            patch.object(local_base, "_npm_root", return_value=""),
            patch.object(runtime, "_npm_root", return_value=""),
            patch.object(local_base, "_WIN", True),
            patch.object(local_base.shutil, "which", return_value=None),
        ):
            item.start()
            self.addCleanup(item.stop)

    def test_harness_native_does_not_imply_a_personal_installation(self):
        self.assertIsNone(local_base._codex_bin())
        self.assertEqual(runtime._codex_native_details(), ("0.166.0-win32-x64", str(self.binary)))
        with patch.object(setup, "_cached_version_probe", return_value="codex-cli 0.166.0") as probe:
            self.assertEqual(setup._runtime_issue("codex-harness"), "")
        self.assertEqual(probe.call_args.args[0], str(self.binary))

    def test_personal_discovery_requires_its_own_valid_package_manifest(self):
        self.personal.parent.mkdir(parents=True)
        for manifest in ("broken json", "[]", "{}", '{"name":"@agentclientprotocol/codex-acp"}'):
            with self.subTest(manifest=manifest):
                self.personal.write_text(manifest, encoding="utf-8")
                self.assertIsNone(local_base._codex_bin())
        self.personal.write_text('{"name":"@openai/codex","version":"0.166.0"}', encoding="utf-8")
        self.assertEqual(local_base._codex_bin(), str(self.binary))

    def test_personal_uninstall_preserves_harness_and_does_not_report_a_shared_residual(self):
        self.personal.parent.mkdir(parents=True)
        self.personal.write_text('{"name":"@openai/codex","version":"0.166.0"}', encoding="utf-8")
        self.assertEqual(local_base._codex_bin(), str(self.binary))
        commands = []

        def uninstall(_jid, argv, **kwargs):
            commands.append(argv)
            self.personal.unlink()
            return 0, "personal wrapper removed"

        with patch.object(setup, "node_env", return_value={"ok": True, "nodePath": "node", "npmPath": "npm"}), \
                patch.object(npm, "environment", return_value={}), \
                patch.object(setup, "_stream", side_effect=uninstall):
            jid = setup._new_job("codex", "uninstall")
            setup._run_npm(jid, "codex", "uninstall")
        self.assertTrue(setup.job(jid)["ok"], setup.job(jid))
        self.assertEqual(commands, [["node", "npm", "uninstall", "-g", "@openai/codex"]])
        self.assertEqual(self.binary.read_bytes(), b"shared native fixture")
        self.assertIsNone(local_base._codex_bin())
        self.assertEqual(runtime._codex_native_details(), ("0.166.0-win32-x64", str(self.binary)))

    def test_independent_native_path_installation_stays_discoverable(self):
        standalone = Path(self.temp.name) / "standalone/codex.exe"
        standalone.parent.mkdir()
        standalone.write_bytes(b"standalone native fixture")
        with patch.object(local_base.shutil, "which", return_value=str(standalone)):
            self.assertEqual(local_base._codex_bin(), str(standalone))


class NpmNetworkEnvironmentTests(unittest.TestCase):
    def test_system_proxy_is_available_to_npm_without_persisting_npm_config(self):
        with patch.dict(os.environ, {"PATH": "fixture"}, clear=True), \
             patch.object(network, "_proxies", return_value={"https": "http://proxy.fixture:8080", "no": "localhost"}):
            env = npm.environment({"nodePath": "fixture-node"}, install=True)
            self.assertNotIn("HTTPS_PROXY", os.environ)
        self.assertEqual(env.get("HTTPS_PROXY"), "http://proxy.fixture:8080")
        self.assertEqual(env.get("NO_PROXY"), "localhost")

    def test_explicitly_disabled_https_proxy_does_not_inherit_http_proxy(self):
        with patch.dict(os.environ, {"PATH": "fixture", "HTTPS_PROXY": "", "HTTP_PROXY": "http://http.fixture"}, clear=True), \
             patch.object(network, "_proxies", return_value={"http": "http://http.fixture"}):
            env = npm.environment({}, install=True)
        # npm otherwise falls back from an empty HTTPS_PROXY to HTTP_PROXY.
        self.assertEqual(env.get("NPM_CONFIG_HTTPS_PROXY"), "false")


class CodexExecutableReadinessTests(unittest.TestCase):
    def test_native_warning_cannot_hide_a_successful_matching_version(self):
        for version, exit_code, ready in (("0.165.0", 0, True), ("0.164.0", 0, False), ("0.165.0", 3, False)):
            source = ("import sys; "
                      "print('WARNING: isolated CODEX_HOME does not exist', file=sys.stderr, flush=True); "
                      "print('codex-cli " + version + "'); sys.exit(" + str(exit_code) + ")")
            def real_probe(executable, args, *, run, timeout):
                self.assertEqual(args, ["--version"])
                return run(executable, ["-c", source], timeout=timeout)
            with self.subTest(version=version, exit_code=exit_code), \
                    patch.object(setup, "_codex_native_name", return_value="@openai/codex-win32-x64"), \
                    patch.object(setup, "_codex_dependency_version", return_value="0.165.0"), \
                    patch.object(setup, "_codex_native_version", return_value="0.165.0-win32-x64"), \
                    patch.object(setup, "_codex_native_binary", return_value=sys.executable), \
                    patch.object(setup, "_cached_version_probe", side_effect=real_probe):
                self.assertEqual(not setup._runtime_issue("codex-harness"), ready)

    def test_matching_metadata_cannot_hide_a_broken_native_executable(self):
        with patch.object(setup, "_codex_native_name", return_value="@openai/codex-win32-x64"), \
             patch.object(setup, "_codex_dependency_version", return_value="0.160.1"), \
             patch.object(setup, "_codex_native_version", return_value="0.160.1-win32-x64"), \
             patch.object(setup, "_cached_version_probe", return_value=""):
            self.assertTrue(setup._runtime_issue("codex-harness"), "A wrapper's metadata is not native executable readiness")

    def test_native_readiness_requires_the_resolved_version_to_start(self):
        for reported, ready in (("codex-cli 0.160.1", True), ("codex-cli 0.148.0", False), ("", False)):
            with self.subTest(reported=reported), \
                 patch.object(setup, "_codex_native_name", return_value="@openai/codex-win32-x64"), \
                 patch.object(setup, "_codex_dependency_version", return_value="0.160.1"), \
                 patch.object(setup, "_codex_native_version", return_value="0.160.1-win32-x64"), \
                 patch.object(setup, "_codex_native_binary", return_value="fixture-native-executable"), \
                 patch.object(setup, "_cached_version_probe", return_value=reported):
                self.assertEqual(not setup._runtime_issue("codex-harness"), ready)


class CodexInstallJobTests(unittest.TestCase):
    def setUp(self):
        for item in (patch.object(npm, "runtime_target", return_value=("win32", "x64")),):
            item.start()
            self.addCleanup(item.stop)

    def test_complete_optional_package_does_not_trigger_a_second_network_install(self):
        commands = []
        with patch.object(setup, "node_env", return_value={"ok": True, "nodePath": "node", "npmPath": "npm"}), \
             patch.object(npm, "environment", return_value={}), patch.object(npm, "activate_environment"), \
             patch.object(setup, "_stream", side_effect=lambda jid, argv, **kw: (commands.append(argv) or (0, ""))), \
             patch.object(setup, "_codex_dependency_version", return_value="0.160.1"), \
             patch.object(setup, "_codex_native_version", return_value="0.160.1-win32-x64"), \
             patch.object(setup, "_runtime_issue", return_value=""), \
             patch.object(setup, "_pkg_version", return_value="1.7.0"), \
             patch.object(setup, "_bin_of", return_value="fixture-agent"), \
             patch.object(setup, "_short", return_value="1.7.0"):
            jid = setup._new_job("codex-harness", "install")
            setup._run_npm(jid, "codex-harness", "install")
        self.assertTrue(setup.job(jid)["ok"])
        self.assertEqual(len(commands), 1, commands)

    def test_missing_native_is_repaired_inside_the_resolved_codex_package(self):
        with tempfile.TemporaryDirectory() as temp:
            codex = Path(temp).resolve() / "@agentclientprotocol/codex-acp/node_modules/@openai/codex"
            codex.mkdir(parents=True)
            (codex / "package.json").write_text('{"version":"0.160.1"}', encoding="utf-8")
            commands = []
            with patch.object(runtime, "_npm_root", return_value=str(Path(temp).resolve())), \
                 patch.object(npm, "private_root", return_value=""), \
                 patch.object(setup, "node_env", return_value={"ok": True, "nodePath": "node", "npmPath": "npm"}), \
                 patch.object(npm, "environment", return_value={}), patch.object(npm, "activate_environment"), \
                 patch.object(setup, "_stream", side_effect=lambda jid, argv, **kw: (commands.append(argv) or (0, ""))), \
                 patch.object(setup, "_runtime_issue", return_value=""), \
                 patch.object(setup, "_pkg_version", return_value="1.7.0"), \
                 patch.object(setup, "_bin_of", return_value="fixture-agent"), \
                 patch.object(setup, "_short", return_value="1.7.0"):
                jid = setup._new_job("codex-harness", "update")
                setup._run_npm(jid, "codex-harness", "update")
        self.assertEqual(len(commands), 2)
        self.assertNotIn("-g", commands[1])
        self.assertIn("--prefix=" + str(codex), commands[1])
        self.assertIn("--no-save", commands[1])

    def test_same_version_broken_closest_package_is_reextracted_and_failed_repair_restores_it(self):
        for repair_code in (0, 1):
            with self.subTest(repair_code=repair_code), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve()
                codex = root / "@agentclientprotocol/codex-acp/node_modules/@openai/codex"
                native = codex / "node_modules/@openai/codex-win32-x64"
                native.mkdir(parents=True)
                (codex / "package.json").write_text('{"version":"0.160.1"}', encoding="utf-8")
                metadata = '{"version":"0.160.1-win32-x64"}'
                (native / "package.json").write_text(metadata, encoding="utf-8")
                def stream(_jid, argv, **kwargs):
                    if not any(arg.startswith("--prefix=") for arg in argv):
                        return 0, "main package unchanged"
                    if repair_code:
                        return repair_code, "npm error code EACCES"
                    # Real npm leaves an existing same-version package alone,
                    # even when files inside it were deleted (cold-run evidence).
                    if not native.exists():
                        native.mkdir(parents=True)
                        (native / "package.json").write_text(metadata, encoding="utf-8")
                        binary = native / "vendor/x86_64-pc-windows-msvc/bin/codex.exe"
                        binary.parent.mkdir(parents=True)
                        binary.write_bytes(b"re-extracted native executable")
                    return 0, "npm install complete"
                with patch.object(runtime, "_npm_root", return_value=str(root)), \
                     patch.object(npm, "private_root", return_value=""), \
                     patch.object(setup, "node_env", return_value={"ok": True, "nodePath": "node", "npmPath": "npm"}), \
                     patch.object(npm, "environment", return_value={}), patch.object(npm, "activate_environment"), \
                     patch.object(setup, "_stream", side_effect=stream), \
                     patch.object(Path, "rename", side_effect=PermissionError("fixture encryption filter blocks directory rename")), \
                     patch.object(setup, "_pkg_version", return_value="2.2.2"), \
                     patch.object(setup, "_bin_of", return_value="fixture-agent"), \
                     patch.object(setup, "_short", side_effect=lambda executable, _args, **kw:
                         "codex-cli 0.160.1" if executable.endswith("codex.exe") else "2.2.2"):
                    jid = setup._new_job("codex-harness", "update")
                    setup._run_npm(jid, "codex-harness", "update")
                self.assertEqual(setup.job(jid)["ok"], repair_code == 0, setup.job(jid))
                if repair_code:
                    self.assertEqual((native / "package.json").read_text(encoding="utf-8"), metadata)
                self.assertEqual(list(codex.glob(".sw-native-*")), [])

    def test_failed_repair_does_not_merge_a_backup_into_an_undeletable_new_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            native = root / "node_modules/@openai/codex-win32-x64"
            native.mkdir(parents=True)
            (native / "old.txt").write_text("original", encoding="utf-8")
            original_remove = agent_codex_install.shutil.rmtree
            calls = 0
            def remove(path, **kwargs):
                nonlocal calls
                if Path(path) == native:
                    calls += 1
                    if calls > 1:
                        raise PermissionError("fixture new npm directory cannot be cleared")
                return original_remove(path, **kwargs)
            def install(*_args, **_kwargs):
                native.mkdir(parents=True)
                (native / "new.txt").write_text("partial npm result", encoding="utf-8")
                return 1, "install interrupted"
            with patch.object(runtime, "_codex_package_dir", return_value=str(root)), \
                 patch.object(runtime, "_codex_dependency_version", return_value="0.160.1"), \
                 patch.object(agent_codex_install.shutil, "rmtree", side_effect=remove):
                code, _detail = agent_codex_install.repair_native(install)
            self.assertNotEqual(code, 0)
            self.assertFalse((native / "old.txt").exists(), "Never merge a backup into an uncleared npm tree")
            backups = list(root.glob(".sw-native-*/old.txt"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(encoding="utf-8"), "original")


class NpmRecoveryJobTests(unittest.TestCase):
    def run_job(self, registry, first_output, second_code=0):
        commands = []
        def stream(jid, argv, **kwargs):
            commands.append(argv)
            return (1, first_output) if len(commands) == 1 else (second_code, "fixture retry")
        with patch.object(setup, "node_env", return_value={"ok": True, "nodePath": "node", "npmPath": "npm"}), \
             patch.object(npm, "environment", return_value={}), patch.object(npm, "activate_environment"), \
             patch.object(setup, "_stream", side_effect=stream), \
             patch.object(setup.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=registry)), \
             patch.object(setup, "_runtime_issue", return_value=""), \
             patch.object(setup, "_pkg_version", return_value="0.25.1"), \
             patch.object(setup, "_bin_of", return_value="fixture-agent"), \
             patch.object(setup, "_short", return_value="0.25.1"):
            jid = setup._new_job("qwen", "install")
            setup._run_npm(jid, "qwen", "install")
        return setup.job(jid), commands

    def test_unreachable_public_registry_tries_the_other_public_source_once(self):
        job, commands = self.run_job("https://registry.npmjs.org/", "npm error code ECONNRESET")
        self.assertTrue(job["ok"], job)
        self.assertEqual(len(commands), 2)
        self.assertIn("--registry=https://registry.npmmirror.com", commands[1])

    def test_registry_5xx_recovery_is_bounded_and_keeps_failure(self):
        job, commands = self.run_job("https://registry.npmmirror.com/", "npm ERR! code E503", 1)
        self.assertFalse(job["ok"])
        self.assertEqual(len(commands), 2)
        self.assertIn("--registry=https://registry.npmjs.org", commands[1])

    def test_private_registry_is_never_bypassed(self):
        job, commands = self.run_job("https://packages.company.invalid/", "npm error code ETIMEDOUT")
        self.assertFalse(job["ok"])
        self.assertEqual(len(commands), 1)

    def test_auth_tls_engine_and_filesystem_errors_are_not_retried(self):
        for code in ("E401", "E403", "EBADENGINE", "EACCES", "CERT_HAS_EXPIRED", "EINTEGRITY"):
            with self.subTest(code=code):
                job, commands = self.run_job("https://registry.npmjs.org/", "npm error code " + code)
                self.assertFalse(job["ok"])
                self.assertEqual(len(commands), 1)

    def test_authenticated_or_scoped_public_registry_never_changes_source(self):
        for config in (
            '//registry.npmjs.org/:_authToken = (protected)',
            '@company:registry = "https://registry.npmjs.org/"',
            '//registry.npmjs.org/:keyfile = (protected)',
            'key = "fixture-client-private-key"',
            'cert = "fixture-client-certificate"',
        ):
            with self.subTest(config=config), patch.object(
                    agent_npm_network.subprocess, "run", side_effect=lambda argv, **kw:
                    SimpleNamespace(returncode=0, stdout=config if "list" in argv else "https://registry.npmjs.org/")):
                self.assertEqual(agent_npm_network._alternative(["node", "npm"], {}), "")


if __name__ == "__main__":
    unittest.main()
