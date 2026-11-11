# -*- coding: utf-8 -*-
"""Offline smoke for personal MCP probing on the actual execution Runner."""
from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.abspath("."))
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import runner_main  # noqa: E402
from app.api import capabilities  # noqa: E402
from app.services import mcp_http, mcp_servers, runner_hub  # noqa: E402


passed = failed = 0


def check(name: str, condition, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + ("  << " + str(detail)[:300] if detail else ""))


class FakeRunner:
    def __init__(self, result=None, version="1.9.1"):
        self.id = "runner-probe-1"
        self.host = "DESKTOP-PROBE"
        self.version = version
        self.result = result or {"ok": True, "data": {"tools": ["search", "read"]}}
        self.calls = []

    async def call(self, op: str, data: dict, timeout: int = 0) -> dict:
        self.calls.append((op, data, timeout))
        return self.result


async def main() -> None:
    secret = "Bearer secret-token"
    saved = mcp_servers.personal_spec({
        "id": "mcp-probe-1",
        "name": "知识库",
        "type": "http",
        "url": "http://127.0.0.1:18422/mcp",
        "headers": {"Authorization": secret},
        "approved": True,
        "approvedTarget": "http://127.0.0.1:18422/mcp",
        "enabled": True,
    })
    client = type("Client", (), {"id": "u-probe", "mcp_servers": [saved]})()
    masked = mcp_servers.mask(saved)

    original_for_client = runner_hub.for_client
    original_pick_for = runner_hub.pick_for
    original_bridge = mcp_servers._bridge_sync
    original_probe = mcp_servers.probe_sync
    original_http_list = mcp_http.list_tools
    original_http_call = mcp_http.call
    try:
        runner = FakeRunner()
        runner_hub.for_client = lambda client_id: runner
        result = await capabilities.probe_my_mcp_server(masked, client)
        check("probe uses the employee's Runner", bool(runner.calls), runner.calls)
        check("probe uses the dedicated RPC", runner.calls[0][0] == "mcp.probe", runner.calls)
        check("masked credential is restored only for RPC",
              runner.calls[0][1]["spec"]["headers"]["Authorization"] == secret)
        check("successful probe returns tool names",
              result["tools"] == ["search", "read"] and result["toolCount"] == 2, result)
        check("successful response identifies the tested machine",
              result["runner"]["host"] == "DESKTOP-PROBE", result)
        check("credentials never return to the client", secret not in json.dumps(result), result)

        runner.result = {"ok": False, "error": "authentication failed for " + secret}
        error = await capabilities.probe_my_mcp_server(masked, client)
        check("failed probe returns an explicit unsuccessful health state",
              error.get("ok") is False and error.get("connectionState") == "error"
              and error.get("authenticationTested") is False, error)
        check("failed probe redacts credentials", secret not in json.dumps(error), error)
        check("failed probe keeps a useful redaction marker", "***" in error.get("error", ""), error)

        runner_hub.for_client = lambda _client_id: FakeRunner(version="1.9.0")
        outdated = await capabilities.probe_my_mcp_server(masked, client)
        check("outdated Runner fails with actionable health metadata",
              outdated.get("ok") is False and outdated.get("connectionState") == "error"
              and "版本过旧" in outdated.get("error", ""), outdated)
        runner_hub.for_client = lambda _client_id: None
        offline = await capabilities.probe_my_mcp_server(masked, client)
        check("offline Runner cannot produce a successful probe",
              offline.get("ok") is False and offline.get("connectionState") == "offline"
              and offline.get("authenticationTested") is False
              and "不在线" in offline.get("message", ""), offline)

        check("version comparison accepts probe protocol version",
              capabilities._version_at_least("1.9.1", (1, 9, 1)))
        check("version comparison rejects old Runner",
              not capabilities._version_at_least("1.9.0", (1, 9, 1)))

        fleet_runner = FakeRunner()
        runner_hub.pick_for = lambda *_args, **_kwargs: fleet_runner
        managed = await mcp_servers.probe_managed({
            "name": "company-files", "type": "stdio", "command": "node",
            "args": ["server.js"], "env": {"TOKEN": "company-secret"},
        })
        check("organization stdio probe runs on an online Runner",
              fleet_runner.calls and fleet_runner.calls[0][0] == "mcp.probe",
              fleet_runner.calls)
        check("managed probe identifies its real execution machine",
              managed.get("ok") and managed.get("runOn") == "runner"
              and managed.get("runnerHost") == "DESKTOP-PROBE", managed)
        runner_hub.pick_for = lambda *_args, **_kwargs: None
        unavailable = await mcp_servers.probe_managed({
            "name": "company-files", "type": "stdio", "command": "node"})
        check("managed probe fails clearly when no Runner is online",
              not unavailable.get("ok") and "Runner" in unavailable.get("error", ""),
              unavailable)

        bridge_calls = []
        mcp_servers._bridge_sync = lambda name, spec, action, timeout=0: (
            bridge_calls.append((name, spec, action, timeout)) or
            "## alpha\nFirst tool\n\n## beta\nSecond tool")
        local = mcp_servers.probe_sync({
            "name": "trusted-local", "type": "stdio", "command": "node",
            "args": ["server.js"], "env": {"TOKEN": "local-secret"},
        })
        check("stdio probe uses the in-memory task bridge",
              bridge_calls and bridge_calls[0][2] == "list", bridge_calls)
        check("stdio probe returns the actual tool list",
              local.get("tools") == ["alpha", "beta"], local)
        check("diagnostics redact HTTP and local secrets",
              mcp_servers.redact_diagnostic(
                  "remote %s local local-secret" % secret,
                  {"headers": {"Authorization": secret}, "env": {"TOKEN": "local-secret"}},
              ) == "remote *** local ***")

        mcp_servers.probe_sync = lambda spec, timeout=25: {
            "ok": True, "tools": ["runner_search"]}
        local_runner = runner_main.Runner(
            "http://127.0.0.1:9080", "", "u-probe", "runner-local")
        runner_result = await local_runner._mcp({
            "op": "mcp.probe", "spec": {"name": "knowledge"}})
        check("Runner handles MCP probe without opening a task",
              runner_result.get("ok") and
              runner_result.get("data", {}).get("tools") == ["runner_search"], runner_result)
        mcp_http.list_tools = lambda spec, timeout=25: [{
            "name": "search", "inputSchema": {"type": "object",
                                                "required": ["query"]}}]
        mcp_http.call = lambda spec, tool, arguments, timeout=25: {
            "content": [{"type": "image", "data": "YWJj", "mimeType": "image/png"}],
            "structuredContent": {"query": arguments.get("query")},
        }
        listed = await local_runner._mcp({
            "op": "mcp.list", "name": "knowledge",
            "spec": {"type": "http", "url": "http://127.0.0.1/mcp"}})
        check("Runner lists complete MCP contracts on the employee machine",
              listed.get("data", {}).get("tools", [{}])[0].get(
                  "inputSchema", {}).get("required") == ["query"], listed)
        called = await local_runner._mcp({
            "op": "mcp.call", "name": "knowledge", "tool": "search",
            "arguments": {"query": "SoduWork"},
            "spec": {"type": "http", "url": "http://127.0.0.1/mcp"}})
        call_data = called.get("data", {}).get("result", {})
        check("Runner preserves typed MCP results instead of flattening them",
              call_data.get("content", [{}])[0].get("type") == "image"
              and call_data.get("structuredContent", {}).get("query") == "SoduWork", called)
        malformed = await local_runner._mcp({"op": "mcp.call"})
        check("Runner rejects malformed MCP calls", not malformed.get("ok"), malformed)
        check("Runner protocol version satisfies the MCP probe contract",
              capabilities._version_at_least(
                  str(runner_main.RUNNER_VERSION), (1, 9, 1)),
              runner_main.RUNNER_VERSION)
    finally:
        runner_hub.for_client = original_for_client
        runner_hub.pick_for = original_pick_for
        mcp_servers._bridge_sync = original_bridge
        mcp_servers.probe_sync = original_probe
        mcp_http.list_tools = original_http_list
        mcp_http.call = original_http_call


asyncio.run(main())
print("\n%d PASS / %d FAIL" % (passed, failed))
raise SystemExit(1 if failed else 0)
