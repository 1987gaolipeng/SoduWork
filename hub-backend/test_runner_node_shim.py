"""Exercise the production shim with native PATH lookup, not `sh script`.

Import the standalone OS bootstrap helper so Linux package validation does not
need Hub/model dependencies merely to test the installed runtime's wrapper.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from app.services.runner_node import ensure_node_shim as ensure


@unittest.skipUnless(os.name == "nt", "Native cmd execution requires Windows")
class WindowsNodeShimTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-node-unicode-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        source = Path(__file__).resolve().parents[1] / "client/node_modules/electron/dist/electron.exe"
        if not source.is_file():
            source = Path(shutil.which("node") or "")
        self.assertTrue(source.is_file(), "Native verification needs source Electron or CI Node")
        self.bundled = self.root / "中文 runtime %SODUWORK_TEST_EXPAND% !SODUWORK_TEST_EXPAND!" / source.name
        self.bundled.parent.mkdir()
        shutil.copy2(source, self.bundled)
        for name in ("icudtl.dat", "v8_context_snapshot.bin", "snapshot_blob.bin"):
            if (source.parent / name).is_file():
                shutil.copy2(source.parent / name, self.bundled.parent / name)
        self.data = self.root / "数据目录 with spaces"
        self.environment = patch.dict(os.environ, {"SODUWORK_TEST_EXPAND": "must-not-expand"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        for key in ("NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"):
            os.environ.pop(key, None)
        self.cmd = str(Path(os.environ["SystemRoot"]) / "System32/cmd.exe")

    def tool_environment(self):
        from app.services.local_base import _env_for
        mounted = ensure(str(Path(self.cmd).parent), str(self.bundled), str(self.data),
                         which=lambda *_a, **_kw: None)
        # Use the production Agent/terminal environment builder. The launcher
        # must work in actual tool subprocesses, not just the Python parent.
        env = _env_for({"needs_llm": False}, {})
        env["PATH"] = mounted
        return env

    def run_cmd(self, command, env):
        # cmd parses shell quotes, not the C-runtime escaping used for list
        # arguments; these commands are fixed fixture text, never user input.
        return subprocess.run(f'"{self.cmd}" /d /v:on /c {command}', env=env,
                              cwd=self.root, capture_output=True, timeout=30,
                              creationflags=subprocess.CREATE_NO_WINDOW)

    def test_unicode_runtime_and_arguments_work_without_changing_codepage(self):
        env = self.tool_environment()
        javascript = "console.log(JSON.stringify([process.env.ELECTRON_RUN_AS_NODE,process.argv[1]]))"
        for page in (437, 936, 65001):
            with self.subTest(codepage=page):
                result = self.run_cmd(
                    f'chcp {page} >nul & call node -e "{javascript}" "two words 中文" & chcp', env)
                self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
                lines = result.stdout.splitlines()
                self.assertTrue(lines and lines[0].startswith(b"["), (result.stdout, result.stderr))
                self.assertEqual(json.loads(lines[0]), ["1", "two words 中文"])
                self.assertTrue(lines[-1].rstrip().endswith(str(page).encode()), lines)

    def test_cmd_wrapper_preserves_nonzero_exit_status(self):
        result = self.run_cmd('node -e "process.exit(37)"', self.tool_environment())
        self.assertEqual(result.returncode, 37, result.stderr.decode("utf-8", "replace"))

    def test_unwritable_shim_does_not_change_path_or_publish_runtime(self):
        previous = os.environ.get("SODUWORK_NODE_SHIM_EXECUTABLE")
        with patch("app.services.runner_node.os.makedirs", side_effect=PermissionError("fixture denied")):
            self.assertEqual(ensure("original-path", str(self.bundled), str(self.data),
                                    which=lambda *_a, **_kw: None), "original-path")
        self.assertEqual(os.environ.get("SODUWORK_NODE_SHIM_EXECUTABLE"), previous)


@unittest.skipIf(os.name == "nt", "POSIX execution bits require a native POSIX filesystem")
class NodeShimTests(unittest.TestCase):
    def test_direct_path_execution_and_existing_permissions_repair(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Native Linux verification requires a real Node executable")
        with tempfile.TemporaryDirectory(prefix="soduwork-node-permissions-") as root:
            bundled = Path(root) / "中文 runtime" / "node"
            bundled.parent.mkdir()
            bundled.symlink_to(node)
            configured = dict(which=lambda *_a, **_kw: None, node_major=lambda _: 24)
            mounted = ensure("", str(bundled), root, **configured)
            shim = Path(root) / "node-shim" / "node"
            for repair in (False, True):
                if repair:
                    shim.chmod(0o644)
                    self.assertIsNone(shutil.which("node", path=str(shim.parent)))
                    mounted = ensure(mounted, str(bundled), root, **configured)
                self.assertEqual(shutil.which("node", path=mounted), str(shim))
                self.assertEqual(shim.stat().st_mode & 0o777, 0o700)
                result = subprocess.run(["node", "-e",
                    "console.log(process.env.ELECTRON_RUN_AS_NODE, process.argv[1])", "two words 中文"],
                    env={**os.environ, "PATH": mounted}, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), "1 two words 中文")

    def test_usable_system_node_does_not_create_or_override_shim(self):
        node = shutil.which("node")
        self.assertIsNotNone(node)
        with tempfile.TemporaryDirectory(prefix="soduwork-node-existing-") as root:
            original = str(Path(node).parent)
            self.assertEqual(ensure(original, node, root, node_major=lambda _: 24), original)
            self.assertFalse((Path(root) / "node-shim").exists())


if __name__ == "__main__":
    unittest.main()
