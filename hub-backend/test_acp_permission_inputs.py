"""ACP 1.6.2 permission envelopes through the real bridge; isolated files only."""
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services.acp_access import BridgeAccess
from app.services.acp_bridge import AcpBridge


class CodexModeCompatibilityTests(unittest.TestCase):
    def access(self, mode, agent):
        return BridgeAccess(json.dumps({"url": "http://127.0.0.1:1", "token": "fixture",
            "policy": {"mode": mode}}), agent_name=agent)

    def test_standard_prefers_user_approval_and_retains_older_adapter_support(self):
        for agent in ("codex-harness", "codex"):
            for available, expected in (
                (["agent", "workspace-write", "agent-full-access", "read-only"], "workspace-write"),
                (["agent", "agent-full-access", "read-only"], "agent"),
            ):
                with self.subTest(agent=agent, available=available):
                    access = self.access("standard", agent)
                    bridge = SimpleNamespace(agent_name=agent, session_id="restored-session")
                    with patch.object(access, "call", return_value={"ok": True}) as receipt:
                        bridge.request = unittest.mock.Mock(return_value={})
                        access.apply(bridge, {"modes": {"availableModes": [{"id": v} for v in available]}})
                    bridge.request.assert_called_once_with("session/set_mode", {
                        "sessionId": "restored-session", "modeId": expected})
                    receipt.assert_called_once_with("/applied", {"mode": "standard", "nativeMode": expected})

    def test_full_and_readonly_are_reapplied_without_inheriting_auto_review(self):
        for agent in ("codex-harness", "codex"):
            for mode, native in (("full", "agent-full-access"), ("readonly", "read-only")):
                with self.subTest(agent=agent, mode=mode):
                    access = self.access(mode, agent)
                    env = {"INITIAL_AGENT_MODE": "agent", "CODEX_HOME": "isolated"}
                    self.assertEqual(access.agent_environment(agent, env), {**env, "INITIAL_AGENT_MODE": "read-only"})
                    self.assertEqual(env["INITIAL_AGENT_MODE"], "agent")
                    bridge = SimpleNamespace(agent_name=agent, session_id="saved", request=unittest.mock.Mock(return_value={}))
                    with patch.object(access, "call", return_value={"ok": True}):
                        access.apply(bridge, {"modes": {"currentModeId": "agent", "availableModes": [
                            {"id": v} for v in ("agent", "workspace-write", "agent-full-access", "read-only")]}})
                    self.assertEqual(bridge.request.call_args.args[1]["modeId"], native)

    def test_unsupported_or_rejected_mode_never_acknowledges_applied_access(self):
        access = self.access("full", "codex-harness")
        bridge = SimpleNamespace(agent_name="codex-harness", session_id="saved", request=unittest.mock.Mock())
        with patch.object(access, "call") as receipt:
            with self.assertRaisesRegex(Exception, "UNSUPPORTED"):
                access.apply(bridge, {"modes": {"availableModes": [{"id": "agent"}]}})
            bridge.request.side_effect = RuntimeError("native mode rejected")
            with self.assertRaisesRegex(RuntimeError, "native mode rejected"):
                access.apply(bridge, {"modes": {"availableModes": [{"id": "agent-full-access"}]}})
            receipt.assert_not_called()

    def test_bootstrap_does_not_change_legacy_or_other_agent_environments(self):
        env = {"INITIAL_AGENT_MODE": "agent"}
        self.assertEqual(BridgeAccess("", agent_name="codex-harness").agent_environment("codex-harness", env), env)
        self.assertEqual(self.access("full", "qwen").agent_environment("qwen", env), env)

    def test_managed_codex_uses_its_own_native_package_and_no_inherited_credential_logs(self):
        from app.services import acp_agents
        env = {"CODEX_PATH": "personal-codex", "APP_SERVER_LOGS": "personal-logs"}
        acp_agents.inject_llm_env("codex-harness", env, {
            "base": "http://127.0.0.1:1/v1", "key": "fixture-secret", "model": "fixture"})
        self.assertNotIn("CODEX_PATH", env)
        self.assertNotIn("APP_SERVER_LOGS", env)
        self.assertIn("codex_gateway_startup.mjs", env["NODE_OPTIONS"])
        self.assertNotIn("fixture-secret", env["NODE_OPTIONS"])
        self.assertNotIn("fixture-secret", env["CODEX_CONFIG"])


class CodexPermissionInputsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-acp-inputs-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.work.mkdir()
        self.channel = json.dumps({"url": "http://127.0.0.1:1", "token": "isolated",
                                   "policy": {"mode": "standard", "workspaceRoot": str(self.work)}})
        self.access = BridgeAccess(self.channel, agent_name="codex-harness")
        self.requests = []
        self.access.call = self.broker

    def broker(self, path, value):
        if path == "/request":
            self.requests.append(value)
            return {"decision": "deny"}
        return {}

    def file_event(self, call_id="file-1", path=None, **extra):
        # createFileChangeUpdate -> createAddFileContent; no rawInput/locations.
        return {"sessionUpdate": "tool_call", "toolCallId": call_id,
                "title": "Editing files", "kind": "edit", "status": "in_progress",
                "content": [{"type": "diff", "path": path or str(self.work / "report.md"),
                             "oldText": None, "newText": "# Actual document\n",
                             "_meta": {"kind": "add"}}], **extra}

    def file_request(self, call_id="file-1", **extra):
        # buildFileChangePermissionRequest intentionally omits rawInput.
        return {"toolCall": {"toolCallId": call_id, "kind": "edit", "status": "pending"},
                "_meta": {"codex": {"params": {"threadId": "thread-1", "turnId": "turn-1",
                    "itemId": call_id, "reason": "write output", "grantRoot": None}}}, **extra}

    def test_real_bridge_binds_metadata_only_edit_to_live_structured_diff(self):
        bridge = AcpBridge([], str(self.work), "codex-harness", "workspace")
        self.addCleanup(bridge.close)
        bridge.access = self.access
        sent = []
        bridge.send = sent.append
        event = self.file_event()
        event["content"].append({"type": "diff", "path": str(self.root / "outside.md"),
                                 "oldText": "old", "newText": "new", "_meta": {"kind": "update"}})
        with patch("app.services.acp_bridge._emit"):
            bridge._incoming({"method": "session/update", "params": {"update": event}})
        request = self.file_request(options=[{"optionId": "once", "kind": "allow_once"},
                                             {"optionId": "deny", "kind": "reject_once"}])
        bridge._incoming({"id": 42, "method": "session/request_permission", "params": request})
        operation = self.requests[-1]
        self.assertEqual(operation["target"], str(self.work / "report.md"))
        self.assertEqual(operation["arguments"]["changes"][0]["newText"], "# Actual document\n")
        self.assertEqual(operation["locations"], [{"path": row["path"]} for row in event["content"]])
        self.assertNotIn("input", operation["arguments"])
        self.assertFalse(operation["allowSession"])
        self.assertTrue(operation["arguments"]["inputIncomplete"])
        self.assertEqual(sent[-1]["result"]["outcome"]["optionId"], "deny")

    def test_lossy_diffs_and_grant_root_never_prove_the_full_write_set(self):
        for change in ("add", "update", "delete"):
            with self.subTest(change=change):
                event = self.file_event()
                event["content"][0]["_meta"]["kind"] = change
                self.access.observe_tool(event)
                request = self.file_request()
                request["_meta"]["codex"]["params"]["grantRoot"] = str(self.work)
                self.assertFalse(self.access.native_permission(request))
                self.assertFalse(self.requests[-1]["allowSession"])
                self.assertEqual(self.requests[-1]["arguments"]["changes"][0]["_meta"]["kind"], change)

    def test_partial_updates_refresh_content_and_completed_calls_are_not_reused(self):
        self.access.observe_tool(self.file_event())
        changed = self.file_event(content=[{"type": "diff", "path": str(self.work / ".env"),
                                            "oldText": "before", "newText": "after"}])
        changed["sessionUpdate"] = "tool_call_update"
        del changed["kind"]
        self.access.observe_tool(changed)
        self.access.native_permission(self.file_request())
        self.assertEqual(self.requests[-1]["target"], str(self.work / ".env"))
        for status in ("completed", "failed"):
            self.access.observe_tool(self.file_event())
            self.access.observe_tool({"sessionUpdate": "tool_call_update", "toolCallId": "file-1", "status": status})
            self.assertFalse(self.access.native_permission(self.file_request()))
            self.assertTrue(self.requests[-1]["arguments"]["inputUnavailable"])
            self.assertEqual(self.access.native_call_bytes, 0)

    def test_other_ids_tool_kind_changes_and_restarts_cannot_recover_old_inputs(self):
        self.access.observe_tool(self.file_event())
        self.access.native_permission(self.file_request("other"))
        self.assertTrue(self.requests[-1]["arguments"]["inputUnavailable"])
        self.access.observe_tool({"sessionUpdate": "tool_call_update", "toolCallId": "file-1", "kind": "execute"})
        self.access.native_permission(self.file_request())
        self.assertTrue(self.requests[-1]["arguments"]["inputUnavailable"])
        self.access.observe_tool(self.file_event())
        self.access.observe_tool({"sessionUpdate": "tool_call", "toolCallId": "file-1", "kind": "edit"})
        self.access.native_permission(self.file_request())
        self.assertTrue(self.requests[-1]["arguments"]["inputUnavailable"])

    def test_codex_shell_uses_original_command_and_preserves_all_execution_context(self):
        command = 'powershell.exe -NoProfile -Command "Write-Output fixture"'
        source = {"threadId": "t", "turnId": "turn", "itemId": "shell-1", "command": command,
                  "cwd": str(self.work), "reason": "display-only",
                  "networkApprovalContext": {"host": "fixture.invalid", "protocol": "https"},
                  "futureExecutionField": {"strict": True}}
        self.assertFalse(self.access.native_permission({
            "toolCall": {"toolCallId": "shell-1", "kind": "execute",
                         "rawInput": {"command": "Write-Output fixture", "cwd": str(self.work)}},
            "_meta": {"codex": {"params": source}}}))
        operation = self.requests[-1]
        self.assertEqual((operation["action"], operation["tool"]), ("native.command", "codex.shell"))
        self.assertEqual(operation["target"], command)
        self.assertEqual(operation["arguments"], source)
        self.assertTrue(operation["allowSession"])

    def test_missing_shell_input_recovers_only_from_the_same_live_call(self):
        event = {"sessionUpdate": "tool_call", "toolCallId": "shell-1", "kind": "execute",
                 "status": "in_progress", "rawInput": {"command": "cat report.md", "cwd": str(self.work)}}
        self.access.observe_tool(event)
        request = {"toolCall": {"toolCallId": "shell-1", "kind": "execute", "rawInput": None},
                   "_meta": {"codex": {"params": {"itemId": "shell-1", "command": None, "cwd": None}}}}
        self.assertFalse(self.access.native_permission(request))
        self.assertEqual(self.requests[-1]["arguments"]["command"], "cat report.md")
        self.assertEqual(self.requests[-1]["arguments"]["cwd"], str(self.work))
        self.assertEqual(self.requests[-1]["action"], "native.command")
        self.access.observe_tool({**event, "sessionUpdate": "tool_call_update", "rawInput": None})
        self.assertFalse(self.access.native_permission(request))
        self.assertNotEqual(self.requests[-1]["action"], "native.command")
        self.assertFalse(self.requests[-1]["allowSession"])

    def test_titles_mismatched_metadata_and_mcp_payloads_are_never_shell_proof(self):
        for raw in (None, {"server": "mcp", "tool": "execute", "arguments": {"command": "something"}}):
            self.assertFalse(self.access.native_permission({
                "toolCall": {"toolCallId": "mcp-1", "title": "cat safe.md", "kind": "execute", "rawInput": raw},
                "_meta": {"codex": {"params": {"itemId": "other", "command": "cat safe.md"}}}}))
            self.assertEqual(self.requests[-1]["action"], "native.tool")
            self.assertEqual(self.requests[-1]["tool"], "")
        self.assertNotIn('"input": null', json.dumps(self.requests))

    def test_complete_file_inputs_keep_existing_default_scope_for_all_acp_agents(self):
        for agent in ("codex-harness", "opencode", "qwen", "dsh"):
            self.access.agent_name = agent
            with self.subTest(agent=agent):
                request = {"toolCall": {"kind": "edit", "rawInput": {"path": "report.md", "content": "text"}}}
                self.assertTrue(self.access.native_permission(request))
                request["toolCall"]["rawInput"]["path"] = ".env"
                self.assertFalse(self.access.native_permission(request))
                request["toolCall"]["rawInput"]["path"] = "../outside.md"
                self.assertFalse(self.access.native_permission(request))

    def test_live_cache_is_bounded_and_oversized_inputs_do_not_create_grants(self):
        for index in range(70):
            self.access.observe_tool(self.file_event(str(index)))
        self.assertLessEqual(len(self.access.native_calls), 64)
        self.assertFalse(self.access.native_permission(self.file_request("0")))
        self.assertTrue(self.requests[-1]["arguments"]["inputUnavailable"])
        self.access.observe_tool(self.file_event("large", content=[{"type": "diff", "path": "report.md",
                            "oldText": None, "newText": "x" * (2 * 1024 * 1024)}]))
        self.assertFalse(self.access.native_permission(self.file_request("large")))
        self.assertFalse(self.requests[-1]["allowSession"])
        self.assertLessEqual(self.access.native_call_bytes, 4 * 1024 * 1024)

    def test_large_diff_keeps_file_summary_and_exact_content_digest(self):
        event = self.file_event()
        event["content"][0]["newText"] = "document " * 3000
        self.access.observe_tool(event)
        self.access.native_permission(self.file_request())
        first = self.requests[-1]["arguments"]
        self.assertEqual(first["changes"][0], {"path": str(self.work / "report.md"),
            "kind": "add", "oldBytes": 0, "newBytes": 27000})
        self.assertEqual(first["changeCount"], 1)
        self.assertGreater(first["inputBytes"], 27000)
        event["content"][0]["newText"] += "changed"
        self.access.observe_tool(event)
        self.access.native_permission(self.file_request())
        self.assertNotEqual(first["inputDigest"], self.requests[-1]["arguments"]["inputDigest"])
        self.assertFalse(self.requests[-1]["allowSession"])


if __name__ == "__main__":
    unittest.main()
