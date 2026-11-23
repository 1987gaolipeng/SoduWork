"""Installation job bookkeeping with mocked npm, never a real installation."""
import threading
import tempfile
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from app.services import agent_setup


class NonReentrantLock:
    """Fail deterministically where a real same-thread Lock would deadlock."""
    def __init__(self):
        self.owner = None
    def __enter__(self):
        current = threading.get_ident()
        if self.owner == current:
            raise AssertionError("Job finalization acquired its non-reentrant lock twice")
        self.owner = current
    def __exit__(self, *_args):
        self.owner = None


class AgentSetupInstallTests(unittest.TestCase):
    def test_runtime_activation_preserves_backup_when_replacement_and_restore_fail(self):
        runtime = agent_setup.dsh_runtime
        for restore_fails in (False, True):
            with self.subTest(restore_fails=restore_fails), tempfile.TemporaryDirectory() as folder:
                target = Path(runtime.host_root(folder))
                target.mkdir(parents=True)
                (target / "original.txt").write_text("previous working runtime", encoding="utf-8")
                stage = Path(tempfile.mkdtemp(prefix=".dsh-host-stage-", dir=target.parent))
                (stage / "new.txt").write_text("new runtime", encoding="utf-8")
                replace = runtime.os.replace
                def fail(source, destination):
                    if Path(source) == stage or (restore_fails and Path(source).name.startswith(".dsh-host-backup-")):
                        raise PermissionError("fixture activation blocked")
                    return replace(source, destination)
                with patch.object(runtime, "_runtime_issue_at", return_value=""), \
                     patch.object(runtime, "_native_specs", return_value=[]), \
                     patch.object(runtime.os, "replace", side_effect=fail):
                    with self.assertRaises(PermissionError):
                        runtime.activate_stage(str(stage), folder, "fixture")
                if restore_fails:
                    backups = list(target.parent.glob(".dsh-host-backup-*/original.txt"))
                    self.assertEqual(len(backups), 1, "Keep the last working runtime for recovery")
                    original = backups[0]
                else:
                    original = target / "original.txt"
                self.assertEqual(original.read_text(encoding="utf-8"), "previous working runtime")
                self.assertTrue((stage / "new.txt").exists())

    def run_install(self, code=0, version=None, *, npm="fixture-npm", issue="", key="qwen", action="install", commands=None, reported=None):
        if version is None:
            version = agent_setup._SPECS[key].get("version") or "0.25.0"
        runtime = {"ok": bool(npm), "nodePath": "fixture-node", "npmPath": npm,
                   "why": "Runner 需要可独立运行的 Node.js 和 npm" if not npm else ""}
        def stream(_jid, argv, **_kwargs):
            if commands is not None:
                commands.append(argv)
            return code, "fixture npm output"
        with (patch.object(agent_setup, "node_env", return_value=runtime),
              patch.object(agent_setup.agent_npm_runtime, "environment", return_value={}),
              patch.object(agent_setup.agent_npm_runtime, "activate_environment"),
              patch.object(agent_setup, "_stream", side_effect=stream),
              patch.object(agent_setup, "_pkg_version", return_value=version),
              patch.object(agent_setup, "_runtime_issue", return_value=issue),
              patch.object(agent_setup, "_bin_of", return_value="fixture-agent"),
              patch.object(agent_setup, "_short", return_value=version if reported is None else reported),
              patch.object(agent_setup, "_load_probes", side_effect=AssertionError("Install must not consume model probe state")),
              patch.object(agent_setup, "_done") as done):
            agent_setup._run_npm("fixture", key, action)
        return done

    def test_dsh_cold_start_has_time_to_handshake_but_cannot_activate_after_timeout(self):
        for startup_seconds in (35, 90):
            with self.subTest(startup_seconds=startup_seconds):
                def handshake(_executable, _stage, _version, *, timeout):
                    self.assertLessEqual(timeout, 60, "Installation must remain bounded")
                    return "" if startup_seconds <= timeout else "ACP handshake timed out"
                runtime = agent_setup.dsh_runtime
                with (patch.object(runtime, "stage_bundled_runtime", return_value={
                          "path": "fixture-stage", "version": "0.2.0-rc.2", "nativePackages": []}),
                      patch.object(runtime, "stage_boot_issue", side_effect=handshake),
                      patch.object(runtime, "activate_stage") as activate,
                      patch.object(runtime, "discard_stage") as discard,
                      patch.object(agent_setup, "_acp_runtime_issue", return_value="")):
                    done = self.run_install(key="dsh")
                if startup_seconds == 35:
                    self.assertIs(done.call_args.args[1], True)
                    activate.assert_called_once()
                    discard.assert_called_once_with("")
                else:
                    self.assertIs(done.call_args.args[1], False)
                    self.assertIn("ACP handshake timed out", done.call_args.args[2])
                    activate.assert_not_called()
                    discard.assert_called_once_with("fixture-stage")

    def test_successful_install_does_not_consume_a_model_probe_failure(self):
        done = self.run_install()
        done.assert_called_once()
        self.assertIs(done.call_args.args[1], True)
        self.assertIn(agent_setup._SPECS["qwen"]["version"], done.call_args.args[2])

    def test_verified_adapters_reject_wrong_metadata_before_runtime_activation(self):
        for key in ("kimi", "qwen", "dsh"):
            for action in ("install", "update"):
                for actual in ("", "0.1.0", "99.0.0"):
                    with self.subTest(key=key, action=action, actual=actual), \
                            patch.object(agent_setup.dsh_runtime, "stage_bundled_runtime") as stage:
                        done = self.run_install(version=actual, key=key, action=action)
                        self.assertFalse(done.call_args.args[1])
                        self.assertIn("已验证版本", done.call_args.args[2])
                        self.assertIn(agent_setup._SPECS[key]["version"], done.call_args.args[2])
                        stage.assert_not_called()

    def test_install_and_update_use_exact_reviewed_adapter_specs(self):
        runtime = agent_setup.dsh_runtime
        for key in ("kimi", "qwen", "dsh"):
            for action in ("install", "update"):
                commands = []
                with self.subTest(key=key, action=action), \
                        patch.object(runtime, "stage_bundled_runtime", return_value={"path": "fixture-stage", "version": "native-fixture"}), \
                        patch.object(runtime, "stage_boot_issue", return_value=""), \
                        patch.object(runtime, "activate_stage"), patch.object(runtime, "discard_stage"), \
                        patch.object(agent_setup, "_acp_runtime_issue", return_value=""):
                    done = self.run_install(key=key, action=action, commands=commands)
                self.assertTrue(done.call_args.args[1])
                spec = agent_setup._SPECS[key]
                self.assertEqual(commands, [["fixture-node", "fixture-npm", "install", "-g",
                    "--include=optional", "--engine-strict", spec["pkg"] + "@" + spec["version"]]])

    def test_pinned_metadata_cannot_hide_an_older_selected_executable(self):
        for key in ("kimi", "qwen", "dsh"):
            with self.subTest(key=key), patch.object(agent_setup.dsh_runtime, "stage_bundled_runtime") as stage:
                done = self.run_install(key=key, reported="0.1.0")
                self.assertFalse(done.call_args.args[1])
                self.assertIn("选中的执行程序版本为 0.1.0", done.call_args.args[2])
                stage.assert_not_called()

    def test_version_responses_accept_native_product_prefixes_but_not_numbers_in_diagnostics(self):
        for key in ("kimi", "qwen", "dsh"):
            spec = agent_setup._SPECS[key]
            version = spec["version"]
            for reported in (version, "v" + version, spec["pkg"] + " " + version,
                             spec["pkg"] + "@" + version, agent_setup._PROFILES[key]["name"] + " version " + version):
                with self.subTest(key=key, reported=reported):
                    self.assertEqual(agent_setup._verified_cli_issue(key, reported), "")
            for reported in ("0.1.0", "Error: expected " + version, version + "\nNode 22.23.3",
                             "not-the-selected-agent " + version):
                with self.subTest(key=key, reported=reported):
                    self.assertTrue(agent_setup._verified_cli_issue(key, reported))

    def test_private_install_metadata_never_falls_back_to_a_legacy_package(self):
        package = agent_setup._SPECS["qwen"]["pkg"]
        version = agent_setup._SPECS["qwen"]["version"]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            legacy = root / "legacy.json"
            legacy.write_text(json.dumps({"name": package, "version": version}), encoding="utf-8")
            private = root / "private"
            target = private.joinpath(*package.split("/"), "package.json")
            with patch.object(agent_setup, "_package_files", return_value=[str(legacy)]):
                self.assertEqual(agent_setup._pkg_version(package), version)
                self.assertEqual(agent_setup._pkg_version(package, root=str(private)), "")
                target.parent.mkdir(parents=True)
                target.write_text(json.dumps({"name": "wrong-package", "version": version}), encoding="utf-8")
                self.assertEqual(agent_setup._pkg_version(package, root=str(private)), "")
                target.write_text(json.dumps({"name": package, "version": version}), encoding="utf-8")
                self.assertEqual(agent_setup._pkg_version(package, root=str(private)), version)

    def test_verified_version_check_handles_missing_matching_and_newer_installs(self):
        for key in ("kimi", "qwen", "dsh"):
            spec = agent_setup._SPECS[key]
            for current in ("", spec["version"], "99.0.0"):
                with self.subTest(key=key, current=current), \
                        patch.object(agent_setup, "node_env", return_value={"ok": True, "nodePath": "node", "npmPath": "npm"}), \
                        patch.object(agent_setup.agent_npm_runtime, "environment", return_value={}), \
                        patch.object(agent_setup, "_stream", return_value=(0, spec["version"])) as npm, \
                        patch.object(agent_setup, "_version_of", return_value=(current, "pkg", "")), \
                        patch.object(agent_setup, "_bin_of", return_value="fixture-agent"), \
                        patch.object(agent_setup, "_cached_version_probe", return_value=spec["version"]), \
                        patch.object(agent_setup, "_runtime_issue", return_value=""), \
                        patch.object(agent_setup, "_done") as done:
                    agent_setup._run_npm("fixture", key, "check")
                    self.assertEqual(npm.call_args.args[1], ["node", "npm", "view", spec["pkg"] + "@" + spec["version"], "version"])
                    self.assertTrue(done.call_args.args[1])
                    self.assertIn("已验证版本", done.call_args.args[2])
                    self.assertNotIn("新版", done.call_args.args[2])
                    self.assertNotIn("最新", done.call_args.args[2])

    def test_verified_registry_response_cannot_redirect_to_an_unreviewed_version(self):
        with (patch.object(agent_setup, "node_env", return_value={"ok": True, "nodePath": "node", "npmPath": "npm"}),
              patch.object(agent_setup.agent_npm_runtime, "environment", return_value={}),
              patch.object(agent_setup, "_stream", return_value=(0, "99.0.0")),
              patch.object(agent_setup, "_version_of", return_value=("", "", "")),
              patch.object(agent_setup, "_done") as done):
            agent_setup._run_npm("fixture", "qwen", "check")
        self.assertFalse(done.call_args.args[1])
        self.assertIn("版本查询不一致", done.call_args.args[2])

    def test_verified_check_reports_a_stale_selected_binary_even_with_matching_metadata(self):
        version = agent_setup._SPECS["qwen"]["version"]
        with (patch.object(agent_setup, "node_env", return_value={"ok": True, "nodePath": "node", "npmPath": "npm"}),
              patch.object(agent_setup.agent_npm_runtime, "environment", return_value={}),
              patch.object(agent_setup, "_stream", return_value=(0, version)),
              patch.object(agent_setup, "_version_of", return_value=(version, "pkg", "")),
              patch.object(agent_setup, "_runtime_issue", return_value=""),
              patch.object(agent_setup, "_bin_of", return_value="fixture-agent"),
              patch.object(agent_setup, "_cached_version_probe", return_value="0.1.0"),
              patch.object(agent_setup, "_done") as done):
            agent_setup._run_npm("fixture", "qwen", "check")
        self.assertFalse(done.call_args.args[1])
        self.assertIn("选中的执行程序版本为 0.1.0", done.call_args.args[2])

    def test_detection_rejects_unreviewed_adapter_versions_without_installing(self):
        for key in ("kimi", "qwen", "dsh"):
            with self.subTest(key=key), patch.object(agent_setup, "_pkg_version", return_value="99.0.0"), \
                    patch.object(agent_setup, "_stream") as npm, \
                    patch.object(agent_setup, "_acp_runtime_issue") as runtime:
                issue = agent_setup._runtime_issue(key)
                self.assertIn(agent_setup._SPECS[key]["version"], issue)
                self.assertIn("更新", issue)
                npm.assert_not_called()
                runtime.assert_not_called()

    def test_catalog_version_is_used_for_pi_npm_install(self):
        calls = []
        runtime = {"ok": True, "nodePath": "fixture-node", "npmPath": "fixture-npm", "why": ""}

        def stream(_jid, argv, **_kwargs):
            calls.append(argv)
            return 0, "fixture npm output"

        with (patch.object(agent_setup, "node_env", return_value=runtime),
              patch.object(agent_setup.agent_npm_runtime, "environment", return_value={}),
              patch.object(agent_setup.agent_npm_runtime, "activate_environment"),
              patch.object(agent_setup, "_stream", side_effect=stream),
              patch.object(agent_setup, "_pkg_version", return_value="0.84.4"),
              patch.object(agent_setup, "_runtime_issue", return_value=""),
              patch.object(agent_setup, "_bin_of", return_value="fixture-agent"),
              patch.object(agent_setup, "_short", return_value="0.84.4"),
              patch.object(agent_setup, "_done") as done):
            agent_setup._run_npm("fixture", "pi", "install")

        self.assertTrue(calls)
        self.assertIn("@earendil-works/pi-coding-agent@0.84.4", calls[0])
        self.assertTrue(done.call_args.args[1])

    def test_npm_nonzero_and_missing_package_metadata_never_report_install_success(self):
        for code, version, issue in [(1, "0.25.0", ""), (124, "0.25.0", ""),
                                     (0, "", ""), (0, "0.25.0", "runtime incomplete")]:
            with self.subTest(code=code, version=version, issue=issue):
                done = self.run_install(code, version, issue=issue)
                self.assertIs(done.call_args.args[1], False)

    def test_missing_npm_finishes_with_an_actionable_reason(self):
        done = self.run_install(npm=None)
        done.assert_called_once()
        self.assertIs(done.call_args.args[1], False)
        self.assertIn("npm", done.call_args.args[2])

    def test_missing_package_finishes_without_starting_npm(self):
        with (patch.dict(agent_setup._SPECS, {"qwen": {"installer": "npm"}}),
              patch.object(agent_setup, "node_env") as runtime,
              patch.object(agent_setup, "_stream") as run,
              patch.object(agent_setup, "_done") as done):
            agent_setup._run_npm("fixture", "qwen", "install")
        runtime.assert_not_called()
        run.assert_not_called()
        done.assert_called_once_with("fixture", False, "该 Agent 缺少安装包定义")

    def test_a_job_that_returns_without_a_result_cannot_deadlock_finalization(self):
        jobs = {"fixture": {"state": "running"}}
        with (patch.object(agent_setup, "_JOB_LOCK", NonReentrantLock()),
              patch.object(agent_setup, "_JOBS", jobs)):
            agent_setup._guard("fixture", lambda _jid: None)
        self.assertEqual(jobs["fixture"]["state"], "done")
        self.assertIs(jobs["fixture"]["ok"], False)


if __name__ == "__main__":
    unittest.main()
