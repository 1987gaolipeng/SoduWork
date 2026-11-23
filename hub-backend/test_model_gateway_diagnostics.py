"""Real loopback Hub/provider HTTP with fresh SQLite; no external model traffic.

Run: python -m unittest -v test_model_gateway_diagnostics
Optional SDK receipt: SODUWORK_MODEL_SDK_CHECK=1 (requires client npm dependencies).
The production routers/auth/catalog/transport run; migrations and background jobs do not.
"""
import asyncio
import json
import os
from pathlib import Path
import secrets
import socket
import unittest

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api import ai_proxy, personal_models
from app.db import get_session
from app.models import Client, ModelDef, ModelProvider, User
from app.services import device_auth
from test_model_runtime import IsolatedDatabase


class RequestCorrelationTests(unittest.TestCase):
    def test_generic_refusals_require_recognized_evidence(self):
        from app.services.model_errors import forbidden_category
        for raw in ("", " ", ".", "!", "。", "{}", '{"requestId":"fixture"}', '{"error":{}}',
                    '{"error":{"message":null}}', '{"error":""}', '{"error":{"message":" "}}',
                    "null", "[]", '{"error":'):
            with self.subTest(raw=raw):
                self.assertEqual(forbidden_category(raw), "unclassified")
        for raw in ("HTTP 403", "HTTP 403: Forbidden", '{"error":{"status":403}}'):
            with self.subTest(raw=raw):
                self.assertEqual(forbidden_category(raw), "generic")

    def test_only_bounded_opaque_noncredential_request_ids_are_accepted(self):
        from app.services.model_transport import _upstream_request_id
        secret = "synthetic-api-credential"
        for value in (secret, "prefix-" + secret, "https://private.invalid", "bad\nheader", "x" * 101, ""):
            self.assertEqual(_upstream_request_id({"x-request-id": value}, secret), "")
        self.assertEqual(_upstream_request_id({"x-request-id": "request-183:attempt.2"}, secret), "request-183:attempt.2")
        self.assertEqual(_upstream_request_id({"x-request-id": secret, "x-ms-request-id": "safe-183"}, secret), "safe-183")


