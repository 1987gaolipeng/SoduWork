"""Signed upgrade manifests remain consumable across installer brand changes."""
import base64
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///:memory:'
os.environ.setdefault('AUTH_SECRET', 'isolated-brand-test-secret')
os.environ.setdefault('ADMIN_PASS', 'isolated-brand-test-password')

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import client_updates as api, download
from app.db import Base, get_session
from app.deps import current_client, current_user
from app.models import Client, ClientRelease, ClientUpdateAttempt, User
from app.services import client_updates as contract


class BrandCompatibilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.device_id = 'device'
        self.engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda c: Base.metadata.create_all(c, tables=[
                Client.__table__, ClientRelease.__table__, ClientUpdateAttempt.__table__, User.__table__]))
        temporary = tempfile.TemporaryDirectory(prefix='soduwork-update-brand-')
        self.addCleanup(temporary.cleanup)
        # Match release_root(), including Windows TEMP paths using an 8.3 alias.
        root = Path(temporary.name).resolve()
        key = Ed25519PrivateKey.generate()
        private = base64.b64encode(key.private_bytes_raw()).decode()
        public = base64.b64encode(key.public_key().public_bytes_raw()).decode()
        for helper, value in [('release_root', root), ('trusted_public_keys', {'brand-fixture': public})]:
            mocked = patch.object(contract, helper, return_value=value)
            mocked.start()
            self.addCleanup(mocked.stop)
        self.rows = {}
        payload = b'accepted-installer-fixture\n' * 50000
        async with self.sessions() as session:
            session.add(Client(id='device', name='fixture', platform='win32', app_version='1.12.79'))
            for platform, formats in [('win32', ['exe']), ('linux', ['deb', 'rpm', 'tar.gz'])]:
                for fmt in formats:
                    for prefix in ['SoduWork']:
                        suffix = 'Setup.exe' if platform == 'win32' else 'linux.' + fmt
                        name = f'{prefix}-1.12.82-{suffix}'
                        row = ClientRelease(id=str(uuid.uuid5(uuid.NAMESPACE_URL, name)),
                            version='1.12.82', channel='stable', platform=platform, arch='x64',
                            artifact_name=name, artifact_path=name, artifact_size=len(payload),
                            sha256=hashlib.sha256(payload).hexdigest(), signature='', key_id='brand-fixture',
                            enabled=True, mandatory=False, min_version='', notes='',
                            created_at=datetime(2026, 10, 15, tzinfo=timezone.utc))
                        row.signature = contract.sign(contract.manifest_payload(row), private)
                        (root / name).write_bytes(payload)
                        self.rows[platform, fmt, prefix] = row
                        session.add(row)
            await session.commit()
        app = FastAPI()
        for router in [api.router, api.admin_router, download.router]:
            app.include_router(router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def client_override():
            return Client(id=self.device_id, name='fixture', app_version='1.12.79')

        async def user_override():
            user = User(id='admin', username='admin', is_super=True, is_active=True)
            user._perms = {'client.update'}
            return user

        app.dependency_overrides[get_session] = session_override
        app.dependency_overrides[current_client] = client_override
        app.dependency_overrides[current_user] = user_override
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def check(self, version, platform='win32', fmt=''):
        response = await self.http.get('/api/v1/client-updates/check', params={
            'current': version, 'platform': platform, 'format': fmt})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_each_client_generation_gets_a_supported_signed_name(self):
        for version in ['1.12.81']:
            prefix = 'SoduWork'
            self.device_id = 'device-' + version
            async with self.sessions() as session:
                session.add(Client(id=self.device_id, name='fixture', app_version=version))
                await session.commit()
            result = await self.check(version)
            self.assertTrue(result['hasUpdate'])
            self.assertEqual(result['manifest']['artifact']['name'], f'{prefix}-1.12.82-Setup.exe')

    async def test_unsupported_pending_manifest_is_not_returned(self):
        result = await self.check('1.12.81')
        self.assertEqual(result['manifest']['artifact']['name'], 'SoduWork-1.12.82-Setup.exe')

    async def test_linux_keeps_format_and_brand_constraints_together(self):
        for fmt in ['deb', 'rpm', 'tar.gz']:
            result = await self.check('1.12.81', 'linux', fmt)
            self.assertEqual(result['manifest']['artifact']['name'], f'SoduWork-1.12.82-linux.{fmt}')

    async def test_no_supported_copy_means_no_invalid_update(self):
        async with self.sessions() as session:
            for prefix in ['SoduWork']:
                row = await session.get(ClientRelease, self.rows['win32', 'exe', prefix].id)
                row.enabled = False
            await session.commit()
        self.assertFalse((await self.check('1.12.81'))['hasUpdate'])

    async def test_public_downloads_prefer_current_brand(self):
        win = await self.http.get('/api/v1/download/client/info')
        self.assertEqual(win.json()['artifactFilename'], 'SoduWork-1.12.82-Setup.exe')
        linux = await self.http.get('/api/v1/download/client/linux/info')
        for fmt, item in linux.json()['formats'].items():
            self.assertEqual(item['filename'], f'SoduWork-1.12.82-linux.{fmt}')

    async def test_check_rejects_missing_or_changed_artifacts_without_creating_an_attempt(self):
        from sqlalchemy import select
        row = self.rows['win32', 'exe', 'SoduWork']
        path = contract.safe_artifact_path(row.artifact_path)
        original = path.read_bytes()
        for damage, detail in [('missing', 'missing'), ('size', 'size changed'), ('digest', 'digest changed')]:
            with self.subTest(damage=damage):
                path.write_bytes(original)
                contract.assert_artifact_integrity(row, path)  # Warm the real stat-based cache.
                if damage == 'missing':
                    path.unlink()
                elif damage == 'size':
                    path.write_bytes(original[:-1])
                else:
                    path.write_bytes(b'X' * len(original))
                response = await self.http.get('/api/v1/client-updates/check', params={'current': '1.12.81'})
                self.assertEqual(response.status_code, 503, response.text)
                self.assertIn(detail, response.json()['detail'])
                self.assertNotIn(str(path), response.text)
                async with self.sessions() as session:
                    self.assertEqual((await session.execute(select(ClientUpdateAttempt))).scalars().all(), [])
        path.write_bytes(original)
        self.assertTrue((await self.check('1.12.81'))['hasUpdate'])

    async def test_pending_update_is_rechecked_when_its_artifact_disappears(self):
        data = await self.check('1.12.81')
        row = self.rows['win32', 'exe', 'SoduWork']
        contract.safe_artifact_path(row.artifact_path).unlink()
        response = await self.http.get('/api/v1/client-updates/check', params={'current': '1.12.81'})
        self.assertEqual(response.status_code, 503, response.text)
        async with self.sessions() as session:
            attempt = await session.get(ClientUpdateAttempt, data['attemptId'])
            self.assertEqual(attempt.state, 'available')

    async def test_admin_cannot_force_an_unreadable_manifest(self):
        target = self.rows['win32', 'exe', 'SoduWork'].id
        result = await self.http.post('/api/v1/admin/clients/device/updates', json={'releaseId': target})
        self.assertEqual(result.status_code, 409, result.text)

    async def test_fixed_download_requires_enabled_stable_signed_intact_bytes(self):
        row = self.rows['win32', 'exe', 'SoduWork']
        url = '/api/v1/download/client/releases/' + row.id
        result = await self.http.get(url)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(hashlib.sha256(result.content).hexdigest(), row.sha256)
        async with self.sessions() as session:
            live = await session.get(ClientRelease, row.id)
            live.enabled = False
            await session.commit()
        self.assertEqual((await self.http.get(url)).status_code, 404)
        async with self.sessions() as session:
            live = await session.get(ClientRelease, row.id)
            live.enabled = True
            live.channel = 'beta'
            await session.commit()
        self.assertEqual((await self.http.get(url)).status_code, 404)
        async with self.sessions() as session:
            live = await session.get(ClientRelease, row.id)
            live.channel = 'stable'
            live.signature = 'invalid'
            await session.commit()
        self.assertEqual((await self.http.get(url)).status_code, 503)
        async with self.sessions() as session:
            live = await session.get(ClientRelease, row.id)
            live.signature = row.signature
            await session.commit()
        contract.safe_artifact_path(row.artifact_path).write_bytes(b'corrupted')
        self.assertEqual((await self.http.get(url)).status_code, 503)
        self.assertEqual((await self.http.get('/api/v1/download/client/releases/missing')).status_code, 404)

    def test_invalid_version_or_unknown_prefix_is_not_supported(self):
        self.assertFalse(contract.installer_supported_by_client('SoduWork-1.12.82-Setup.exe', 'invalid'))
        self.assertFalse(contract.installer_supported_by_client('Unknown-1.12.82-Setup.exe', '1.12.81'))


if __name__ == '__main__':
    unittest.main()
