"""Real ASGI auth, isolated DB and loopback model HTTP; no external inference."""
import asyncio
import base64
import json
import re
import tempfile
import unittest
import io
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from sqlalchemy import select

from test_model_runtime import IsolatedDatabase
from app import auth
from app.db import get_session
from app.models import AppSetting, AuditLog, Client, ModelDef, ModelProvider, User
from app.api import model_capabilities as api, tasks, ai_proxy
from app.services import model_capabilities as caps, model_capability_probe as probe, model_catalog as catalog
from app.services import device_auth, model_config_guard, runtime_images, ai_exec, local_base


class CapabilityTests(IsolatedDatabase):
    async def test_creation_receipt_precedes_a_concurrent_edit_after_commit(self):
        from app.api import admin
        from app.services import client_domain_events
        self.app.include_router(admin.router)
        created = {}

        async def edit_after_commit(_session):
            async with self.sessions() as session:
                rows = await catalog.catalog(session)
                model = next(row for row in rows["models"] if row["id"] == "p:new")
                created.update(id=model["id"], revision=model["revision"], configRevision=model["configRevision"],
                               providerRevision=rows["providers"][0]["revision"])
                saved = await model_config_guard.catalog(session, ModelDef, model["id"], model["revision"])
                saved.ctx_window = 65536
                await session.commit()

        with patch.object(client_domain_events, "models_changed", edit_after_commit), patch.object(admin.audit, "log", new=AsyncMock()):
            response = await self.http.put("/api/v1/admin/model-defs", headers=self.headers["admin"],
                                           json={"providerId": "p", "name": "new", "expectedRevision": "new"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"ok": True, **created})
        stale = await self.check(model="new", checks=["connection"], expectedConfigRevision=created["configRevision"])
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(self.requests, [])

    async def test_admin_model_edit_persists_capabilities_and_rejects_conflicting_limits(self):
        from app.api import admin
        self.app.include_router(admin.router)
        async with self.sessions() as session:
            revision = model_config_guard.revision(await session.get(ModelDef, "p:model"))
        config = {"imageRouting": "auto", "maxOutputTokens": 32000,
                  "capabilities": {"imageInput": "supported", "streaming": "unknown", "toolCalling": "supported"},
                  "thinkingMode": "controllable", "thinkingFormat": "openai"}
        body = {"providerId": "p", "name": "model", "ctxWindow": 128000, "config": config,
                "expectedRevision": revision}
        with patch.object(admin.audit, "log", new=AsyncMock()):
            response = await self.http.put("/api/v1/admin/model-defs", headers=self.headers["admin"], json=body)
        self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as session:
            saved = await session.get(ModelDef, "p:model")
            self.assertEqual(saved.ctx_window, 128000)
            self.assertEqual(saved.config["maxOutputTokens"], 32000)
            self.assertEqual(saved.config["capabilities"], config["capabilities"])
            body["expectedRevision"] = model_config_guard.revision(saved)
        for context in (8192, True, 2.5, 10000001):
            response = await self.http.put("/api/v1/admin/model-defs", headers=self.headers["admin"],
                                           json={**body, "ctxWindow": context})
            self.assertEqual(response.status_code, 400, response.text)
        async with self.sessions() as session:
            self.assertEqual((await session.get(ModelDef, "p:model")).ctx_window, 128000)

    async def test_admin_invalid_config_types_do_not_commit_other_changes(self):
        from app.api import admin
        self.app.include_router(admin.router)
        original = {"imageRouting": "auto", "capabilities": {"toolCalling": "supported"}}
        async with self.sessions() as session:
            model = await session.get(ModelDef, "p:model")
            model.config = original
            model.label = "Original label"
            await session.commit()
            revision = model_config_guard.revision(model)
        for value in ([], ["config"], "invalid", True, 123):
            with self.subTest(value=value):
                response = await self.http.put("/api/v1/admin/model-defs", headers=self.headers["admin"],
                    json={"providerId": "p", "name": "model", "expectedRevision": revision,
                          "label": "Should not be saved", "enabled": False, "config": value})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(response.headers.get("X-Error-Code"), "model.config.invalid-object")
                async with self.sessions() as session:
                    model = await session.get(ModelDef, "p:model")
                    self.assertEqual(model.config, original)
                    self.assertEqual(model.label, "Original label")
                    self.assertTrue(model.enabled)
        response = await self.http.put("/api/v1/admin/model-defs", headers=self.headers["admin"],
            json={"providerId": "p", "name": "invalid-new", "expectedRevision": "new", "config": []})
        self.assertEqual(response.status_code, 400, response.text)
        async with self.sessions() as session:
            self.assertIsNone(await session.get(ModelDef, "p:invalid-new"))

    async def test_admin_edit_after_legacy_read_preserves_manual_capabilities(self):
        from app.api import admin
        self.app.include_router(admin.router)
        declared = {"imageInput": "unknown", "toolCalling": "supported", "streaming": "supported"}
        for invalid in ({"thinkingFormat": "unrecognized-format"}, {"maxOutputTokens": 512}):
            with self.subTest(invalid=invalid):
                original = {"imageRouting": "auto", "capabilities": declared, **invalid}
                async with self.sessions() as session:
                    model = await session.get(ModelDef, "p:model")
                    model.config = original
                    await session.commit()
                response = await self.http.get("/api/v1/admin/model-catalog", headers=self.headers["admin"])
                self.assertEqual(response.status_code, 200, response.text)
                view = next(row for row in response.json()["models"] if row["id"] == "p:model")
                self.assertEqual(view["config"]["capabilities"], declared)
                self.assertEqual(view["capabilityProfile"]["toolCalling"]["source"], "configured")
                async with self.sessions() as session:
                    # Reading a legacy row must never silently migrate the database.
                    self.assertEqual((await session.get(ModelDef, "p:model")).config, original)
                response = await self.http.put("/api/v1/admin/model-defs", headers=self.headers["admin"],
                    json={"providerId": "p", "name": "model", "expectedRevision": view["revision"],
                          "label": "Label-only edit", "modality": "chat", "config": view["config"]})
                self.assertEqual(response.status_code, 200, response.text)
                async with self.sessions() as session:
                    model = await session.get(ModelDef, "p:model")
                    self.assertEqual(model.config["capabilities"], declared)
                    self.assertEqual(model.label, "Label-only edit")

    async def test_admin_empty_and_null_config_keep_explicit_reset_compatibility(self):
        from app.api import admin
        self.app.include_router(admin.router)
        for empty in ({}, None):
            with self.subTest(empty=empty):
                async with self.sessions() as session:
                    model = await session.get(ModelDef, "p:model")
                    model.config = {"capabilities": {"toolCalling": "supported"}}
                    await session.commit()
                    revision = model_config_guard.revision(model)
                response = await self.http.put("/api/v1/admin/model-defs", headers=self.headers["admin"],
                    json={"providerId": "p", "name": "model", "expectedRevision": revision, "config": empty})
                self.assertEqual(response.status_code, 200, response.text)
                async with self.sessions() as session:
                    self.assertEqual((await session.get(ModelDef, "p:model")).config, {})

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.requests, self.mode, self.peers = [], "ok", []
        self.challenge = ""
        self.server = await asyncio.start_server(self.serve, "127.0.0.1", 0)
        self.base = "http://127.0.0.1:" + str(self.server.sockets[0].getsockname()[1]) + "/v1"
        async with self.engine.begin() as connection:
            await connection.run_sync(User.__table__.create)
            await connection.run_sync(AuditLog.__table__.create)
        async with self.sessions() as session, session.begin():
            session.add_all([
                User(id="admin", username="admin", is_super=True),
                User(id="alice", username="alice"), User(id="bob", username="bob"),
                *[Client(id=cid, user_ref=owner, auth_state="active", model_keys={"custom-p": owner + "-private"},
                         config={"modelProviders": [{"id": "custom-p", "name": "Personal", "baseUrl": self.base,
                                                      "personal": True, "kind": "openai-compat"}]},
                         models=[{"providerId": "custom-p", "name": "personal-model", "ctxWindow": 128000,
                                  "config": {"imageRouting": "auto", "maxOutputTokens": 32768}}])
                  for cid, owner in (("a", "alice"), ("b", "bob"))],
                ModelProvider(id="p", name="Fixture", api_key="company-private", base_url=self.base),
                ModelDef(id="p:model", provider_id="p", name="model", ctx_window=128000,
                         config={"imageRouting": "auto", "maxOutputTokens": 32768}),
            ])
        self.app = FastAPI()
        self.app.include_router(api.router)
        self.app.include_router(tasks.router)
        self.app.include_router(ai_proxy.router)
        async def isolated_session():
            async with self.sessions() as session:
                yield session
        self.app.dependency_overrides[get_session] = isolated_session
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.headers = {"admin": {"Authorization": "Bearer " + auth.sign_claims(
            {"uid": "admin", "ver": 1}, ttl_seconds=600, token_type="user")}}
        async with self.sessions() as session:
            for name in ("a", "b"):
                token, _ = device_auth.issue_session(await session.get(Client, name))
                self.headers[name] = {"Authorization": "Device " + token}
        original = probe.image_challenge
        def challenge():
            expected, image = original()
            self.challenge = expected
            return expected, image
        self.challenge_patch = patch.object(probe, "image_challenge", side_effect=challenge)
        self.challenge_patch.start()

    async def asyncTearDown(self):
        self.challenge_patch.stop()
        await self.http.aclose()
        self.server.close()
        await self.server.wait_closed()
        await asyncio.gather(*self.peers, return_exceptions=True)
        await super().asyncTearDown()

    async def serve(self, reader, writer):
        self.peers.append(asyncio.current_task())
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            length = next(int(row.split(b":")[1]) for row in headers.lower().split(b"\r\n")
                          if row.startswith(b"content-length:"))
            body = json.loads(await reader.readexactly(length))
            self.requests.append((headers.decode(), body))
            status, content_type = "200 OK", "application/json"
            if self.mode == "timeout":
                await reader.read()
                return
            if self.mode == "unsupported":
                status, data = "400 Bad Request", b'{"error":{"message":"image input is not supported"}}'
            elif self.mode == "private-error":
                status, data = "401 Unauthorized", b'{"error":{"message":"company-private secret internal response"}}'
            elif self.mode == "plain-tools" and body.get("tools") and body.get("stream"):
                status, data = "400 Bad Request", b'{"error":{"code":"tools_not_supported"}}'
            elif body.get("stream"):
                content_type = "text/event-stream"
                tool_result = next((row for row in body["messages"] if row["role"] == "tool"), None)
                if tool_result:
                    if self.mode == "receipt-requires-choice" and "tool_choice" not in body:
                        status, content_type = "403 Forbidden", "application/json"
                        data = b'{"error":{"message":"synthetic receipt policy refusal"}}'
                    else:
                        data = ("data: " + json.dumps({"choices": [{"index": 0, "delta": {
                            "content": tool_result["content"]}, "finish_reason": "stop"}]}) + "\n\ndata: [DONE]\n\n").encode()
                elif body.get("tools"):
                    if self.mode == "json-tools-only":
                        status, content_type = "400 Bad Request", "application/json"
                        data = b'{"error":{"message":"streamed tools request not accepted"}}'
                    elif self.mode == "auto-only-tools" and isinstance(body.get("tool_choice"), dict):
                        data = b'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
                    else:
                        value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                        arguments = json.dumps({"value": value})
                        split = len(arguments) // 2
                        deltas = [{"tool_calls": [{"index": 0, "id": "call-", "type": "function", "function": {
                            "name": "soduwork_", "arguments": arguments[:split]}}]},
                            {"tool_calls": [{"index": 0, "id": "test", "function": {
                            "name": "capability_echo", "arguments": arguments[split:]}}]}]
                        data = "".join("data: " + json.dumps({"choices": [{"index": 0, "delta": delta}]})
                                       + "\r\n\r\n" for delta in deltas).encode()
                        data += b'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\r\n\r\ndata: [DONE]\r\n\r\n'
                else:
                    data = (b'data: {"choices":[{"delta":{"reasoning_content":"test thought"}}]}\n\n'
                            b'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
            else:
                message = {"content": "OK"}
                tool_result = next((row for row in body["messages"] if row["role"] == "tool"), None)
                if tool_result:
                    message = {"content": tool_result["content"]}
                elif body.get("tools"):
                    value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                    message = {"tool_calls": [{"id": "call-test", "type": "function", "function": {
                        "name": "soduwork_capability_echo", "arguments": json.dumps({"value": value})}}]}
                elif isinstance(body["messages"][0]["content"], list):
                    url = body["messages"][0]["content"][1]["image_url"]["url"]
                    self.assertEqual(runtime_images._mime(base64.b64decode(url.split(",")[1])), "image/png")
                    self.assertNotIn(self.challenge, body["messages"][0]["content"][0]["text"])
                    wrong = str((int(self.challenge[0]) + 1) % 10) + self.challenge[1:]
                    message = {"content": self.challenge if self.mode != "wrong-image" else wrong}
                finish = "tool_calls" if "tool_calls" in message else "stop"
                data = json.dumps({"choices": [{"message": message, "finish_reason": finish}]}).encode()
            writer.write(("HTTP/1.1 " + status + "\r\nContent-Type: " + content_type +
                          "\r\nContent-Length: " + str(len(data)) + "\r\nConnection: close\r\n\r\n").encode() + data)
            await writer.drain()
        except asyncio.IncompleteReadError:
            pass  # A timeout/disconnect may close before a full HTTP request.
        finally:
            writer.close()
            await writer.wait_closed()

    async def check(self, who="admin", checks=None, **extra):
        path = "/api/v1/admin/model-capabilities/check" if who == "admin" else "/api/v1/my-models/capabilities/check"
        return await self.http.post(path, headers=self.headers.get(who, {}), json={
            "providerId": "p" if who == "admin" else "custom-p",
            "model": "model" if who == "admin" else "personal-model",
            "checks": checks or list(probe.CHECKS), **extra})

    async def test_real_checks_persist_and_propagate_to_runtime_with_scoped_evidence(self):
        response = await self.check("a")
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(self.requests), 5)
        tool_request = next(body for _, body in self.requests if body.get("tools"))
        receipt_request = next(body for _, body in self.requests if any(row["role"] == "tool" for row in body["messages"]))
        self.assertTrue(tool_request["stream"])
        self.assertTrue(receipt_request["stream"])
        self.assertEqual(receipt_request["tools"], tool_request["tools"])
        self.assertNotIn("tool_choice", receipt_request)
        self.assertTrue(all("Bearer alice-private" in headers for headers, _ in self.requests))
        self.assertEqual(result["capabilityProfile"]["imageInput"]["source"], "verified")
        self.assertEqual(result["capabilityProfile"]["reasoningStream"]["state"], "reported")
        self.assertEqual(result["imageRouting"], "native")
        self.assertNotIn("alice-private", response.text)
        mine = await self.http.get("/api/v1/my-models", headers=self.headers["a"])
        personal = next(row for row in mine.json()["usable"] if row["own"])
        self.assertTrue(personal["capabilityCheck"]["checkedAt"])
        config = await self.http.get("/api/v1/ai-proxy/config?model=personal-model", headers=self.headers["a"])
        self.assertEqual(config.json()["input"], ["text", "image"])
        self.assertEqual(config.json()["maxOutputTokens"], 32768)
        self.assertEqual(config.json().get("compatibility"), result["compatibility"])
        async with self.sessions() as session:
            admin = (await catalog.catalog(session))["models"][0]
            bob = next(row for row in await catalog.usable(session, await session.get(Client, "b")) if row["own"])
            self.assertIsNone(admin["capabilityCheck"])
            self.assertIsNone(bob["capabilityCheck"])
            self.assertEqual(bob["imageRouting"], "vision-fallback")
            alice = await catalog.resolve(session, await session.get(Client, "a"), "personal-model")
            llm = ai_exec.with_llm({"cfg": {"llm": {}}}, alice)["cfg"]["llm"]
            self.assertEqual(llm["maxOutputTokens"], 32768)
            self.assertEqual(llm["capabilityProfile"]["streaming"]["state"], "supported")
            self.assertEqual(llm.get("compatibility"), result["compatibility"])
        company = await self.check("admin", ["connection"])
        self.assertEqual(company.status_code, 200)
        self.assertIn("Bearer company-private", self.requests[-1][0])
        async with self.sessions() as session:
            events = list((await session.scalars(select(AuditLog))).all())
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].actor_id, "admin")
            self.assertEqual(events[0].action, "model.capability_check")
            self.assertEqual(events[0].target_id, "p:model")
            self.assertEqual(events[0].detail, {"checks": {"connection": "passed"}})

    async def test_single_check_reports_its_own_success_and_retains_other_evidence(self):
        self.mode = "wrong-image"
        first = (await self.check(checks=["connection", "imageInput"])).json()
        self.assertFalse(first["ok"])
        self.assertEqual(first["checks"]["imageInput"]["status"], "inconclusive")

        response = await self.check(checks=["connection"])
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["checks"]["connection"]["status"], "passed")
        self.assertEqual(result["checks"]["imageInput"], first["checks"]["imageInput"])
        self.assertTrue(result["ok"])

    async def test_admin_recheck_repairs_and_persists_cached_named_tool_choice(self):
        first = await self.check("admin", ["connection"])
        self.assertEqual(first.status_code, 200, first.text)
        async with self.sessions() as session:
            row = (await session.scalars(select(AppSetting).where(
                AppSetting.key.startswith("model-check-v1:")))).one()
            saved = json.loads(row.value)
            saved["compatibility"]["toolChoice"] = "named"
            row.value = json.dumps(saved)
            await session.commit()

        self.mode = "auto-only-tools"
        for expected_choices in (["named", "auto"], ["auto"]):
            self.requests.clear()
            response = await self.check("admin", ["toolCalling"])
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            self.assertEqual(result["capabilityProfile"]["toolCalling"]["source"], "verified")
            self.assertEqual(result["capabilityProfile"]["toolCalling"]["state"], "supported")
            self.assertEqual(result["compatibility"]["toolChoice"], "auto")
            choices = ["named" if isinstance(body["tool_choice"], dict) else body["tool_choice"]
                       for _, body in self.requests if "tool_choice" in body]
            self.assertEqual(choices, expected_choices)
            self.assertEqual(len(self.requests), len(expected_choices) + 1)

    async def test_auth_saved_scope_and_no_arbitrary_endpoint(self):
        self.assertEqual((await self.check("missing")).status_code, 401)
        self.assertEqual((await self.check(baseUrl="https://attacker.invalid")).status_code, 400)
        self.assertEqual((await self.check(model="not-saved")).status_code, 404)
        self.assertEqual((await self.check(providerId="other")).status_code, 404)
        no_permission = auth.sign_claims({"uid": "alice", "ver": 1}, ttl_seconds=600, token_type="user")
        response = await self.http.post("/api/v1/admin/model-capabilities/check", headers={"Authorization": "Bearer " + no_permission}, json={})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.requests, [])

    async def test_queued_check_requires_the_saved_configuration_before_contacting_the_provider(self):
        async with self.sessions() as session:
            row = (await catalog.catalog(session))["models"][0]
            previous = row["configRevision"]
            provider = await session.get(ModelProvider, "p")
            provider.api_key = "rotated-test-key"
            await session.commit()
        async with self.sessions() as session:
            current = (await catalog.catalog(session))["models"][0]["configRevision"]
        self.assertNotEqual(previous, current)
        stale = await self.check(checks=["connection"], expectedConfigRevision=previous)
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(stale.headers.get("X-Error-Code"), "model_config_revision_changed")
        self.assertEqual(stale.json()["detail"], "模型配置在检测期间已变更，请重新检测")
        self.assertEqual(self.requests, [])
        fresh = await self.check(checks=["connection"], expectedConfigRevision=current)
        self.assertEqual(fresh.status_code, 200, fresh.text)
        self.assertEqual(fresh.json()["checks"]["connection"]["status"], "passed")
        self.assertEqual(len(self.requests), 1)

    async def test_receipt_probe_uses_runtime_default_choice_and_keeps_independent_stream_check(self):
        self.mode = "receipt-requires-choice"
        response = await self.check(checks=["connection", "toolCalling", "streaming"])
        self.assertEqual(response.status_code, 200)
        checks = response.json()["checks"]
        self.assertEqual(checks["connection"]["status"], "passed")
        self.assertEqual(checks["streaming"]["status"], "passed")
        self.assertEqual(checks["toolCalling"]["status"], "inconclusive")
        self.assertEqual(checks["toolCalling"]["code"], "request_rejected")
        self.assertEqual(checks["toolCalling"]["stage"], "tool_result")

    async def test_json_only_tools_do_not_enable_streamed_tool_runtime(self):
        self.mode = "json-tools-only"
        response = await self.check(checks=["toolCalling", "streaming"])
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["checks"]["toolCalling"]["status"], "inconclusive")
        self.assertEqual(result["checks"]["toolCalling"]["code"], "request_not_accepted")
        self.assertEqual(result["capabilityProfile"]["toolCalling"]["state"], "unknown")
        self.assertEqual(result["checks"]["streaming"]["status"], "passed")
        self.assertTrue(self.requests[0][1]["stream"])

    async def test_admin_verifies_plain_tool_round_trip_separately_from_text_streaming(self):
        self.mode = "plain-tools"
        response = await self.check(checks=["connection", "imageInput", "toolCalling", "streaming"])
        self.assertEqual(response.status_code, 200)
        report = response.json()
        self.assertEqual(report["capabilityProfile"]["toolCalling"]["state"], "supported")
        self.assertEqual(report["checks"]["toolCalling"]["stage"], "tool_result")
        self.assertTrue(all(check["status"] == "passed" for check in report["checks"].values()))
        tool_requests = [body for _, body in self.requests if "tools" in body]
        self.assertEqual(len(tool_requests), 3)
        self.assertTrue(tool_requests[0]["stream"])
        for body in tool_requests[1:]:
            self.assertEqual(set(body), {"model", "messages", "tools"})
        self.assertEqual([row["role"] for row in tool_requests[2]["messages"]], ["user", "assistant", "tool"])

    async def test_organization_evidence_follows_org_credentials_and_runtime_revision_changes(self):
        async with self.sessions() as session:
            client = await session.get(Client, "b")
            client.models = [{"providerId": "custom-p", "name": "personal-alias", "config": {"imageRouting": "auto"}}]
            await session.commit()
        before = (await self.http.get("/api/v1/ai-proxy/config", headers=self.headers["b"])).json()
        result = await self.check("admin", ["imageInput"])
        self.assertEqual(result.status_code, 200)
        after = (await self.http.get("/api/v1/ai-proxy/config", headers=self.headers["b"])).json()
        self.assertEqual(after["imageRouting"], "native")
        self.assertEqual(after["capabilityProfile"]["imageInput"]["source"], "verified")
        self.assertEqual(before["configRevision"], after["configRevision"])
        self.assertNotEqual(before["runtimeRevision"], after["runtimeRevision"])
        alice = (await self.http.get("/api/v1/ai-proxy/config?model=personal-model", headers=self.headers["a"])).json()
        self.assertEqual(alice["imageRouting"], "vision-fallback")
        mine = (await self.http.get("/api/v1/my-models", headers=self.headers["b"])).json()
        own = next(row for row in mine["usable"] if row["own"])
        self.assertIsNone(own["capabilityCheck"])
        self.assertEqual(own["imageRouting"], "vision-fallback")

    async def test_key_address_model_config_changes_invalidate_evidence(self):
        self.assertTrue((await self.check("a", checks=["connection", "imageInput"])).json()["ok"])
        async with self.sessions() as session:
            client = await session.get(Client, "a")
            model = await session.get(ModelDef, "p:model")
            p = (await catalog.effective_provider_map(session, client))["p"]
            row = catalog._m_api(model)
            scope = "client:a"
            _, before = caps.identity(row, p, "alice-private", scope)
            variants = [(row, {**p, "baseUrl": p["baseUrl"] + "/new"}, "alice-private"),
                        ({**row, "name": "other"}, p, "alice-private"),
                        ({**row, "config": {"thinkingFormat": "zai", "maxOutputTokens": 4096}}, p, "alice-private"),
                        (row, p, "changed-key")]
            for changed, provider, key in variants:
                self.assertNotEqual(caps.identity(changed, provider, key, scope)[1], before)
            client.model_keys = {"custom-p": "new-private"}
            await session.commit()
        async with self.sessions() as session:
            row = next(row for row in await catalog.usable(session, await session.get(Client, "a")) if row["own"])
            self.assertIsNone(row["capabilityCheck"])
            self.assertEqual(row["capabilityProfile"]["imageInput"]["state"], "unknown")

    async def test_timeout_keeps_capability_unconfirmed(self):
        self.mode = "timeout"
        with patch.object(probe, "TIMEOUT", .15):
            result = (await self.check(checks=["imageInput"])).json()
        self.assertEqual(result["checks"]["imageInput"]["status"], "inconclusive")
        self.assertEqual(result["checks"]["imageInput"]["code"], "timeout")
        self.assertEqual(result["capabilityProfile"]["imageInput"]["state"], "unknown")

    async def test_unsupported_and_bad_answer_have_distinct_truthful_results(self):
        # Keep timeout cancellation on a separate listener from response checks.
        self.mode = "wrong-image"
        result = (await self.check(checks=["imageInput"])).json()
        self.assertEqual(result["checks"]["imageInput"]["code"], "expected_output_missing")
        self.mode = "unsupported"
        result = (await self.check(checks=["imageInput"])).json()
        self.assertEqual(result["checks"]["imageInput"]["status"], "unsupported")
        self.assertEqual(result["capabilityProfile"]["imageInput"]["state"], "unsupported")
        self.assertEqual(result["imageRouting"], "vision-fallback")
        self.mode = "private-error"
        response = await self.check(checks=["connection"])
        self.assertNotIn("company-private", response.text)
        self.assertNotIn("internal response", response.text)
        self.assertEqual(response.json()["checks"]["connection"]["code"], "credentials_or_access")

    async def test_model_edit_during_probe_discards_stale_result(self):
        original = probe.run
        async def changed(conf, checks):
            result = await original(conf, checks)
            async with self.sessions() as session:
                model = await session.get(ModelDef, "p:model")
                model.config = {"imageRouting": "auto", "maxOutputTokens": 4096}
                await session.commit()
            return result
        with patch.object(probe, "run", side_effect=changed):
            result = await self.check(checks=["connection"])
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.headers.get("X-Error-Code"), "model_config_revision_changed")

    async def test_latest_transient_result_preserves_verified_evidence(self):
        first = (await self.check(checks=["imageInput"])).json()
        self.assertEqual(first["checks"]["imageInput"]["status"], "passed")
        self.mode = "wrong-image"
        latest = (await self.check(checks=["imageInput"])).json()
        self.assertEqual(latest["checks"]["imageInput"]["status"], "inconclusive")
        self.assertEqual(latest["verifiedChecks"]["imageInput"]["status"], "passed")
        self.assertEqual(latest["imageRouting"], "native")
        self.assertEqual(first["runtimeRevision"], latest["runtimeRevision"])

    async def test_image_rejection_preserves_proven_native_route_across_catalog_reads(self):
        first = (await self.check(checks=["imageInput"])).json()
        original = first["checks"]["imageInput"]
        self.assertEqual(original["status"], "passed")
        self.mode = "unsupported"
        for _ in range(2):
            rejected = (await self.check(checks=["imageInput"])).json()
            self.assertFalse(rejected["ok"])
            self.assertEqual(rejected["checks"]["imageInput"]["status"], "unsupported")
            self.assertEqual(rejected["verifiedChecks"]["imageInput"], original)
            self.assertEqual(rejected["runtimeRevision"], first["runtimeRevision"])
            async with self.sessions() as session:
                row = (await catalog.catalog(session))["models"][0]
                self.assertEqual(row["input"], ["text", "image"])
                self.assertEqual(row["imageRouting"], "native")
                self.assertEqual(row["capabilityCheck"]["checks"]["imageInput"], rejected["checks"]["imageInput"])
                self.assertEqual(row["capabilityCheck"]["verifiedChecks"]["imageInput"], original)
        self.mode = "wrong-image"
        uncertain = (await self.check(checks=["imageInput"])).json()
        self.assertEqual(uncertain["checks"]["imageInput"]["status"], "inconclusive")
        self.assertEqual(uncertain["verifiedChecks"]["imageInput"], original)
        for evidence in (rejected, uncertain):
            for declaration, expected_conflict in (("supported", True), ("unsupported", False)):
                manual = caps.profile({"capabilities": {"imageInput": declaration}}, evidence)["imageInput"]
                self.assertEqual(manual["state"], declaration)
                self.assertEqual(bool(manual.get("conflict")), expected_conflict)
        self.mode = "ok"
        recovered = (await self.check(checks=["imageInput"])).json()
        self.assertEqual(recovered["checks"]["imageInput"]["status"], "passed")
        self.assertEqual(recovered["verifiedChecks"]["imageInput"], recovered["checks"]["imageInput"])

    async def test_older_started_run_cannot_overwrite_newer_result(self):
        old = {"configRevision": "same", "runSequence": 1, "checkedAt": "later-finish",
               "checks": {"imageInput": {"status": "unsupported", "checkedAt": "later-finish"}}}
        new = {"configRevision": "same", "runSequence": 2, "checkedAt": "earlier-finish",
               "checks": {"imageInput": {"status": "passed", "checkedAt": "earlier-finish"}}}
        async with self.sessions() as session:
            await caps.persist(session, "synthetic-model-check", new)
        async with self.sessions() as session:
            result = await caps.persist(session, "synthetic-model-check", old)
        self.assertEqual(result["runSequence"], 2)
        self.assertEqual(result["checks"]["imageInput"]["status"], "passed")

    async def test_concurrent_same_target_probe_is_bounded_by_active_lease(self):
        entered, release = asyncio.Event(), asyncio.Event()
        calls = 0
        async def pending(conf, checks):
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            return {"checks": {"connection": {"status": "passed", "code": "verified", "checkedAt": probe.now()}},
                    "checkedAt": probe.now(), "reasoningStreamReported": False}
        with patch.object(probe, "run", side_effect=pending):
            first = asyncio.create_task(self.check(checks=["connection"]))
            try:
                await asyncio.wait_for(entered.wait(), 3)
                second = asyncio.create_task(self.check(checks=["connection"]))
                try:
                    response = await asyncio.wait_for(asyncio.shield(second), .5)
                    self.assertEqual(response.status_code, 409)
                finally:
                    release.set()
                    await asyncio.gather(second, return_exceptions=True)
            finally:
                release.set()
                await first
        self.assertEqual(calls, 1)

    async def test_disconnect_cancels_upstream_and_releases_probe_lease(self):
        self.mode = "timeout"
        disconnected = asyncio.Event()
        async def is_disconnected():
            return disconnected.is_set()
        request = SimpleNamespace(is_disconnected=is_disconnected)
        async with self.sessions() as session:
            client = await session.get(Client, "a")
            task = asyncio.create_task(api.model_transport.until_disconnect(request, api.check_saved(
                {"providerId": "custom-p", "model": "personal-model", "checks": ["connection"]}, session, client)))
            try:
                # Wait for the real loopback request, including cold DB/runtime
                # admission on slower hosts; cancellation itself is unchanged.
                async with asyncio.timeout(10):
                    while not self.requests:
                        await asyncio.sleep(.01)
                disconnected.set()
                from fastapi import HTTPException
                with self.assertRaises(HTTPException) as caught:
                    await task
                self.assertEqual(caught.exception.status_code, 499)
            finally:
                disconnected.set()
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        async with self.sessions() as session:
            records = list((await session.scalars(select(AppSetting))).all())
            for row in records:
                if row.key.startswith("model-check-v1:"):
                    self.assertNotIn("_probeLease", json.loads(row.value))
            state = await api.model_runtime.snapshot()
            self.assertEqual(state["running"], 0)
        self.mode = "ok"
        self.assertEqual((await self.check(checks=["connection"])).status_code, 200)

    async def test_device_authorization_rotation_rejects_probe_persistence(self):
        original = probe.run
        async def rotate(conf, checks):
            result = await original(conf, checks)
            async with self.sessions() as session:
                client = await session.get(Client, "a")
                client.auth_version += 1
                await session.commit()
            return result
        with patch.object(probe, "run", side_effect=rotate):
            response = await self.check("a", checks=["connection"])
        self.assertEqual(response.status_code, 401)
        async with self.sessions() as session:
            rows = list((await session.scalars(select(AppSetting))).all())
            checks = [json.loads(row.value) for row in rows if row.key.startswith("model-check-v1:")]
            self.assertTrue(checks)
            self.assertTrue(all(not item.get("checks") and not item.get("_probeLease") for item in checks))

    async def test_replaced_expired_run_lease_rejects_old_writer(self):
        from fastapi import HTTPException
        async with self.sessions() as session:
            old = await caps.begin_run(session, "synthetic-expiry", "same", lifetime=-1)
        async with self.sessions() as session:
            newer = await caps.begin_run(session, "synthetic-expiry", "same")
        result = {"configRevision": "same", "checks": {"connection": {"status": "passed"}}}
        async with self.sessions() as session:
            with self.assertRaises(HTTPException) as caught:
                await caps.persist(session, "synthetic-expiry", result, lease=old)
            self.assertEqual(caught.exception.status_code, 409)
            await session.rollback()
        async with self.sessions() as session:
            final = await caps.persist(session, "synthetic-expiry", result, lease=newer)
        self.assertEqual(final["runSequence"], 2)

    async def test_functional_a_b_a_edits_reject_original_probe_and_expire_old_evidence(self):
        first = (await self.check(checks=["imageInput"])).json()
        self.assertEqual(first["imageRouting"], "native")
        original = probe.run
        async def restore(conf, checks):
            result = await original(conf, checks)
            for output in (4096, 32768):
                async with self.sessions() as session:
                    current = await session.get(ModelDef, "p:model")
                    row = await model_config_guard.catalog(session, ModelDef, "p:model", model_config_guard.revision(current))
                    row.config = {**row.config, "maxOutputTokens": output}
                    await session.commit()
            return result
        with patch.object(probe, "run", side_effect=restore):
            response = await self.check(checks=["connection"])
        self.assertEqual(response.status_code, 409)
        async with self.sessions() as session:
            row = (await catalog.usable(session, await session.get(Client, "a")))[0]
        self.assertIsNone(row["capabilityCheck"])
        self.assertNotEqual(row["configRevision"], first["configRevision"])

    async def test_declarations_labels_routes_and_unrelated_saves_preserve_wire_evidence(self):
        first = (await self.check(checks=["imageInput"])).json()
        async with self.sessions() as session:
            current = await session.get(ModelDef, "p:model")
            row = await model_config_guard.catalog(session, ModelDef, "p:model", model_config_guard.revision(current))
            row.config = {**row.config, "imageRouting": "vision-fallback", "capabilities": {"imageInput": "unsupported"}}
            row.label, row.note = "Renamed fixture", "Public fixture note"
            await session.commit()
        async with self.sessions() as session:
            await model_config_guard.catalog(session, ModelDef, "p:other", "new")
            session.add(ModelDef(id="p:other", provider_id="p", name="other"))
            await session.commit()
        async with self.sessions() as session:
            rows = await catalog.usable(session, await session.get(Client, "a"))
            row = next(item for item in rows if item["name"] == "model")
        self.assertEqual(row["configRevision"], first["configRevision"])
        self.assertIsNotNone(row["capabilityCheck"])
        self.assertTrue(row["capabilityProfile"]["imageInput"].get("conflict"))
        self.assertEqual(row["imageRouting"], "vision-fallback")
        self.assertNotEqual(row["runtimeRevision"], first["runtimeRevision"])

    async def test_v1_evidence_reads_and_upgrades_without_losing_other_conclusive_checks(self):
        async with self.sessions() as session:
            client = await session.get(Client, "a")
            row = catalog._m_api(await session.get(ModelDef, "p:model"))
            provider = (await catalog.effective_provider_map(session, client))["p"]
            scope = caps.principal_scope(client, row, "org")
            slot, legacy = caps.identity(row, provider, "company-private", scope, legacy=True)
            session.add(AppSetting(key=slot, value=json.dumps({"configRevision": legacy,
                "checkedAt": "2026-01-01T00:00:00+00:00", "checks": {"imageInput": {
                    "status": "passed", "checkedAt": "2026-01-01T00:00:00+00:00"}, "toolCalling": {
                    "status": "passed", "checkedAt": "2026-01-01T00:00:00+00:00"}}})))
            await session.commit()
        before = (await self.http.get("/api/v1/my-models", headers=self.headers["a"])).json()["usable"][0]
        self.assertEqual(before["imageRouting"], "native")
        self.assertEqual(before["capabilityCheck"]["checks"]["toolCalling"]["code"], "legacy_recheck_required")
        self.assertEqual(before["capabilityProfile"]["toolCalling"]["state"], "unknown")
        result = (await self.check(checks=["connection"])).json()
        self.assertEqual(result["reportVersion"], 3)
        self.assertEqual(result["verifiedChecks"]["imageInput"]["status"], "passed")
        self.assertEqual(result["imageRouting"], "native")
        self.assertNotIn("toolCalling", result["verifiedChecks"])
        self.assertEqual(result["checks"]["toolCalling"]["status"], "inconclusive")

    async def test_personal_model_delete_recreate_does_not_restore_old_evidence(self):
        definition = {"providerId": "custom-p", "name": "own", "config": {"imageRouting": "auto"}}
        async with self.sessions() as session:
            client = await session.get(Client, "a")
            client.models = [definition]
            await session.commit()
        first = (await self.check("a", model="own", checks=["imageInput"])).json()
        for definitions in ([], [definition]):
            async with self.sessions() as session:
                client = await session.get(Client, "a")
                await model_config_guard.personal(session, client, model_config_guard.revision(client))
                client.models = definitions
                await session.commit()
        async with self.sessions() as session:
            rows = await catalog.usable(session, await session.get(Client, "a"))
            own = next(row for row in rows if row["name"] == "own")
        self.assertIsNone(own["capabilityCheck"])
        self.assertNotEqual(first["configRevision"], own["configRevision"])

    async def test_personal_legacy_declaration_save_preserves_matching_wire_evidence(self):
        definition = {"providerId": "custom-p", "name": "own", "config": {"imageRouting": "auto"}}
        async with self.sessions() as session:
            client = await session.get(Client, "a")
            client.models = [definition]
            await session.commit()
        first = (await self.check("a", model="own", checks=["imageInput"])).json()
        async with self.sessions() as session:
            revision = model_config_guard.revision(await session.get(Client, "a"))
        response = await self.http.put("/api/v1/my-models", headers=self.headers["a"], json={
            "expectedRevision": revision, "returnRevision": True, "models": [{**definition, "label": "Renamed own", "ctxWindow": 0,
                "modality": "chat", "config": {"imageRouting": "auto", "capabilities": {"imageInput": "unsupported"}}}]})
        self.assertEqual(response.status_code, 200, response.text)
        own = next(row for row in response.json()["usable"] if row["name"] == "own")
        async with self.sessions() as session:
            self.assertEqual(response.json()["revision"], model_config_guard.revision(await session.get(Client, "a")))
        self.assertEqual(own["configRevision"], first["configRevision"])
        self.assertTrue(own["capabilityProfile"]["imageInput"].get("conflict"))

    async def test_personal_model_config_roundtrip_preserves_limits_and_declarations(self):
        async with self.sessions() as session:
            client = await session.get(Client, "a")
            revision = model_config_guard.revision(client)
        config = {"imageRouting": "auto", "maxOutputTokens": 8192,
                  "capabilities": {"imageInput": "supported", "toolCalling": "unknown", "streaming": "supported"}}
        response = await self.http.put("/api/v1/my-models", headers=self.headers["a"], json={
            "expectedRevision": revision, "models": [{"providerId": "custom-p", "name": "own",
                "ctxWindow": 64000, "config": config}]})
        self.assertEqual(response.status_code, 200, response.text)
        own = next(row for row in response.json()["usable"] if row["name"] == "own")
        self.assertEqual(own["config"], config)
        self.assertEqual(own["ctxWindow"], 64000)
        self.assertEqual(own["imageRouting"], "native")
        self.assertEqual(own["capabilityProfile"]["imageInput"]["source"], "configured")
        response = await self.check("a", model="own", checks=["connection", "streaming"])
        self.assertEqual(response.status_code, 200)
        mine = (await self.http.get("/api/v1/my-models", headers=self.headers["a"])).json()
        self.assertIsNotNone(mine["myModels"][0]["capabilityCheck"])


    async def test_resolved_model_reports_optional_adapter_without_selecting_it(self):
        async with self.sessions() as session:
            client = await session.get(Client, "a")
            for enabled in (False, True):
                with patch.object(catalog, "adapter_configured", return_value=enabled):
                    resolved = await catalog.resolve(session, client, "model")
                self.assertEqual(resolved["model"], "model")
                self.assertIs(resolved["visionFallbackAvailable"], enabled)
                carried = ai_exec.with_llm({"cfg": {"llm": {"visionFallbackAvailable": not enabled}}}, resolved)["cfg"]["llm"]
                self.assertIs(carried["visionFallbackAvailable"], enabled)