class GatewayDiagnosticsTests(IsolatedDatabase):
    async def start_server(self, app):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False,
                                              lifespan="off", timeout_graceful_shutdown=3))
        task = asyncio.create_task(server.serve(sockets=[sock]))
        self.servers.append((server, task, sock, port))
        async with asyncio.timeout(5):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(.01)
        return f"http://127.0.0.1:{port}"

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.servers, self.calls = [], []
        self.mode = "billing"
        self.secret = secrets.token_hex(24)
        upstream = FastAPI()

        @upstream.api_route("/{path:path}", methods=["GET", "POST"])
        async def provider(path: str, request: Request):
            self.calls.append((request.method, path))
            if self.mode == "forbidden-category":
                return JSONResponse(status_code=403, content=self.denial)
            if self.mode in ("trace-denial", "unsafe-trace-denial"):
                request_id = "fixture-request-183" if self.mode == "trace-denial" else self.secret
                return JSONResponse(status_code=403, headers={"x-request-id": request_id}, content={
                    "error": {"message": f"private refusal {self.secret} https://private.invalid"}})
            if request.method == "GET" and self.mode != "probe-billing":
                model = "personal-probe-model" if path.startswith("personal/") else "fixture-model"
                return {"data": [{"id": model}]}
            if path.endswith("messages"):
                return {"content": [{"type": "text", "text": "fixture"}]}
            return JSONResponse(status_code=429, headers={"Retry-After": "1"}, content={
                "error": {"code": "1113" if self.mode in ("billing", "probe-billing") else "rate_limit",
                          "message": f"余额不足 {self.secret} {request.headers.get('authorization', '')} https://private.invalid"}})

        self.provider_url = await self.start_server(upstream)
        async with self.engine.begin() as connection:
            await connection.run_sync(User.__table__.create)
        async with self.sessions() as session, session.begin():
            session.add_all([
                User(id="fixture-user", username="fixture-user"),
                Client(id="fixture", user_ref="fixture-user", auth_state="active"),
                ModelProvider(id="fixture", name="Fixture", api_key=self.secret,
                              base_url=self.provider_url + "/v1"),
                ModelDef(id="fixture:fixture-model", provider_id="fixture", name="fixture-model"),
            ])
        app = FastAPI()
        app.include_router(ai_proxy.router)
        app.include_router(personal_models.router, prefix="/api/v1")

        async def isolated_session():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[get_session] = isolated_session
        self.hub_url = await self.start_server(app)
        self.http = httpx.AsyncClient(base_url=self.hub_url, trust_env=False, timeout=10)
        async with self.sessions() as session:
            token, _ = device_auth.issue_session(await session.get(Client, "fixture"))
        self.headers = {"Authorization": "Device " + token}
        config = await self.http.get("/api/v1/ai-proxy/config", headers=self.headers)
        self.assertEqual(config.status_code, 200)
        self.assertTrue(config.json()["ok"], config.text)
        self.ticket = config.json()["key"]

    async def asyncTearDown(self):
        await self.http.aclose()
        for server, task, sock, port in reversed(self.servers):
            server.should_exit = True
            await asyncio.wait_for(task, 5)
            sock.close()
            with socket.socket() as check:
                self.assertNotEqual(check.connect_ex(("127.0.0.1", port)), 0)
        await super().asyncTearDown()

    async def test_discovery_success_does_not_certify_generation_and_billing_is_safe(self):
        managed_probe = await self.http.post("/api/v1/my-models/test", headers=self.headers,
                                             json={"providerId": "fixture"})
        self.assertEqual(managed_probe.status_code, 403)
        self.assertEqual(self.calls, [], "organization probes must not contact the provider")

        catalog = (await self.http.get("/api/v1/my-models", headers=self.headers)).json()
        personal_secret = secrets.token_hex(24)
        saved = await self.http.put("/api/v1/my-models", headers=self.headers, json={
            "expectedRevision": catalog["revision"], "providers": [{"id": "custom-probe",
                "name": "Personal probe", "baseUrl": self.provider_url + "/personal/v1",
                "kind": "openai-compat", "personal": True}],
            "keys": {"custom-probe": personal_secret},
            "models": [{"providerId": "custom-probe", "name": "personal-probe-model"}]})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(self.calls, [])
        probe = await self.http.post("/api/v1/my-models/test", headers=self.headers,
                                     json={"providerId": "custom-probe"})
        self.assertEqual(probe.status_code, 200)
        self.assertTrue(probe.json()["ok"])
        self.assertEqual(probe.json()["keyFrom"], "mine")
        self.assertEqual(probe.json()["probe"], "models")
        self.assertIn("尚未验证", probe.json()["detail"])
        self.assertEqual(self.calls, [("GET", "personal/v1/models")])
        auth = {"Authorization": "Bearer " + self.ticket}
        for path in ("chat/completions", "responses"):
            for stream in (False, True):
                response = await self.http.post("/api/v1/ai-proxy/v1/" + path, headers=auth,
                    json={"model": "fixture-model", "messages": [{"role": "user", "content": "hi"}],
                          "input": "hi", "stream": stream})
                self.assertEqual(response.status_code, 200 if stream else 429)
                payload = (json.loads(next(line[6:] for line in response.text.splitlines()
                                          if line.startswith("data: "))) if stream else response.json())
                self.assertEqual(payload["error"]["providerCode"], "1113")
                self.assertEqual(payload["error"]["code"], "upstream_billing_error")
                self.assertIn("billing_required", payload["error"]["message"])
                self.assertNotIn("retry-after", response.headers)
                self.assertNotIn(self.secret, response.text)
                self.assertNotIn("private.invalid", response.text)
        self.assertEqual(len(self.calls), 5)
        personal_config = await self.http.get("/api/v1/ai-proxy/config", headers=self.headers,
                                             params={"model": "personal-probe-model"})
        self.assertEqual(personal_config.status_code, 200, personal_config.text)
        self.assertEqual(personal_config.json()["quotaScope"], "personal")
        response = await self.http.post("/api/v1/ai-proxy/v1/chat/completions",
            headers={"Authorization": "Bearer " + personal_config.json()["key"]},
            json={"model": "personal-probe-model", "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["error"]["code"], "upstream_billing_error")
        self.assertEqual(response.json()["error"]["providerCode"], "1113")
        self.assertNotIn("retry-after", response.headers)
        self.assertNotIn(personal_secret, response.text)
        self.assertNotIn(self.secret, response.text)
        self.assertNotIn("private.invalid", response.text)
        self.assertEqual(self.calls[-1], ("POST", "personal/v1/chat/completions"))
        self.assertEqual(len(self.calls), 6)
        self.mode = "transient"
        response = await self.http.post("/api/v1/ai-proxy/v1/chat/completions", headers=auth,
            json={"model": "fixture-model", "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(response.json()["error"]["code"], 429)
        self.assertEqual(float(response.headers["retry-after"]), 1)
        self.mode = "probe-billing"
        probe = (await self.http.post("/api/v1/my-models/test", headers=self.headers,
                                     json={"providerId": "custom-probe"})).json()
        self.assertFalse(probe["ok"])
        self.assertEqual(probe["providerCode"], "1113")
        self.assertIn("余额", probe["detail"])
        self.assertNotIn(self.secret, json.dumps(probe))
        self.assertNotIn(personal_secret, json.dumps(probe))
        self.assertNotIn("private.invalid", json.dumps(probe))

    async def test_anthropic_stays_configurable_but_gateway_explains_the_boundary(self):
        catalog = (await self.http.get("/api/v1/my-models", headers=self.headers)).json()
        saved = await self.http.put("/api/v1/my-models", headers=self.headers, json={
            "expectedRevision": catalog["revision"], "providers": [{"id": "custom-anthropic",
                "name": "Anthropic fixture", "baseUrl": self.provider_url + "/anthropic",
                "kind": "anthropic", "personal": True}],
            "keys": {"custom-anthropic": self.secret},
            "models": [{"providerId": "custom-anthropic", "name": "anthropic-model"}]})
        self.assertEqual(saved.status_code, 200, saved.text)
        probe = (await self.http.post("/api/v1/my-models/test", headers=self.headers,
                                     json={"providerId": "custom-anthropic"})).json()
        self.assertTrue(probe["ok"])
        self.assertEqual(probe["protocol"], "anthropic")
        self.assertFalse(probe["gatewayCompatible"])
        catalog = (await self.http.get("/api/v1/my-models", headers=self.headers)).json()
        row = next(row for row in catalog["usable"] if row["name"] == "anthropic-model")
        self.assertEqual(row["providerKind"], "anthropic")
        before = len(self.calls)
        config = (await self.http.get("/api/v1/ai-proxy/config", headers=self.headers,
                                     params={"model": "anthropic-model"})).json()
        self.assertFalse(config["ok"])
        self.assertEqual(config["code"], "unsupported_model_protocol")
        self.assertEqual(config["protocol"], "anthropic")
        self.assertIn("OpenAI 兼容地址", config["reason"])
        self.assertNotIn("key", config)
        self.assertEqual(len(self.calls), before, "incompatible gateway must fail before upstream traffic")
        async with self.sessions() as session:
            client = await session.get(Client, "fixture")
            self.assertEqual(client.model_keys["custom-anthropic"], self.secret)
            self.assertEqual(client.config["modelProviders"][0]["kind"], "anthropic")

    async def sdk_receipt(self, category=""):
        if os.environ.get("SODUWORK_MODEL_SDK_CHECK") != "1":
            self.skipTest("Opt-in Node SDK receipt; HTTP behavior is tested independently")
        script = Path(__file__).resolve().parents[1] / "client/e2e/model-billing.cjs"
        process = await asyncio.create_subprocess_exec("node", str(script),
            env={**os.environ, "SODUWORK_FIXTURE_HUB": self.hub_url,
                 "SODUWORK_FIXTURE_TICKET": self.ticket, "SODUWORK_FIXTURE_REFUSAL": category},
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            output, _ = await asyncio.wait_for(process.communicate(), 45)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        self.assertEqual(process.returncode, 0, output.decode("utf-8", "replace"))
        self.assertIn(b'"retryAttempts":0', output)

    async def test_native_sdk_stops_billing_retries(self):
        await self.sdk_receipt()
        self.assertEqual(self.calls, [("POST", "v1/chat/completions")])

    async def test_sdk_summary_action_requires_a_neutral_provider_refusal(self):
        self.mode = "forbidden-category"
        for category, body in [("restricted", {"code": "permission_denied", "message": self.secret}),
                               ("unclassified", {}),
                               ("generic", {"message": "Forbidden"})]:
            self.denial = {"error": body}
            await self.sdk_receipt(category)
        self.assertEqual(self.calls, [("POST", "v1/chat/completions")] * 3)

    async def test_summary_denial_category_survives_json_and_sse_without_provider_details(self):
        self.mode = "forbidden-category"
        for denial, category in [
            ({"error": {"code": "forbidden", "message": "Forbidden"}}, "generic"),
            ({"error": {"requestId": "fixture"}}, "unclassified"),
            ("!", "unclassified"),
            ({"error": {"message": f"Access denied by policy: {self.secret}"}}, "restricted"),
            ({"error": {"code": "insufficient_permissions", "message": self.secret}}, "restricted"),
            ({"error": {"code": "private-code", "message": self.secret}}, "unclassified"),
            ({"error": "Forbidden", "detail": {"reason": self.secret}}, "unclassified"),
            ({"error": {"message": " " * 4000 + "Forbidden"}}, "unclassified"),
        ]:
            self.denial = denial
            for stream in (False, True):
                response = await self.http.post("/api/v1/ai-proxy/v1/chat/completions",
                    headers={"Authorization": "Bearer " + self.ticket},
                    json={"model": "fixture-model", "messages": [{"role": "user", "content": "hi"}], "stream": stream})
                self.assertEqual(response.status_code, 200 if stream else 403)
                error = (json.loads(next(line[6:] for line in response.text.splitlines() if line.startswith("data: ")))
                         if stream else response.json())["error"]
                self.assertEqual(error["refusalCategory"], category)
                self.assertIn(f"[soduwork-refusal:{category}]", error["message"])
                self.assertNotIn(self.secret, response.text)
                self.assertNotIn("private-code", response.text)

    async def test_denial_keeps_safe_correlation_without_guessing_permission(self):
        self.mode = "trace-denial"
        auth = {"Authorization": "Bearer " + self.ticket}
        for stream in (False, True):
            response = await self.http.post("/api/v1/ai-proxy/v1/chat/completions", headers=auth,
                json={"model": "fixture-model", "messages": [{"role": "user", "content": "hi"}], "stream": stream})
            self.assertEqual(response.status_code, 200 if stream else 403)
            payload = (json.loads(next(line[6:] for line in response.text.splitlines() if line.startswith("data: ")))
                       if stream else response.json())["error"]
            self.assertNotIn("权限", payload["message"])
            self.assertRegex(payload["diagnosticId"], r"^[a-f0-9]{32}$")
            self.assertIn("[soduwork-trace:" + payload["diagnosticId"] + "]", payload["message"])
            self.assertEqual(payload["upstreamRequestId"], "fixture-request-183")
            self.assertNotIn(self.secret, response.text)
            self.assertNotIn("private.invalid", response.text)
        self.mode = "unsafe-trace-denial"
        response = await self.http.post("/api/v1/ai-proxy/v1/chat/completions", headers=auth,
            json={"model": "fixture-model", "messages": [{"role": "user", "content": "hi"}]})
        self.assertNotIn("upstreamRequestId", response.json()["error"])
        self.assertNotIn(self.secret, response.text)


if __name__ == "__main__":
    import unittest
    unittest.main()
