"""Task parse keeps a single JSON contract while waiting behind idle proxies."""
import asyncio
import json
import os
import socket
import threading
import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

os.environ.setdefault("AUTH_SECRET", "isolated-parser-keepalive-secret")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from fastapi import FastAPI
from app.api import tasks as api
from app.db import get_session
from app.deps import current_ai_client
from app.services import task_parse_response


class ParseKeepaliveTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_http_idle_budget_expires_without_keepalive_but_slow_parse_succeeds_with_it(self):
        import uvicorn
        app = FastAPI()
        app.include_router(api.router)
        app.dependency_overrides[current_ai_client] = lambda: SimpleNamespace(id="isolated")
        closed = []
        async def database():
            try:
                yield object()
            finally:
                closed.append(True)
        app.dependency_overrides[get_session] = database
        calls = []
        async def parse(*args, **kwargs):
            calls.append(kwargs["model"])
            before = len(closed)
            await asyncio.sleep(.35)
            # The request dependency must stay alive throughout streaming.
            if kwargs["model"] == "slow-chosen":
                self.assertEqual(len(closed), before)
            return {"title": "慢模型完整结果", "note": "原文尾部"}
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
        try:
            with patch.object(api.svc, "parse_task_text", parse), \
                    patch.object(task_parse_response, "KEEPALIVE_SECONDS", .02):
                thread.start()
                for _ in range(200):
                    if server.started:
                        break
                    await asyncio.sleep(.01)
                self.assertTrue(server.started)
                async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", trust_env=False,
                                             timeout=httpx.Timeout(2, read=.15)) as http:
                    with self.assertRaises(httpx.ReadTimeout):
                        await http.post("/api/v1/tasks/parse", json={"text": "原文", "model": "legacy"})
                    # Let the legacy request settle before checking dependency lifetime.
                    await asyncio.sleep(.4)
                    result = await http.post("/api/v1/tasks/parse", json={"text": "原文", "model": "slow-chosen", "keepalive": True})
                    self.assertEqual(result.status_code, 200)
                    self.assertEqual(result.json()["fields"]["note"], "原文尾部")
                    self.assertGreater(result.content.count(b" \n"), 2)
                    self.assertEqual(calls, ["legacy", "slow-chosen"])
        finally:
            server.should_exit = True
            await asyncio.to_thread(thread.join, 3)
            sock.close()
        self.assertFalse(thread.is_alive())

    async def test_slow_parse_yields_bytes_before_result_and_remains_valid_json(self):
        finish = asyncio.Event()
        async def parse():
            await finish.wait()
            return {"title": "完整结果", "note": "保留尾部"}
        with patch.object(task_parse_response, "KEEPALIVE_SECONDS", .01):
            response = task_parse_response.response(parse)
            stream = response.body_iterator
            first = await anext(stream)
            second = await asyncio.wait_for(anext(stream), .1)
            self.assertEqual(first + second, b" \n \n")
            finish.set()
            chunks = [first, second] + [part async for part in stream]
        result = json.loads(b"".join(chunks))
        self.assertTrue(result["ok"])
        self.assertEqual(result["fields"]["note"], "保留尾部")
        self.assertEqual(response.headers["content-type"], "application/json")
        self.assertEqual(response.headers["x-accel-buffering"], "no")

    async def test_total_deadline_cancels_model_and_returns_recoverable_error(self):
        cancelled = asyncio.Event()
        async def parse():
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        with patch.object(task_parse_response, "TOTAL_SECONDS", .03), \
                patch.object(task_parse_response, "KEEPALIVE_SECONDS", .005):
            result = json.loads(b"".join([part async for part in task_parse_response.response(parse).body_iterator]))
        self.assertTrue(cancelled.is_set())
        self.assertFalse(result["ok"])
        self.assertIn("超时", result["fields"]["_parseError"])
        self.assertIn("原文已保留", result["fields"]["_parseError"])

    async def test_disconnect_cancels_pending_work(self):
        started, cancelled = asyncio.Event(), asyncio.Event()
        async def parse():
            try:
                started.set()
                await asyncio.Future()
            finally:
                cancelled.set()
        stream = task_parse_response.response(parse).body_iterator
        await anext(stream)
        await started.wait()
        await stream.aclose()
        self.assertTrue(cancelled.is_set())

    async def test_asgi_send_disconnect_settles_work_and_session(self):
        started, cancelled = asyncio.Event(), asyncio.Event()
        async def parse():
            try:
                started.set()
                await asyncio.Future()
            finally:
                cancelled.set()
        async def send(message):
            if message["type"] == "http.response.body":
                await started.wait()
                raise OSError("client gone")
        response = task_parse_response.response(parse)
        with self.assertRaises(OSError):
            await asyncio.wait_for(response.stream_response(send), 1)
        self.assertTrue(cancelled.is_set(), "no orphan model request after send failure")

    async def test_unknown_error_does_not_expose_upstream_or_claim_success(self):
        async def parse():
            raise RuntimeError("SECRET https://internal.invalid")
        result = json.loads(b"".join([part async for part in task_parse_response.response(parse).body_iterator]))
        self.assertFalse(result["ok"])
        self.assertIn("重试", result["fields"]["_parseError"])
        self.assertNotIn("SECRET", str(result))

    async def test_real_route_is_opt_in_and_keeps_validation_and_identity(self):
        app = FastAPI()
        app.include_router(api.router)
        client = SimpleNamespace(id="own-device")
        db = object()
        app.dependency_overrides[current_ai_client] = lambda: client
        app.dependency_overrides[get_session] = lambda: db
        parser = AsyncMock(return_value={"title": "结果"})
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as http:
            with patch.object(api.svc, "parse_task_text", parser):
                for keepalive in (False, True):
                    result = await http.post("/api/v1/tasks/parse", json={"text": "原文", "model": "chosen", "keepalive": keepalive})
                    self.assertEqual(result.status_code, 200, result.text)
                    self.assertEqual(result.json(), {"ok": True, "fields": {"title": "结果"}})
                    self.assertEqual(result.headers.get("x-accel-buffering"), "no" if keepalive else None)
                    self.assertIs(parser.await_args.args[0], db)
                    self.assertIs(parser.await_args.kwargs["client"], client)
                    self.assertEqual(parser.await_args.kwargs["model"], "chosen")
                before = parser.await_count
                invalid = await http.post("/api/v1/tasks/parse", json={"text": "原文", "attachments": "invalid", "keepalive": True})
                self.assertEqual(invalid.status_code, 422)
                self.assertEqual(parser.await_count, before)


if __name__ == "__main__":
    unittest.main()
