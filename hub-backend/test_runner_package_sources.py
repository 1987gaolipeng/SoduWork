"""Isolated packaging checks: no local executable, database or user files used."""
import os
from pathlib import Path
import tempfile
import tarfile
import unittest
from unittest.mock import patch
import zipfile

# runner_enroll imports the model declarations; packaging tests never use a DB.
# Keep direct invocation isolated too, without overriding the quality gate URL.
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app.services import runner_enroll, runner_sources


class RunnerPackageSourcesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-runner-package-")
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name)
        self.backend = self.project / "hub-backend"
        self.backend.mkdir()
        self.cache = self.backend / "downloads" / "cache"
        self.binary = self.write("client/runner/soduwork-runner.exe", "fixture executable")
        self.write("hub-backend/runner.spec", "hidden = ['app.services.hidden']\n"
                   "a = Analysis([], hiddenimports=hidden, excludes=['app.db'])\n")
        self.write("hub-backend/runner_main.py", "from app.services import root\n")
        self.write("hub-backend/app/__init__.py", "")
        self.write("hub-backend/app/agent_catalog.json", '{"schemaVersion":1,"agents":[]}')
        self.write("hub-backend/app/services/__init__.py", "")
        self.write("hub-backend/app/services/root.py", "from . import child\nfrom .. import db\n")
        self.write("hub-backend/app/services/child.py", "value = 1\n")
        self.write("hub-backend/app/services/hidden.py", "from .child import value\n")
        self.write("hub-backend/app/db.py", "raise RuntimeError('must not be imported')\n")
        self.write("hub-backend/app/api/tasks.py", "raise RuntimeError('Hub only')\n")
        self.write("hub-backend/requirements-runner.txt", "websockets>=12\n")
        self.write("hub-backend/build-runner.ps1", "# build recipe\n")
        self.write("skills/example/SKILL.md", "# Bundled skill\n")
        for name, value in (("_PROJECT", self.project), ("_BACKEND", self.backend),
                            ("_CACHE", self.cache)):
            started = patch.object(runner_enroll, name, value)
            started.start()
            self.addCleanup(started.stop)

    def write(self, name, body):
        target = self.project / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
        return target

    def test_source_graph_covers_transitive_and_hidden_imports_and_resources(self):
        inputs = {str(path.relative_to(self.project)).replace("\\", "/")
                  for path in runner_sources.build_inputs(self.backend, self.project)}
        self.assertIn("hub-backend/app/services/child.py", inputs)
        self.assertIn("hub-backend/app/services/hidden.py", inputs)
        self.assertIn("hub-backend/app/__init__.py", inputs)
        self.assertIn("hub-backend/app/agent_catalog.json", inputs)
        self.assertIn("hub-backend/runner.spec", inputs)
        self.assertIn("hub-backend/requirements-runner.txt", inputs)
        self.assertIn("hub-backend/build-runner.ps1", inputs)
        self.assertIn("skills/example/SKILL.md", inputs)
        self.assertNotIn("hub-backend/app/db.py", inputs)
        self.assertNotIn("hub-backend/app/api/tasks.py", inputs)

    def test_source_graph_refreshes_changed_imports_without_restarting_hub(self):
        runner_sources.build_inputs(self.backend, self.project)
        added = self.write("hub-backend/app/services/new_dependency.py", "value = 2\n")
        self.write("hub-backend/app/services/child.py", "from .new_dependency import value\n")
        self.assertIn(added, runner_sources.build_inputs(self.backend, self.project))

    def test_agent_declaration_changes_require_a_fresh_runner(self):
        for source in runner_sources.build_inputs(self.backend, self.project):
            os.utime(source, (1000, 1000))
        os.utime(self.binary, (2000, 2000))
        os.utime(self.backend / "app/agent_catalog.json", (3000, 3000))
        runner_sources._STAMP_CACHE.clear()
        self.assertTrue(runner_enroll.packages_info()["windows"]["stale"])

    def test_dsh_adapter_resources_require_a_fresh_runner(self):
        for name in ("dsh_session_storage.mjs", "dsh_gateway_bundle/package.json",
                     "dsh_gateway_bundle/cordis.patch.yml"):
            with self.subTest(resource=name):
                source = self.write("hub-backend/app/services/" + name, "adapter fixture")
                inputs = runner_sources.build_inputs(self.backend, self.project)
                self.assertIn(source, inputs)
                for item in inputs:
                    os.utime(item, (1000, 1000))
                os.utime(self.binary, (2000, 2000))
                os.utime(source, (3000, 3000))
                runner_sources._STAMP_CACHE.clear()
                self.assertTrue(runner_enroll.packages_info()["windows"]["stale"])

    def test_harness2_notices_are_exported_and_invalidate_runner_freshness(self):
        for name in ("LICENSE", "UPSTREAM.md"):
            with self.subTest(resource=name):
                source = self.write("hub-backend/app/services/harness2_vendor/" + name, "upstream notice")
                inputs = runner_sources.build_inputs(self.backend, self.project)
                self.assertIn(source, inputs)
                self.assertIn(source, runner_enroll._src_sources())
                for item in inputs:
                    os.utime(item, (1000, 1000))
                os.utime(self.binary, (2000, 2000))
                os.utime(source, (3000, 3000))
                runner_sources._STAMP_CACHE.clear()
                self.assertTrue(runner_enroll.packages_info()["windows"]["stale"])

    def test_source_archive_refreshes_each_changed_dsh_resource(self):
        for name in ("dsh_session_storage.mjs", "dsh_gateway_bundle/package.json",
                     "dsh_gateway_bundle/cordis.patch.yml"):
            with self.subTest(resource=name):
                relative = "hub-backend/app/services/" + name
                source = self.write(relative, "original adapter fixture")
                archive_path = runner_enroll.source_package()
                source.write_text("updated adapter fixture", encoding="utf-8")
                future = archive_path.stat().st_mtime + 2
                os.utime(source, (future, future))
                with tarfile.open(runner_enroll.source_package(), "r:gz") as archive:
                    self.assertEqual(archive.extractfile(relative).read(), source.read_bytes())

    def test_recipe_is_parsed_without_execution(self):
        with (self.backend / "runner.spec").open("a", encoding="utf-8") as source:
            source.write("\nraise RuntimeError('recipe must not execute')\n")
        self.assertTrue(runner_sources.build_inputs(self.backend, self.project))

    def test_platform_specific_recipe_lists_do_not_break_package_information(self):
        self.write("hub-backend/runner.spec", "hidden = ['app.services.hidden']\n"
                   "a = Analysis([], excludes=['app.db'] + "
                   "([] if sys.platform == 'win32' else ['app.services.child']))\n")
        child = self.backend / "app/services/child.py"
        for platform, includes_child in (("win32", True), ("linux", False), ("darwin", False)):
            with self.subTest(platform=platform), patch.object(runner_sources.sys, "platform", platform):
                runner_sources._STAMP_CACHE.clear()
                inputs = runner_sources.build_inputs(self.backend, self.project)
                self.assertEqual(child in inputs, includes_child)
                self.assertTrue(runner_enroll.packages_info()["windows"]["buildable"])

    def test_current_repository_recipe_handles_all_packaging_platforms(self):
        recipe = Path(__file__).parent / "runner.spec"
        for platform in ("win32", "linux", "darwin"):
            with self.subTest(platform=platform), patch.object(runner_sources.sys, "platform", platform):
                hidden, excluded = runner_sources._recipe(recipe)
                self.assertIn("app.services.access_policy", hidden)
                self.assertIn("app.db", excluded)
                self.assertEqual("winpty" in excluded, platform != "win32")

    def test_recipe_expressions_cannot_execute_code(self):
        marker = self.project / "must-not-exist"
        self.write("hub-backend/runner.spec", "hidden = []\n"
                   "a = Analysis([], excludes=__import__('pathlib').Path(" + repr(str(marker)) + ").touch())\n")
        with self.assertRaises(ValueError):
            runner_sources.build_inputs(self.backend, self.project)
        self.assertFalse(marker.exists())

    def test_skill_build_resources_exclude_generated_caches_and_local_dependencies(self):
        for name in ("__pycache__/check.pyc", "node_modules/dependency/index.js", ".venv/private.py", "leftover.pyo"):
            self.write("skills/example/" + name, "must not be shipped")
        source = self.write("skills/example/scripts/check.py", "print('source')")
        files = runner_sources.skill_files(self.project)
        self.assertEqual(set(files), {source, self.project / "skills/example/SKILL.md"})

    def test_skill_license_and_provenance_survive_source_and_frozen_resource_selection(self):
        files = {"skills/example/LICENSE": "Copyright (c) Original author\nMIT permission fixture\n",
                 "skills/example/UPSTREAM.md": "Upstream: https://example.org/project/tree/fixed-revision\n"}
        for name, text in files.items():
            self.assertIn(self.write(name, text), runner_sources.skill_files(self.project))
        with tarfile.open(runner_enroll.source_package(), "r:gz") as archive:
            for name in files:
                self.assertEqual(archive.extractfile(name).read(), (self.project / name).read_bytes())

    def test_project_license_is_exported_and_refreshes_source_archive(self):
        license_path = self.write("LICENSE", "Original project license\n")
        archive_path = runner_enroll.source_package()
        with tarfile.open(archive_path, "r:gz") as archive:
            self.assertEqual(archive.extractfile("LICENSE").read(), license_path.read_bytes())
        license_path.write_text("Updated project license\n", encoding="utf-8")
        future = archive_path.stat().st_mtime + 2
        os.utime(license_path, (future, future))
        with tarfile.open(runner_enroll.source_package(), "r:gz") as archive:
            self.assertEqual(archive.extractfile("LICENSE").read(), license_path.read_bytes())

    def test_windows_package_excludes_obsolete_runtime_and_local_settings(self):
        self.write("client/runner/_internal/python.dll", "obsolete library")
        self.write("client/runner/runner.json", "local settings")
        result = runner_enroll.windows_package()
        with zipfile.ZipFile(result) as archive:
            self.assertEqual(archive.namelist(), ["soduwork-runner.exe"])
            self.assertEqual(archive.read("soduwork-runner.exe"), b"fixture executable")

    def test_legacy_future_dated_cache_is_rebuilt(self):
        self.cache.mkdir(parents=True)
        old = self.cache / "soduwork-runner-win.zip"
        with zipfile.ZipFile(old, "w") as archive:
            archive.writestr("soduwork-runner.exe", "old executable")
            archive.writestr("_internal/python.dll", "old runtime")
        os.utime(old, (self.binary.stat().st_mtime + 100, self.binary.stat().st_mtime + 100))
        self.assertEqual(runner_enroll.windows_package(), old)
        with zipfile.ZipFile(old) as archive:
            self.assertEqual(archive.namelist(), ["soduwork-runner.exe"])
            self.assertEqual(archive.read("soduwork-runner.exe"), b"fixture executable")

    def test_source_changes_mark_runner_stale_but_hub_only_changes_do_not(self):
        for source in runner_sources.build_inputs(self.backend, self.project):
            os.utime(source, (1000, 1000))
        os.utime(self.binary, (2000, 2000))
        os.utime(self.backend / "app/api/tasks.py", (3000, 3000))
        self.assertFalse(runner_enroll.packages_info()["windows"]["stale"])
        os.utime(self.backend / "app/services/child.py", (3000, 3000))
        runner_sources._STAMP_CACHE.clear()
        self.assertTrue(runner_enroll.packages_info()["windows"]["stale"])

    def test_inventory_refresh_reuses_advisory_stamp_for_thirty_seconds(self):
        with patch.object(runner_sources, "build_inputs", wraps=runner_sources.build_inputs) as scan:
            with patch.object(runner_sources.time, "monotonic", return_value=100):
                runner_enroll.packages_info()
                runner_enroll.packages_info()
            self.assertEqual(scan.call_count, 1)
            with patch.object(runner_sources.time, "monotonic", return_value=131):
                runner_enroll.packages_info()
            self.assertEqual(scan.call_count, 2)

    def test_admin_uploaded_package_still_takes_priority(self):
        ready = self.write("hub-backend/downloads/soduwork-runner-win.zip", "uploaded bundle")
        self.assertEqual(runner_enroll.windows_package(), ready)

    def test_no_generated_executable_is_reported_as_unavailable(self):
        self.binary.unlink()
        self.assertIsNone(runner_enroll.windows_package())
        self.assertFalse(runner_enroll.packages_info()["windows"]["buildable"])


if __name__ == "__main__":
    unittest.main()
