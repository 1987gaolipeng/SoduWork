"""Isolated concrete permission scope and host-tool execution regression."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from app.services import access_scope as scope, acp_access
from app.services.acp_bridge import AcpBridge

class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-scope-")
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.work.mkdir()
        for name in ("report.txt", "report name.txt", "AGENTS.md", "SKILL.md", ".env"):
            (self.work / name).write_text("needle fixture", encoding="utf-8")
        (self.root / "outside.txt").write_text("outside", encoding="utf-8")
        # Junctions work without Developer Mode on Windows.
        if os.name == "nt":
            import subprocess
            subprocess.run(["cmd", "/c", "mklink", "/J", str(self.work / "link"), str(self.root)],
                           check=True, stdout=subprocess.DEVNULL, creationflags=0x08000000)
        else:
            (self.work / "link").symlink_to(self.root, target_is_directory=True)
        self.policy = {"mode": "standard", "workspaceRoot": str(self.work)}
        self.raw = json.dumps({"url": "http://127.0.0.1:1", "token": "fixture-only", "policy": self.policy})
        self.access = acp_access.BridgeAccess(self.raw)
        self.requests = []
        self.access.call = lambda path, value: self.requests.append((path, value)) or {"decision": "deny"}

    def tearDown(self):
        # Break the loop before recursive temp cleanup.
        if os.name == "nt":
            os.rmdir(self.work / "link")
        else:
            (self.work / "link").unlink()
        self.temp.cleanup()

    def test_shared_literal_query_corpus(self):
        corpus = Path(__file__).resolve().parent.parent / "client/tests/fixtures/access-query-cases.json"
        for row in json.loads(corpus.read_text(encoding="utf-8")):
            with self.subTest(command=row["command"]):
                self.assertEqual(scope.automatic_query(str(self.work), row["command"]), row["allow"])
        self.assertFalse(scope.automatic_query(str(self.work), "pwd", env=[{"name": "PATH", "value": "."}]))

    def native(self, kind, raw, locations=None):
        return self.access.native_permission({"toolCall": {
            "toolCallId": "isolated", "kind": kind, "rawInput": raw, "locations": locations or []}})

    def test_native_concrete_edits_and_instruction_reads_are_automatic(self):
        for key in ("path", "file_path", "filePath"):
            self.assertTrue(self.native("edit", {key: "report.txt", "oldString": "fixture", "newString": "updated"}))
            self.assertTrue(self.native("read", {key: str(self.work / "AGENTS.md")}))
        self.assertEqual(self.requests, [])

    def test_native_sensitive_escape_unknown_input_and_multipath_still_wait(self):
        for filename in (".env", ".ENV", ".ssh/id_rsa", "../outside.txt", "link/outside.txt"):
            self.assertFalse(self.native("read", {"path": filename}))
        self.assertFalse(self.native("edit", {"path": "SKILL.md", "content": "change"}))
        self.assertFalse(self.native("edit", {"path": "report.txt", "command": "run-malicious"}))
        self.assertFalse(self.native("edit", {"path": "report.txt"},
                                     [{"path": str(self.root / "outside.txt")}]))
        self.assertFalse(self.native("execute", {"command": "cat report.txt"}))
        self.assertEqual(len(self.requests), 9)

    def test_host_path_checks_sensitive_files_with_real_operations(self):
        with patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": self.raw}):
            bridge = AcpBridge([], str(self.work), "qwen", "workspace", allow_terminal=True)
        bridge.access = self.access
        try:
            bridge._write_text_file({"path": str(self.work / "new.txt"), "content": "new content"})
            self.assertEqual((self.work / "new.txt").read_text(), "new content")
            self.assertEqual(bridge._read_text_file({"path": str(self.work / "AGENTS.md")})["content"], "needle fixture")
            self.assertEqual(self.requests, [])
            with self.assertRaises(acp_access.AccessError):
                bridge._read_text_file({"path": str(self.work / ".env")})
            with self.assertRaises(acp_access.AccessError):
                bridge._write_text_file({"path": str(self.work / "AGENTS.md"), "content": "changed"})
            self.assertEqual((self.work / "AGENTS.md").read_text(), "needle fixture")
        finally:
            bridge.close()

    def test_host_safe_terminal_uses_absolute_trusted_binary_without_a_shell(self):
        with patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": self.raw}):
            bridge = AcpBridge([], str(self.work), "qwen", "workspace", allow_terminal=True)
        bridge.access = self.access
        try:
            result = bridge._terminal_create({"command": "cat", "args": ["report.txt"], "cwd": str(self.work)})
            terminal = bridge._terminal(result)
            self.assertEqual(terminal.wait()["exitCode"], 0)
            self.assertEqual(self.requests, [])
            self.assertFalse(self.access.terminal_program("cat", ["report.txt"], str(self.work),
                                                          [{"name": "PATH", "value": "."}]))
        finally:
            bridge.close()

    def test_workspace_executable_is_never_used_for_automatic_queries(self):
        local = self.work / ("cat.exe" if os.name == "nt" else "cat")
        local.write_text("fake executable", encoding="utf-8")
        local.chmod(0o755)
        with patch.dict(os.environ, {"PATH": str(self.work) + os.pathsep + os.environ.get("PATH", "")}):
            resolved = scope.trusted_program("cat", str(self.work))
            self.assertTrue(resolved)
            self.assertNotEqual(os.path.normcase(resolved), os.path.normcase(str(local)))

    def test_host_rg_excludes_secrets_links_and_ignores_external_configuration(self):
        (self.work / "report.txt").write_text("needle PUBLIC_REPORT", encoding="utf-8")
        (self.work / ".ENV.local").write_text("needle PRIVATE_ENV", encoding="utf-8")
        (self.work / "auth.json").write_text("needle PRIVATE_AUTH", encoding="utf-8")
        (self.root / "outside.txt").write_text("needle PRIVATE_OUTSIDE", encoding="utf-8")
        config = self.root / "ripgrep-config"
        config.write_text("--glob=*.missing", encoding="utf-8")
        with patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": self.raw, "RIPGREP_CONFIG_PATH": str(config)}):
            bridge = AcpBridge([], str(self.work), "qwen", "workspace", allow_terminal=True)
            bridge.access = self.access
            try:
                result = bridge._terminal_create({"command": "rg", "args": ["--hidden", "-n", "needle|missing", "."], "cwd": str(self.work)})
                terminal = bridge._terminal(result)
                self.assertEqual(terminal.wait()["exitCode"], 0)
                output = terminal.output()[0]
                self.assertIn("PUBLIC_REPORT", output)
                self.assertNotIn("PRIVATE_", output)
                self.assertEqual(self.requests, [])
            finally:
                bridge.close()

    def test_opencode_metadata_only_workspace_reads_use_bound_live_paths(self):
        self.access.agent_name = "opencode"
        event = {"sessionUpdate": "tool_call", "toolCallId": "bound-read", "kind": "read", "status": "pending",
                 "rawInput": {"filePath": str(self.work / "report.txt")}}
        read = {"toolCall": {"toolCallId": "bound-read", "kind": "read", "rawInput": {}, "locations": []}}
        self.access.observe_tool(event)
        self.assertTrue(self.access.native_permission(read))
        self.assertEqual(self.requests, [])
        self.access.observe_tool({**event, "rawInput": {"filePath": str(self.work / ".env")}})
        self.assertFalse(self.access.native_permission(read))
        self.access.observe_tool(event)
        self.access.observe_tool({**event, "status": "completed"})
        self.assertFalse(self.access.native_permission(read))

    def test_readonly_and_full_maps_preserve_semantics_and_standard_does_not_override_file_guards(self):
        self.assertEqual(acp_access.opencode_permissions("readonly")["*"], "deny")
        self.assertEqual(acp_access.opencode_permissions("full")["*"], "allow")
        rules = acp_access.opencode_permissions("standard")
        for name in ("read", "edit", "grep", "bash", "external_directory"):
            self.assertEqual(rules[name], "ask")
        self.access.mode = "readonly"
        self.assertFalse(self.native("edit", {"path": "report.txt", "content": "bad"}))
        self.assertEqual(self.access.terminal_program("pwd", [], str(self.work), []), "")

if __name__ == "__main__":
    unittest.main()
