"""Other installed adapters' permission contracts, with real isolated IPC/HTTP.

Envelope evidence: OpenCode 1.18.21 compiled acp/permission + tool-call mappers;
Qwen Code 0.24.6 acpAgent/tool schemas; dsh-acp 0.4.26 bridge.js. Vendor requests
are fixture-generated, not real paid model turns; execution gates are production.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from app.services import access_broker, access_policy, local_base
from app.services.acp_access import BridgeAccess
from app.services.skill_read_scope import ReadScope

ROOT = Path(__file__).resolve().parent


class OtherPermissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-other-permissions-")
        self.addCleanup(self.temp.cleanup)
        # The real ACP bridge canonicalizes cwd. Pin the same spelling here:
        # Windows TEMP can use an 8.3 home alias while the native peer reports
        # its long path, and read grants deliberately verify both spellings.
        self.root = Path(self.temp.name).resolve()
        self.work = self.root / "work"
        self.work.mkdir()
        self.policy = access_policy.normalize({"schema": access_policy.SCHEMA, "mode": "standard",
                                              "revision": 1, "workspaceRoot": str(self.work)})
        self.requests = []

    def bridge_access(self, agent):
        bridge = BridgeAccess(json.dumps({"url": "http://127.0.0.1:1", "token": "fixture", "policy": self.policy}),
                              agent_name=agent)
        bridge.call = lambda path, row: self.requests.append(row) or {"decision": "deny"}
        return bridge

    def call(self, kind, args, **extra):
        return {"toolCall": {"toolCallId": "test-call", "kind": kind, "rawInput": args, **extra}}

    def live(self, bridge, kind, args, **extra):
        bridge.observe_tool({"sessionUpdate": "tool_call", "toolCallId": "test-call",
                             "kind": kind, "status": "pending", "rawInput": args, **extra})

    def test_opencode_empty_or_missing_read_inputs_use_only_same_live_call(self):
        bridge = self.bridge_access("opencode")
        self.live(bridge, "read", {"filePath": str(self.work / "source.txt")})
        for raw in ({}, None):
            self.assertTrue(bridge.native_permission(self.call("read", raw)))
        self.assertEqual(self.requests, [])
        self.assertFalse(bridge.native_permission(self.call("read", {}, toolCallId="other")))
        self.assertFalse(self.requests[-1]["allowSession"])
        bridge.observe_tool({"sessionUpdate": "tool_call_update", "toolCallId": "test-call", "status": "completed"})
        self.assertFalse(bridge.native_permission(self.call("read", {})))
        self.assertTrue(self.requests[-1]["arguments"]["inputUnavailable"])
        self.live(bridge, "read", {"filePath": str(self.work / "source.txt")})
        bridge.observe_tool({"sessionUpdate": "tool_call", "toolCallId": "test-call", "kind": "read"})
        self.assertFalse(bridge.native_permission(self.call("read", {})))
        self.live(bridge, "read", {"filePath": str(self.work / "source.txt")})
        bridge.observe_tool({"sessionUpdate": "tool_call_update", "toolCallId": "test-call", "kind": "execute"})
        self.assertFalse(bridge.native_permission(self.call("read", {})))

    def test_opencode_single_file_patch_is_automatic_but_every_target_is_checked(self):
        bridge = self.bridge_access("opencode")
        inside = str(self.work / "report.md")
        self.live(bridge, "edit", {"filePath": inside, "content": "new"})
        self.assertTrue(bridge.native_permission(self.call("edit", {"filepath": inside, "diff": "patch"})))
        self.assertEqual(self.requests, [])
        for args, locations in [({"filepath": str(self.root / "outside.md"), "diff": "patch"}, []),
                                ({"filepath": str(self.work / ".env"), "diff": "patch"}, []),
                                ({"filepath": inside, "diff": "patch", "files": [{"filePath": inside}]}, []),
                                ({"filepath": inside, "diff": "patch"}, [{"path": str(self.root / "outside.md")}]),
                                ({"filepath": inside, "diff": "patch", "unknownExecutionOption": True}, [])]:
            self.assertFalse(bridge.native_permission(self.call("edit", args, locations=locations)))
        bridge.mode = "readonly"
        self.assertFalse(bridge.native_permission(self.call("edit", {"filepath": inside, "diff": "patch"})))
        bridge.mode = "standard"
        self.live(bridge, "edit", {"filePath": inside}, locations=[{"path": str(self.root / "other.md")}])
        self.assertFalse(bridge.native_permission(self.call("edit", {"filepath": inside, "diff": "patch"},
                                                           locations=[{"path": inside}])))

    def test_opencode_restores_shell_execution_options_and_conflicts_cannot_reuse(self):
        bridge = self.bridge_access("opencode")
        self.live(bridge, "execute", {"command": "test", "workdir": str(self.root), "timeout": 999,
                                      "futureExecutionOption": "retained"})
        self.assertFalse(bridge.native_permission(self.call("execute", {"command": "test"})))
        row = self.requests[-1]
        self.assertEqual(row["tool"], "opencode.shell")
        self.assertEqual(row["arguments"]["workdir"], str(self.root))
        self.assertEqual(row["arguments"]["timeout"], 999)
        self.assertEqual(row["arguments"]["futureExecutionOption"], "retained")
        self.assertTrue(row["allowSession"])
        self.assertFalse(bridge.native_permission(self.call("execute", {"command": "different"})))
        self.assertFalse(self.requests[-1]["allowSession"])
        self.assertTrue(self.requests[-1]["arguments"]["inputIncomplete"])
        self.assertFalse(bridge.native_permission(self.call("execute", {"command": "test"}, toolCallId="unbound")))
        self.assertFalse(self.requests[-1]["allowSession"])

    def test_qwen_actual_read_and_write_options_and_selected_resource_scope(self):
        bridge = self.bridge_access("qwen")
        package = self.root / "selected-skill"
        package.mkdir()
        target = package / "guide.pdf"
        target.write_text("fixture")
        bridge.read_scope = ReadScope.capture([str(package)])
        self.assertTrue(bridge.native_permission(self.call("read", {"file_path": str(target), "pages": "1-3"},
                                                           _meta={"toolName": "read_file"})))
        self.assertTrue(bridge.native_permission(self.call("edit", {
            "file_path": str(self.work / "result.md"), "content": "result", "record_as_artifact": False},
            _meta={"toolName": "write_file"})))
        self.assertEqual(self.requests, [])
        self.assertFalse(bridge.native_permission(self.call("edit", {"file_path": str(target), "content": "changed", "record_as_artifact": False},
                                                            _meta={"toolName": "write_file"})))
        self.assertFalse(bridge.native_permission(self.call("read", {"file_path": str(target), "pages": "1"},
                                                           _meta={"toolName": "mcp__read_file"})))
        self.assertFalse(bridge.native_permission(self.call("read", {"file_path": str(package / "auth.json"), "pages": None},
                                                           _meta={"toolName": "read_file"})))

    def test_only_verified_native_shell_descriptions_are_excluded_from_grants(self):
        for agent in ("opencode", "qwen"):
            bridge = self.bridge_access(agent)
            args = {"command": "test", "description": "first", "timeout": 1000, "cwd": str(self.work)}
            self.live(bridge, "execute", args)
            bridge.native_permission(self.call("execute", args, title="first", _meta={"toolName": "run_shell_command"}))
            first = self.requests[-1]
            second = {**first, "title": "different", "arguments": {**first["arguments"], "description": "different"}}
            self.assertEqual(access_policy.operation_digest(first), access_policy.operation_digest(second))
            for key, value in (("command", "other"), ("cwd", str(self.root)), ("timeout", 999), ("is_background", True), ("unknown", True)):
                changed = {**second, "arguments": {**second["arguments"], key: value}}
                self.assertNotEqual(access_policy.operation_digest(first), access_policy.operation_digest(changed))
            mcp = {**first, "action": "native.tool", "tool": "mcp.shell"}
            self.assertNotEqual(access_policy.operation_digest(mcp), access_policy.operation_digest({**mcp, "arguments": second["arguments"]}))
        qwen = self.bridge_access("qwen")
        qwen.native_permission(self.call("execute", {"command": "test"}, _meta={"toolName": "mcp_shell"}))
        self.assertEqual(self.requests[-1]["action"], "native.tool")

    def test_dsh_id_only_permission_recovers_live_details(self):
        bridge = self.bridge_access("dsh")
        self.live(bridge, "execute", {"command": "precise command", "cwd": str(self.work)}, title="Execute")
        bridge.native_permission({"toolCall": {"toolCallId": "test-call"}})
        self.assertEqual(self.requests[-1]["arguments"]["command"], "precise command")
        bridge.observe_tool({"sessionUpdate": "tool_call_update", "toolCallId": "test-call", "status": "failed"})
        bridge.native_permission({"toolCall": {"toolCallId": "test-call"}})
        self.assertFalse(self.requests[-1]["allowSession"])
        for agent in ("unknown-runtime",):
            self.assertFalse(access_policy.capability(agent)["supported"])
            with self.assertRaises(access_policy.UnsupportedPolicyError):
                access_policy.prepare(agent, self.policy, str(self.work))

    def test_real_subprocess_native_envelopes_once_session_deny_and_readonly(self):
        # No native vendor process or model is contacted. This exercises the
        # actual bridge executable, policy apply, secret channel and disk gates.
        for agent in ("opencode", "qwen", "dsh"):
            for mode in ("standard", "readonly"):
                with self.subTest(agent=agent, mode=mode):
                    self.roundtrip(agent, mode)

    def roundtrip(self, agent, mode):
        work = self.root / (agent + "-" + mode)
        work.mkdir()
        (work / "source.txt").write_text("source")
        resource = self.root / "resources"
        resource.mkdir(exist_ok=True)
        (resource / "guide.md").write_text("selected resource")
        ref = "isolated-" + work.name
        policy = access_policy.normalize({**self.policy, "mode": mode, "workspaceRoot": str(work)})
        run = {"state": "running", "ws": str(work), "accessPolicy": policy, "cli": agent,
               "started": time.time(), "lines": [], "seq": 0,
               "_skillReadScope": ReadScope.capture([str(resource)])}
        env = {**os.environ, "SODUWORK_DATA_ROOT": str(self.root / "data"), "PYTHONDONTWRITEBYTECODE": "1"}
        with patch.dict(local_base._RUNS, {ref: run}), patch.object(local_base, "_STORE", str(self.root / "runs")):
            channel = access_broker.attach(ref, {"accessPolicy": policy, "local_cli": agent}, env)
            proc = None
            seen = []
            try:
                argv = [sys.executable, "-B", str(ROOT / "app/services/acp_bridge.py"), "--cwd", str(work),
                        "--agent-name", agent, "--permission", "workspace", "--", sys.executable, "-B",
                        str(ROOT / "tests/acp_permission_agent.py"), agent, mode]
                proc = subprocess.Popen(argv, cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                proc.stdin.write("isolated permission verification")
                proc.stdin.close()
                proc.stdin = None
                end = time.monotonic() + 20
                while proc.poll() is None and time.monotonic() < end:
                    for row in list(channel.pending.values()):
                        if row["requestId"] in seen:
                            continue
                        seen.append(row["requestId"])
                        self.assertEqual(row["kind"], "execute", row)
                        decision = "session" if row["arguments"].get("command") == "isolated-marker" else "deny"
                        self.assertFalse((work / "approved-0.txt").exists() if decision == "session" else (work / "denied.txt").exists())
                        self.assertTrue(channel.respond(row["requestId"], decision, 1)["ok"])
                    time.sleep(.02)
                if proc.poll() is None:
                    channel.close()
                    proc.kill()
                    self.fail("isolated bridge exceeded 20 seconds")
                out, err = proc.communicate(timeout=5)
                self.assertEqual(proc.returncode, 0, out + err)
                self.assertNotIn(channel.token, out + err)
                self.assertEqual(len(seen), 2 if mode == "standard" else 0)
                for name in ("document.txt", "approved-0.txt", "approved-1.txt"):
                    self.assertEqual((work / name).exists(), mode == "standard", name)
                self.assertFalse((work / "denied.txt").exists())
                self.assertEqual(run["appliedAccessPolicy"]["mode"], mode)
            finally:
                access_broker.close(ref)
                if proc and proc.poll() is None:
                    proc.kill()
                    proc.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
