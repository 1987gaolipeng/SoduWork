"""Platform contract checks on one host, without native builds or downloads."""
from __future__ import annotations

import os
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch


class RunnerPlatformContractTests(unittest.TestCase):

    def test_shared_executor_selects_native_artifacts_and_cpu_variants(self):
        from app.services import managed_agents
        cases = [
            ("Windows", "AMD64", True, False, "opencode-windows-x64.zip"),
            ("Windows", "AMD64", False, False, "opencode-windows-x64-baseline.zip"),
            ("Darwin", "arm64", True, False, "opencode-darwin-arm64.zip"),
            ("Darwin", "x86_64", True, False, "opencode-darwin-x64.zip"),
            ("Darwin", "x86_64", False, False, "opencode-darwin-x64-baseline.zip"),
            ("Linux", "x86_64", True, False, "opencode-linux-x64.tar.gz"),
            ("Linux", "x86_64", False, False, "opencode-linux-x64-baseline.tar.gz"),
            ("Linux", "x86_64", False, True, "opencode-linux-x64-baseline-musl.tar.gz"),
            ("Linux", "aarch64", True, False, "opencode-linux-arm64.tar.gz"),
        ]
        for system, machine, avx2, musl, expected in cases:
            with self.subTest(system=system, machine=machine, avx2=avx2, musl=musl):
                with (patch.object(managed_agents.platform, "system", return_value=system),
                      patch.object(managed_agents.platform, "machine", return_value=machine),
                      patch.object(managed_agents, "_has_avx2", return_value=avx2),
                      patch.object(managed_agents, "_is_musl", return_value=musl)):
                    filename, digest = managed_agents.OPENCODE_ARTIFACTS[managed_agents.platform_key()]
                self.assertEqual(filename, expected)
                self.assertRegex(digest, r"^[a-f0-9]{64}$")

    def test_python_notice_override_refuses_unreviewed_dependency_versions(self):
        backend = Path(__file__).resolve().parent
        with patch.dict(os.environ, {"SODUWORK_INTERNAL_BUILD": "1"}), patch("importlib.metadata.version", return_value="unreviewed-fixture-version"):
            with self.assertRaisesRegex(RuntimeError, "Review original Python notice"):
                runpy.run_path(str(backend / "runner.spec"), init_globals={"SPECPATH": str(backend)})

    def test_public_runner_build_is_blocked_by_source_only_distribution_scope(self):
        backend = Path(__file__).resolve().parent
        original_read = Path.read_text
        profile = backend.parent / "tools/distribution/PUBLIC-SOURCE.json"
        def read_fixture(path, *args, **kwargs):
            if path == profile:
                return '{"sourceOnly": true}'
            return original_read(path, *args, **kwargs)
        # Exercise the negative gate even after a future reviewed binary release.
        with patch.dict(os.environ, {"SODUWORK_INTERNAL_BUILD": ""}), patch.object(Path, "read_text", read_fixture):
            with self.assertRaisesRegex(RuntimeError, "Public Runner distribution is blocked"):
                runpy.run_path(str(backend / "runner.spec"), init_globals={"SPECPATH": str(backend)})

    def test_all_runner_recipes_include_active_modules_native_trust_and_original_notices(self):
        from app.services import runner_sources
        # Replace installed-distribution metadata discovery only; execute the
        # production recipe and inspect its resulting PyInstaller arguments.
        import PyInstaller.utils.hooks as hooks
        def data_files(name, **kwargs):
            self.assertNotEqual(name, "certifi", "Runner must use the installed OS trust")
            return []
        from packaging.markers import default_environment
        # packaging caches the host environment. Supply each fixture target
        # explicitly, without poisoning later checks with the first mocked OS.
        marker_environment = default_environment()
        backend = Path(__file__).resolve().parent
        project = backend.parent
        import json
        reviewed_versions = {row["name"]: row["version"] for row in json.loads(
            (project / "third-party/manifest.json").read_text(encoding="utf-8"))["pythonNoticeOverrides"]}
        required = {
            "app/services/darwin_process_tree.py", "app/services/linux_process_tree.py",
            "app/agent_catalog.json",
        }
        for platform in ("win32", "darwin", "linux"):
            with self.subTest(platform=platform):
                captured = {}
                class Analysis:
                    def __init__(self, *_args, **kwargs):
                        captured.update(kwargs)
                        self.pure = self.scripts = self.binaries = self.datas = []
                with (patch.object(runner_sources.sys, "platform", platform),
                      patch("packaging.markers.default_environment", return_value={
                          **marker_environment, "sys_platform": platform,
                          "os_name": "nt" if platform == "win32" else "posix",
                          "platform_system": {"win32": "Windows", "darwin": "Darwin", "linux": "Linux"}[platform]}),
                      patch.dict(os.environ, {"SODUWORK_INTERNAL_BUILD": "1"}),
                      patch("importlib.metadata.version", side_effect=reviewed_versions.__getitem__),
                      patch.object(hooks, "copy_metadata", return_value=[]),
                      patch.object(hooks, "collect_data_files", side_effect=data_files),
                      patch.object(hooks, "collect_dynamic_libs", return_value=[])):
                    runpy.run_path(str(backend / "runner.spec"), init_globals={
                        "SPECPATH": str(backend), "Analysis": Analysis,
                        "PYZ": lambda *_a, **_k: None, "EXE": lambda *_a, **_k: None,
                    })
                    inputs = {path.relative_to(backend).as_posix()
                              for path in runner_sources.build_inputs(backend, project)
                              if path.is_relative_to(backend)}
                self.assertTrue(required.issubset(inputs), sorted(required - inputs))
                native = {"win32": "truststore._windows", "darwin": "truststore._macos",
                          "linux": "truststore._openssl"}[platform]
                self.assertIn(native, captured["hiddenimports"])
                retired = ("harness2", "claude_runtime", "agent_native_install")
                self.assertFalse(any(any(name in path for name in retired) for path in inputs))
                self.assertFalse(any(any(name in module for name in retired)
                                     for module in captured["hiddenimports"]))
                self.assertFalse(any(part.startswith("harness2") for entry in captured["datas"]
                                     for path in entry for part in Path(path).parts))
                self.assertIn((str(backend / "app/agent_catalog.json"), "app"), captured["datas"])
                original = project / "third-party/licenses/dnspython-LICENSE.txt"
                self.assertIn((str(original), "third-party/python/dnspython-2.9.0"), captured["datas"])


if __name__ == "__main__":
    unittest.main()
