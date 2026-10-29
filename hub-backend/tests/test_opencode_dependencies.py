"""Native dependency preparation never borrows personal config or activates versions."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from app.services import opencode_dependencies as deps


VERSION = "1.18.18"


def tree(config, version=VERSION):
    config.mkdir(parents=True, exist_ok=True)
    packages = {"": {"dependencies": {"@opencode-ai/plugin": version}}}
    for name in ("@opencode-ai/plugin", "@opencode-ai/sdk"):
        relative = "node_modules/" + name
        package = config / relative
        (package / "dist").mkdir(parents=True)
        value = {"name": name, "version": version, "type": "module",
                 "exports": {".": "./dist/index.js"}}
        if name.endswith("/plugin"):
            value["dependencies"] = {"@opencode-ai/sdk": version}
        (package / "package.json").write_text(json.dumps(value), encoding="utf-8")
        (package / "dist" / "index.js").write_text("export const fixture = true;", encoding="utf-8")
        packages[relative] = {
            "version": version, "resolved": f"https://registry.npmjs.org/{name}/fixture.tgz",
            "integrity": "sha512-" + "A" * 86 + "==",
            "dependencies": value.get("dependencies", {}),
        }
    # npm keeps entries for optional packages belonging to other platforms.
    packages["node_modules/platform-optional"] = {
        "version": "1.0.0", "optional": True, "os": ["not-this-os"],
        "resolved": "https://registry.npmjs.org/platform-optional/fixture.tgz",
        "integrity": "sha512-" + "A" * 86 + "==",
    }
    (config / "package.json").write_text(
        json.dumps({"dependencies": {"@opencode-ai/plugin": version}}), encoding="utf-8")
    (config / "package-lock.json").write_text(
        json.dumps({"lockfileVersion": 3, "packages": packages}), encoding="utf-8")
    return config


class OpenCodeDependenciesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-dependencies-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.data = self.root / "runner"
        self.config = self.data / "agents" / "opencode" / "config" / "opencode"
        self.binary = self.root / "native"
        self.binary.write_bytes(b"fixture")

    def bootstrap(self, binary, version, stage, say):
        self.assertEqual(Path(binary), self.binary)
        self.assertEqual(version, VERSION)
        return tree(stage / "config" / "opencode")

    def test_missing_is_readonly_and_does_not_create_data(self):
        self.assertTrue(deps.issue(str(self.data), VERSION))
        self.assertFalse(self.data.exists())

    def test_preparation_publishes_only_dependencies_and_does_not_activate(self):
        self.config.mkdir(parents=True)
        personal = self.config / "opencode.json"
        personal.write_text('{"plugin":["never-load-user-plugin"]}', encoding="utf-8")
        active = self.data / "agents" / "opencode" / "active.json"
        active.write_text('{"version":"previous"}', encoding="utf-8")
        with patch.object(deps, "_bootstrap", side_effect=self.bootstrap) as bootstrap:
            deps.prepare(str(self.binary), VERSION, str(self.data), Mock())
        self.assertEqual(bootstrap.call_count, 1)
        self.assertEqual(deps.issue(str(self.data), VERSION), "")
        self.assertEqual(personal.read_text(), '{"plugin":["never-load-user-plugin"]}')
        self.assertEqual(active.read_text(), '{"version":"previous"}')
        with patch.object(deps, "_bootstrap") as bootstrap:
            deps.prepare(str(self.binary), VERSION, str(self.data), Mock())
        bootstrap.assert_not_called()

    def test_half_installed_or_fabricated_lock_is_not_ready(self):
        tree(self.config)
        self.assertTrue(deps.issue(str(self.data), VERSION))
        with patch.object(deps, "_bootstrap", side_effect=self.bootstrap):
            deps.prepare(str(self.binary), VERSION, str(self.data), Mock())
        self.assertEqual(deps.issue(str(self.data), VERSION), "")
        (self.config / "node_modules/@opencode-ai/sdk/dist/index.js").unlink()
        self.assertTrue(deps.issue(str(self.data), VERSION))

    def test_wrong_version_and_tampered_package_are_not_ready(self):
        with patch.object(deps, "_bootstrap", side_effect=self.bootstrap):
            deps.prepare(str(self.binary), VERSION, str(self.data), Mock())
        self.assertTrue(deps.issue(str(self.data), "1.18.19"))
        package = self.config / "node_modules/@opencode-ai/plugin/package.json"
        package.write_text('{"version":"private-secret"}', encoding="utf-8")
        message = deps.issue(str(self.data), VERSION)
        self.assertTrue(message)
        self.assertNotIn("private-secret", message)
        self.assertNotIn(str(self.root), message)

    def test_bootstrap_failure_preserves_previous_files_and_redacts_detail(self):
        tree(self.config, "1.18.17")
        original = (self.config / "package-lock.json").read_bytes()
        with patch.object(deps, "_bootstrap", side_effect=RuntimeError("proxy-user:private-secret")):
            with self.assertRaises(RuntimeError) as raised:
                deps.prepare(str(self.binary), VERSION, str(self.data), Mock())
        self.assertNotIn("private-secret", str(raised.exception))
        self.assertEqual((self.config / "package-lock.json").read_bytes(), original)

    def test_publish_failure_rolls_back_all_previous_dependency_files(self):
        tree(self.config, "1.18.17")
        original = {str(path.relative_to(self.config)): path.read_bytes()
                    for path in self.config.rglob("*") if path.is_file()}
        replace = os.replace

        def fail_new_lock(source, target):
            if Path(target).resolve() == (self.config / "package-lock.json").resolve() and "backup" not in str(source):
                raise OSError("fixture disk error")
            return replace(source, target)

        with (patch.object(deps, "_bootstrap", side_effect=self.bootstrap),
              patch.object(deps.os, "replace", side_effect=fail_new_lock)):
            with self.assertRaises(RuntimeError):
                deps.prepare(str(self.binary), VERSION, str(self.data), Mock())
        self.assertEqual({str(path.relative_to(self.config)): path.read_bytes()
                          for path in self.config.rglob("*") if path.is_file()}, original)

    def test_transaction_restores_dependencies_when_activation_fails(self):
        tree(self.config, "1.18.17")
        original = {str(path.relative_to(self.config)): path.read_bytes()
                    for path in self.config.rglob("*") if path.is_file()}
        with patch.object(deps, "_bootstrap", side_effect=self.bootstrap):
            with self.assertRaisesRegex(ValueError, "activation failed"):
                with deps.transaction(str(self.binary), VERSION, str(self.data), Mock()):
                    self.assertEqual(deps.issue(str(self.data), VERSION), "")
                    raise ValueError("activation failed")
        self.assertEqual({str(path.relative_to(self.config)): path.read_bytes()
                          for path in self.config.rglob("*") if path.is_file()}, original)

    def test_transaction_without_previous_dependencies_removes_new_files_on_failure(self):
        with patch.object(deps, "_bootstrap", side_effect=self.bootstrap):
            with self.assertRaises(KeyboardInterrupt):
                with deps.transaction(str(self.binary), VERSION, str(self.data), Mock()):
                    raise KeyboardInterrupt
        self.assertFalse((self.config / "node_modules").exists())
        self.assertFalse((self.config / "package-lock.json").exists())

    def test_stage_cleanup_failure_does_not_turn_committed_install_into_failure(self):
        with (patch.object(deps, "_bootstrap", side_effect=self.bootstrap),
              patch.object(deps.shutil, "rmtree", side_effect=OSError("fixture locked file"))):
            deps.prepare(str(self.binary), VERSION, str(self.data), Mock())
        self.assertEqual(deps.issue(str(self.data), VERSION), "")

    def test_environment_isolates_home_model_npm_config_and_keeps_verified_proxies(self):
        stage = self.root / "stage"
        stage.mkdir()
        source = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": "private-home", "USERPROFILE": "private-home",
            "OPENAI_API_KEY": "private-secret", "OPENCODE_CONFIG_CONTENT": "private-secret",
            "OPENCODE_CONFIG_DIR": "private-config", "NPM_CONFIG_USERCONFIG": "private-npmrc",
            "NODE_TLS_REJECT_UNAUTHORIZED": "0", "NPM_CONFIG_STRICT_SSL": "false",
        }
        proxies = {"http": "http://fixture-user:fixture-password@127.0.0.1:9001",
                   "https": "http://127.0.0.1:9002", "no": "localhost"}
        with (patch.dict(os.environ, source, clear=True),
              patch.object(deps.managed_agent_network, "_proxies", return_value=proxies)):
            env = deps._environment(stage)
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("OPENCODE_CONFIG_DIR", env)
        self.assertNotIn("NODE_TLS_REJECT_UNAUTHORIZED", env)
        self.assertEqual(env["NPM_CONFIG_STRICT_SSL"], "true")
        self.assertEqual(env["NPM_CONFIG_HTTPS_PROXY"], proxies["https"])
        self.assertEqual(env["NPM_CONFIG_PROXY"], proxies["https"])
        self.assertEqual(env["NPM_CONFIG_NOPROXY"], "localhost")
        for key in ("HOME", "USERPROFILE", "XDG_DATA_HOME", "XDG_CONFIG_HOME",
                    "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_CACHE", "OPENCODE_DB"):
            self.assertTrue(Path(env[key]).is_relative_to(stage), key)
        self.assertNotIn("model", json.loads(env["OPENCODE_CONFIG_CONTENT"]))

    def test_explicit_no_proxy_does_not_restore_disabled_protocol_proxy(self):
        stage = self.root / "stage"
        stage.mkdir()
        with patch.object(deps.managed_agent_network, "_proxies", return_value={"no": "fixture"}):
            env = deps._environment(stage)
        self.assertNotIn("HTTP_PROXY", env)
        self.assertNotIn("HTTPS_PROXY", env)
        self.assertEqual(env["NO_PROXY"], "fixture")

    def test_https_registry_does_not_fall_back_to_explicitly_disabled_https_proxy(self):
        stage = self.root / "stage"
        stage.mkdir()
        with (patch.dict(os.environ, {"HTTPS_PROXY": "", "HTTP_PROXY": "http://fixture:9001"}),
              patch.object(deps.managed_agent_network, "_proxies",
                           return_value={"http": "http://fixture:9001"})):
            env = deps._environment(stage)
        for name in ("NPM_CONFIG_PROXY", "NPM_CONFIG_HTTPS_PROXY", "HTTP_PROXY", "HTTPS_PROXY"):
            self.assertNotIn(name, env)

    def test_http_registry_uses_http_proxy_even_when_https_proxy_differs(self):
        stage = self.root / "stage"
        stage.mkdir()
        with (patch.dict(os.environ, {"NPM_CONFIG_REGISTRY": "http://127.0.0.1:9000/"}),
              patch.object(deps.managed_agent_network, "_proxies", return_value={
                  "http": "http://fixture:9001", "https": "http://fixture:9002"})):
            env = deps._environment(stage)
        self.assertEqual(env["NPM_CONFIG_PROXY"], "http://fixture:9001")
        self.assertEqual(env["NPM_CONFIG_HTTPS_PROXY"], "http://fixture:9001")

    def test_bootstrap_requires_marker_even_when_native_exits_zero(self):
        stage = self.root / "stage"
        stage.mkdir()
        proc = Mock(returncode=0)
        proc.poll.return_value = 0

        def spawn(*args, **kwargs):
            kwargs["stdout"].write(b'{"agent":{"unrelated":{}}}')
            kwargs["stdout"].flush()
            self.assertEqual(args[0], [str(self.binary), "debug", "config"])
            self.assertNotIn("model", json.loads(kwargs["env"]["OPENCODE_CONFIG_CONTENT"]))
            return proc

        with (patch.object(deps.subprocess, "Popen", side_effect=spawn),
              patch.object(deps, "_stop") as stop):
            with self.assertRaises(RuntimeError):
                deps._bootstrap(str(self.binary), VERSION, stage, Mock())
        stop.assert_called_once()

    def test_bootstrap_timeout_stops_its_owned_process(self):
        stage = self.root / "stage"
        stage.mkdir()
        proc = Mock(returncode=None)
        proc.poll.return_value = None
        with (patch.object(deps.subprocess, "Popen", return_value=proc),
              patch.object(deps, "TIMEOUT", 0), patch.object(deps, "_stop") as stop):
            with self.assertRaises(TimeoutError):
                deps._bootstrap(str(self.binary), VERSION, stage, Mock())
        stop.assert_called_once()

    def test_tree_cleanup_failure_still_closes_native_process(self):
        proc = Mock(pid=1234)
        proc.poll.return_value = None
        with (patch.object(deps.sys, "platform", "linux"),
              patch("app.services.linux_process_tree.kill_owned_tree", side_effect=OSError),
              patch.object(deps, "close_process") as close):
            with self.assertRaises(OSError):
                deps._stop(proc, [], None)
        close.assert_called_once_with(proc, [], None)

    def test_lock_paths_cannot_escape_the_managed_tree(self):
        tree(self.config)
        lock = self.config / "package-lock.json"
        value = json.loads(lock.read_text())
        value["packages"]["../private-secret"] = value["packages"]["node_modules/@opencode-ai/sdk"]
        lock.write_text(json.dumps(value))
        with self.assertRaises(RuntimeError):
            deps._validate(self.config, VERSION)


@unittest.skipUnless(os.environ.get("SODUWORK_TEST_OPENCODE_BIN"),
                     "Requires an explicitly selected installed OpenCode")
class OpenCodeDependenciesNativeTests(unittest.TestCase):
    def test_real_preparation_then_both_native_tool_loops_with_registry_unavailable(self):
        from app.services import acp_bridge
        from test_harness2_native_web import _WebFixture, Harness2NativeWebTests
        from test_opencode_native_config import OpenCodeNativeConfigTests

        binary = Path(os.environ["SODUWORK_TEST_OPENCODE_BIN"]).resolve()
        evidence = {}
        with tempfile.TemporaryDirectory(prefix="soduwork-prepared-native-") as directory:
            root = Path(directory)
            started = time.monotonic()
            deps.prepare(str(binary), VERSION, str(root / "runner"), lambda _message: None)
            evidence["prepare_seconds"] = round(time.monotonic() - started, 3)
            self.assertEqual(deps.issue(str(root / "runner"), VERSION), "")
            for runtime in ("harness2", "opencode"):
                fixture = _WebFixture()
                fixture.start()
                try:
                    work = root / runtime
                    work.mkdir()
                    (work / "unchanged.txt").write_bytes(b"Fixture stays unchanged.")
                    case = Harness2NativeWebTests()
                    case.fixture = fixture
                    native = OpenCodeNativeConfigTests()

                    def turn(mode, prompt, session=""):
                        env, _ = case.environment(root, work, fixture, binary, mode)
                        home = root / "empty-home"
                        home.mkdir(exist_ok=True)
                        env.update(HOME=str(home), USERPROFILE=str(home))
                        if runtime == "harness2":
                            return case.run_turn(work, env, prompt, session)
                        command = [sys.executable, str(Path(acp_bridge.__file__)),
                                   "--cwd", str(work), "--agent-name", "opencode",
                                   "--session", session, "--", str(binary), "acp"]
                        return native.run_turn(command, env)

                    started = time.monotonic()
                    first = turn("standard", "Fetch the local fixture weather.")
                    first_seconds = round(time.monotonic() - started, 3)
                    sid = case.session(first)
                    self.assertTrue(sid.startswith("ses_"))
                    case.assert_stream(first, "WEATHER-VERIFIED")
                    self.assertTrue(fixture.weather_in_history)
                    self.assertEqual(fixture.gets, ["/weather"])
                    self.assertEqual(len(fixture.grants), 1)
                    self.assertTrue(fixture.grants[0]["approved"])
                    fixture.next_phase("resume")
                    resumed = turn("standard", "Continue the same session.", sid)
                    self.assertEqual(case.session(resumed), sid)
                    self.assertTrue(fixture.reply_in_history)
                    case.assert_stream(resumed, "RESUME-VERIFIED")
                    fixture.next_phase("readonly")
                    readonly = turn("readonly", "Use webfetch only if permitted.", sid)
                    self.assertEqual(case.session(readonly), sid)
                    case.assert_stream(readonly, "READONLY-BLOCKED")
                    self.assertEqual(fixture.gets, ["/weather"])
                    self.assertEqual(fixture.applied, ["standard", "standard", "readonly"])
                    self.assertEqual(fixture.dependency_requests, 0)
                    self.assertFalse(fixture.bad_requests)
                    if runtime == "harness2":
                        execution = [row for row in fixture.calls if not row["auxiliary"]]
                        self.assertTrue(all(row["harness_identity"] for row in execution), fixture.calls)
                        self.assertFalse(any(row["executor_identity"] for row in execution), fixture.calls)
                    self.assertFalse((root / "refinement").exists())
                    self.assertEqual(deps.issue(str(root / "runner"), VERSION), "")
                    self.assertEqual(
                        {path.name: path.read_bytes() for path in work.rglob("*") if path.is_file()},
                        {"unchanged.txt": b"Fixture stays unchanged."})
                    evidence[runtime] = {
                        "first_turn_seconds": first_seconds,
                        "total_seconds": round(time.monotonic() - started, 3),
                        "main_calls": sum(not row["auxiliary"] for row in fixture.calls),
                        "title_calls": sum(row["auxiliary"] for row in fixture.calls),
                        "registry_requests": fixture.dependency_requests,
                        "weather_gets": len(fixture.gets), "native_session_resumed": True,
                        "readonly_blocked": True, "ready_afterwards": True,
                    }
                finally:
                    fixture.close()
        print("NATIVE_DEPENDENCY_EVIDENCE " + json.dumps(evidence, sort_keys=True))


if __name__ == "__main__":
    unittest.main()
