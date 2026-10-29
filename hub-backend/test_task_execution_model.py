"""Isolated direct-dispatch model contracts; no model calls or production data."""
import os
os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///:memory:'

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from app.services import task_execution_model as routing, task_execution_options


class TaskModelTests(unittest.IsolatedAsyncioTestCase):
    def context(self):
        return {'name': 'local', 'cfg': {'llm': {'model': 'old-model', 'key': 'old-key'}},
                'localCfg': {'llm': {'model': 'old-model', 'key': 'old-key'}}}

    async def test_every_gateway_runtime_gets_the_complete_selected_provider(self):
        model = {'base': 'https://fixture.invalid/v1', 'key': 'fixture-key',
                 'model': 'chosen', 'input': ['text', 'image'], 'imageRouting': 'native'}
        with patch.object(routing.model_catalog, 'resolve', new=AsyncMock(return_value=model)) as resolve:
            for cli in ['pi', 'opencode', 'qwen', 'codex-harness', 'dsh']:
                source = self.context()
                result, execution = await routing.prepare(None, None, source,
                    {'id': 'runner:device:' + cli}, 'chosen')
                self.assertEqual(result['cfg']['llm']['key'], 'fixture-key')
                self.assertEqual(result['localCfg']['llm']['model'], 'chosen')
                self.assertEqual(result['localCfg']['llm']['input'], ['text', 'image'])
                self.assertEqual(execution, {'kind': 'local:' + cli, 'model': 'chosen'})
                self.assertEqual(source['cfg']['llm']['key'], 'old-key')
                self.assertEqual(resolve.call_args.args[2], 'chosen')

    async def test_native_codex_options_bypass_company_catalog_and_credentials(self):
        with patch.object(routing.model_catalog, 'resolve', new=AsyncMock()) as resolve:
            result, execution = await routing.prepare(None, None, self.context(),
                {'id': 'runner:device:codex'}, 'gpt-5-codex', 'high')
            self.assertEqual(execution, {'kind': 'local:codex', 'model': 'gpt-5-codex',
                                         'reasoningEffort': 'high'})
            self.assertNotIn('llm', result['cfg'])
            self.assertNotIn('llm', result['localCfg'])
            resolve.assert_not_awaited()

    async def test_unavailable_explicit_and_saved_choices_never_fall_back(self):
        client = SimpleNamespace(agent_models={'qwen': 'saved-qwen-model'})
        with patch.object(routing.model_catalog, 'resolve', new=AsyncMock(return_value={})) as resolve:
            for chosen, expected in [('removed-model', 'removed-model'), ('', 'saved-qwen-model')]:
                with self.assertRaisesRegex(ValueError, expected):
                    await routing.prepare(None, client, self.context(), {'id': 'local:qwen'}, chosen)
                self.assertEqual(resolve.call_args.args[2], expected)

    async def test_default_model_uses_the_final_selected_runtime(self):
        client = SimpleNamespace(agent_models={'pi': 'pi-default', 'qwen': 'qwen-default'})
        with patch.object(routing.model_catalog, 'resolve', new=AsyncMock(return_value={})) as resolve:
            with self.assertRaisesRegex(ValueError, 'qwen-default'):
                await routing.prepare(None, client, self.context(), {'id': 'runner:device:qwen'})
            self.assertEqual(resolve.call_args.args[2], 'qwen-default')

    async def test_account_managed_model_cannot_accept_a_company_override(self):
        with self.assertRaisesRegex(ValueError, 'does not support'):
            await routing.prepare(None, None, self.context(), {'id': 'local:claude'}, 'company')
        result, _ = await routing.prepare(None, None, self.context(), {'id': 'local:claude'})
        self.assertNotIn('llm', result['cfg'])

    def test_task_model_catalog_is_not_offered_to_native_account_agents(self):
        agents = [{'id': 'runner:device:' + cli, 'cli': cli, 'host': 'fixture',
                   'modelPick': True, 'capabilities': {'available': ['files']}}
                  for cli in ['pi', 'opencode', 'qwen', 'codex-harness', 'dsh', 'codex', 'claude']]
        rows = {row['cli']: row for row in task_execution_options.substrate_options(agents, ['files'])}
        for cli in ['pi', 'opencode', 'qwen', 'codex-harness', 'dsh']:
            self.assertTrue(rows[cli]['modelPick'])
            self.assertEqual(rows[cli]['modelSource'], 'gateway')
        for cli in ['codex', 'claude']:
            self.assertFalse(rows[cli]['modelPick'])
        self.assertTrue(rows['codex']['nativeModelPick'])


if __name__ == '__main__':
    unittest.main()
