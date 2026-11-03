"""Device import -> personal use -> admin publication -> another client -> real tool."""
import os
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
import json
import tempfile
import unittest
import httpx
from skill_test_support import fixture
from mcp_test_support import protocol_server, runners, config
from app import models
from app.api import admin
from app.services import mcp_servers, mcp_import, plugin_mcp_gateway as gateway

class McpManagementTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-mcp-test-")
        self.app, self.tokens, self.sessions, self.cleanup = await fixture(self.temp.name)
        self.app.include_router(admin.router)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.peer, self.url, self.seen = protocol_server()
        self.runner_patch = runners(); self.runner_patch.start()
    async def asyncTearDown(self):
        self.runner_patch.stop(); self.peer.shutdown(); self.peer.server_close()
        await self.http.aclose(); await self.cleanup(); self.temp.cleanup()
    async def req(self, method, path, who="alice", **kwargs):
        return await self.http.request(method, "/api/v1" + path, headers={
            "Authorization": ("Bearer " if who in ("admin", "ordinaryUser") else "Device ") + self.tokens[who]}, **kwargs)
    async def imported(self):
        r = await self.req("POST", "/mcp-servers/import?confirmed=true",
                          files={"file": ("connections.json", json.dumps(config(self.url)))})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["personal"][0]
    async def shared(self):
        item = await self.imported()
        r = await self.req("POST", "/mcp-servers/" + item["id"] + "/share",
                          json={"name": "company-business", "confirmed": True})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["item"]
    async def test_import_roundtrip_private_probe_and_policy(self):
        preview = await self.req("POST", "/mcp-servers/import/preview", files={
            "file": ("connections.json", json.dumps(config(self.url)))})
        self.assertEqual(preview.json()["summary"]["importable"], 1)
        self.assertNotIn("private-fixture-key", preview.text)
        preview_row = preview.json()["servers"][0]
        self.assertEqual(preview_row["config"]["url"], self.url)
        self.assertIn("Authorization", preview_row["config"]["credentialKeys"])
        self.assertNotIn("private-fixture-key", json.dumps(preview_row["config"]))
        item = await self.imported()
        self.assertFalse(item["enabled"])
        self.assertEqual(item["headers"]["Authorization"], "••••")
        self.assertFalse((await self.req("GET", "/mcp-servers", who="bob")).json()["personal"])
        r = await self.req("POST", "/mcp-servers/probe", json=item)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["tools"], ["read_status"])
        self.assertIn("delete_item", r.json()["blockedTools"])
        self.assertNotIn("private-fixture-key", r.text)
        again = await self.imported()
        self.assertEqual(item["id"], again["id"])
        self.assertEqual(len((await self.req("GET", "/mcp-servers")).json()["personal"]), 1)
        item["enabled"] = True
        saved = await self.req("PUT", "/mcp-servers", json={"servers": [item], "enabledCompany": []})
        self.assertEqual(saved.status_code, 200, saved.text)
        async with self.sessions() as session:
            client = await session.get(models.Client, "device-alice")
            claims = {"pmcp": ["business"], "ref": "fixture", "cid": client.id}
            result = await gateway.call_tool(session, client, claims, "business", "read_status", {})
            self.assertIn("BUSINESS_OK", str(result))
            before = self.seen.count("tools/call")
            with self.assertRaises(ValueError):
                await gateway.call_tool(session, client, claims, "business", "delete_item", {})
            self.assertEqual(before, self.seen.count("tools/call"))
    async def test_share_publish_other_client_enable_use_and_disable(self):
        submission = await self.shared()
        self.assertNotIn("private-fixture-key", json.dumps(submission))
        self.assertEqual(submission["spec"]["headers"]["Authorization"], "")
        self.assertEqual((await self.req("GET", "/mcp-servers/submissions", who="bob")).json()["items"], [])
        denied = await self.req("GET", "/admin/capabilities/mcp/submissions", who="ordinaryUser")
        self.assertEqual(denied.status_code, 403)
        endpoint = "/admin/capabilities/mcp/submissions/" + submission["id"] + "/review"
        missing = await self.req("POST", endpoint, who="admin", json={"action": "publish", "server": submission["spec"]})
        self.assertEqual(missing.status_code, 400)
        spec = {**submission["spec"], "headers": {"Authorization": "Bearer company-fixture-key"}}
        r = await self.req("POST", endpoint, who="admin", json={"action": "publish", "server": spec})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("company-fixture-key", r.text)
        self.assertEqual((await self.req("POST", endpoint, who="admin", json={"action":"publish","server":spec})).status_code, 200)
        view = (await self.req("GET", "/mcp-servers", who="bob")).json()
        self.assertEqual(len(view["company"]), 1)
        self.assertEqual(view["enabledCompany"], [])
        company = view["company"][0]
        probe = await self.req("POST", "/mcp-servers/company/" + company["id"] + "/probe", who="bob")
        self.assertTrue(probe.json()["ok"], probe.text)
        await self.req("PUT", "/mcp-servers", who="bob", json={"servers": [], "enabledCompany": ["company-business"]})
        async with self.sessions() as session:
            client = await session.get(models.Client, "device-bob")
            resolved = await gateway.authorized_servers(session, client, {"pmcp":["company-business"]})
            self.assertNotIn("soduworkRunOn",resolved["company-business"])
            result = await gateway.call_tool(session, client, {"pmcp":["company-business"],"ref":"bob","cid":client.id},
                                            "company-business", "read_status", {})
            self.assertIn("BUSINESS_OK", str(result))
        admin_view = (await self.req("GET", "/admin/mcp-servers", who="admin")).json()
        original = next(row for row in admin_view["servers"] if row["id"] == company["id"])
        company["enabled"] = False
        r = await self.req("POST", "/admin/mcp-servers/upsert", who="admin", json={"server":company, "original":original})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.req("GET", "/mcp-servers", who="bob")).json()["company"], [])
        async with self.sessions() as session:
            client = await session.get(models.Client, "device-bob")
            with self.assertRaises(ValueError):
                await gateway.call_tool(session, client, {"pmcp":["company-business"]}, "company-business", "read_status", {})
    async def test_consent_capacity_invalid_inputs_and_no_execution(self):
        r = await self.req("POST", "/mcp-servers/import", files={"file":("x.json",json.dumps(config(self.url)))})
        self.assertEqual(r.status_code, 400)
        bad = {"mcpServers":{"untrusted":{"command":"not-a-trusted-command","args":["--do-not-execute"]}}}
        r = await self.req("POST", "/mcp-servers/import/preview", files={"file":("x.json",json.dumps(bad))})
        self.assertEqual(r.json()["summary"]["importable"], 0)
        for raw in [b"["*100, b"x"*(1024*1024+1)]:
            r = await self.req("POST", "/mcp-servers/import/preview", files={"file":("x.json",raw)})
            self.assertEqual(r.status_code, 400)
        self.assertEqual(self.seen, [])
    def test_formats_and_unsupported_policies(self):
        toml = '[mcp_servers.search]\nurl = "https://example.com/mcp"\nenabled_tools = ["search"]\n'
        self.assertEqual(mcp_import.parse(toml.encode(),"config.toml")["items"][0]["row"]["enabledTools"],["search"])
        for field, value in [("enabled_tools",["*"]),("bearer_token_env_var","PRIVATE_TOKEN"),("oauth",{"x":1}),("url","https://host/?token=secret")]:
            data = config(self.url); data["mcpServers"]["business"][field] = value
            self.assertFalse(mcp_import.parse(json.dumps(data).encode(),"x.json")["items"][0]["valid"])
    async def test_rejection_retry_duplicate_and_long_credentials(self):
        item = await self.shared()
        endpoint = "/admin/capabilities/mcp/submissions/" + item["id"] + "/review"
        rejected = await self.req("POST", endpoint, who="admin", json={"action":"reject"})
        self.assertEqual(rejected.json()["item"]["status"],"rejected")
        retried = await self.shared()
        self.assertEqual(retried["id"],item["id"])
        self.assertEqual(retried["status"],"pending")
        data = config(self.url); secret = "B" * 2000
        data["mcpServers"]["business-long"] = data["mcpServers"].pop("business")
        data["mcpServers"]["business-long"]["headers"]["Authorization"] = secret
        r = await self.req("POST","/mcp-servers/import?confirmed=true",files={"file":("long.json",json.dumps(data))})
        self.assertEqual(r.status_code,200,r.text)
        self.assertNotIn(secret,r.text)
        async with self.sessions() as session:
            client = await session.get(models.Client,"device-alice")
            self.assertEqual(next(x for x in mcp_servers.personal_load(client) if x["name"]=="business-long")["headers"]["Authorization"],secret)

    def test_stdio_probe_reads_real_structured_bridge_response(self):
        from pathlib import Path
        from unittest.mock import patch
        import shutil
        from app.services import skills
        repo = Path(__file__).resolve().parent.parent
        spec = {"name":"stdio-fixture","command":shutil.which("node"),
                "args":[str(repo/"client/tests/fixtures/mcp-peer.cjs")],"env":{},
                "enabledTools":["read_status"],"disabledTools":["delete_item"]}
        with patch.object(skills,"bundled_root",lambda:str(repo/"skills")):
            result=mcp_servers.probe_sync(spec)
            self.assertTrue(result["ok"],result)
            self.assertEqual(result["tools"],["read_status"])
            self.assertIn("delete_item",result["blockedTools"])
            self.assertIn("STDIO_BUSINESS_OK",mcp_servers.bridge_call_sync("stdio-fixture",spec,"read_status",{}))
            spec["enabledTools"]=["missing"]
            self.assertFalse(mcp_servers.probe_sync(spec)["ok"])

    async def test_concurrent_company_save_rejects_stale_snapshot(self):
        async with self.sessions() as session:
            await mcp_servers.save(session, [{"id":"seed","name":"seed","command":"node","enabled":False}])
            await session.commit()
        async with self.sessions() as a, self.sessions() as b:
            first = await mcp_servers.load(a)
            second = await mcp_servers.load(b)
            await mcp_servers.save(a, first + [{"id":"new","name":"new","command":"node","enabled":False}])
            await a.commit()
            # Keep the old snapshot alive, as a stale admin modal would.
            old = await b.get(models.AppSetting,mcp_servers.SETTING_KEY)
            old.value = json.dumps(first,ensure_ascii=False)
            from sqlalchemy.orm.attributes import set_committed_value
            set_committed_value(old,"value",json.dumps(first,ensure_ascii=False))
            with self.assertRaises(ValueError):
                await mcp_servers.save(b, second + [{"id":"other","name":"other","command":"node"}])

    async def test_admin_argument_text_probe_save_reload_and_array_edit(self):
        from unittest.mock import AsyncMock, patch
        from types import SimpleNamespace
        spec = {"id": "comma-arguments", "name": "Comma arguments", "type": "stdio",
                "command": "node", "args": 'fixture.js, "a,b", "", --flag, --flag', "enabled": False}
        expected = ["fixture.js", "a,b", "", "--flag", "--flag"]
        runner = SimpleNamespace(id="isolated", host="fixture", call=AsyncMock(
            return_value={"ok": True, "data": {"ok": True, "tools": []}}))
        with patch("app.services.runner_hub.pick_for", return_value=runner):
            probe = await self.req("POST", "/admin/mcp-servers/probe", who="admin", json=spec)
        self.assertEqual(probe.status_code, 200, probe.text)
        self.assertTrue(probe.json()["ok"], probe.text)
        self.assertEqual(runner.call.call_args.args[1]["spec"]["args"], expected)
        saved = await self.req("POST", "/admin/mcp-servers/upsert", who="admin", json={"server": spec})
        self.assertEqual(saved.status_code, 200, saved.text)
        view = await self.req("GET", "/admin/mcp-servers", who="admin")
        original = next(row for row in view.json()["servers"] if row["id"] == spec["id"])
        self.assertEqual(original["args"], expected)
        updated = await self.req("POST", "/admin/mcp-servers/upsert", who="admin",
            json={"server": {**original, "name": "Edited"}, "original": original})
        self.assertEqual(updated.status_code, 200, updated.text)
        for bad in ['"unfinished', ','.join(['arg'] * 31)]:
            with patch("app.services.runner_hub.pick_for") as pick:
                probe = await self.req("POST", "/admin/mcp-servers/probe", who="admin", json={**spec, "args": bad})
                self.assertEqual(probe.status_code, 200, probe.text)
                self.assertFalse(probe.json()["ok"])
                pick.assert_not_called()
            saved = await self.req("POST", "/admin/mcp-servers/upsert", who="admin",
                json={"server": {**spec, "id": "invalid", "name": "Invalid", "args": bad}})
            self.assertEqual(saved.status_code, 409, saved.text)

if __name__ == "__main__":
    unittest.main()
