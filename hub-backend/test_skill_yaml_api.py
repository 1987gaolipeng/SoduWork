"""Real API boundaries with temporary registry and SQLite; no external services."""
import tempfile
import unittest
from pathlib import Path

import httpx
import yaml

from skill_test_support import fixture
from app import models
from app.services import skill_content, skill_packages


BAD = b'---\nname: debug-radar\ndescription: Gather evidence: preserve logs\n---\nKeep all instructions.\n'


class SkillYamlApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='soduwork-yaml-api-')
        self.app, self.tokens, self.sessions, self.cleanup = await fixture(self.temp.name)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.cleanup()
        self.temp.cleanup()

    async def req(self, path, *, admin=False, **kwargs):
        headers = {'Authorization': ('Bearer ' if admin else 'Device ') + self.tokens['admin' if admin else 'alice']}
        return await self.http.post('/api/v1' + path, headers=headers, **kwargs)

    def legacy(self, pending=False):
        content = {'SKILL.md': BAD, 'references/keep.txt': b'unchanged'}
        checksum = skill_packages._canonical_digest(content)
        target = Path(skill_packages.root(), 'packages', checksum, 'debug-radar')
        target.mkdir(parents=True)
        for name, data in content.items():
            file = target / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        (target / '.ready').write_text(checksum)
        row = {'name': 'debug-radar', 'description': 'Legacy description', 'scope': 'personal',
               'ownerClientId': 'device-alice', 'packageChecksum': checksum, 'path': str(target), 'bundled': True}
        index = {'schemaVersion': 1, 'items': [row], 'submissions': []}
        if pending:
            index['submissions'].append({'id': 'legacy-pending', 'name': row['name'], 'checksum': checksum,
                'ownerClientId': 'device-alice', 'status': 'pending', 'baseChecksum': '', 'package': dict(row)})
        skill_packages._save_index(index)
        return checksum, target

    async def test_bad_upload_is_rejected_before_install_or_enable(self):
        payload = skill_content.archive({'SKILL.md': BAD})
        for endpoint in ('/skills/preflight', '/skills/import'):
            with self.subTest(endpoint=endpoint):
                response = await self.req(endpoint, files={'file': ('bad.skill', payload)})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn('SKILL.md', response.text)
        self.assertEqual(skill_packages.active(owner_client_id='device-alice'), [])
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.Client, 'device-alice')).skills, [])

    async def test_create_quotes_description_and_preserves_body(self):
        description = 'Gather evidence: keep "quotes", #hash, 中文 and \\paths'
        body = 'Keep all lines.\n' + '尾部要求\n' * 600
        response = await self.req('/skills/create', json={'name': 'debug-radar', 'description': description, 'instructions': body})
        self.assertEqual(response.status_code, 200, response.text)
        row = skill_packages.active(owner_client_id='device-alice')[0]
        source = Path(row['path'], 'SKILL.md').read_text(encoding='utf8')
        self.assertEqual(yaml.safe_load(source.split('---')[1])['description'], description)
        self.assertTrue(source.endswith(body.strip() + '\n'))

    async def test_legacy_bad_package_can_be_downloaded_but_not_submitted(self):
        checksum, target = self.legacy()
        response = await self.req('/skills/debug-radar/share', json={'checksum': checksum})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(skill_packages._load_index()['submissions'], [])
        download = await self.http.get('/api/v1/skills/debug-radar/download', params={'checksum': checksum, 'path': 'SKILL.md'},
            headers={'Authorization': 'Device ' + self.tokens['alice']})
        self.assertEqual(download.status_code, 200, download.text)
        self.assertEqual(download.content, BAD)
        self.assertEqual((target / 'SKILL.md').read_bytes(), BAD)

    async def test_legacy_pending_bad_package_cannot_be_published(self):
        checksum, target = self.legacy(pending=True)
        response = await self.req('/admin/capabilities/skill-submissions/legacy-pending/review', admin=True,
            json={'checksum': checksum, 'decision': 'approve'})
        self.assertEqual(response.status_code, 400, response.text)
        index = skill_packages._load_index()
        self.assertEqual(index['submissions'][0]['status'], 'pending')
        self.assertFalse(any(row['scope'] == 'company' for row in index['items']))
        self.assertEqual((target / 'SKILL.md').read_bytes(), BAD)

    async def test_first_runtime_download_of_legacy_bad_skill_returns_named_conflict(self):
        _checksum, target = self.legacy()
        response = await self.req('/skills/runtime', json={'names': ['debug-radar']})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn('debug-radar/SKILL.md', response.json()['detail'])
        self.assertEqual((target / 'SKILL.md').read_bytes(), BAD)
