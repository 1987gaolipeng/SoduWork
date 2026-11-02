"""Runner version probing regression without real accounts, models or installs."""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

from app.services import agent_setup, agent_setup_runtime, agent_version_probe


class VersionProbeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-version-probe-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.executable = self.root / "agent.exe"
        self.executable.write_bytes(b"test executable")

    def probe(self, run, **options):
        return agent_version_probe.probe(str(self.executable), ["--version"], run=run, **options)

    def test_first_probe_runs_once_and_repeated_probe_reuses_success(self):
        run = Mock(return_value="Agent 1.2.3")
        self.assertEqual(self.probe(run), "Agent 1.2.3")
        self.assertEqual(self.probe(run), "Agent 1.2.3")
        run.assert_called_once_with(str(self.executable), ["--version"], timeout=15)

    def test_executable_and_package_updates_invalidate_success(self):
        package = self.root / "package.json"
        package.write_text('{"version":"1"}', encoding="utf-8")
        run = Mock(side_effect=["one", "two", "three", "four"])
        self.assertEqual(self.probe(run, files=[str(package)]), "one")
        self.executable.write_bytes(b"a replacement executable with new metadata")
        self.assertEqual(self.probe(run, files=[str(package)]), "two")
        package.write_text('{"version":"2.0.0"}', encoding="utf-8")
        self.assertEqual(self.probe(run, files=[str(package)]), "three")
        package.unlink()
        self.assertEqual(self.probe(run, files=[str(package)]), "four")
        self.assertEqual(run.call_count, 4)

    def test_interpreter_script_and_environment_changes_invalidate(self):
        script = self.root / "cli.js"
        script.write_text("version one", encoding="utf-8")
        run = Mock(side_effect=["one", "two", "three"])
        def invoke():
            return agent_version_probe.probe(str(self.executable), [str(script), "--version"], run=run)
        with patch.dict(os.environ, {"SODUWORK_VERSION_TEST_CONTEXT": "first"}):
            self.assertEqual(invoke(), "one")
            script.write_text("updated version script", encoding="utf-8")
            self.assertEqual(invoke(), "two")
        with patch.dict(os.environ, {"SODUWORK_VERSION_TEST_CONTEXT": "second"}):
            self.assertEqual(invoke(), "three")
        self.assertEqual(run.call_count, 3)

    def test_failure_and_exception_do_not_poison_later_attempts(self):
        run = Mock(side_effect=["", RuntimeError("cannot start"), "1.0.0"])
        self.assertEqual(self.probe(run), "")
        self.assertEqual(self.probe(run), "")
        self.assertEqual(self.probe(run), "1.0.0")
        self.assertEqual(self.probe(run), "1.0.0")
        self.assertEqual(run.call_count, 3)

    def test_success_cache_expires(self):
        run = Mock(return_value="1.0.0")
        with patch.object(agent_version_probe, "TTL_SECONDS", 0):
            self.probe(run)
            self.probe(run)
        self.assertEqual(run.call_count, 2)

    def test_concurrent_runner_threads_share_one_probe(self):
        gate = threading.Event()
        started = threading.Event()
        barrier = threading.Barrier(8)
        def slow(*_args, **_kwargs):
            started.set()
            self.assertTrue(gate.wait(3))
            return "1.0.0"
        run = Mock(side_effect=slow)
        def invoke():
            barrier.wait(timeout=3)
            return self.probe(run)
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(invoke) for _ in range(8)]
            try:
                self.assertTrue(started.wait(3))
                self.assertEqual(run.call_count, 1)
            finally:
                gate.set()
            self.assertEqual([job.result(timeout=3) for job in futures], ["1.0.0"] * 8)
        self.assertEqual(run.call_count, 1)

    def test_replacement_while_probing_does_not_cache_old_result(self):
        calls = 0
        def run(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                self.executable.write_bytes(b"replaced while checking")
            return "1.0.0"
        self.probe(run)
        self.probe(run)
        self.assertEqual(calls, 2)

    def test_registered_agent_version_path_uses_cache_but_detect_rechecks_auth(self):
        spec = {"installer": "managed", "pkg": "fixture-agent"}
        profile = {"name": "Fixture", "needs_llm": False, "bin": lambda: str(self.executable)}
        with (patch.dict(agent_setup._SPECS, {"version-fixture": spec}),
              patch.dict(agent_setup._PROFILES, {"version-fixture": profile}),
              patch.object(agent_setup, "_npm_root", return_value=str(self.root)),
              patch.object(agent_setup, "_runtime_issue", return_value=""),
              patch.object(agent_setup.managed_agents, "managed_binary", return_value=""),
              patch.object(agent_setup, "_short", return_value="1.0.0") as run,
              patch.object(agent_setup, "_auth_probe", side_effect=[("unauthed", "login required"),
                                                                     ("authed", "account ready")]) as auth):
            first = agent_setup.detect("version-fixture", probes={})
            second = agent_setup.detect("version-fixture", probes={})
            self.assertEqual(first["version"], "1.0.0")
            self.assertEqual(second["version"], "1.0.0")
            self.assertEqual(first["state"], "unauthed")
            self.assertEqual(second["state"], "ready")
            self.assertEqual(run.call_count, 1)
            self.assertEqual(auth.call_count, 2)

    def test_new_package_metadata_overrides_cached_cli_fallback_immediately(self):
        package = self.root / "fixture-agent" / "package.json"
        spec = {"installer": "npm", "pkg": "fixture-agent"}
        profile = {"bin": lambda: str(self.executable), "argv_prefix": lambda: []}
        with (patch.dict(agent_setup._SPECS, {"version-fixture": spec}),
              patch.dict(agent_setup._PROFILES, {"version-fixture": profile}),
              patch.object(agent_setup, "_npm_root", return_value=str(self.root)),
              patch.object(agent_setup, "_short", return_value="1.0.0") as run):
            self.assertEqual(agent_setup._version_of("version-fixture")[0], "1.0.0")
            self.assertEqual(agent_setup._version_of("version-fixture")[0], "1.0.0")
            package.parent.mkdir()
            package.write_text('{"version":"2.0.0"}', encoding="utf-8")
            self.assertEqual(agent_setup._version_of("version-fixture"), ("2.0.0", "pkg", ""))
            self.assertEqual(run.call_count, 1)

    def test_real_version_process_requires_successful_exit(self):
        # Real local interpreter processes prove nonzero diagnostic output can
        # never become a successful cached version. No credentials or network.
        self.assertEqual(agent_setup_runtime._short(sys.executable,
            ["-c", "print('1.2.3')"]), "1.2.3")
        self.assertEqual(agent_setup_runtime._short(sys.executable,
            ["-c", "import sys; print('fatal startup error'); sys.exit(3)"]), "")

    def test_real_version_stdout_wins_over_an_earlier_stderr_warning(self):
        source = ("import sys; "
                  "print('WARNING: the isolated account directory does not exist', file=sys.stderr, flush=True); "
                  "print('codex-cli 0.165.0', flush=True)")
        self.assertEqual(agent_setup_runtime._short(sys.executable, ["-c", source]), "codex-cli 0.165.0")

    def test_real_stderr_only_version_stays_supported_without_accepting_failed_exit(self):
        for code in (0, 3):
            with self.subTest(code=code):
                source = "import sys; print('Agent 1.2.3', file=sys.stderr); sys.exit(" + str(code) + ")"
                self.assertEqual(agent_setup_runtime._short(sys.executable, ["-c", source]),
                                 "Agent 1.2.3" if code == 0 else "")

    def test_real_version_probe_drains_both_output_pipes(self):
        # More than a pipe buffer of diagnostics must not block stdout or timeout.
        source = "import sys; sys.stderr.write('warning\\n' * 16384); print('Agent 1.2.3')"
        self.assertEqual(agent_setup_runtime._short(sys.executable, ["-c", source]), "Agent 1.2.3")


if __name__ == "__main__":
    unittest.main()
