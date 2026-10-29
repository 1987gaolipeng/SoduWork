"""Test real authentication endpoints and OAuth fixtures in an isolated database without provider
connections or business content.
"""
import os
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
import json
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit, parse_qs
import httpx
from cryptography.fernet import Fernet
from skill_test_support import fixture
from app import models
from app.api import admin
from app.services import connector_oauth as oauth, connector_oauth_registry as registry, mcp_servers


class ConnectorFoundations(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="connector-test-")
        self.app, self.tokens, self.sessions, self.cleanup = await fixture(self.temp.name)
        self.app.include_router(admin.router)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.cfg = SimpleNamespace(hub_public_url="https://hub.fixture.invalid", soduwork_env="development",
            connector_oauth_key=Fernet.generate_key().decode(), connector_google_client_id="fixture-client",
            connector_google_client_secret="fixture-app-secret", connector_microsoft_client_id="fixture-ms-client",
            connector_microsoft_client_secret="fixture-ms-secret", connector_microsoft_tenant="organizations")
        self.settings = patch.object(registry, "get_settings", lambda: self.cfg); self.settings.start()
        self.calls = []
        async def platform(url, *, data=None, token=None):
            self.calls.append((url, data, token))
            if data:
                return {"access_token": "fixture-access-token", "refresh_token": "fixture-refresh-token",
                        "token_type": "Bearer", "expires_in": 3600}
            return {"user": {"permissionId": "fixture-account"}, "id": "fixture-account"}
        self.platform = patch.object(oauth, "request_json", platform); self.platform.start()
    async def asyncTearDown(self):
        self.platform.stop(); self.settings.stop()
        await self.http.aclose(); await self.cleanup(); self.temp.cleanup()
    async def req(self, method, route, who="admin", **kwargs):
        return await self.http.request(method, "/api/v1" + route, headers={
            "Authorization": ("Bearer " if who in {"admin", "ordinaryUser"} else "Device ") + self.tokens[who]}, **kwargs)
    def company(self, key, **extra):
        return {"id": key, "name": key, "type": "http", "url": "https://example.com/mcp", **extra}
    async def add(self, key, **extra):
        reply = await self.req("POST", "/admin/mcp-servers/upsert", json={"server": self.company(key, **extra), "original": None})
        self.assertEqual(reply.status_code, 200, reply.text)
        return next(row for row in reply.json()["servers"] if row["id"] == key)
    async def test_company_independent_updates_preserve_siblings(self):
        first = await self.add("a", headers={"Authorization": "Bearer original-fixture"})
        second = await self.add("b")
        r = await self.req("POST", "/admin/mcp-servers/upsert", json={"server": {**second, "description": "B"}, "original": second})
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.req("POST", "/admin/mcp-servers/upsert", json={"server": {**first, "description": "A"}, "original": first})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual({r["description"] for r in r.json()["servers"]}, {"A", "B"})
        self.assertNotIn("original-fixture", r.text)
        async with self.sessions() as session:
            self.assertEqual((await mcp_servers.load(session))[0]["headers"]["Authorization"], "Bearer original-fixture")
    async def test_company_stale_update_delete_and_secret_revision(self):
        old = await self.add("a", headers={"Authorization": "Bearer first-fixture"})
        changed = await self.req("POST", "/admin/mcp-servers/upsert", json={"server": {**old, "headers": {"Authorization": "Bearer second-fixture"}}, "original": old})
        fresh = changed.json()["servers"][0]
        self.assertNotEqual(old["revision"], fresh["revision"])
        for method, route, data in [("POST", "/admin/mcp-servers/upsert", {"server": {**old, "name": "stale"}, "original": old}),
                                    ("DELETE", "/admin/mcp-servers/a", {"original": old})]:
            self.assertEqual((await self.req(method, route, json=data)).status_code, 409)
        self.assertEqual((await self.req("DELETE", "/admin/mcp-servers/a", json={"original": fresh})).status_code, 200)
    async def test_company_legacy_requires_revision_for_changes(self):
        r = await self.req("PUT", "/admin/mcp-servers", json={"servers": [self.company("a")]})
        self.assertEqual(r.status_code, 200, r.text)
        snapshot = r.json()
        self.assertEqual((await self.req("PUT", "/admin/mcp-servers", json={"servers": snapshot["servers"]})).status_code, 200)
        self.assertEqual((await self.req("PUT", "/admin/mcp-servers", json={"servers": []})).status_code, 409)
        await self.add("b")
        self.assertEqual((await self.req("PUT", "/admin/mcp-servers", json={"servers": [], "revision": snapshot["revision"]})).status_code, 409)
        fresh = (await self.req("GET", "/admin/mcp-servers")).json()
        self.assertEqual((await self.req("PUT", "/admin/mcp-servers", json={"servers": [], "revision": fresh["revision"]})).status_code, 200)
    async def test_company_authorization_and_no_oauth_sharing(self):
        self.assertEqual((await self.req("POST", "/admin/mcp-servers/upsert", who="ordinaryUser", json={"server": self.company("a")})).status_code, 403)
        self.assertEqual((await self.req("POST", "/admin/mcp-servers/upsert", json={"server": self.company("a", oauth={"provider": "google-drive", "connectionId": "x"})})).status_code, 409)
    async def started(self, who="alice", provider="google-drive", connector_id="connection-a"):
        reply = await self.req("POST", "/mcp-servers/oauth/start", who=who, json={"provider": provider, "connectorId": connector_id})
        self.assertEqual(reply.status_code, 200, reply.text)
        result = reply.json(); result["query"] = parse_qs(urlsplit(result["authorizationUrl"]).query)
        return result
    async def connected(self, provider="google-drive"):
        started = await self.started(provider=provider)
        callback = await self.req("GET", "/mcp-servers/oauth/callback", params={"state": started["query"]["state"][0], "code": "fixture-code"})
        self.assertEqual(callback.status_code, 200)
        status = (await self.req("GET", "/mcp-servers/oauth/status/" + started["attemptId"], who="alice")).json()
        self.assertEqual(status["state"], "connected", status)
        return started, status["oauth"]
    def personal(self, binding):
        return {"id": "connection-a", "name": "drive-fixture", "type": "stdio", "templateKey": "connector-" + binding["provider"],
                "command": "soduwork-connector", "args": [binding["provider"]], "env": {"ALLOW_WRITES": "true"},
                "approved": True, "approvedTarget": "connector-" + binding["provider"], "enabled": True, "oauth": binding}
    async def test_oauth_metadata_no_secrets_and_setup_requirement(self):
        data = (await self.req("GET", "/mcp-servers/oauth/providers", who="alice")).json()
        self.assertEqual(len(data["providers"]), 6)
        self.assertNotIn("fixture-app-secret", json.dumps(data))
        self.cfg.connector_oauth_key = ""
        data = (await self.req("GET", "/mcp-servers/oauth/providers", who="alice")).json()
        self.assertTrue(all(not row["available"] for row in data["providers"]))
        self.assertEqual((await self.req("POST", "/mcp-servers/oauth/start", who="alice", json={"provider":"google-drive","connectorId":"x"})).status_code, 400)
    async def test_oauth_openapi_and_private_response_headers(self):
        schema = self.app.openapi()
        for path, method in (
            ("/api/v1/mcp-servers/oauth/providers", "get"),
            ("/api/v1/mcp-servers/oauth/start", "post"),
            ("/api/v1/mcp-servers/oauth/status/{attempt_id}", "get"),
            ("/api/v1/mcp-servers/oauth/cancel/{attempt_id}", "post"),
        ):
            with self.subTest(path=path):
                response = schema["paths"][path][method]["responses"]["200"]
                self.assertIn("application/json", response["content"])
        reply = await self.req("GET", "/mcp-servers/oauth/providers", who="alice")
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(reply.headers["Cache-Control"], "no-store")
    async def test_oauth_pkce_callback_single_use_encrypted_storage(self):
        started, binding = await self.connected()
        self.assertEqual(started["query"]["code_challenge_method"], ["S256"])
        self.assertEqual(started["query"]["access_type"], ["offline"])
        self.assertNotIn("fixture-app-secret", started["authorizationUrl"])
        self.assertEqual(len(self.calls), 2)
        await self.req("GET", "/mcp-servers/oauth/callback", params={"state": started["query"]["state"][0], "code":"replayed"})
        self.assertEqual(len(self.calls), 2)
        async with self.sessions() as session:
            row = await oauth.row_for(session,"token",binding["connectionId"])
            self.assertNotIn("fixture-access-token", row.value)
            self.assertNotIn("fixture-refresh-token", row.value)
            self.assertNotIn("fixture-account", row.value)
        self.assertEqual((await self.req("GET", "/mcp-servers/oauth/status/" + started["attemptId"], who="bob")).status_code, 404)
    async def test_oauth_bad_state_cancel_expiry_never_call_platform(self):
        started = await self.started()
        await self.req("GET", "/mcp-servers/oauth/callback", params={"state": started["attemptId"] + ".wrong", "code":"code"})
        self.assertEqual(self.calls, [])
        await self.req("POST", "/mcp-servers/oauth/cancel/" + started["attemptId"], who="alice")
        await self.req("GET", "/mcp-servers/oauth/callback", params={"state": started["query"]["state"][0], "code":"code"})
        self.assertEqual(self.calls, [])
        another = await self.started()
        with patch.object(oauth, "now", lambda: another["expiresAt"] + 1):
            await self.req("GET", "/mcp-servers/oauth/callback", params={"state": another["query"]["state"][0], "code":"code"})
        self.assertEqual(self.calls, [])
    async def test_oauth_cross_account_connection_provider_and_hub_rejected(self):
        _, binding = await self.connected()
        spec = self.personal(binding)
        async with self.sessions() as session:
            alice = await session.get(models.Client,"device-alice")
            bob = await session.get(models.Client,"device-bob")
            await oauth.validate_binding(session, alice, spec)
            for client, bad in [(bob,spec),(alice,{**spec,"id":"different"}),(alice,{**spec,"args":["outlook"]})]:
                with self.assertRaises(ValueError): await oauth.validate_binding(session,client,bad)
            self.cfg.hub_public_url = "https://another-hub.fixture.invalid"
            with self.assertRaises(ValueError): await oauth.validate_binding(session,alice,spec)
    async def test_oauth_resolve_refresh_persist_and_identity_guard(self):
        _, binding = await self.connected()
        async with self.sessions() as session:
            row = await oauth.row_for(session,"token",binding["connectionId"])
            record = oauth.unpack(row); record["expiresAt"] = 1
            await oauth.replace(session,row,record); await session.commit()
        async with self.sessions() as session:
            alice = await session.get(models.Client,"device-alice")
            spec = await oauth.resolve(session,alice,self.personal(binding))
            self.assertEqual(spec["env"]["GOOGLE_ACCESS_TOKEN"],"fixture-access-token")
            self.assertEqual(spec["env"]["ALLOW_WRITES"],"false")
        self.assertEqual(self.calls[-2][1]["grant_type"],"refresh_token")
        async with self.sessions() as session:
            self.assertGreater(oauth.unpack(await oauth.row_for(session,"token",binding["connectionId"]))["expiresAt"],oauth.now())
    async def test_oauth_microsoft_fixed_endpoints_and_readonly_scope(self):
        started, binding = await self.connected("outlook")
        self.assertEqual(urlsplit(started["authorizationUrl"]).hostname,"login.microsoftonline.com")
        self.assertIn("offline_access",started["query"]["scope"][0]); self.assertIn("Mail.Read",started["query"]["scope"][0])
        self.assertNotIn("Mail.Send",started["query"]["scope"][0])
        self.assertEqual(binding["provider"],"outlook")
    async def test_oauth_personal_save_probe_and_dispatch_share_owned_binding(self):
        _, binding = await self.connected()
        spec = self.personal(binding)
        saved = await self.req("POST", "/mcp-servers/upsert", who="alice", json={"server": spec, "original": None})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertNotIn("fixture-access-token", saved.text)
        stored = saved.json()["personal"][0]
        self.assertEqual(stored["env"]["GOOGLE_ACCESS_TOKEN"], "")
        self.assertEqual(stored["oauth"], binding)
        self.assertEqual((await self.req("POST", "/mcp-servers/upsert", who="bob", json={"server": spec, "original": None})).status_code, 400)
        self.assertEqual((await self.req("POST", "/mcp-servers/export", who="alice", json={"ids": ["connection-a"]})).status_code, 422)
        received = []
        class Runner:
            id, host, version = "fixture", "fixture", "1.12.91"
            async def call(self, op, body, **kwargs):
                received.append(body["spec"])
                return {"ok": True, "data": {"ok": True, "connectionState": "verified", "authenticationTested": True,
                    "tools": ["list_files"], "message": "private provider result must be discarded"}}
        with patch("app.services.runner_hub.for_client", return_value=Runner()):
            checked = await self.req("POST", "/mcp-servers/probe", who="alice", json=stored)
        self.assertEqual(checked.status_code, 200, checked.text)
        self.assertEqual(checked.json()["connectionState"], "verified")
        self.assertNotIn("private provider", checked.text); self.assertNotIn("fixture-access-token", checked.text)
        self.assertEqual(received[0]["env"]["GOOGLE_ACCESS_TOKEN"], "fixture-access-token")
        async with self.sessions() as session:
            alice=await session.get(models.Client,"device-alice")
            path,payload=await mcp_servers.runtime_for_dispatch(session,["drive-fixture"],client=alice,materialize=False)
            self.assertEqual(path, "")
            self.assertEqual(payload["servers"]["drive-fixture"]["env"]["GOOGLE_ACCESS_TOKEN"],"fixture-access-token")
        with patch("app.services.runner_hub.for_client", return_value=None):
            checked=await self.req("POST","/mcp-servers/probe",who="alice",json=stored)
            self.assertEqual(checked.json()["connectionState"],"offline")

    async def test_oauth_authorization_error_requires_reconnect_but_network_does_not(self):
        _, binding = await self.connected()
        async with self.sessions() as session:
            row=await oauth.row_for(session,"token",binding["connectionId"]);record=oauth.unpack(row);record["expiresAt"]=1
            await oauth.replace(session,row,record);await session.commit()
        async def network(*args,**kwargs): raise ValueError("network fixture")
        async def revoked(*args,**kwargs): raise oauth.AuthorizationExpired("revoked fixture")
        for fail,state in [(network,"connected"),(revoked,"needs_auth")]:
            with patch.object(oauth,"request_json",fail):
                async with self.sessions() as session:
                    alice=await session.get(models.Client,"device-alice")
                    with self.assertRaises(ValueError): await oauth.resolve(session,alice,self.personal(binding))
            async with self.sessions() as session:
                self.assertEqual(oauth.unpack(await oauth.row_for(session,"token",binding["connectionId"]))["state"],state)

    async def test_oauth_cancel_completed_unsaved_binding_cannot_be_reused(self):
        started, binding = await self.connected()
        reply = await self.req("POST", "/mcp-servers/oauth/cancel/" + started["attemptId"], who="alice")
        self.assertEqual(reply.json()["state"], "cancelled")
        self.assertEqual((await self.req("GET", "/mcp-servers/oauth/status/" + started["attemptId"], who="alice")).json()["state"], "cancelled")
        self.assertEqual((await self.req("POST", "/mcp-servers/upsert", who="alice", json={"server": self.personal(binding)})).status_code, 400)
        async with self.sessions() as session:
            with self.assertRaises(ValueError): await oauth.row_for(session, "token", binding["connectionId"])

    async def test_oauth_saved_binding_survives_late_close_and_cleanup_on_replace_delete(self):
        started, first = await self.connected()
        saved = await self.req("POST", "/mcp-servers/upsert", who="alice", json={"server": self.personal(first)})
        original = saved.json()["personal"][0]
        self.assertEqual((await self.req("POST", "/mcp-servers/oauth/cancel/" + started["attemptId"], who="alice")).json()["state"], "connected")
        _, second = await self.connected()
        changed = await self.req("POST", "/mcp-servers/upsert", who="alice", json={"server": self.personal(second), "original": original})
        self.assertEqual(changed.status_code, 200, changed.text)
        async with self.sessions() as session:
            with self.assertRaises(ValueError): await oauth.row_for(session, "token", first["connectionId"])
            await oauth.row_for(session, "token", second["connectionId"])
        # Allow deletion of stored connection references even when the encryption key is missing.
        self.cfg.connector_oauth_key = ""
        deleted = await self.req("DELETE", "/mcp-servers/connection-a", who="alice")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        async with self.sessions() as session:
            with self.assertRaises(ValueError): await oauth.row_for(session, "token", second["connectionId"])

    async def test_oauth_cancel_during_callback_never_persists_token(self):
        started = await self.started()
        async def platform(url, *, data=None, token=None):
            if data:
                reply = await self.req("POST", "/mcp-servers/oauth/cancel/" + started["attemptId"], who="alice")
                self.assertEqual(reply.json()["state"], "cancelled")
                return {"access_token": "fixture-access-token", "refresh_token": "fixture-refresh-token", "expires_in": 3600}
            return {"user": {"permissionId": "fixture-account"}}
        with patch.object(oauth, "request_json", platform):
            await self.req("GET", "/mcp-servers/oauth/callback", params={"state": started["query"]["state"][0], "code": "fixture-code"})
        self.assertEqual((await self.req("GET", "/mcp-servers/oauth/status/" + started["attemptId"], who="alice")).json()["state"], "cancelled")
        from sqlalchemy import select
        async with self.sessions() as session:
            rows = (await session.execute(select(models.AppSetting).where(models.AppSetting.key.like(oauth.PREFIX + "token_%")))).scalars().all()
            self.assertEqual(rows, [])

    async def test_oauth_owner_disabled_during_callback_cannot_receive_binding(self):
        started = await self.started()
        async def platform(url, *, data=None, token=None):
            if data:
                async with self.sessions() as session:
                    client = await session.get(models.Client, "device-alice")
                    client.auth_state = "revoked"
                    await session.commit()
                return {"access_token": "fixture-access-token", "refresh_token": "fixture-refresh-token", "expires_in": 3600}
            return {"user": {"permissionId": "fixture-account"}}
        with patch.object(oauth, "request_json", platform):
            await self.req("GET", "/mcp-servers/oauth/callback", params={"state": started["query"]["state"][0], "code": "fixture-code"})
        async with self.sessions() as session:
            record = oauth.unpack(await oauth.row_for(session, "attempt", started["attemptId"]))
            self.assertEqual(record["state"], "needs_auth")
            self.assertNotIn("connectionId", record)

if __name__ == "__main__": unittest.main()
