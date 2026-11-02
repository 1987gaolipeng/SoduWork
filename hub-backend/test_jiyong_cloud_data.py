"""Cloud declarations, package portability and authenticated namespace validation."""
import copy
import json
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from app.api import jiyong_data as api
from app.services import jiyong_contract as contract, jiyong_data_contract as data
from app.services import jiyong_cloud_database as database


def declaration():
    return {'version': 1, 'storage': {'location': 'cloud'},
            'collections': [{'key': 'notes', 'indexes': ['status']}],
            'initialization': {'script': 'assets/data-init.json'}}


def seed():
    return {'schemaVersion': 1, 'migrations': [{'version': 1, 'seed': [
        {'collection': 'notes', 'id': 'welcome', 'value': {'status': 'example', 'title': '欢迎'}}]}]}


def body():
    return {'appId': 'local:cloud-notes', 'packageKey': 'cloud-notes', 'version': '0.1.0',
            'checksum': 'a' * 64, 'declaration': declaration(), 'initialization': seed(),
            'method': 'data.get', 'params': {'collection': 'notes', 'id': 'welcome'}}


class ContractTests(unittest.TestCase):
    def test_cloud_declaration_and_initialization_survive_package_round_trip(self):
        import base64
        import test_jiyong_contract
        from app.services import plugin_drafts, plugin_packages
        draft = test_jiyong_contract.JiyongTests().body()
        draft['jiyong'].update(storage={'location': 'cloud'}, initialization={'script': 'assets/data-init.json'})
        draft['resources'].append({'path': 'assets/data-init.json', 'kind': 'asset', 'encoding': 'base64',
                                   'content': base64.b64encode(json.dumps(seed()).encode()).decode()})
        parsed = plugin_packages.parse(plugin_drafts.build(draft))
        exported = plugin_packages.personal_draft(parsed)
        self.assertEqual(exported['jiyong']['storage'], {'location': 'cloud'})
        self.assertEqual(plugin_packages.parse(plugin_drafts.build(exported))['manifest']['jiyong'], parsed['manifest']['jiyong'])

    def test_both_runtimes_normalize_cloud_and_legacy_identically(self):
        module = Path(__file__).resolve().parents[1] / 'client/core/jiyong-contract.cjs'
        for raw in [declaration(), {**declaration(), 'storage': {'location': 'local'}},
                    {'version': 1, 'collections': []}]:
            result = subprocess.run(['node', '-e', 'console.log(JSON.stringify(require(process.argv[1]).normalize(JSON.parse(process.argv[2]))))',
                                     str(module), json.dumps(raw)], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout), contract.normalize(raw))

    def test_cloud_rejects_missing_initialization_unknown_fields_and_credentials(self):
        for storage in [{'location': 'sqlite'}, {'location': 'cloud', 'password': 'x'}, {'location': 'cloud', 'name': 'db'}]:
            with self.subTest(storage=storage), self.assertRaises(ValueError):
                contract.normalize({**declaration(), 'storage': storage})
        with self.assertRaises(ValueError):
            contract.normalize({'version': 1, 'storage': {'location': 'cloud'}})
        for raw in [None, {'schemaVersion': 1, 'migrations': [{'version': 2, 'seed': []}]},
                    {'schemaVersion': 1, 'migrations': [{'version': 1, 'sql': 'DROP TABLE records', 'seed': []}]}]:
            with self.subTest(raw=raw), self.assertRaises((ValueError, TypeError)):
                data.initialization(contract.normalize(declaration()), raw)

    def test_crud_validation_limits_and_tombstone_revision_contract(self):
        schema = contract.normalize(declaration())
        self.assertEqual(data.request('data.list', {'collection': 'notes'}, schema)['limit'], 50)
        for after in [None, '']:
            self.assertEqual(data.request('data.list', {'collection': 'notes', 'after': after}, schema)['after'], '')
        for params in [{'collection': 'other'}, {'collection': 'notes', 'limit': True},
                       {'collection': 'notes', 'filter': []}, {'collection': 'notes', 'filter': {'title': 'x'}}]:
            with self.assertRaises(ValueError):
                data.request('data.list', params, schema)
        for operation in [{'id': 'x', 'value': {}}, {'id': 'x', 'value': {}, 'expectedRevision': True},
                          {'id': '../x', 'value': {}, 'expectedRevision': 0}]:
            with self.assertRaises(ValueError):
                data.request('data.batch', {'collection': 'notes', 'operations': [operation]}, schema)
        self.assertEqual(data.request('data.batch', {'collection': 'notes', 'operations': [
            {'id': 'x', 'expectedRevision': 2, 'delete': True}]}, schema)['operations'][0]['expectedRevision'], 2)

    def test_db_must_be_independent_postgres(self):
        config = SimpleNamespace(database_url='postgresql+asyncpg://hub@localhost/hub', jiyong_database_url='')
        with patch.object(database, 'get_settings', return_value=config):
            for url in ['', 'sqlite+aiosqlite:///:memory:', 'postgresql+asyncpg://other@localhost/hub']:
                config.jiyong_database_url = url
                with self.assertRaises(database.CloudError):
                    database.database_url()


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.user = SimpleNamespace(id='user-a', org_id='org-a', is_active=True, account_deleted_at=None)
        self.session = SimpleNamespace(get=AsyncMock(side_effect=lambda model, value:
            self.user if model is api.User else SimpleNamespace(id=value, parent_id=None)))
        self.device = SimpleNamespace(user_ref='user-a', id='device-a')
        self.app = FastAPI()
        self.app.include_router(api.router)
        self.app.dependency_overrides[api.get_session] = lambda: self.session
        self.app.dependency_overrides[api.current_client] = lambda: self.device
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://fixture')

    async def asyncTearDown(self):
        await self.http.aclose()

    async def test_namespace_is_derived_from_account_not_device_or_payload(self):
        execute = AsyncMock(return_value={'ok': True, 'item': None, 'revision': 0})
        with patch.object(api.storage, 'execute', execute):
            for index, device in enumerate(['device-a', 'device-b']):
                self.device.id = device
                candidate = body()
                candidate['appId'] = 'local:' + str(index + 1) * 8 + '-1111-4111-8111-111111111111'
                response = await self.http.post('/api/v1/jiyong/data', json=candidate)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(execute.call_args.args[:3], ('org-a:user-a', 'personal:cloud-notes', 'cloud-notes'))
            bad = body(); bad['ownerId'] = 'user-b'
            self.assertEqual((await self.http.post('/api/v1/jiyong/data', json=bad)).status_code, 422)
            self.assertEqual(execute.await_count, 2)

    async def test_status_is_read_only_and_unconfigured_blocks(self):
        with patch.object(api.database, 'check', AsyncMock(side_effect=database.CloudError('尚未配置'))), patch.object(api.storage, 'execute', AsyncMock()) as execute:
            response = await self.http.get('/api/v1/jiyong/status')
            self.assertEqual(response.status_code, 503)
            execute.assert_not_awaited()

    async def test_department_transfer_preserves_company_account_space(self):
        self.session.get = AsyncMock(side_effect=lambda model, value: self.user if model is api.User else
            SimpleNamespace(id=value, parent_id=None if value == 'company-root' else 'company-root'))
        with patch.object(api.storage, 'execute', AsyncMock(return_value={'ok': True})) as execute:
            for department in ['department-a', 'department-b']:
                self.user.org_id = department
                response = await self.http.post('/api/v1/jiyong/data', json=body())
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(execute.call_args.args[0], 'company-root:user-a')

    async def test_market_storage_probe_blocks_unconfigured_cloud_and_leaves_local_apps_alone(self):
        from app.api.plugin_client_catalog import _cloud_data_ready
        from fastapi import HTTPException
        with patch.object(api.database, 'check', AsyncMock(side_effect=database.CloudError('尚未配置'))) as check:
            await _cloud_data_ready({'jiyong': {'storage': {'location': 'local'}}})
            check.assert_not_awaited()
            with self.assertRaises(HTTPException) as raised:
                await _cloud_data_ready({'jiyong': declaration()})
            self.assertEqual(raised.exception.status_code, 503)

    async def test_invalid_seed_local_storage_and_inactive_account_never_reach_database(self):
        with patch.object(api.storage, 'execute', AsyncMock()) as execute:
            for mutate in [lambda x: x.update(packageKey='../another'),
                           lambda x: x['declaration'].update(storage={'location': 'local'}),
                           lambda x: x['initialization']['migrations'][0].update(version=3)]:
                raw = body(); mutate(raw)
                self.assertEqual((await self.http.post('/api/v1/jiyong/data', json=raw)).status_code, 422)
            self.user.is_active = False
            self.assertEqual((await self.http.post('/api/v1/jiyong/data', json=body())).status_code, 403)
            execute.assert_not_awaited()

    async def test_revision_conflicts_keep_machine_readable_code(self):
        with patch.object(api.storage, 'execute', AsyncMock(side_effect=database.CloudError('数据已更新', 'JIYONG_CONFLICT', 409))):
            result = await self.http.post('/api/v1/jiyong/data', json=body())
            self.assertEqual(result.status_code, 409)
            self.assertEqual(result.json()['detail']['code'], 'JIYONG_CONFLICT')

    async def test_missing_device_session_is_rejected(self):
        del self.app.dependency_overrides[api.current_client]
        self.assertEqual((await self.http.get('/api/v1/jiyong/status')).status_code, 401)

    async def test_market_version_uses_server_manifest_and_rejects_revoked_installation(self):
        candidate = body(); candidate.update(appId='market-id', versionId='v1')
        pinned = SimpleNamespace(id='v1', plugin_id='market-id', manifest={'key': 'cloud-notes', 'jiyong': declaration()},
                                 version='1.0.0', checksum='b' * 64)
        self.session.get = AsyncMock(side_effect=lambda model, value: self.user if model is api.User else
            SimpleNamespace(id=value, parent_id=None) if model is api.OrgUnit else pinned)
        files = [{'path': 'assets/data-init.json', 'encoding': 'utf8', 'content': json.dumps(seed())}]
        from app.api import plugin_client_catalog
        from app.services import plugin_package_resources, plugin_installed
        with patch.object(plugin_client_catalog, '_client_actor', AsyncMock()), \
                patch.object(plugin_installed, 'resolve', AsyncMock(return_value=[(None, pinned, None)])) as installed, \
                patch.object(plugin_package_resources, 'ui_for_version', return_value={'resources': files}), \
                patch.object(api.storage, 'execute', AsyncMock(return_value={'ok': True})) as execute:
            candidate['declaration'] = {'malicious': True}
            candidate['initialization'] = {'sql': 'DROP DATABASE'}
            response = await self.http.post('/api/v1/jiyong/data', json=candidate)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(execute.call_args.args[1], 'market:market-id')
            self.assertEqual(execute.call_args.args[3], contract.normalize(declaration()))
            installed.side_effect = ValueError('已安装版本已撤销')
            self.assertEqual((await self.http.post('/api/v1/jiyong/data', json=candidate)).status_code, 403)
            installed.side_effect = ValueError('即用未安装')
            self.assertEqual((await self.http.post('/api/v1/jiyong/data', json=candidate)).status_code, 403)
            self.assertEqual(execute.await_count, 1)


if __name__ == '__main__':
    unittest.main()
