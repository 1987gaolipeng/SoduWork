"""Installation cannot succeed before native plugin dependencies are ready."""
from __future__ import annotations

from contextlib import ExitStack, contextmanager
from pathlib import Path
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from app.services import managed_agents


class InstallReadinessTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.root = self.directory / "agents" / "opencode"
        self.stack.enter_context(patch.object(managed_agents, "_root", return_value=self.root))
        self.stack.enter_context(patch.object(managed_agents, "_cpu_compatibility_issue", return_value=""))
        self.stack.enter_context(patch.object(managed_agents, "platform_key", return_value="windows-x64"))
        self.version = managed_agents.OPENCODE_VERSION
        self.target = self.root / self.version / managed_agents._binary_name()

    def test_existing_binary_repairs_dependencies_before_activation(self):
        order = []
        @contextmanager
        def prepare(*_args):
            order.append("dependencies")
            yield
        with (patch.object(managed_agents, "binary_version", return_value=self.version),
              patch.object(managed_agents, "_prepare_dependencies", side_effect=prepare),
              patch.object(managed_agents, "_activate", side_effect=lambda *_: order.append("activate"))):
            ok, _ = managed_agents.install("install", lambda _: None)
        self.assertTrue(ok)
        self.assertEqual(order, ["dependencies", "activate"])

    def test_existing_binary_dependency_failure_is_not_success(self):
        with (patch.object(managed_agents, "binary_version", return_value=self.version),
              patch.object(managed_agents, "_prepare_dependencies", side_effect=RuntimeError("not ready")),
              patch.object(managed_agents, "_activate") as activate):
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                managed_agents.install("update", lambda _: None)
        activate.assert_not_called()

    def test_new_binary_dependency_failure_preserves_active_installation(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b"previous executable")
        managed_agents._activate(self.version)
        active_before = managed_agents._active_file().read_bytes()
        with (patch.object(managed_agents, "binary_version", side_effect=["old", "old", self.version]),
              patch.object(managed_agents, "_download"),
              patch.object(managed_agents, "_extract_binary",
                           side_effect=lambda _, path: path.write_bytes(b"candidate")),
              patch.object(managed_agents, "_prepare_dependencies", side_effect=RuntimeError("not ready"))):
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                managed_agents.install("update", lambda _: None)
        self.assertEqual(self.target.read_bytes(), b"previous executable")
        self.assertEqual(managed_agents._active_file().read_bytes(), active_before)
        self.assertEqual(list(self.root.glob(".staging-*")), [])

    def test_check_is_read_only_and_reports_incomplete_dependencies(self):
        with (patch.object(managed_agents, "binary_version", return_value=self.version),
              patch.object(managed_agents, "runtime_issue", return_value="执行组件依赖未就绪"),
              patch.object(managed_agents, "_prepare_dependencies") as prepare,
              patch.object(managed_agents, "_activate") as activate):
            ok, detail = managed_agents.install("check", lambda _: None)
        self.assertFalse(ok)
        self.assertIn("依赖未就绪", detail)
        prepare.assert_not_called()
        activate.assert_not_called()

    def test_uninstall_never_prepares_dependencies(self):
        with (patch.object(managed_agents, "binary_version", return_value=self.version),
              patch.object(managed_agents, "_prepare_dependencies") as prepare,
              patch.object(managed_agents, "_remove_managed", return_value=(True, "removed"))):
            self.assertEqual(managed_agents.install("uninstall", lambda _: None), (True, "removed"))
        prepare.assert_not_called()

    def test_global_installation_does_not_acquire_managed_prerequisites(self):
        with patch.object(managed_agents, "managed_binary", return_value=""):
            self.assertEqual(managed_agents.runtime_issue(), "")

    def test_failed_upgrade_checks_retained_active_version_not_install_target(self):
        old_version = "1.18.17"
        old_binary = self.root / old_version / managed_agents._binary_name()
        old_binary.parent.mkdir(parents=True)
        old_binary.write_bytes(b"old executable")
        managed_agents._activate(old_version)
        check = Mock(return_value="")
        with (patch.object(managed_agents, "binary_version",
                           side_effect=[old_version, "", self.version]),
              patch.object(managed_agents, "_download"),
              patch.object(managed_agents, "_extract_binary",
                           side_effect=lambda _, path: path.write_bytes(b"candidate")),
              patch.object(managed_agents, "_prepare_dependencies", side_effect=RuntimeError("not ready")),
              patch.dict(sys.modules, {"app.services.opencode_dependencies": SimpleNamespace(issue=check)})):
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                managed_agents.install("update", lambda _: None)
            self.assertEqual(managed_agents.runtime_issue(), "")
        check.assert_called_once_with(str(self.directory), old_version)
        self.assertEqual(managed_agents.managed_binary(), str(old_binary))

    def test_activation_failure_rolls_back_binary_and_dependency_transaction(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b"old executable")
        managed_agents._activate(self.version)
        active_before = managed_agents._active_file().read_bytes()
        events = []

        @contextmanager
        def prepare(*_args):
            events.append("prepared")
            try:
                yield
            except Exception:
                events.append("rolled back")
                raise
            else:
                events.append("committed")

        with (patch.object(managed_agents, "binary_version", side_effect=["old", "old", self.version]),
              patch.object(managed_agents, "_download"),
              patch.object(managed_agents, "_extract_binary",
                           side_effect=lambda _, path: path.write_bytes(b"candidate")),
              patch.object(managed_agents, "_prepare_dependencies", side_effect=prepare),
              patch.object(managed_agents, "_activate", side_effect=OSError("fixture disk error"))):
            with self.assertRaisesRegex(OSError, "fixture disk error"):
                managed_agents.install("update", lambda _: None)
        self.assertEqual(self.target.read_bytes(), b"old executable")
        self.assertEqual(managed_agents._active_file().read_bytes(), active_before)
        self.assertEqual(events, ["prepared", "rolled back"])
        self.assertEqual(list(self.root.glob(".staging-*")), [])


if __name__ == "__main__":
    unittest.main()
