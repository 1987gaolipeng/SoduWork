"""Isolated regression suite: no production database, server or MCP execution."""
import base64
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import AsyncMock, patch

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.db import Base
from app import models, automation_models as am
from app.services import (plugin_adapters, plugin_packages, plugin_drafts,
                          plugin_package_resources, plugin_service, plugin_catalog,
                          plugin_installations, plugin_conversation, plugin_mcp_gateway,
                          plugin_audience)


def archive(files):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, content in files.items():
            bundle.writestr(name, json.dumps(content) if isinstance(content, dict) else content)
    return out.getvalue()


def skill(text="Use references/policy.md to finish."):
    return "---\nname: business-method\ndescription: Summarize business progress\n---\n" + text


class PortablePackageTests(unittest.TestCase):
    def test_large_package_is_complete_and_validated_before_install(self):
        files = {
            "plugin.json": {"$schema": plugin_adapters.PORTABLE_SCHEMA, "name": "business"},
            "skills/business/SKILL.md": skill(),
            **{f"skills/business/references/part-{i}.md": f"section {i}" for i in range(80)},
        }
        parsed = plugin_packages.parse(archive(files))
        self.assertEqual(len(parsed["resourceBundle"]["resources"]), 81)
        self.assertEqual(len(parsed["capabilities"]["resources"]), 81)
        self.assertEqual(len(plugin_packages.personal_draft(parsed)["resources"]), 81)
        files["skills/business/references/oversized.bin"] = b"x" * (8 * 1024 * 1024)
        with self.assertRaisesRegex(ValueError, "8MB"):
            plugin_packages.parse(archive(files))

    def test_native_maximum_previous_resources_remain_runnable(self):
        draft = {"template": "method", "key": "native-method", "name": "Native", "description": "Complete native resource package",
                 "version": "1.0.0", "instructions": "Read the method and produce evidence.",
                 "resources": [{"path": f"references/part-{i}.md", "kind": "reference",
                                "encoding": "utf8", "content": f"section {i}"} for i in range(64)]}
        parsed = plugin_packages.parse(plugin_drafts.build(draft))
        self.assertGreater(len(parsed["resourceBundle"]["resources"]), 64)
        self.assertEqual(parsed["capabilities"]["resources"], parsed["manifest"]["resources"])

    def test_native_long_instructions_are_not_replaced_with_a_truncated_duplicate(self):
        instructions = "A" * 7000 + "FINAL-NATIVE-ACCEPTANCE"
        draft = {"template": "method", "key": "native-method", "name": "Native",
                 "version": "1.0.0", "description": "Native method", "instructions": instructions}
        parsed = plugin_packages.parse(plugin_drafts.build(draft))
        self.assertEqual(plugin_packages.personal_draft(parsed)["instructions"], instructions)
        original = "B" * 10000 + "FINAL-IMPORTED-ACCEPTANCE"
        parsed["manifest"]["instructions"] = original
        imported = plugin_packages.personal_draft(parsed)
        self.assertEqual(base64.b64decode(imported["resources"][0]["content"]).decode(), original)
        self.assertIn(imported["resources"][0]["path"], imported["instructions"])

    def test_malformed_manifest_is_rejected_and_portable_discovery_is_fixed(self):
        for manifest in [[], {"$schema": plugin_adapters.PORTABLE_SCHEMA, "name": "business",
                             "extensions": ["bad"]},
                         {"$schema": plugin_adapters.PORTABLE_SCHEMA, "name": "business",
                          "extensions": {"com.openai": "bad"}}]:
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                plugin_packages.parse(archive({"plugin.json": json.dumps(manifest)}))
        parsed = plugin_packages.parse(archive({
            "plugin.json": {"$schema": plugin_adapters.PORTABLE_SCHEMA, "name": "business"},
            "SKILL.md": skill(),
            "skills/business/SKILL.md": skill(),
        }))
        self.assertEqual(len(parsed["capabilities"]["bundledSkills"]), 1)
        self.assertEqual(parsed["capabilities"]["bundledSkills"][0]["archivePath"], "skills/business/SKILL.md")

    def test_portable_root_and_overlay_precedence(self):
        parsed = plugin_packages.parse(archive({
            "plugin.json": {"$schema": plugin_adapters.PORTABLE_SCHEMA, "name": "business",
                            "version": "1.2.0", "extensions": {"com.openai": {
                                "interface": {"displayName": "Portable business"},
                                "mcpServers": {"not-portable": {}}}}},
            ".codex-plugin/plugin.json": {"name": "legacy", "interface": {"displayName": "Wrong"}},
            ".mcp.json": {"legacy-only": {"url": "https://invalid.example/mcp"}},
            "skills/business/SKILL.md": skill(),
        }))
        self.assertEqual(parsed["sourceKind"], "agent-plugins")
        self.assertEqual(parsed["manifest"]["key"], "business")
        self.assertEqual(parsed["manifest"]["name"], "Portable business")
        self.assertEqual(parsed["capabilities"]["mcpServers"], [])
        self.assertFalse(parsed["capabilities"]["hasWorkflow"])

    def test_wrapped_portable_and_same_root_legacy_overlays(self):
        for files in [
            {"wrapped/plugin.json": {"$schema": plugin_adapters.PORTABLE_SCHEMA, "name": "business"},
             "wrapped/skills/business/SKILL.md": skill()},
            {".codex-plugin/plugin.json": {"name": "business", "skills": "./skills/"},
             ".claude-plugin/plugin.json": {"name": "business"},
             "skills/business/SKILL.md": skill()},
        ]:
            parsed = plugin_packages.parse(archive(files))
            draft = plugin_packages.personal_draft(parsed)
            self.assertEqual(len(parsed["capabilities"]["bundledSkills"]), 1)
            self.assertTrue(any(row["path"].endswith("/SKILL.md") for row in draft["resources"]))

    def test_multiple_unrelated_packages_are_rejected(self):
        with self.assertRaises(ValueError):
            plugin_packages.parse(archive({
                "first/.codex-plugin/plugin.json": {"name": "first"},
                "second/.claude-plugin/plugin.json": {"name": "second"},
            }))

    def test_pure_mcp_does_not_require_workflow_or_skill(self):
        for manifest, mcp_name in [
            ({"$schema": plugin_adapters.PORTABLE_SCHEMA, "name": "connector"}, "mcp.json"),
            ({"name": "connector"}, ".mcp.json"),
        ]:
            manifest_name = "plugin.json" if "$schema" in manifest else ".codex-plugin/plugin.json"
            parsed = plugin_packages.parse(archive({
                manifest_name: manifest,
                mcp_name: {"mcpServers": {"business": {"type": "streamable-http",
                                                       "url": "https://invalid.example/mcp"}}},
            }))
            self.assertEqual(parsed["capabilities"]["mcpServers"], ["business"])
            self.assertFalse(parsed["capabilities"]["hasWorkflow"])
            self.assertFalse(parsed["capabilities"].get("adapterBlockers"))
            draft = plugin_packages.personal_draft(parsed)
            self.assertEqual(draft["template"], "connector")
            self.assertNotIn("invalid.example", json.dumps(draft))

    def test_full_skill_and_binary_resources_survive_personal_export(self):
        long_text = skill("step\n" * 4000 + "\nFINAL-ACCEPTANCE-MARKER")
        parsed = plugin_packages.parse(archive({
            ".codex-plugin/plugin.json": {"name": "business", "version": "1.0.0"},
            "skills/business/SKILL.md": long_text,
            "skills/business/references/policy.md": "A complete policy",
            "skills/business/scripts/check.py": "print('verified')",
            "assets/template.bin": b"\x00\x01\xff",
        }))
        draft = plugin_packages.personal_draft(parsed)
        resources = {row["path"]: base64.b64decode(row["content"]) for row in draft["resources"]}
        prefix = plugin_package_resources.PREFIX
        self.assertEqual(resources[prefix + "skills/business/SKILL.md"], long_text.encode())
        self.assertEqual(resources[prefix + "assets/template.bin"], b"\x00\x01\xff")
        roundtrip = plugin_packages.parse(plugin_drafts.build(draft))
        self.assertEqual(roundtrip["resources"], draft["resources"])
        self.assertIn("SKILL.md", draft["instructions"])

    def test_hooks_remain_inert_and_paths_cannot_escape(self):
        parsed = plugin_packages.parse(archive({
            ".codex-plugin/plugin.json": {"name": "business"},
            "skills/business/SKILL.md": skill(),
            "hooks/hooks.json": {"hooks": {"SessionStart": "must-not-run"}},
            "hooks/start.py": "raise RuntimeError('never execute during install')",
        }))
        draft = plugin_packages.personal_draft(parsed)
        self.assertIn("hooks", parsed["capabilities"].get("unsupportedComponents", []))
        self.assertNotIn("hooks/hooks.json", " ".join(row["path"] for row in draft["resources"]))
        with self.assertRaises(ValueError):
            plugin_packages.parse(archive({"../SKILL.md": skill()}))

    def test_custom_mcp_config_never_becomes_a_runtime_resource(self):
        parsed = plugin_packages.parse(archive({
            ".codex-plugin/plugin.json": {"name": "business", "mcpServers": "./settings/connections.json"},
            "skills/business/SKILL.md": skill(),
            "settings/connections.json": {"mcpServers": {"business": {
                "url": "https://invalid.example/mcp", "headers": {"Authorization": "Bearer fixture-private-value"}}}},
        }))
        draft = plugin_packages.personal_draft(parsed)
        self.assertEqual(draft["mcpServers"], ["business"])
        self.assertNotIn("settings/connections.json", " ".join(row["path"] for row in draft["resources"]))
        self.assertNotIn("fixture-private-value", json.dumps(draft))


class InstalledLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-plugin-lifecycle-")
        self.package_patch = patch.object(plugin_packages, "package_root", return_value=self.temp.name)
        self.package_patch.start()
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.author = models.User(id="author", username="author", org_id="company", display_name="Author")
        self.reader = models.User(id="reader", username="reader", org_id="company")
        self.session.add_all([
            models.OrgUnit(id="company", name="Company"),
            models.OrgUnit(id="foreign", name="Foreign"),
            self.author, self.reader,
            models.User(id="outsider", username="outsider", org_id="foreign"),
            models.Client(id="author-device", user_ref="author"),
            models.Client(id="reader-device", user_ref="reader"),
        ])
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()
        self.package_patch.stop()
        self.temp.cleanup()

    async def test_signed_publication_http_two_employees_and_admin(self):
        import inspect
        import httpx
        from datetime import datetime, timezone
        from fastapi import FastAPI, Request
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives import serialization
        from app.api import plugin_client_catalog as client_api, plugins as admin_api
        from app.services import plugin_signatures
        from app.db import get_session
        from app.deps import current_client

        app = FastAPI()
        app.include_router(client_api.router)
        app.include_router(admin_api.router)
        async def session_dependency():
            yield self.session
        async def device_dependency(request: Request):
            return await self.session.get(models.Client, request.headers["x-fixture-device"])
        admin = models.User(id="reviewer", username="reviewer", org_id="company", is_super=True)
        self.session.add(admin)
        await self.session.commit()
        async def admin_dependency():
            return admin
        app.dependency_overrides[get_session] = session_dependency
        app.dependency_overrides[current_client] = device_dependency
        dependency = inspect.signature(admin_api.trust_version).parameters["user"].default.dependency
        app.dependency_overrides[dependency] = admin_dependency
        # Only authentication is fixture-owned. HTTP handlers, signing, storage,
        # review, catalog, install and runtime resolution are production code.
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://isolated") as http:
            author = {"x-fixture-device": "author-device"}
            reader = {"x-fixture-device": "reader-device"}
            draft = {"template":"method", "key":"signed-business", "name":"Signed business",
                     "version":"1.0.0", "description":"Share a complete business method",
                     "instructions":"Read the supplied policy and summarize verified progress.",
                     "resources":[{"path":"references/policy.md","kind":"reference",
                                   "encoding":"utf8","content":"Only cite verified facts."}]}
            response = await http.post("/api/v1/plugins/drafts/signing-payload", headers=author,
                json={"draft":draft,"keyId":"isolated-publisher","signedAt":datetime.now(timezone.utc).isoformat()})
            self.assertEqual(response.status_code,200,response.text)
            payload = response.json()["payload"]
            private = Ed25519PrivateKey.generate()
            public = base64.b64encode(private.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
            signature = {key:payload[key] for key in ("schema","algorithm","keyId","signedAt")}
            signature["signature"] = base64.b64encode(private.sign(
                plugin_signatures.canonical_bytes(payload))).decode()
            response = await http.post("/api/v1/plugins/personal-publish", headers=author,
                json={"draft":draft,"signature":signature,
                      "publisher":{"keyId":payload["keyId"],"publicKey":public},
                      "visibility":"users","userIds":["reader"]})
            self.assertEqual(response.status_code,200,response.text)
            version = (await self.session.execute(select(am.PluginVersion).where(
                am.PluginVersion.version=="1.0.0"))).scalar_one()
            plugin = await self.session.get(am.Plugin,version.plugin_id)
            self.assertEqual(version.trust_state,"quarantined")
            self.assertEqual((await http.get("/api/v1/plugins/catalog",headers=reader)).json()["items"],[])
            await plugin_signatures.register_candidate(self.session,version,plugin,admin,{})
            response = await http.post(f"/api/v1/admin/plugins/versions/{version.id}/trust",
                                       json={"enabled":True,"note":"Verified isolated package"})
            self.assertEqual(response.status_code,200,response.text)
            catalog = (await http.get("/api/v1/plugins/catalog",headers=reader)).json()
            item = next(row for row in catalog["items"] if row["pluginId"]==plugin.id)
            self.assertFalse(item["installed"])
            response = await http.put(f"/api/v1/plugins/{plugin.id}/installation",headers=reader,
                                     json={"enabled":True,"expectedVersionId":version.id})
            self.assertEqual(response.status_code,200,response.text)
            legacy = await http.post("/api/v1/plugins/conversation-grant",headers=reader,
                                     json={"pluginIds":[plugin.id],"conversationId":"legacy-chat"})
            self.assertEqual(legacy.status_code,409)
            self.assertIn("更新 SoduWork 客户端",legacy.json()["detail"])
            response = await http.post("/api/v1/plugins/conversation-grant",headers=reader,
                                      json={"pluginIds":[plugin.id],"conversationId":"reader-chat","resourceProtocol":1})
            self.assertEqual(response.status_code,200,response.text)
            body = response.json()
            self.assertNotIn("_versionIds",body)
            self.assertNotIn("_bindingIds",body)
            self.assertTrue(body["items"][0]["resourceBundle"]["resources"])
            rejected = await http.post("/api/v1/plugins/conversation-grant",headers=author,
                                      json={"pluginIds":[plugin.id]})
            self.assertEqual(rejected.status_code,409)
            response = await http.post(f"/api/v1/admin/plugins/versions/{version.id}/trust",
                                       json={"enabled":False,"note":"Revoke isolated version"})
            self.assertEqual(response.status_code,200,response.text)
            rejected = await http.post("/api/v1/plugins/conversation-grant",headers=reader,
                                      json={"pluginIds":[plugin.id]})
            self.assertEqual(rejected.status_code,409)

    async def publish(self, version="1.0.0", **kwargs):
        data = plugin_drafts.build({"template": "method", "key": "business",
            "name": "Business", "version": version, "description": "Summarize progress",
            "instructions": "Verify facts and produce the report.", **kwargs})
        result = await plugin_service.install(
            self.session, data, self.author, "company", source_channel="personal-publish")
        row = await self.session.get(am.PluginVersion, result["versionId"])
        await plugin_service.approve_version(self.session, row, True, "Reviewer")
        return row

    async def install(self, version):
        return await plugin_installations.install_current(
            self.session, "reader", version.plugin_id, version.id)

    async def test_publish_review_share_install_use_without_binding(self):
        version = await self.publish()
        before = await plugin_catalog.client_catalog(self.session, "company", user_id="reader")
        self.assertFalse(before["items"][0]["installed"])
        await self.install(version)
        catalog = await plugin_catalog.client_catalog(self.session, "company", user_id="reader")
        self.assertTrue(catalog["items"][0]["conversationUse"]["available"])
        result = await plugin_conversation.resolve(self.session, "company",
            [version.plugin_id], user_id="reader", include_resources=True)
        self.assertEqual(result["_versionIds"], [version.id])
        self.assertTrue(result["items"][0]["resourceBundle"]["resources"])
        self.assertEqual(result["items"][0]["capabilities"]["skills"], [])
        self.assertEqual(await self.session.scalar(select(func.count()).select_from(am.PluginBinding)), 0)
        with self.assertRaises(ValueError):
            await plugin_conversation.resolve(self.session, "foreign", [version.plugin_id], user_id="outsider")
        await plugin_installations.uninstall(self.session, "reader", version.plugin_id)
        with self.assertRaises(ValueError):
            await plugin_conversation.resolve(self.session, "company", [version.plugin_id], user_id="reader")

    async def test_upgrade_is_explicit_and_revocation_blocks_old_version(self):
        old = await self.publish()
        await self.install(old)
        new = await self.publish("2.0.0", mcpServers=["new-connection"])
        catalog = await plugin_catalog.client_catalog(self.session, "company", user_id="reader")
        item = catalog["items"][0]
        self.assertTrue(item["updateAvailable"])
        self.assertTrue(item["conversationUse"]["available"])
        result = await plugin_conversation.resolve(self.session, "company", [old.plugin_id], user_id="reader")
        self.assertEqual(result["_versionIds"], [old.id])
        self.assertEqual(result["items"][0]["capabilities"]["mcpServers"], [])
        await plugin_service.approve_version(self.session, old, False, "Reviewer")
        with self.assertRaises(ValueError):
            await plugin_conversation.resolve(self.session, "company", [old.plugin_id], user_id="reader")
        await self.install(new)
        result = await plugin_conversation.resolve(self.session, "company", [old.plugin_id], user_id="reader")
        self.assertEqual(result["_versionIds"], [new.id])

    async def test_mcp_ticket_rechecks_installation_and_version(self):
        version = await self.publish(mcpServers=["business-tools"])
        await self.install(version)
        client = await self.session.get(models.Client, "reader-device")
        claims = {"pvids": [version.id]}
        self.assertEqual(await plugin_mcp_gateway._installed_names(self.session, client, claims), ["business-tools"])
        with patch.object(plugin_mcp_gateway.mcp_servers, "runtime_for_dispatch",
                          AsyncMock(side_effect=ValueError("Connection not enabled"))):
            with self.assertRaises(ValueError):
                await plugin_mcp_gateway.validate_versions(self.session, client, [version.id])
        await plugin_installations.uninstall(self.session, "reader", version.plugin_id)
        with self.assertRaises(ValueError):
            await plugin_mcp_gateway._installed_names(self.session, client, claims)

    async def test_personal_connection_is_consistent_from_catalog_to_grant_and_revocation(self):
        from app.api import plugin_client_catalog as api
        from app.auth import verify_claims
        from fastapi import HTTPException

        version = await self.publish(mcpServers=["feishu"])
        self.session.add(am.PluginCatalogPolicy(plugin_id=version.plugin_id,
                         authentication="on_install", installation="installed_by_default"))
        client = await self.session.get(models.Client, "reader-device")
        client.auth_state = "active"
        endpoint = "http://127.0.0.1:39231/mcp"
        client.mcp_servers = [{"id": "native-feishu", "name": "feishu", "type": "http",
            "enabled": True, "approved": True, "approvedTarget": endpoint, "url": endpoint,
            "headers": {"Authorization": "Bearer isolated-native-secret"}}]
        peer = models.Client(id="reader-other-device", user_ref="reader", auth_state="active")
        self.session.add(peer)
        await self.session.commit()
        catalog = await api.client_plugin_catalog(client=client, session=self.session)
        item = next(item for item in catalog["items"] if item["pluginId"] == version.plugin_id)
        self.assertTrue(item["dependencyReadiness"]["ok"])
        body = {"pluginIds": [version.plugin_id], "resourceProtocol": 1}
        result = await api.client_plugin_conversation_grant(body, client, self.session)
        self.assertEqual(result["mcpGrant"]["servers"], ["feishu"])
        claims = verify_claims(result["mcpGrant"]["ticket"], token_type="plugin-mcp")
        self.assertEqual(claims["pvids"], [version.id])
        self.assertEqual(set(await plugin_mcp_gateway.authorized_servers(self.session, client, claims)), {"feishu"})
        self.assertNotIn("isolated-native-secret", json.dumps([catalog, result]))
        with self.assertRaises(HTTPException) as rejected:
            await api.client_plugin_conversation_grant(body, peer, self.session)
        self.assertEqual(rejected.exception.status_code, 409)
        client.mcp_servers = []
        await self.session.commit()
        with self.assertRaises(HTTPException):
            await api.client_plugin_conversation_grant(body, client, self.session)
        with self.assertRaises(ValueError):
            await plugin_mcp_gateway.authorized_servers(self.session, client, claims)

    async def test_market_app_uses_native_connection_without_company_registry(self):
        from app.api import plugin_client_catalog as api
        from fastapi import HTTPException
        version = await self.publish(mcpServers=["business-tools"], ui={"contributions": [{
            "id": "main", "title": "Business", "slot": "workspace.navigation",
            "source": {"type": "external", "url": "https://app.example/home",
                       "bridge": {"version": 1, "capabilities": ["mcp.connect"]}}}]})
        self.session.add(am.PluginCatalogPolicy(plugin_id=version.plugin_id,
                         authentication="on_install", installation="available"))
        await self.session.commit()
        client = await self.session.get(models.Client, "reader-device")
        catalog = await plugin_catalog.client_catalog(self.session, "company", user_id="reader")
        self.assertEqual(catalog["items"][0]["dependencyReadiness"]["requiredMcp"], [])
        await api.set_client_plugin_installation(version.plugin_id,
            {"enabled": True, "expectedVersionId": version.id}, client, self.session)
        binding = {"pluginId": version.plugin_id, "versionId": version.id,
                   "contributionId": "main", "origin": "https://app.example",
                   "server": "business-tools"}
        body = {"pluginIds": [version.plugin_id], "resourceProtocol": 1,
                "applicationConnection": binding}
        result = await api.client_plugin_conversation_grant(body, client, self.session)
        self.assertIsNone(result["mcpGrant"])
        self.assertEqual(result["items"][0]["versionId"], version.id)
        self.assertTrue(result["items"][0]["resourceBundle"]["resources"])
        catalog = await plugin_catalog.client_catalog(self.session, "company", user_id="reader")
        self.assertEqual(catalog["items"][0]["conversationVersionId"], version.id)
        self.assertTrue(catalog["items"][0]["conversationUse"]["available"])
        for change in ({"origin": "https://other.example"}, {"server": "other"},
                       {"versionId": "not-installed"}, {"contributionId": "other"}):
            with self.subTest(change=change), self.assertRaises(HTTPException):
                await api.client_plugin_conversation_grant(
                    {**body, "applicationConnection": {**binding, **change}}, client, self.session)
        for invalid in ([], "invalid", {**binding, "token": "must-not-be-sent"}):
            with self.subTest(binding_type=type(invalid).__name__), self.assertRaises(HTTPException):
                await api.client_plugin_conversation_grant(
                    {**body, "applicationConnection": invalid}, client, self.session)
        with self.assertRaises(HTTPException):
            await api.client_plugin_conversation_grant(
                {"pluginIds": [version.plugin_id], "resourceProtocol": 1}, client, self.session)
        await plugin_installations.uninstall(self.session, "reader", version.plugin_id)
        with self.assertRaises(HTTPException):
            await api.client_plugin_conversation_grant(body, client, self.session)

    async def test_mixed_app_ticket_preserves_hub_scope_and_version_revocation(self):
        from app.api import plugin_client_catalog as api
        from app.auth import verify_claims
        from fastapi import HTTPException
        version = await self.publish(mcpServers=["business-tools", "soduwork-media"], ui={"contributions": [{
            "id": "main", "title": "Business", "slot": "workspace.navigation",
            "source": {"type": "external", "url": "https://app.example/home",
                       "bridge": {"version": 1, "capabilities": ["mcp.connect"]}}}]})
        await self.install(version)
        client = await self.session.get(models.Client, "reader-device")
        client.auth_state = "active"
        await self.session.commit()
        binding = {"pluginId": version.plugin_id, "versionId": version.id,
                   "contributionId": "main", "origin": "https://app.example", "server": "business-tools"}
        body = {"pluginIds": [version.plugin_id], "resourceProtocol": 1, "applicationConnection": binding}
        result = await api.client_plugin_conversation_grant(body, client, self.session)
        self.assertEqual(result["mcpGrant"]["servers"], ["soduwork-media"])
        claims = verify_claims(result["mcpGrant"]["ticket"], token_type="plugin-mcp")
        self.assertEqual(claims["appmcp"], {version.id: ["business-tools"]})
        servers = await plugin_mcp_gateway.authorized_servers(self.session, client, claims)
        self.assertEqual(set(servers), {"soduwork-media"})
        await plugin_service.approve_version(self.session, version, False, "Reviewer")
        with self.assertRaises(ValueError):
            await plugin_mcp_gateway.authorized_servers(self.session, client, claims)
        with self.assertRaises(HTTPException):
            await api.client_plugin_conversation_grant(body, client, self.session)

    async def test_app_ticket_exclusion_is_scoped_to_one_installed_version(self):
        version = await self.publish(mcpServers=["business-tools", "company-tools"])
        await self.install(version)
        client = await self.session.get(models.Client, "reader-device")
        claims = {"pvids": [version.id], "appmcp": {version.id: ["business-tools"]}}
        self.assertEqual(await plugin_mcp_gateway._installed_names(self.session, client, claims),
                         ["company-tools"])
        with patch.object(plugin_mcp_gateway.mcp_servers, "runtime_for_dispatch",
                          AsyncMock(return_value=(None, {"servers": {}}))) as runtime:
            await plugin_mcp_gateway.authorized_servers(self.session, client, claims)
            self.assertEqual(runtime.await_args.args[1], ["company-tools"])
        with self.assertRaises(ValueError):
            await plugin_mcp_gateway._installed_names(
                self.session, client, {"pvids": [version.id], "appmcp": {version.id: ["undeclared"]}})
        peer = await self.publish(key="other-business", mcpServers=["business-tools"])
        await self.install(peer)
        shared = {"pvids": [version.id, peer.id], "appmcp": {version.id: ["business-tools"]}}
        self.assertEqual(await plugin_mcp_gateway._installed_names(self.session, client, shared),
                         ["business-tools", "company-tools"])

    async def test_audience_removal_and_package_tampering_fail_closed(self):
        version = await self.publish()
        await self.install(version)
        await plugin_audience.replace(self.session, version, "users", ["author"],
                                      org_id="company", created_by="author")
        await self.session.commit()
        with self.assertRaises(ValueError):
            await plugin_conversation.resolve(self.session, "company", [version.plugin_id], user_id="reader")
        await plugin_audience.replace(self.session, version, "organization", [],
                                      org_id="company", created_by="author")
        await self.session.commit()
        Path(version.package_path).write_bytes(b"not an approved plugin")
        with self.assertRaises(ValueError):
            await plugin_conversation.resolve(self.session, "company",
                [version.plugin_id], user_id="reader", include_resources=True)


if __name__ == "__main__":
    unittest.main()
