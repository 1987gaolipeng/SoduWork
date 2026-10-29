"""Safe portable export and authenticated export/import roundtrip, no business calls."""
import os
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
import copy
import json
import tempfile
import unittest

import httpx
from skill_test_support import fixture
from app import models
from app.api import mcp_management
from app.services import capability_catalog, mcp_export, mcp_import


def http_row(id_="one", name="业务连接", **patch):
    return {"id": id_, "name": name, "type": "http", "url": "https://mcp.example.test/mcp",
            "headers": {"Authorization": "Bearer fixture-secret", "X-Tenant": "tenant-private"},
            "description": "password=do-not-export", "enabled": True,
            "approved": True, "approvedTarget": "https://mcp.example.test/mcp",
            "startupTimeoutSeconds": 25, "toolTimeoutSeconds": 120,
            "enabledTools": ["search", "read_document"], "disabledTools": ["delete_document"], **patch}


class ExportServiceTests(unittest.TestCase):
    def export(self, *rows):
        original = copy.deepcopy(rows)
        result = mcp_export.personal(list(rows), {"ids": [row["id"] for row in rows]})
        self.assertEqual(rows, original, "export never changes source configuration or its authorization")
        return result, json.loads(result["content"])["mcpServers"]

    def test_preserves_portable_controls_and_keys_without_credentials_or_active_approval(self):
        result, rows = self.export(http_row())
        exported = rows["业务连接"]
        self.assertEqual(exported["headers"], {"Authorization": "", "X-Tenant": ""})
        self.assertEqual(exported["startupTimeoutSeconds"], 25)
        self.assertEqual(exported["toolTimeoutSeconds"], 120)
        self.assertEqual(exported["enabledTools"], ["search", "read_document"])
        self.assertEqual(exported["disabledTools"], ["delete_document"])
        self.assertFalse(exported["enabled"])
        for key in ("id", "approved", "approvedTarget", "keycloak", "description", "command", "args"):
            self.assertNotIn(key, exported)
        for secret in ("fixture-secret", "tenant-private", "do-not-export", "Bearer", "••••"):
            self.assertNotIn(secret, json.dumps(result))
        parsed = mcp_management.personal_candidates(mcp_import.parse(result["content"].encode(), result["filename"]))
        self.assertTrue(parsed["items"][0]["valid"], parsed)
        self.assertFalse(parsed["items"][0]["row"]["enabled"])

    def test_userinfo_unknown_query_and_fragment_are_removed_and_loss_is_explained(self):
        result, rows = self.export(http_row(url="https://user:password@mcp.example.test:8443/mcp?custom=opaque-secret&version=1#private-fragment"))
        self.assertEqual(rows["业务连接"]["url"], "https://mcp.example.test:8443/mcp")
        for value in ("password", "opaque-secret", "private-fragment", "custom", "version=1"):
            self.assertNotIn(value, json.dumps(result))
        self.assertTrue(any("查询参数" in item for item in result["warnings"]))

    def test_all_trusted_templates_roundtrip_without_exporting_source_commands_or_paths(self):
        for template in capability_catalog.MCP_TEMPLATES:
            with self.subTest(template=template["key"]):
                raw = http_row(type="stdio", templateKey=template["key"], command="C:/private/bin/program",
                               args=["--password", "do-not-export"], env={"LOCAL_SECRET": "env-private"})
                result, rows = self.export(raw)
                exported = rows["业务连接"]
                self.assertEqual(exported["command"], template["template"]["command"])
                self.assertEqual(exported["args"], template["template"]["args"])
                self.assertEqual(exported["env"], {key: "" for key in template["template"].get("env", {})})
                for private in ("private", "LOCAL_SECRET", "do-not-export"):
                    self.assertNotIn(private, result["content"])
                parsed = mcp_management.personal_candidates(mcp_import.parse(result["content"].encode(), result["filename"]))
                self.assertTrue(parsed["items"][0]["valid"], parsed)
                self.assertEqual(parsed["items"][0]["row"]["templateKey"], template["key"])

    def test_unreviewed_command_and_managed_local_account_are_skipped_without_diagnostics(self):
        result, rows = self.export(http_row(), http_row("custom", "custom", type="stdio", command="C:/private/tool.exe",
                                                       args=["--token", "opaque-private"]),
                                  http_row("soduwork-feishu-" + "a" * 24, "feishu", url="http://127.0.0.1:43123/mcp"))
        self.assertEqual(list(rows), ["业务连接"])
        self.assertEqual({row["id"] for row in result["skipped"]}, {"custom", "soduwork-feishu-" + "a" * 24})
        for private in ("C:/private", "opaque-private", "43123"):
            self.assertNotIn(private, json.dumps(result))

    def test_secret_bearing_path_encoded_path_private_path_and_local_targets_are_rejected(self):
        targets = ["https://mcp.example.test/fixture-secret", "https://mcp.example.test/%66ixture-secret",
                   "https://mcp.example.test/Users/alice/private.txt", "https://mcp.example.test/C%3A/private/data",
                   "http://localhost:4567/mcp", "http://127.0.0.1:4567/mcp", "http://[::1]:4567/mcp",
                   "https://mcp.example.test/" + "x" * 50]
        for target in targets:
            with self.subTest(target=target), self.assertRaises(mcp_export.ExportError) as error:
                self.export(http_row(url=target))
            self.assertEqual(error.exception.status, 422)
            self.assertNotIn(target, str(error.exception))

    def test_credentials_cannot_leak_through_names_headers_or_tool_controls(self):
        variants = [http_row(name="fixture-secret"), http_row(headers={"Authorization": "Bearer fixture-secret", "fixture-secret": "value"}),
                    http_row(enabledTools=["fixture-secret"]), http_row(disabledTools=["C:/private/tools"])]
        for row in variants:
            with self.subTest(row=row), self.assertRaises(mcp_export.ExportError):
                self.export(row)
        cross = [http_row(), http_row("two", "second", url="https://example.test/fixture-secret", headers={})]
        result, rows = self.export(*cross)
        self.assertEqual(list(rows), ["业务连接"])
        self.assertNotIn("fixture-secret", json.dumps(result))

    def test_dynamic_auth_is_not_silently_downgraded_to_static_headers(self):
        for field in ("keycloak", "oauth", "headersHelper"):
            with self.subTest(field=field), self.assertRaises(mcp_export.ExportError) as error:
                self.export(http_row(**{field: {"secret": "private-oauth"}}))
            self.assertEqual(error.exception.status, 422)
            self.assertNotIn("private-oauth", str(error.exception))

    def test_unknown_foreign_duplicate_and_invalid_selection_are_rejected_atomically(self):
        for body, code in [({"ids": ["one", "foreign"]}, 404), ({"ids": ["one", "one"]}, 400),
                           ({"ids": []}, 400), ({"ids": ["one"], "clientId": "another"}, 400),
                           ({"ids": ["one"], "format": "toml"}, 400), ({"ids": [1]}, 400)]:
            with self.subTest(body=body), self.assertRaises(mcp_export.ExportError) as error:
                mcp_export.personal([http_row()], body)
            self.assertEqual(error.exception.status, code)
        with self.assertRaises(mcp_export.ExportError):
            mcp_export.personal([http_row(), http_row()], {"ids": ["one"]})

    def test_export_size_stays_within_the_existing_import_limit(self):
        controls = [str(index) + "x" * 195 for index in range(200)]
        rows = [http_row(str(index), "connection-" + str(index), enabledTools=controls,
                         disabledTools=["d" + value for value in controls]) for index in range(20)]
        with self.assertRaises(mcp_export.ExportError) as error:
            self.export(*rows)
        self.assertEqual(error.exception.status, 400)
        self.assertIn("1MB", str(error.exception))

    def test_tool_controls_are_not_weakened_to_make_invalid_config_exportable(self):
        for patch in ({"enabledTools": ["*"]}, {"enabledTools": ["same"], "disabledTools": ["same"]},
                      {"startupTimeoutSeconds": 999}, {"toolTimeoutSeconds": "invalid"}):
            with self.subTest(patch=patch), self.assertRaises(mcp_export.ExportError):
                self.export(http_row(**patch))



    def test_share_rejects_opaque_url_credentials_and_scrubs_secret_descriptions(self):
        for target in ("https://mcp.example.test/mcp?auth=opaque-private",
                       "https://mcp.example.test/fixture-secret", "https://mcp.example.test/%66ixture-secret"):
            with self.subTest(target=target), self.assertRaises(ValueError) as error:
                mcp_export.shared_spec(http_row(url=target, approvedTarget=target), "company-business")
            self.assertNotIn("opaque-private", str(error.exception))
            self.assertNotIn("fixture-secret", str(error.exception))
        original = http_row(description="Use the header value fixture-secret")
        before = copy.deepcopy(original)
        result = mcp_export.shared_spec(original, "company-business")
        self.assertEqual(result["description"], "")
        self.assertFalse(result["enabled"])
        self.assertFalse(result["approved"])
        self.assertEqual(result["headers"], {"Authorization": "", "X-Tenant": ""})
        self.assertEqual(original, before)
        self.assertNotIn("fixture-secret", json.dumps(result))

    def test_share_rejects_secret_names_tool_names_and_credential_field_names(self):
        for patch, name in (({}, "fixture-secret"), ({"enabledTools": ["fixture-secret"]}, "company"),
                            ({"headers": {"Authorization": "Bearer fixture-secret", "fixture-secret": "value"}}, "company")):
            with self.subTest(patch=patch, name=name), self.assertRaises(ValueError):
                mcp_export.shared_spec(http_row(**patch), name)

    def test_non_secret_template_fields_do_not_trigger_false_secret_match(self):
        template = capability_catalog.mcp_template("connector-tencent-meeting")
        spec = {**template["template"], "id": "meeting", "templateKey": template["key"],
                "approved": True, "approvedTarget": template["key"],
                "env": {"TENCENT_APP_ID": "123456", "TENCENT_SECRET_ID": "private-id-123", "TENCENT_SECRET_KEY": "private-key", "ALLOW_WRITES": "false"}}
        result = mcp_export.shared_spec(spec, "123456-company")
        self.assertEqual(result["name"], "123456-company")
        self.assertTrue(all(value == "" for value in result["env"].values()))
        document = mcp_export.personal([spec], {"ids": ["meeting"]})
        self.assertEqual(document["exported"], [spec["name"]])

class ExportApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-export-test-")
        self.app, self.tokens, self.sessions, self.cleanup = await fixture(self.temp.name)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        async with self.sessions() as session:
            alice = await session.get(models.Client, "device-alice")
            bob = await session.get(models.Client, "device-bob")
            alice.mcp_servers = [http_row()]
            bob.mcp_servers = [http_row("other", "other")]
            await session.commit()

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.cleanup()
        self.temp.cleanup()

    async def req(self, method, route, who="alice", **kwargs):
        return await self.http.request(method, "/api/v1" + route,
                                       headers={"Authorization": "Device " + self.tokens[who]}, **kwargs)

    async def test_authenticated_export_import_roundtrip_keeps_disabled_and_never_overwrites(self):
        response = await self.req("POST", "/mcp-servers/export", json={"ids": ["one"]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        document = response.json()
        self.assertNotIn("fixture-secret", response.text)
        uploaded = {"file": (document["filename"], document["content"])}
        preview = await self.req("POST", "/mcp-servers/import/preview", who="bob", files=uploaded)
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["summary"]["importable"], 1)
        first = await self.req("POST", "/mcp-servers/import?confirmed=true", who="bob", files=uploaded)
        self.assertEqual(first.status_code, 200, first.text)
        item = first.json()["importedRows"][0]
        self.assertFalse(item["enabled"])
        self.assertEqual(item["headers"], {"Authorization": "", "X-Tenant": ""})
        self.assertEqual(item["enabledTools"], ["search", "read_document"])
        second = await self.req("POST", "/mcp-servers/import?confirmed=true", who="bob", files=uploaded)
        self.assertEqual(second.json()["imported"], [])
        self.assertEqual(len(second.json()["personal"]), 2)
        async with self.sessions() as session:
            alice = await session.get(models.Client, "device-alice")
            self.assertEqual(alice.mcp_servers, [http_row()])

    async def test_sharing_reviewed_template_requires_only_required_fields(self):
        template = capability_catalog.mcp_template("connector-tencent-meeting")
        spec = {**template["template"], "id": "meeting", "templateKey": template["key"],
                "approved": True, "approvedTarget": template["key"],
                "env": {"TENCENT_APP_ID": "123456", "TENCENT_SDK_ID": "", "TENCENT_SECRET_ID": "private-id-123", "TENCENT_SECRET_KEY": "private-key"}}
        async with self.sessions() as session:
            client = await session.get(models.Client, "device-alice")
            client.mcp_servers = [spec]
            await session.commit()
        response = await self.req("POST", "/mcp-servers/meeting/share", json={"confirmed": True})
        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()["item"]
        self.assertNotIn("env.TENCENT_SDK_ID", item["requiredCredentials"])
        self.assertNotIn("env.ALLOW_WRITES", item["requiredCredentials"])
        self.assertIn("env.TENCENT_SECRET_KEY", item["requiredCredentials"])
        self.assertNotIn("private-key", response.text)
        self.assertTrue(all(value == "" for value in item["spec"]["env"].values()))

    async def test_authentication_and_foreign_id_cannot_be_bypassed_by_export(self):
        noauth = await self.http.post("/api/v1/mcp-servers/export", json={"ids": ["one"]})
        self.assertEqual(noauth.status_code, 401)
        denied = await self.req("POST", "/mcp-servers/export", who="bob", json={"ids": ["one"]})
        self.assertEqual(denied.status_code, 404, denied.text)
        self.assertNotIn("业务连接", denied.text)
        invalid = await self.req("POST", "/mcp-servers/export", who="bob", json={"ids": ["other"], "clientId": "device-alice"})
        self.assertEqual(invalid.status_code, 400, invalid.text)
        self.assertNotIn("fixture-secret", invalid.text)


if __name__ == "__main__":
    unittest.main()
