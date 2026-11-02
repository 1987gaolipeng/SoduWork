"""Isolated persistence/IO tests. No configured business DB or paid API calls."""
import asyncio
import json
import os
import socket
import httpx
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import AsyncAdaptedQueuePool

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from app import models
from app.services import video_files, video_generation as video, video_jobs, storage
from app.services.model_errors import UpstreamError

MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 32
CONF = {"model": "video-model", "provider": "openai", "kind": "openai-compat",
        "base": "https://provider.test/v1", "key": "test-only-secret", "config": {
            "statusPath": "/tasks/{id}", "resultPath": "/tasks/{id}/content"}}


class VideoRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        database = Path(self.temp.name, "test.db").as_posix()
        self.engine = create_async_engine("sqlite+aiosqlite:///" + database,
            poolclass=AsyncAdaptedQueuePool, pool_size=1, max_overflow=0, pool_timeout=.2)
        async with self.engine.begin() as connection:
            await connection.run_sync(models.Attachment.__table__.create)
            await connection.run_sync(models.Client.__table__.create)
        self.factory = async_sessionmaker(self.engine, expire_on_commit=False)
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(video.model_catalog, "resolve",
            new=AsyncMock(return_value=CONF)))
        self.stack.enter_context(patch.object(video, "POLL_INTERVAL_SECONDS", 0))
        self.stack.enter_context(patch.object(storage, "backend_name", return_value="local"))
        self.stack.enter_context(patch.object(storage, "_LOCAL_DIR", str(Path(self.temp.name, "files"))))
        self.stack.enter_context(patch.object(video_jobs.resource_access, "attachment_url",
            side_effect=lambda aid: "/api/v1/attachments/" + aid + "?ticket=test"))
        self.args = {"prompt": "product demo", "platform": "douyin", "duration": 10,
                     "filename": "demo.mp4"}

    async def asyncTearDown(self):
        await self.engine.dispose()
        self.stack.close()
        self.temp.cleanup()

    async def generate(self, **args):
        async with self.factory() as session:
            client = await session.get(models.Client, "client-1")
            if client is None:
                client = models.Client(id="client-1", user_ref="owner-1")
                session.add(client)
                await session.commit()
            return await video.generate_video(session, client, dict(self.args, **args),
                                               conversation_id="conversation-1")

    async def rows(self):
        async with self.factory() as session:
            return (await session.execute(select(models.Attachment))).scalars().all()

    async def test_binary_video_is_saved_and_repeated_request_reuses_attachment(self):
        request = AsyncMock(return_value=(MP4, "application/octet-stream"))
        with patch.object(video, "_provider_request", new=request):
            first = await self.generate()
            second = await self.generate(caption="updated caption", filename="new.mp4")
        self.assertEqual(first["artifact"]["attachmentId"], second["artifact"]["attachmentId"])
        self.assertEqual(first["artifact"]["duration"], 10)
        self.assertEqual(first["artifact"]["aspectRatio"], "9:16")
        self.assertEqual(first["artifact"]["mimeType"], "video/mp4")
        self.assertEqual(request.await_count, 1)
        row = (await self.rows())[0]
        self.assertEqual(storage.get(row.storage_key, row.backend), MP4)

    async def test_explicit_new_generation_does_not_reuse_completed_video(self):
        request = AsyncMock(return_value=(MP4, "video/mp4"))
        with patch.object(video, "_provider_request", new=request):
            first = await self.generate(generationId="version-1")
            second = await self.generate(generationId="version-2")
        self.assertNotEqual(first["artifact"]["attachmentId"], second["artifact"]["attachmentId"])
        self.assertEqual(request.await_count, 2)

    async def test_poll_timeout_then_retry_only_polls_same_persisted_job(self):
        calls = []
        fail = True

        async def request(conf, path, body, timeout):
            nonlocal fail
            calls.append((path, body is not None))
            # A single-connection pool must remain available during provider IO.
            async with self.factory() as observer:
                await observer.execute(select(models.Attachment.id))
            if body is not None:
                return b'{"id":"job/1","status":"queued"}', "application/json"
            if fail:
                fail = False
                raise TimeoutError("test timeout")
            if path.endswith("/content"):
                return MP4, "video/mp4"
            return b'{"status":"succeeded"}', "application/json"

        with patch.object(video, "_provider_request", new=request):
            with self.assertRaises(TimeoutError):
                await self.generate()
            pending = (await self.rows())[0]
            self.assertEqual(pending.evidence_meta["jobId"], "job/1")
            self.assertEqual(pending.size, 0)
            result = await self.generate()
        self.assertEqual(sum(is_post for _, is_post in calls), 1)
        self.assertEqual(result["artifact"]["attachmentId"], pending.id)
        self.assertIn(("/tasks/job%2F1/content", False), calls)

    async def test_simultaneous_request_cannot_create_second_provider_job(self):
        started, finish = asyncio.Event(), asyncio.Event()
        calls = []

        async def request(conf, path, body, timeout):
            calls.append(path)
            started.set()
            await finish.wait()
            return MP4, "video/mp4"

        with patch.object(video, "_provider_request", new=request):
            task = asyncio.create_task(self.generate())
            await asyncio.wait_for(started.wait(), 2)
            try:
                with self.assertRaisesRegex(ValueError, "正在生成"):
                    await self.generate()
            finally:
                finish.set()
                await task
        self.assertEqual(len(calls), 1)

    async def test_cancelled_poll_releases_lease_and_preserves_job_for_retry(self):
        polling = asyncio.Event()

        async def request(conf, path, body, timeout):
            if body is not None:
                return b'{"id":"job-2","status":"pending"}', "application/json"
            polling.set()
            await asyncio.Event().wait()

        with patch.object(video, "_provider_request", new=request):
            task = asyncio.create_task(self.generate())
            await asyncio.wait_for(polling.wait(), 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        row = (await self.rows())[0]
        self.assertEqual(row.evidence_meta["jobId"], "job-2")
        self.assertEqual(row.evidence_meta["leaseUntil"], 0)
        resumed = AsyncMock(return_value=(MP4, "video/mp4"))
        with patch.object(video, "_provider_request", new=resumed):
            result = await self.generate()
        self.assertEqual(result["artifact"]["attachmentId"], row.id)
        self.assertIsNone(resumed.call_args.args[2])

    async def test_uncertain_submission_does_not_automatically_bill_again(self):
        request = AsyncMock(side_effect=TimeoutError("header timeout"))
        with patch.object(video, "_provider_request", new=request):
            with self.assertRaises(TimeoutError):
                await self.generate()
            with self.assertRaisesRegex(ValueError, "提交结果尚不确定"):
                await self.generate()
        self.assertEqual(request.await_count, 1)

    async def test_failed_provider_job_cannot_be_reported_as_completed(self):
        request = AsyncMock(return_value=(b'{"id":"bad-job","status":"failed",'
            b'"error":"secret-provider-value"}', "application/json"))
        with patch.object(video, "_provider_request", new=request):
            with self.assertRaises(video.VideoJobFailed) as failure:
                await self.generate()
            with self.assertRaisesRegex(ValueError, "上次视频任务已失败"):
                await self.generate()
        self.assertNotIn("secret-provider-value", str(failure.exception))
        self.assertEqual(request.await_count, 1)
        row = (await self.rows())[0]
        self.assertFalse(row.storage_key)
        self.assertEqual(row.evidence_meta["status"], "failed")

    async def test_result_path_only_waits_for_result(self):
        request = AsyncMock(side_effect=[UpstreamError(404, "not ready"),
            (b'{"status":"processing"}', "application/json"), (MP4, "video/mp4")])
        with patch.object(video, "_provider_request", new=request):
            data, _ = await video._resolve_bytes(CONF, {"resultPath": "/tasks/{id}/content"},
                b'{"id":"job-1"}', "application/json", video.time.monotonic() + 3)
        self.assertEqual(data, MP4)
        self.assertEqual(request.await_count, 3)

    async def test_dns_private_and_mixed_answers_are_rejected(self):
        def address(ip):
            return (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))
        for ips in (["127.0.0.1"], ["169.254.169.254"], ["8.8.8.8", "192.0.2.1"]):
            with self.subTest(ips=ips), patch.object(video.socket, "getaddrinfo",
                    return_value=[address(ip) for ip in ips]):
                with self.assertRaisesRegex(ValueError, "内部地址"):
                    await video._resolve_public_addresses("https://cdn.example/video.mp4")
        with patch.object(video.socket, "getaddrinfo", return_value=[address("8.8.8.8")]):
            self.assertEqual(await video._resolve_public_addresses("https://cdn.example/video.mp4"),
                             ("8.8.8.8",))

    async def test_public_backend_connects_to_validated_ip_and_keeps_tls_host(self):
        backend = video._PinnedNetworkBackend(("8.8.8.8",))
        with patch.object(backend._backend, "connect_tcp", new=AsyncMock(return_value="stream")) as connect:
            self.assertEqual(await backend.connect_tcp("untrusted.example", 443), "stream")
        self.assertEqual(connect.call_args.args, ("8.8.8.8", 443))

    async def test_real_http_provider_through_model_transport_generates_file(self):
        from app.services import model_runtime, model_transport
        from app.model_runtime_models import ModelRuntimeLease, ModelRuntimeMetric
        async with self.engine.begin() as connection:
            for model in (models.AppSetting, models.ModelDef, models.ModelProvider,
                          ModelRuntimeLease, ModelRuntimeMetric):
                await connection.run_sync(model.__table__.create)
        seen, peers = [], []
        async def serve(reader, writer):
            peers.append(asyncio.current_task())
            try:
                head = await reader.readuntil(b"\r\n\r\n")
                lines = head.split(b"\r\n")
                method, path, _ = lines[0].decode().split(" ")
                length = next((int(line.split(b":", 1)[1]) for line in lines
                               if line.lower().startswith(b"content-length:")), 0)
                payload = await reader.readexactly(length) if length else b""
                seen.append((method, path, payload))
                if method == "POST":
                    body, mime = b'{"id":"socket-job","status":"queued"}', "application/json"
                elif path.endswith("/content"):
                    body, mime = MP4, "video/mp4"
                else:
                    body, mime = b'{"status":"succeeded"}', "application/json"
                writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        try:
            conf = dict(CONF, base=f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}", user="fixture")
            with patch.object(video.model_catalog, "resolve", new=AsyncMock(return_value=conf)), \
                    patch.object(model_runtime, "SessionLocal", self.factory):
                result = await self.generate()
                self.assertEqual((await model_runtime.snapshot())["running"], 0)
                async with self.factory() as session:
                    self.assertEqual((await session.scalars(select(ModelRuntimeLease))).all(), [])
            self.assertEqual([method for method, _, _ in seen], ["POST", "GET", "GET"])
            self.assertEqual(json.loads(seen[0][2])["prompt"], "product demo")
            row = (await self.rows())[0]
            self.assertEqual(storage.get(row.storage_key, row.backend), MP4)
            self.assertEqual(result["artifact"]["size"], len(MP4))
        finally:
            server.close()
            await server.wait_closed()
            await asyncio.gather(*peers, return_exceptions=True)
            await model_transport.shutdown()

    async def test_streamed_video_storage_closes_temp_file_and_releases_pool(self):
        async def chunks():
            yield MP4
            yield b"x" * (1024 * 1024)
        body = await video_files.collect(chunks(), 2 * 1024 * 1024)
        self.assertIsInstance(body, video_files.VideoBody)
        with patch.object(video, "_provider_request", new=AsyncMock(return_value=(body, "video/mp4"))):
            result = await self.generate(filename="demo.exe")
        self.assertTrue(body.handle.closed)
        self.assertEqual(result["artifact"]["filename"], "demo.mp4")
        self.assertEqual(result["artifact"]["size"], len(MP4) + 1024 * 1024)

    async def test_mcp_http_result_and_audit_survive_released_auth_transaction(self):
        from fastapi import Depends, FastAPI
        from app.api import task_mcp
        from app.services import plugin_builtin, plugin_mcp_gateway, plugin_mcp_limits
        async with self.engine.begin() as connection:
            for model in (models.User, models.AuditLog):
                await connection.run_sync(model.__table__.create)
        async with self.factory() as session:
            session.add(models.Client(id="client-1", user_ref="owner-1"))
            session.add(models.User(id="owner-1", username="fixture", display_name="fixture"))
            await session.commit()
        app = FastAPI()
        app.include_router(task_mcp.router)
        async def db():
            async with self.factory() as session:
                yield session
        async def principal(session=Depends(task_mcp.get_session)):
            return SimpleNamespace(client=await session.get(models.Client, "client-1"), claims={
                "typ": "plugin-mcp", "ref": "conversation-1", "cid": "client-1",
                "jti": "video-mcp-fixture", **plugin_mcp_limits.ticket_claims()})
        app.dependency_overrides[task_mcp.get_session] = db
        app.dependency_overrides[task_mcp._client_by_mcp_bearer] = principal
        plugin_mcp_limits.reset_for_tests()
        payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "plugin_mcp_call", "arguments": {"server": "soduwork-media",
                "tool": "generate_video", "arguments": self.args}}}
        with patch.object(plugin_mcp_gateway, "_server", new=AsyncMock(return_value=(
                "soduwork-media", plugin_builtin.virtual_spec("soduwork-media")))), \
                patch.object(video, "_provider_request", new=AsyncMock(return_value=(MP4, "video/mp4"))):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post("/api/v1/mcp", json=payload)
                self.assertEqual(response.status_code, 200, response.text)
                result = response.json()["result"]
                self.assertFalse(result["isError"], result)
                media = json.loads(result["content"][0]["text"])
                self.assertEqual(media["result"]["artifact"]["mimeType"], "video/mp4")
        async with self.factory() as session:
            audits = (await session.execute(select(models.AuditLog))).scalars().all()
            self.assertEqual([row.actor_id for row in audits], ["owner-1"])
            self.assertEqual(audits[0].action, "plugin.mcp_call")

    async def test_oversized_or_truncated_stream_closes_temp_file(self):
        created = []
        original = tempfile.TemporaryFile
        def create():
            handle = original()
            created.append(handle)
            return handle
        async def chunks():
            yield MP4
            yield b"x" * 1024
        with patch.object(video_files.tempfile, "TemporaryFile", side_effect=lambda **kw: create()):
            with self.assertRaisesRegex(ValueError, "超过"):
                await video_files.collect(chunks(), 100)
        self.assertTrue(created[0].closed)


if __name__ == "__main__":
    unittest.main()
