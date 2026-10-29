"""Draft parsing through slow gateways, with no real models or business data."""
import asyncio
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-task-parse-keepalive-test-secret")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app.api import tasks
from app.services import task_parse_response as transport


class KeepaliveTests(unittest.IsolatedAsyncioTestCase):
    async def test_requirement_policy_is_scoped_and_automation_retains_old_budget(self):
        async def parse():
            await asyncio.sleep(.03)
            return {"strict": transport.REQUIREMENT_REQUEST.get()}
        async def collect(requirement):
            return json.loads(b"".join([p async for p in transport.response(
                parse, requirement=requirement).body_iterator]))
        with patch.object(transport, "TOTAL_SECONDS", .01):
            requirement, automation = await asyncio.gather(collect(True), collect(False))
        self.assertFalse(requirement["ok"])
        self.assertEqual(automation["fields"], {"strict": False})
        self.assertFalse(transport.REQUIREMENT_REQUEST.get())

    async def test_model_failure_returns_immediately_without_fallback_in_new_requirement(self):
        from app.services import task_parse_sources, model_catalog, model_transport, llm
        from app.services.model_errors import UpstreamError
        session = SimpleNamespace(close=AsyncMock())
        conf = {"kind": "openai-compat", "model": "chosen"}
        for status in (429, 503, 504):
            async def parse():
                content = await task_parse_sources._parse_with_my_model(session, object(), "chosen", "system", "input")
                if not content:
                    await llm.chat(session, "system", "input")
                return {"title": content}
            with patch.object(model_catalog, "resolve", AsyncMock(return_value=conf)), \
                 patch.object(model_transport, "open_response", AsyncMock(side_effect=UpstreamError(status, "secret"))) as upstream, \
                 patch.object(llm, "chat", AsyncMock()) as fallback:
                result = json.loads(b"".join([p async for p in transport.response(parse).body_iterator]))
                self.assertFalse(result["ok"])
                self.assertIn(str(status), result["fields"]["_parseError"])
                self.assertNotIn("secret", str(result))
                fallback.assert_not_awaited()
                self.assertEqual(upstream.await_args.kwargs["timeout"], 120)
                # Legacy/automation callers retain their original fallback contract.
                self.assertEqual(await task_parse_sources._parse_with_my_model(session, object(), "chosen", "system", "input"), "")
                self.assertEqual(upstream.await_args.kwargs["timeout"], 90)

    async def test_slow_parse_emits_bytes_before_result_and_preserves_json(self):
        gate = asyncio.Event()
        parse = AsyncMock(side_effect=lambda: None)

        async def slow():
            await gate.wait()
            return {"title": "需求", "note": "完整原文"}

        parse.side_effect = slow
        with patch.object(transport, "KEEPALIVE_SECONDS", .01):
            response = transport.response(parse)
            iterator = response.body_iterator
            first = await asyncio.wait_for(anext(iterator), .5)
            second = await asyncio.wait_for(anext(iterator), .5)
            self.assertEqual(first.strip() + second.strip(), b"")
            gate.set()
            rest = [chunk async for chunk in iterator]
        self.assertEqual(json.loads(first + second + b"".join(rest)), {
            "ok": True, "fields": {"title": "需求", "note": "完整原文"}})
        parse.assert_awaited_once()
        self.assertEqual(response.headers["x-accel-buffering"], "no")

    async def test_total_timeout_cancels_parse_and_is_not_a_success(self):
        cancelled = asyncio.Event()

        async def hang():
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with patch.object(transport, "TOTAL_SECONDS", .02), patch.object(transport, "KEEPALIVE_SECONDS", .005):
            result = json.loads(b"".join([part async for part in transport.response(hang).body_iterator]))
        self.assertTrue(cancelled.is_set())
        self.assertFalse(result["ok"])
        self.assertIn("超时", result["fields"]["_parseError"])
        self.assertIn("原文已保留", result["fields"]["_parseError"])

    async def test_close_cancels_pending_parse(self):
        started, stopped = asyncio.Event(), asyncio.Event()

        async def hang():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        response = transport.response(hang)
        await anext(response.body_iterator)
        await started.wait()
        await response.body_iterator.aclose()
        self.assertTrue(stopped.is_set())

    async def test_send_failure_settles_parse_without_background_hook(self):
        started, stopped = asyncio.Event(), asyncio.Event()

        async def hang():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        async def send(message):
            if message["type"] == "http.response.body":
                await started.wait()
                raise OSError("fixture disconnect")

        with self.assertRaises(OSError):
            await transport.response(hang).stream_response(send)
        self.assertTrue(stopped.is_set())

    async def test_errors_do_not_expose_private_exception_or_report_success(self):
        for error in (RuntimeError("token=PRIVATE https://private.invalid"), HTTPException(503, "PRIVATE")):
            parse = AsyncMock(side_effect=error)
            raw = b"".join([part async for part in transport.response(parse).body_iterator])
            result = json.loads(raw)
            self.assertFalse(result["ok"])
            self.assertIn("_parseError", result["fields"])
            self.assertNotIn(b"PRIVATE", raw)


class ParseRouteTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(tasks.router)
        self.session = object()
        self.actor = SimpleNamespace(id="fixture-device", user_ref="fixture-user")
        app.dependency_overrides[tasks.current_ai_client] = lambda: self.actor
        app.dependency_overrides[tasks.get_session] = lambda: self.session
        self.http = TestClient(app)

    def tearDown(self):
        self.http.close()

    def test_negotiated_and_legacy_calls_keep_inputs_and_result(self):
        body = {"text": "需求原文", "model": "chosen", "instruction": "当前指令", "attachments": []}
        for accept in ("application/json", transport.ACCEPT):
            parse = AsyncMock(return_value={"title": "整理后"})
            with patch.object(tasks.svc, "parse_task_text", parse):
                reply = self.http.post("/api/v1/tasks/parse", json=body, headers={"Accept": accept})
            self.assertEqual(reply.status_code, 200)
            self.assertEqual(reply.json(), {"ok": True, "fields": {"title": "整理后"}})
            parse.assert_awaited_once_with(self.session, body["text"], client=self.actor,
                                          model="chosen", attachments=[], instruction="当前指令")
            self.assertEqual(reply.content.startswith(b" \n"), accept == transport.ACCEPT)

    def test_validation_still_returns_422_without_starting_model(self):
        with patch.object(tasks.svc, "parse_task_text", AsyncMock()) as parse:
            reply = self.http.post("/api/v1/tasks/parse", json={"text": "原文", "attachments": "invalid"},
                                   headers={"Accept": transport.ACCEPT})
        self.assertEqual(reply.status_code, 422)
        parse.assert_not_awaited()

    def test_legacy_http_error_status_is_unchanged(self):
        with patch.object(tasks.svc, "parse_task_text", AsyncMock(side_effect=HTTPException(503, "unavailable"))):
            reply = self.http.post("/api/v1/tasks/parse", json={"text": "原文"})
        self.assertEqual(reply.status_code, 503)

    def test_authentication_failure_is_not_wrapped_as_stream_success(self):
        def denied():
            raise HTTPException(401, "fixture unauthenticated")
        self.http.app.dependency_overrides[tasks.current_ai_client] = denied
        with patch.object(tasks.svc, "parse_task_text", AsyncMock()) as parse:
            reply = self.http.post("/api/v1/tasks/parse", json={"text": "原文"},
                                   headers={"Accept": transport.ACCEPT})
        self.assertEqual(reply.status_code, 401)
        parse.assert_not_awaited()

    def test_request_session_remains_owned_until_stream_finishes(self):
        closed = []

        async def session():
            try:
                yield self.session
            finally:
                closed.append(True)

        async def parse(*args, **kwargs):
            await asyncio.sleep(.01)
            self.assertEqual(closed, [])
            return {"title": "parsed before session close"}

        self.http.app.dependency_overrides[tasks.get_session] = session
        with patch.object(tasks.svc, "parse_task_text", parse):
            reply = self.http.post("/api/v1/tasks/parse", json={"text": "原文"},
                                   headers={"Accept": transport.ACCEPT})
        self.assertTrue(reply.json()["ok"])
        self.assertEqual(closed, [True])


if __name__ == "__main__":
    unittest.main()
