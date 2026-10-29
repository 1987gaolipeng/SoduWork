"""Actual HTTP config/catalog/dispatch parity on isolated SQLite; no provider calls."""
import os
import unittest

os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///:memory:'

import httpx
from fastapi import FastAPI
from app.api import ai_proxy
from app.db import get_session
from app.models import Client, ModelDef, ModelProvider, User
from app.services import device_auth, model_catalog, task_execution_model
from test_model_runtime import IsolatedDatabase


class AgentDefaultsTests(IsolatedDatabase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.agents = ['pi', 'opencode', 'qwen', 'codex-harness', 'dsh']
        async with self.engine.begin() as connection:
            await connection.run_sync(User.__table__.create)
        async with self.sessions() as session, session.begin():
            session.add_all([
                User(id='fixture-user', username='fixture-user'),
                Client(id='fixture', user_ref='fixture-user', auth_state='active',
                       agent_models={cli: cli + '-model' for cli in self.agents}),
                ModelProvider(id='fixture', name='Fixture', api_key='fixture-company-key',
                              base_url='http://fixture.invalid/v1'),
                *[ModelDef(id='fixture:' + name, provider_id='fixture', name=name,
                           config={'imageRouting': 'native', 'maxOutputTokens': 8192})
                  for name in ['explicit-model', *[cli + '-model' for cli in self.agents]]],
            ])
        app = FastAPI()
        app.include_router(ai_proxy.router)
        async def isolated_session():
            async with self.sessions() as session:
                yield session
        app.dependency_overrides[get_session] = isolated_session
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture')
        async with self.sessions() as session:
            token, _ = device_auth.issue_session(await session.get(Client, 'fixture'))
        self.headers = {'Authorization': 'Device ' + token}

    async def asyncTearDown(self):
        await self.http.aclose()
        await super().asyncTearDown()

    async def config(self, **params):
        response = await self.http.get('/api/v1/ai-proxy/config', params=params, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_every_gateway_matches_controlled_dispatch_and_preserves_capabilities(self):
        for cli in self.agents:
            config = await self.config(agent=cli)
            self.assertTrue(config['ok'], config)
            self.assertEqual(config['model'], cli + '-model')
            self.assertEqual(config['input'], ['text', 'image'])
            self.assertEqual(config['maxOutputTokens'], 8192)
            self.assertNotEqual(config['key'], 'fixture-company-key')
            async with self.sessions() as session:
                context, _ = await task_execution_model.prepare(session,
                    await session.get(Client, 'fixture'), {'cfg': {}}, {'id': 'runner:machine:' + cli})
                self.assertEqual(context['cfg']['llm']['model'], config['model'])
        self.assertEqual((await self.config())['model'], 'pi-model')
        self.assertEqual((await self.config(agent='local:qwen'))['model'], 'qwen-model')

    async def test_explicit_override_and_missing_preferences_never_silently_swap_models(self):
        async with self.sessions() as session, session.begin():
            client = await session.get(Client, 'fixture')
            client.agent_models = {**client.agent_models, 'qwen': 'removed-model'}
        missing = await self.config(agent='qwen')
        self.assertFalse(missing['ok']); self.assertIn('removed-model', missing['reason'])
        chosen = await self.config(agent='qwen', model='explicit-model')
        self.assertTrue(chosen['ok']); self.assertEqual(chosen['model'], 'explicit-model')
        missing = await self.config(agent='pi', model='removed-explicit')
        self.assertFalse(missing['ok']); self.assertIn('removed-explicit', missing['reason'])

    async def test_account_and_unknown_runtimes_cannot_receive_gateway_defaults(self):
        for agent in ['codex', 'claude', 'unknown', 'custom-arbitrary', 'custom-acp-extra']:
            result = await self.config(agent=agent)
            self.assertFalse(result['ok']); self.assertNotIn('key', result)

    async def test_custom_acp_selector_uses_the_actual_default_not_another_agent_preference(self):
        async with self.sessions() as session, session.begin():
            client = await session.get(Client, 'fixture')
            client.agent_models = {**client.agent_models, 'pi': 'removed-pi-model',
                                   'custom-acp': 'removed-custom-preference'}
        async with self.sessions() as session:
            expected = (await model_catalog.usable(session, await session.get(Client, 'fixture')))[0]['name']
        result = await self.config(agent='custom-acp')
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['model'], expected)
        self.assertNotEqual(result['key'], 'fixture-company-key')
        async with self.sessions() as session:
            owner = await device_auth.client_from_proxy_ticket(session, result['key'])
            self.assertEqual(owner.id, 'fixture')
        chosen = await self.config(agent='custom-acp', model='explicit-model')
        self.assertTrue(chosen['ok']); self.assertEqual(chosen['model'], 'explicit-model')
        unavailable = await self.config(agent='custom-acp', model='private-or-removed')
        self.assertFalse(unavailable['ok']); self.assertNotIn('key', unavailable)

    async def test_custom_acp_selector_still_requires_live_device_authorization(self):
        response = await self.http.get('/api/v1/ai-proxy/config', params={'agent': 'custom-acp'})
        self.assertEqual(response.status_code, 401)
        async with self.sessions() as session, session.begin():
            (await session.get(Client, 'fixture')).auth_state = 'revoked'
        response = await self.http.get('/api/v1/ai-proxy/config', params={'agent': 'custom-acp'}, headers=self.headers)
        self.assertIn(response.status_code, (401, 403))


if __name__ == '__main__':
    unittest.main()
