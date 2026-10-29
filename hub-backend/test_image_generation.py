"""Isolated image/catalog/HTTP regression tests; no live provider or business DB."""
import asyncio
import base64
import json
import os
import tempfile
import unittest
from io import BytesIO
from PIL import Image
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.pool import AsyncAdaptedQueuePool

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
from app import models, auth
from app.api import attachments
from app.services import image_generation as image, storage, plugin_mcp_gateway, plugin_builtin
RESOLVE_CATALOG = image.model_catalog.resolve

_bitmap = BytesIO()
Image.new('RGB', (64, 48), (64, 124, 237)).save(_bitmap, format='PNG')
PNG = _bitmap.getvalue()
CONF = {"model": "own-image", "provider": "personal", "kind": "openai-compat",
        "base": "https://provider.test/v1", "key": "isolated-test-key",
        "config": {"endpointPath": "/images/generations", "defaults": {"size": "1024x1024"}}}


class ImageGenerationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = create_async_engine("sqlite+aiosqlite:///" + Path(self.temp.name, 'test.db').as_posix(),
            poolclass=AsyncAdaptedQueuePool, pool_size=1, max_overflow=0, pool_timeout=.3)
        async with self.engine.begin() as conn:
            await conn.run_sync(models.Attachment.__table__.create)
        self.factory = async_sessionmaker(self.engine, expire_on_commit=False)
        self.client = SimpleNamespace(id='device-one', user_ref='owner-one')
        self.stack = ExitStack()
        self.resolve = self.stack.enter_context(patch.object(image.model_catalog, 'resolve',
            new=AsyncMock(return_value=CONF)))
        self.stack.enter_context(patch.object(storage, 'backend_name', return_value='local'))
        self.stack.enter_context(patch.object(storage, '_LOCAL_DIR', str(Path(self.temp.name, 'files'))))
        self.stack.enter_context(patch.object(auth, 'get_settings',
            return_value=SimpleNamespace(auth_secret='isolated-image-signing-key')))

    async def asyncTearDown(self):
        self.stack.close()
        await self.engine.dispose()
        self.temp.cleanup()

    async def generate(self, **args):
        async with self.factory() as session:
            return await image.generate_image(session, self.client, {
                'prompt': '产品海报', 'model': 'own-image', 'providerId': 'personal',
                'generationId': 'turn-one', **args,
            }, conversation_id='stable-conversation')

    async def test_base64_roundtrip_dedup_filename_and_no_db_connection_during_io(self):
        async def provider(conf, endpoint, body, timeout):
            async with self.factory() as other:
                await other.execute(select(models.Attachment.id))
            self.assertEqual(endpoint, '/images/generations')
            self.assertEqual(conf['key'], 'isolated-test-key')
            data = json.loads(body)
            self.assertEqual(data['model'], 'own-image')
            self.assertEqual(data['size'], '1024x1024')
            self.assertEqual(data['n'], 1)
            self.assertNotIn('generationId', data)
            return json.dumps({'data': [{'b64_json': base64.b64encode(PNG).decode()}]}).encode()
        request = AsyncMock(side_effect=provider)
        with patch.object(image, '_provider_request', request):
            first = await self.generate(filename='../poster.exe')
            again = await self.generate(filename='another-name')
            another = await self.generate(generationId='turn-two')
        self.assertEqual(request.await_count, 2)
        self.assertEqual(first['artifact']['attachmentId'], again['artifact']['attachmentId'])
        self.assertNotEqual(first['artifact']['attachmentId'], another['artifact']['attachmentId'])
        self.assertEqual(first['artifact']['kind'], 'image')
        self.assertTrue(first['artifact']['filename'].endswith('.png'))
        async with self.factory() as session:
            row = await session.get(models.Attachment, first['artifact']['attachmentId'])
            self.assertEqual(row.source_ref, 'conversation-image:stable-conversation')
            self.assertEqual(storage.get(row.storage_key, row.backend), PNG)
            self.assertNotIn('isolated-test-key', json.dumps(row.evidence_meta))
        self.assertEqual(self.resolve.call_args.kwargs['provider_id'], 'personal')

    async def test_invalid_image_is_not_saved_or_blindly_resubmitted(self):
        request = AsyncMock(return_value=json.dumps({'data': [{'b64_json': base64.b64encode(b'<html>bad</html>').decode()}]}).encode())
        with patch.object(image, '_provider_request', request):
            with self.assertRaisesRegex(ValueError, '图片文件无效'):
                await self.generate()
            with self.assertRaisesRegex(ValueError, '尚不确定'):
                await self.generate()
        self.assertEqual(request.await_count, 1)

    async def test_same_device_different_accounts_never_reuse_each_others_media(self):
        request = AsyncMock(return_value=PNG)
        with patch.object(image, '_provider_request', request):
            first = await self.generate()
            self.client = SimpleNamespace(id='device-one', user_ref='owner-two')
            second = await self.generate()
            self.client = SimpleNamespace(id='device-one', user_ref='owner-one')
            restored = await self.generate()
        self.assertNotEqual(first['artifact']['attachmentId'], second['artifact']['attachmentId'])
        self.assertEqual(first['artifact']['attachmentId'], restored['artifact']['attachmentId'])
        self.assertEqual(request.await_count, 2)
        async with self.factory() as session:
            first_row = await session.get(models.Attachment, first['artifact']['attachmentId'])
            second_row = await session.get(models.Attachment, second['artifact']['attachmentId'])
            self.assertEqual(first_row.evidence_meta['ownerUserId'], 'owner-one')
            self.assertEqual(second_row.evidence_meta['ownerUserId'], 'owner-two')

    async def test_unattributed_legacy_generation_does_not_leak_or_resubmit(self):
        import uuid
        request = AsyncMock(return_value=PNG)
        with patch.object(image, '_provider_request', request):
            first = await self.generate()
            async with self.factory() as session:
                row = await session.get(models.Attachment, first['artifact']['attachmentId'])
                meta = dict(row.evidence_meta)
                meta.pop('ownerUserId')
                row.id = str(uuid.uuid5(uuid.NAMESPACE_URL,
                    'soduwork-image:device-one:stable-conversation:' + meta['requestFingerprint']))
                row.evidence_meta = meta
                await session.commit()
            with self.assertRaisesRegex(ValueError, '账号归属尚未确认'):
                await self.generate()
        self.assertEqual(request.await_count, 1)

    async def test_anonymous_generation_is_rejected_before_provider_access(self):
        self.client = SimpleNamespace(id='device-one')
        with patch.object(image, '_provider_request', AsyncMock()) as request:
            with self.assertRaisesRegex(ValueError, '先登录'):
                await self.generate()
        request.assert_not_awaited()

    async def test_concurrent_duplicate_has_one_billable_post(self):
        started, finish = asyncio.Event(), asyncio.Event()
        async def provider(*args):
            started.set()
            await finish.wait()
            return PNG
        with patch.object(image, '_provider_request', AsyncMock(side_effect=provider)) as request:
            running = asyncio.create_task(self.generate())
            await started.wait()
            try:
                with self.assertRaisesRegex(ValueError, '正在生成'):
                    await self.generate()
            finally:
                finish.set()
                await running
        self.assertEqual(request.await_count, 1)

    async def test_url_result_and_invalid_arguments(self):
        request = AsyncMock(return_value=b'{"data":[{"url":"https://cdn.test/one.png"}]}')
        with patch.object(image, '_provider_request', request), patch.object(image, '_download', AsyncMock(return_value=PNG)) as download:
            self.assertEqual((await self.generate())['artifact']['mimeType'], 'image/png')
            self.assertEqual(download.call_args.args[0], 'https://cdn.test/one.png')
            for args in ({'n': 2}, {'prompt': ''}, {'extra': {'model': 'other'}}):
                with self.assertRaises(ValueError):
                    await self.generate(**args)
        self.assertEqual(request.await_count, 1)

    async def test_internal_and_active_content_urls_rejected(self):
        for url in ('http://127.0.0.1/secret', 'http://169.254.169.254/', 'file:///secret', '//internal/secret'):
            with self.assertRaises(ValueError):
                await image._download(url, CONF, 1)

    async def test_plugin_uses_same_image_service_and_signed_ref(self):
        generate = AsyncMock(return_value={'ok': True, 'artifact': {'kind': 'image'}})
        with patch.object(image, 'generate_image', generate):
            await plugin_mcp_gateway._connector_call('soduwork-media', plugin_builtin.virtual_spec('soduwork-media'),
                'generate_image', {'prompt': 'cover'}, 240, self.client, object(), {'ref': 'signed-ref'})
        self.assertEqual(generate.call_args.kwargs['conversation_id'], 'signed-ref')

    async def test_same_model_name_resolves_the_selected_personal_provider(self):
        catalog = image.model_catalog
        rows = [{'providerId': provider, 'name': 'same-name', 'config': {}} for provider in ('org', 'personal')]
        providers = {provider: {'id': provider, 'baseUrl': f'https://{provider}.test/v1',
            'kind': 'openai-compat', 'apiKey': 'org-test-key'} for provider in ('org', 'personal')}
        client = SimpleNamespace(id='test-device', model_keys={'personal': 'personal-test-key'})
        with patch.object(catalog, 'usable', AsyncMock(return_value=rows)), \
                patch.object(catalog, 'effective_provider_map', AsyncMock(return_value=providers)):
            result = await RESOLVE_CATALOG(None, client, 'same-name', 'image', provider_id='personal')
            self.assertEqual(result['provider'], 'personal')
            self.assertEqual(result['keyFrom'], 'mine')
            self.assertEqual(result['key'], 'personal-test-key')
            self.assertEqual(await RESOLVE_CATALOG(None, client, 'same-name', 'image', provider_id='removed'), {})

    def test_pixel_validation_supports_jpeg_webp_and_rejects_corruption(self):
        for fmt, mime in (('JPEG', 'image/jpeg'), ('WEBP', 'image/webp'), ('PNG', 'image/png')):
            buffer = BytesIO()
            Image.new('RGB', (32, 32), (30, 90, 180)).save(buffer, format=fmt)
            self.assertEqual(image.validate_image(buffer.getvalue()), mime)
        with self.assertRaises(ValueError):
            image.validate_image(PNG[:45] + b'bad pixels' + PNG[-12:])

    async def test_real_http_transport_uses_image_endpoint_and_releases_capacity(self):
        from app.services import model_runtime, model_transport
        async with self.engine.begin() as connection:
            for model in (models.AppSetting, models.ModelDef, models.ModelProvider):
                await connection.run_sync(model.__table__.create)
        seen, peers = [], []
        async def serve(reader, writer):
            peers.append(asyncio.current_task())
            try:
                headers = await reader.readuntil(b'\r\n\r\n')
                lines = headers.split(b'\r\n')
                length = next((int(line.split(b':', 1)[1]) for line in lines if line.lower().startswith(b'content-length:')), 0)
                body = await reader.readexactly(length)
                seen.append((lines[0], json.loads(body)))
                response = json.dumps({'data': [{'b64_json': base64.b64encode(PNG).decode()}]}).encode()
                writer.write(f'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(response)}\r\nConnection: close\r\n\r\n'.encode() + response)
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
        server = await asyncio.start_server(serve, '127.0.0.1', 0)
        try:
            conf = dict(CONF, base=f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}', user='fixture')
            with patch.object(image.model_catalog, 'resolve', AsyncMock(return_value=conf)), patch.object(model_runtime, 'SessionLocal', self.factory):
                result = await self.generate()
                self.assertEqual((await model_runtime.snapshot())['running'], 0)
            self.assertEqual(len(seen), 1)
            self.assertEqual(seen[0][0], b'POST /images/generations HTTP/1.1')
            self.assertEqual(seen[0][1]['model'], 'own-image')
            self.assertEqual(result['artifact']['kind'], 'image')
        finally:
            server.close()
            await server.wait_closed()
            await asyncio.gather(*peers, return_exceptions=True)
            await model_transport.shutdown()

    async def test_http_generation_download_recovery_and_owner_isolation(self):
        app = FastAPI()
        app.include_router(attachments.router)
        async def session_dep():
            async with self.factory() as session:
                yield session
        app.dependency_overrides[attachments.get_session] = session_dep
        app.dependency_overrides[attachments.current_client] = lambda: self.client
        app.dependency_overrides[attachments.current_ai_client] = lambda: self.client
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://hub.test') as http:
            with patch.object(image, '_provider_request', AsyncMock(return_value=PNG)):
                reply = await http.post('/api/v1/conversations/http-chat/images', json={
                    'prompt': 'cover', 'model': 'own-image', 'generationId': 'http-turn'})
            self.assertEqual(reply.status_code, 200, reply.text)
            artifact = reply.json()['artifact']
            downloaded = await http.get(artifact['url'])
            self.assertEqual(downloaded.content, PNG)
            self.assertEqual(downloaded.headers['content-type'], 'image/png')
            aid = artifact['attachmentId']
            self.assertEqual((await http.get('/api/v1/attachments/' + aid)).status_code, 401)
            listing = await http.get('/api/v1/conversations/http-chat/media')
            self.assertEqual(listing.json()['items'][0]['kind'], 'image')
            self.assertEqual((await http.post(f'/api/v1/attachments/{aid}/access')).status_code, 200)
            self.client = SimpleNamespace(id='device-one', user_ref='owner-two')
            self.assertEqual((await http.get('/api/v1/conversations/http-chat/media')).json()['items'], [])
            self.assertEqual((await http.post(f'/api/v1/attachments/{aid}/access')).status_code, 404)
            self.assertEqual((await http.delete(f'/api/v1/attachments/{aid}')).status_code, 404)
            self.client = SimpleNamespace(id='device-one', user_ref='owner-one')
            self.assertEqual((await http.post(f'/api/v1/attachments/{aid}/access')).status_code, 200)
            self.client = SimpleNamespace(id='device-two', user_ref='owner-two')
            self.assertEqual((await http.get('/api/v1/conversations/http-chat/media')).json()['items'], [])
            self.assertEqual((await http.post(f'/api/v1/attachments/{aid}/access')).status_code, 404)
            self.assertEqual((await http.delete(f'/api/v1/attachments/{aid}')).status_code, 404)


if __name__ == '__main__':
    unittest.main()