class ContractTests(unittest.TestCase):
    def test_output_default_is_separate_from_context_and_small_capability_probe(self):
        for config, expected in (({}, 16384), ({"maxOutputTokens": 32768}, 32768),
                                 ({"maxOutputTokens": 65536}, 65536)):
            cleaned = caps.clean_config(config)
            caps.validate_limits(131072, cleaned)
            fields = caps.runtime_fields(cleaned)
            self.assertEqual(fields["maxOutputTokens"], expected)
            body, _ = probe._payload({"model": "fixture", "contextWindow": 131072, **fields}, "connection")
            self.assertEqual(body["max_tokens"], 512)

    def test_saved_target_generation_keys_fit_the_mapped_database_column(self):
        from app.services.model_capability_generations import generation_key
        key = generation_key("personal-provider", "synthetic-device", "synthetic-provider")
        self.assertLessEqual(len(key), AppSetting.__table__.c.key.type.length)
        self.assertGreaterEqual(len(key.rsplit(":", 1)[-1]), 32)

    def test_limits_reject_invalid_and_conflicting_values(self):
        for value in (True, 1.5, "1.5", -1, 10000001):
            with self.assertRaises(ValueError):
                caps.validate_limits(value, {})
        self.assertEqual(caps.validate_limits(None, {}), 0)
        self.assertEqual(caps.validate_limits("128000", {"maxOutputTokens": 32000}), 128000)
        with self.assertRaises(ValueError):
            caps.validate_limits(8000, {"maxOutputTokens": 32000})

    def test_runner_native_configs_preserve_selected_model_limits(self):
        llm = {"base": "https://fixture.invalid/v1", "key": "private-key", "model": "fixture",
               "contextWindow": 128000, "maxOutputTokens": 32768, "imageRouting": "native"}
        with tempfile.TemporaryDirectory(prefix="soduwork-pi-config-") as folder:
            with patch.object(local_base, "_data_root", return_value=folder):
                env = local_base._env_for(local_base._PROFILES["opencode"], {"llm": llm})
                definition = json.loads(env["OPENCODE_CONFIG_CONTENT"])["provider"]["company"]["models"]["fixture"]
                self.assertEqual(definition["limit"], {"context": 128000, "output": 32768})
                self.assertEqual(definition["modalities"]["input"], ["text", "image"])
                env = local_base._env_for(local_base._PROFILES["pi"], {"llm": llm}, "model-capabilities")
            content = (Path(env["PI_CODING_AGENT_DIR"]) / "models.json").read_text(encoding="utf-8")
            definition = json.loads(content)["providers"]["company"]["models"][0]
            self.assertEqual(definition["maxTokens"], 32768)
            self.assertEqual(definition["input"], ["text", "image"])
            self.assertNotIn("private-key", content)

    def test_working_compatibility_reaches_managed_pi_and_filters_extra_data(self):
        compat = {"maxTokensField": "max_completion_tokens", "toolChoice": "auto", "streamOptions": False}
        llm = {"base": "https://fixture.invalid/v1", "key": "synthetic", "model": "fixture",
               "contextWindow": 128000, "compatibility": {**compat, "untrusted": "discard"}}
        self.assertEqual(runtime_images.model_fields(llm).get("compatibility"), compat)
        with tempfile.TemporaryDirectory(prefix="soduwork-pi-config-") as folder:
            with patch.object(local_base, "_data_root", return_value=folder):
                env = local_base._env_for(local_base._PROFILES["pi"], {"llm": llm}, "compatibility")
            content = json.loads((Path(env["PI_CODING_AGENT_DIR"]) / "models.json").read_text(encoding="utf-8"))
        actual = content["providers"]["company"]["compat"]
        self.assertEqual(actual.get("maxTokensField"), "max_completion_tokens")
        self.assertIs(actual.get("supportsUsageInStreaming"), False)


    def test_legacy_unknown_and_explicit_native_are_not_claimed_verified(self):
        self.assertEqual(caps.runtime_fields({})["imageRouting"], "vision-fallback")
        self.assertEqual(caps.profile({})["toolCalling"]["state"], "unknown")
        self.assertEqual(caps.profile({"imageRouting": "native"})["imageInput"]["source"], "legacy-native")
        for config in ({"capabilities": {"imageInput": True}}, {"maxOutputTokens": True},
                       {"maxOutputTokens": 1023}, {"maxOutputTokens": 262145},
                       {"imageRouting": "native", "capabilities": {"imageInput": "unsupported"}}):
            with self.assertRaises(ValueError):
                catalog.clean_model_config(config)
        self.assertEqual(catalog.clean_model_config({"imageRouting": "auto"}), {"imageRouting": "auto"})

    def test_declared_native_support_is_used_for_automatic_routing(self):
        for route in (None, "auto", "native"):
            fields = caps.runtime_fields({"imageRouting": route, "capabilities": {"imageInput": "supported"}})
            self.assertEqual(fields["imageRouting"], "native")
            self.assertEqual(fields["capabilityProfile"]["imageInput"]["source"], "configured")
        self.assertEqual(caps.runtime_fields({"capabilities": {"imageInput": "unsupported"}})["imageRouting"], "vision-fallback")

    def test_explicit_adapter_route_is_preserved_for_a_native_capable_model(self):
        for capabilities, evidence in (({"imageInput": "supported"}, None),
                ({}, {"checks": {"imageInput": {"status": "passed"}}})):
            fields = caps.runtime_fields({"imageRouting": "vision-fallback", "capabilities": capabilities}, evidence)
            self.assertEqual(fields["capabilityProfile"]["imageInput"]["state"], "supported")
            self.assertEqual(fields["imageRouting"], "vision-fallback")

if __name__ == "__main__":
    unittest.main()
