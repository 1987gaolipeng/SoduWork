# -*- coding: utf-8 -*-
"""Per-turn @plugin MCP authorization smoke; isolated database and cleanup."""
import asyncio
import json
import os
import shutil
import sys

import httpx
from sqlalchemy import delete, select

sys.path.insert(0, ".")

DB = os.path.abspath(".smoke-plugin-mcp-gateway.db")
DATA = os.path.abspath(".smoke-plugin-mcp-gateway-data")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = DATA

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.services import (audit, device_auth, local_base, mcp_http, mcp_servers,
                          plugin_mcp_gateway, plugin_mcp_limits,
                          plugin_runtime, runner_hub)  # noqa: E402

USER = "u-smoke-plugin-mcp"
CLIENT = "c-smoke-plugin-mcp"
ORG = "o-smoke-plugin-mcp"
PLUGIN = "plg-smoke-plugin-mcp"
VERSION = "plv-smoke-plugin-mcp"
BINDING = "plb-smoke-plugin-mcp"
SECRET = "plugin-mcp-" + ("s" * 40)
SESSION = ""
passed = failed = 0


def check(name, condition, extra=""):
    global passed, failed
    if condition:
        passed += 1
    else:
        failed += 1
        print("FAIL", name, str(extra)[:800])


def device_headers():
    return {"Authorization": "Device " + SESSION}


def rpc(method, params=None, rid=1):
    return {"jsonrpc": "2.0", "id": rid, "method": method,
            "params": params or {}}


async def purge():
    async with SessionLocal() as session:
        await session.execute(delete(models.AuditLog).where(
            models.AuditLog.action.in_([
                "plugin.conversation_grant", "plugin.mcp_call", "plugin.mcp_failed",
            ])))
        await session.execute(delete(am.PluginInstallation).where(
            am.PluginInstallation.user_id == USER))
        await session.execute(delete(am.PluginBinding).where(am.PluginBinding.id == BINDING))
        await session.execute(delete(am.PluginVersion).where(am.PluginVersion.id == VERSION))
        await session.execute(delete(am.Plugin).where(am.Plugin.id == PLUGIN))
        await session.execute(delete(models.AppSetting).where(
            models.AppSetting.key == mcp_servers.SETTING_KEY))
        await session.execute(delete(models.Client).where(models.Client.id == CLIENT))
        await session.execute(delete(models.User).where(models.User.id == USER))
        await session.execute(delete(models.OrgUnit).where(models.OrgUnit.id == ORG))
        await session.commit()


async def seed():
    global SESSION
    await purge()
    async with SessionLocal() as session:
        session.add(models.OrgUnit(id=ORG, name="Plugin MCP organization"))
        session.add(models.User(id=USER, username="plugin-mcp-smoke", org_id=ORG,
                                display_name="Plugin MCP smoke", is_active=True))
        client = models.Client(
            id=CLIENT, name="Plugin MCP client",
            secret_hash=device_auth.hash_secret(SECRET),
            auth_state="active", user_ref=USER, mcp_enabled=["worklog"])
        session.add(client)
        session.add(models.AppSetting(
            key=mcp_servers.SETTING_KEY,
            value=json.dumps([{
                "id": "mcp-worklog", "name": "worklog", "type": "http",
                "url": "https://mcp.internal.example/rpc",
                "headers": {"X-Company-Key": "server-secret-never-leak"},
                "description": "Read approved work records", "enabled": True,
                "enabledTools": ["records_search", "oversized_schema"],
            }], ensure_ascii=False)))
        session.add(am.Plugin(
            id=PLUGIN, key="worklog-method", name="Worklog method",
            description="Prepare a grounded status report", enabled=True,
            source_kind="soduwork", org_id=ORG))
        session.add(am.PluginVersion(
            id=VERSION, plugin_id=PLUGIN, version="1.0.0", checksum="plugin-mcp-smoke",
            manifest={
                "name": "Worklog method", "description": "Use approved work records",
                "instructions": "Read the worklog before writing the report.",
                "entrypoints": {"conversation": True, "task": True, "automation": True},
            },
            workflow={"nodes": [{
                "key": "report", "type": "ai", "name": "Prepare report",
                "config": {"prompt": "Use the worklog connector and cite facts."},
            }]},
            capability_report={"skills": [], "mcpServers": ["worklog"], "runtime": []},
            trust_state="approved", enabled=True))
        session.add(am.PluginBinding(
            id=BINDING, plugin_id=PLUGIN, version_id=VERSION,
            org_id=ORG, config={"mcpTools": {"worklog": [
                "records_search", "oversized_schema"]}}, secret_refs={}, enabled=True))
        session.add(am.PluginInstallation(
            plugin_id=PLUGIN, version_id=VERSION, user_id=USER,
            enabled=True))
        await session.commit()
        SESSION = device_auth.issue_session(client)[0]


