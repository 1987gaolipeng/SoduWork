"""Public health identifies the release while retaining the legacy API contract."""
import os
import unittest
from unittest.mock import patch

import httpx

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-health-identity-test-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-health-identity-test-password")

from app.main import app, settings


class HealthIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def health(self, version, commit, tag):
        with patch.dict('os.environ', SODUWORK_HUB_VERSION=version,
                        SODUWORK_DEPLOY_COMMIT=commit, SODUWORK_RELEASE_TAG=tag):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url='http://test') as client:
                response = await client.get('/healthz')
                self.assertEqual(response.status_code, 200)
                return response.json()

    async def test_release_version_commit_and_api_version_are_distinct(self):
        result = await self.health('1.0.5', 'a' * 40, 'hub-v1.0.5')
        self.assertTrue(result['ok'])
        self.assertEqual(result['version'], '1.0.5')
        self.assertEqual(result['commit'], 'a' * 40)
        self.assertEqual(result['releaseTag'], 'hub-v1.0.5')
        self.assertEqual(result['apiVersion'], settings.version)

    async def test_old_images_and_local_development_keep_fallbacks(self):
        for version in ('', 'dev'):
            result = await self.health(version, 'b' * 40, '')
            self.assertEqual(result['version'], 'b' * 40)
            self.assertEqual(result['releaseTag'], '')
        result = await self.health('', '', '')
        self.assertEqual(result['version'], settings.version)
        self.assertEqual(result['commit'], '')


if __name__ == '__main__':
    unittest.main()