async def main():
    await init_db()
    await seed()
    plugin_mcp_limits.reset_for_tests()
    plugin_mcp_gateway.reset_list_cache_for_tests()
    seen = []
    original_list = mcp_http.list_tools
    original_call = mcp_http.call
    original_for_client = runner_hub.for_client
    original_pick_for = runner_hub.pick_for

    def fake_list(spec, timeout=30):
        seen.append(("list", spec))
        return [
            {"name": "records_search", "description": "Search work records",
             "title": "Search records",
             "inputSchema": {"type": "object", "properties": {
                 "query": {"type": "string"}}, "required": ["query"]},
             "outputSchema": {"type": "object", "properties": {
                 "count": {"type": "integer"}}},
             "annotations": {"readOnlyHint": True},
             "icons": [{"src": "data:image/svg+xml;base64,PHN2Zy8+"}]},
            {"name": "oversized_schema", "description": "x" * 2000,
             "inputSchema": {"type": "object", "properties": {
                 "blob": {"type": "string", "description": "x" * 40_000}}}},
            {"name": "danger_delete", "description": "Delete every work record",
             "inputSchema": {"type": "object", "properties": {}}},
        ]

    def fake_call(spec, tool, arguments, timeout=30):
        seen.append(("call", spec, tool, arguments))
        if arguments.get("query") == "large":
            return {"blob": "x" * 600_000}
        return {"rows": [{"title": "Finished migration"}], "count": 1}

    mcp_http.list_tools = fake_list
    mcp_http.call = fake_call
    try:
        node_binding = am.PluginBinding(config={"mcpTools": {
            "worklog": ["records_search"], "another-server": ["read_other"]}})
        node_grants = plugin_runtime.required_mcp_tools(node_binding, ["worklog"])
        check("one workflow node receives only its own server tools from a wider binding",
              node_grants == {"worklog": ["records_search"]}, node_grants)
        scoped_payload = plugin_runtime.apply_mcp_tools({"servers": {
            "worklog": {"command": "worklog-mcp"},
            "another-server": {"command": "other-mcp"},
        }}, node_grants)
        check("Runner dispatch contains only the node connector and its exact tool grant",
              scoped_payload == {"servers": {"worklog": {
                  "command": "worklog-mcp",
                  "allowedTools": ["records_search"],
                  "soduworkPolicy": {
                      "timeoutSeconds": 25, "maxResultChars": 500_000,
                  },
                  "soduWorkPolicy": {
                      "timeoutSeconds": 25, "maxResultChars": 500_000,
                  }}}},
              scoped_payload)
        codex_args = local_base._codex_args("sid", "work", None, {
            "mcpConfig": scoped_payload["servers"]})
        check("Codex cannot receive a native MCP config that would bypass allowedTools",
              not any("mcp_servers." in str(item) for item in codex_args), codex_args)
        check("destructive tool names are classified as high risk",
              plugin_runtime.normalize_mcp_tools(
                  {"worklog": ["danger_delete"]}, ["worklog"])
              and plugin_mcp_gateway.tool_risk("danger_delete") == "high")
        normalized = plugin_mcp_gateway._tools(fake_list({}, 1))[0]
        check("gateway preserves complete MCP tool contracts",
              normalized.get("title") == "Search records"
              and normalized["inputSchema"].get("required") == ["query"]
              and normalized["outputSchema"]["properties"]["count"]["type"] == "integer"
              and normalized["annotations"].get("readOnlyHint") is True
              and len(normalized.get("icons") or []) == 1, normalized)

        class FakeRunner:
            def __init__(self):
                self.calls = []

            def alive(self):
                return True

            async def call(self, op, data, timeout=0):
                self.calls.append((op, data, timeout))
                if op == "mcp.list":
                    return {"ok": True, "data": {"tools": fake_list({}, 1)[:1]}}
                return {"ok": True, "data": {"result": {
                    "content": [{"type": "image", "data": "YWJj", "mimeType": "image/png"}],
                    "structuredContent": {"count": 1},
                }}}

        device_runner = FakeRunner()
        runner_hub.for_client = lambda cid: device_runner if cid == CLIENT else None
        local_client = type("Client", (), {"id": CLIENT})()
        runner_spec = {"type": "http", "url": "http://intranet/mcp",
                       "headers": {"Authorization": "Bearer local-only"},
                       "soduworkRunOn": "runner"}
        runner_tools = await plugin_mcp_gateway._connector_list(
            "personal", runner_spec, 10, local_client)
        runner_result = await plugin_mcp_gateway._connector_call(
            "personal", runner_spec, "search", {"query": "x"}, 10, local_client)
        check("personal MCP list and calls execute on the owning Runner",
              [item[0] for item in device_runner.calls] == ["mcp.list", "mcp.call"]
              and runner_tools[0]["name"] == "records_search", device_runner.calls)
        check("Runner MCP calls retain typed non-text results",
              runner_result.get("content", [{}])[0].get("type") == "image"
              and runner_result.get("structuredContent", {}).get("count") == 1,
              runner_result)

        catalog_runner = FakeRunner()
        runner_hub.pick_for = lambda *_args, **_kwargs: catalog_runner
        catalog_tools = await plugin_mcp_gateway._connector_list(
            "company-local", {"type": "stdio", "command": "trusted-mcp",
                              "soduworkRunOn": "runner"}, 10)
        check("plugin authoring reads stdio tool catalogs on an online Runner",
              catalog_runner.calls[0][0] == "mcp.list"
              and catalog_tools[0]["name"] == "records_search", catalog_runner.calls)

        budget_claims = {
            "jti": "budget-once", "cid": CLIENT, "exp": 4_102_444_800,
            "mcl": 1, "mll": 1, "mcc": 1,
        }
        async with plugin_mcp_limits.governed(
                budget_claims, "worklog", "call"):
            pass
        try:
            async with plugin_mcp_limits.governed(
                    budget_claims, "worklog", "call"):
                pass
            budget_blocked = False
        except plugin_mcp_limits.PluginMcpLimitError as exc:
            budget_blocked = exc.kind == "call-budget"
        check("signed per-turn call budget rejects connector work before execution",
              budget_blocked)

        concurrent_claims = {
            "jti": "one-at-a-time", "cid": CLIENT, "exp": 4_102_444_800,
            "mcl": 5, "mcc": 1,
        }
        lease = await plugin_mcp_limits.acquire(
            concurrent_claims, "worklog", "call")
        try:
            try:
                await plugin_mcp_limits.acquire(
                    concurrent_claims, "worklog", "call")
                concurrency_blocked = False
            except plugin_mcp_limits.PluginMcpLimitError as exc:
                concurrency_blocked = exc.kind == "concurrency"
        finally:
            await plugin_mcp_limits.release(lease, True)
        check("per-turn concurrency limit rejects overlapping connector calls",
              concurrency_blocked)

        circuit_claims = {
            "jti": "circuit-turn", "cid": CLIENT, "exp": 4_102_444_800,
            "mcl": 10, "mft": 2, "mcd": 5,
        }
        for _ in range(2):
            try:
                async with plugin_mcp_limits.governed(
                        circuit_claims, "unstable", "call"):
                    raise RuntimeError("upstream unavailable")
            except RuntimeError:
                pass
        try:
            async with plugin_mcp_limits.governed(
                    circuit_claims, "unstable", "call"):
                pass
            circuit_open = False
        except plugin_mcp_limits.PluginMcpLimitError as exc:
            circuit_open = exc.kind == "circuit-open" and exc.retry_after > 0
        check("repeated upstream failures open a bounded connector circuit",
              circuit_open)
        redacted = mcp_servers._bridge_redact(
            "failed with server-secret-in-arg",
            {"args": ["--token", "server-secret-in-arg"]})
        check("stdio MCP diagnostics redact a secret passed after a credential flag",
              "server-secret-in-arg" not in redacted, redacted)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
            ordinary = await http.post(
                "/api/v1/plugins/conversation-context", headers=device_headers(),
                json={"pluginIds": [PLUGIN], "conversationId": "chat-safe-view"})
            check("ordinary context exposes no internal binding ids or ticket",
                  ordinary.status_code == 200
                  and "_bindingIds" not in ordinary.text
                  and "ticket" not in ordinary.text
                  and "server-secret-never-leak" not in ordinary.text,
                  ordinary.text)

            granted = await http.post(
                "/api/v1/plugins/conversation-grant", headers=device_headers(),
                json={"pluginIds": [PLUGIN], "conversationId": "chat-runtime"})
            grant_body = granted.json() if granted.status_code == 200 else {}
            ticket = str((grant_body.get("mcpGrant") or {}).get("ticket") or "")
            check("grant returns only logical names and a purpose-bound ticket",
                  granted.status_code == 200 and bool(ticket)
                  and (grant_body.get("mcpGrant") or {}).get("servers") == ["worklog"]
                  and (grant_body.get("mcpGrant") or {}).get(
                      "limits", {}).get("maxCalls") == 48
                  and "mcp.internal.example" not in granted.text
                  and "server-secret-never-leak" not in granted.text,
                  granted.text)
            plugin_headers = {"Authorization": "Bearer " + ticket}

            listed = await http.post(
                "/api/v1/mcp", headers=plugin_headers, json=rpc("tools/list"))
            tools = ((listed.json().get("result") or {}).get("tools") or [])
            tool_names = [item.get("name") for item in tools]
            check("plugin ticket sees only generic plugin gateway tools",
                  tool_names == ["plugin_mcp_list", "plugin_mcp_call"], tool_names)
            check("plugin ticket cannot see platform task administration tools",
                  "task_create" not in tool_names and "task_update" not in tool_names,
                  tool_names)

            blocked_task = await http.post(
                "/api/v1/mcp", headers=plugin_headers,
                json=rpc("tools/call", {"name": "task_list", "arguments": {}}))
            blocked_result = blocked_task.json().get("result") or {}
            check("plugin ticket cannot call a hidden platform task tool",
                  blocked_result.get("isError") is True
                  and "不能调用" in json.dumps(blocked_result, ensure_ascii=False),
                  blocked_result)

            real_tools = await http.post(
                "/api/v1/mcp", headers=plugin_headers,
                json=rpc("tools/call", {"name": "plugin_mcp_list",
                                         "arguments": {"server": "worklog"}}))
            real_text = ((real_tools.json().get("result") or {}).get("content") or [{}])[0].get("text", "")
            listed_payload = json.loads(real_text)
            check("authorized connector tools are discovered through the Hub",
                  "records_search" in real_text and "query" in real_text, real_text)
            check("live tool discovery keeps output schema and read-only annotations",
                  listed_payload["tools"][0].get("outputSchema", {}).get("type") == "object"
                  and listed_payload["tools"][0].get(
                      "annotations", {}).get("readOnlyHint") is True,
                  listed_payload["tools"][0])
            check("tool discovery applies the enabled company connector tool policy",
                  "danger_delete" not in real_text, real_text)
            check("oversized tool metadata is bounded before entering model context",
                  len(listed_payload["tools"][1]["description"]) == 1000
                  and listed_payload["tools"][1]["inputSchema"].get("properties") == {},
                  listed_payload["tools"][1])

            list_calls_before_retry = sum(1 for item in seen if item[0] == "list")
            repeated_tools = await http.post(
                "/api/v1/mcp", headers=plugin_headers,
                json=rpc("tools/call", {"name": "plugin_mcp_list",
                                         "arguments": {"server": "worklog"}}))
            repeated_text = ((repeated_tools.json().get("result") or {}).get("content") or [{}])[0].get("text", "")
            check("repeated MCP discovery reuses the signed-turn cache",
                  sum(1 for item in seen if item[0] == "list") == list_calls_before_retry
                  and "records_search" in repeated_text,
                  repeated_text)

            called = await http.post(
                "/api/v1/mcp", headers=plugin_headers,
                json=rpc("tools/call", {"name": "plugin_mcp_call", "arguments": {
                    "server": "worklog", "tool": "records_search",
                    "arguments": {"query": "migration"},
                }}))
            called_result = called.json().get("result") or {}
            called_text = (called_result.get("content") or [{}])[0].get("text", "")
            check("authorized connector call returns the real result",
                  called_result.get("isError") is False
                  and "Finished migration" in called_text, called_text)
            check("Hub resolves credentials internally for the proxy call",
                  len(seen) >= 2
                  and seen[-2][0] == "list" and seen[-1][0] == "call"
                  and seen[-2][1].get("headers", {}).get("X-Company-Key")
                  == "server-secret-never-leak"
                  and seen[-1][3] == {"query": "migration"}, seen)

            large = await http.post(
                "/api/v1/mcp", headers=plugin_headers,
                json=rpc("tools/call", {"name": "plugin_mcp_call", "arguments": {
                    "server": "worklog", "tool": "records_search",
                    "arguments": {"query": "large"},
                }}))
            large_text = ((large.json().get("result") or {}).get("content") or [{}])[0].get("text", "")
            check("oversized MCP results are marked and bounded",
                  '"truncated": true' in large_text and len(large_text) < 510_000,
                  len(large_text))

            calls_before_oversize = len(seen)
            oversized = await http.post(
                "/api/v1/mcp", headers=plugin_headers,
                json=rpc("tools/call", {"name": "plugin_mcp_call", "arguments": {
                    "server": "worklog", "tool": "records_search",
                    "arguments": {"query": "x" * 200_100},
                }}))
            check("oversized MCP arguments fail before reaching the connector",
                  (oversized.json().get("result") or {}).get("isError") is True
                  and len(seen) == calls_before_oversize,
                  oversized.text[:500])

            calls_before_denied = len(seen)
            denied = await http.post(
                "/api/v1/mcp", headers=plugin_headers,
                json=rpc("tools/call", {"name": "plugin_mcp_call", "arguments": {
                    "server": "worklog", "tool": "danger_delete", "arguments": {},
                }}))
            check("an unapproved tool is rejected before connector execution",
                  (denied.json().get("result") or {}).get("isError") is True
                  and "没有被当前插件绑定批准" in denied.text
                  and len(seen) == calls_before_denied, denied.text)

            wrong = await http.post(
                "/api/v1/mcp", headers=plugin_headers,
                json=rpc("tools/call", {"name": "plugin_mcp_list",
                                         "arguments": {"server": "ungranted"}}))
            check("ungranted connector fails closed",
                  (wrong.json().get("result") or {}).get("isError") is True,
                  wrong.text)

            async with SessionLocal() as session:
                device = await session.get(models.Client, CLIENT)
                device.mcp_enabled = []
                await session.commit()
            missing_grant = await http.post(
                "/api/v1/plugins/conversation-grant", headers=device_headers(),
                json={"pluginIds": [PLUGIN], "conversationId": "chat-no-tools"})
            check("conversation preflight fails before model execution when the employee disables the connector",
                  missing_grant.status_code == 409
                  and "尚未启用" in missing_grant.text, missing_grant.text)
            async with SessionLocal() as session:
                device = await session.get(models.Client, CLIENT)
                device.mcp_enabled = ["worklog"]
                await session.commit()

            async with SessionLocal() as session:
                version = await session.get(am.PluginVersion, VERSION)
                version.enabled = False
                await session.commit()
            revoked = await http.post(
                "/api/v1/mcp", headers=plugin_headers, json=rpc("tools/list"))
            check("revoked plugin invalidates an already issued ticket on the next call",
                  (revoked.json().get("error") or {}).get("code") == -32003,
                  revoked.text)

            async with SessionLocal() as session:
                version = await session.get(am.PluginVersion, VERSION)
                version.enabled = True
                client = await session.get(models.Client, CLIENT)
                ordinary_ticket = device_auth.issue_mcp_ticket(client)[0]
                await session.commit()
            ordinary_tools = await http.post(
                "/api/v1/mcp", headers={"Authorization": "Bearer " + ordinary_ticket},
                json=rpc("tools/list"))
            ordinary_names = [item.get("name") for item in
                              ((ordinary_tools.json().get("result") or {}).get("tools") or [])]
            check("ordinary SoduWork tool ticket keeps its existing task tools",
                  "task_create" in ordinary_names
                  and "plugin_mcp_call" not in ordinary_names, ordinary_names)

        async with SessionLocal() as session:
            audits = list((await session.execute(select(models.AuditLog).where(
                models.AuditLog.action.in_([
                    "plugin.conversation_grant", "plugin.mcp_call", "plugin.mcp_failed",
                ])))).scalars().all())
            audit_text = json.dumps([row.detail for row in audits], ensure_ascii=False)
            check("plugin grants and calls are auditable without arguments or secrets",
                  len(audits) >= 4
                  and "server-secret-never-leak" not in audit_text
                  and "migration" not in audit_text
                  and "Finished migration" not in audit_text,
                  audit_text)
            actor = await session.get(models.User, USER)
            activity = await audit.list_plugin_activity(session, actor, {BINDING}, version_ids={VERSION})
            check("plugin detail can attribute bounded connector activity without payloads",
                  activity["total"] >= 2
                  and activity["summary"]["success"] >= 1
                  and all(VERSION in (item.get("detail") or {}).get("versionIds", [])
                          for item in activity["items"])
                  and all("durationMs" in (item.get("detail") or {})
                          for item in activity["items"]), activity)
            unrelated = await audit.list_plugin_activity(session, actor, {"other-binding"},
                                                         version_ids={"other-version"})
            check("connector activity cannot be attributed to another plugin version",
                  unrelated["total"] == 0, unrelated)
    finally:
        mcp_http.list_tools = original_list
        mcp_http.call = original_call
        runner_hub.for_client = original_for_client
        runner_hub.pick_for = original_pick_for


async def guarded():
    try:
        await main()
    finally:
        await purge()
        async with SessionLocal() as session:
            check("smoke data cleaned",
                  await session.get(models.Client, CLIENT) is None
                  and await session.get(am.Plugin, PLUGIN) is None
                  and await session.get(models.AppSetting, mcp_servers.SETTING_KEY) is None)
        await engine.dispose()


asyncio.run(guarded())
print("PASS=%d FAIL=%d" % (passed, failed))
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
sys.exit(1 if failed else 0)
