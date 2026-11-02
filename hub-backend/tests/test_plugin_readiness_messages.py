"""Readiness messages preserve the legacy API and business values."""
from types import SimpleNamespace
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault('DATABASE_URL', 'sqlite+aiosqlite:///:memory:')
os.environ.setdefault('AUTH_SECRET', 'isolated-plugin-message-test-secret')
from app.services import plugin_readiness, plugin_route_readiness, workflow_inputs


class PluginReadinessMessagesTests(unittest.IsolatedAsyncioTestCase):
    async def test_simulation_returns_templates_without_translating_project_names(self):
        version = SimpleNamespace(trust_state='approved', enabled=True, workflow={'nodes': []})
        project = SimpleNamespace(id='fixture', name='保存 {count}')
        with patch.object(plugin_readiness, 'binding_readiness', AsyncMock(return_value={'blockers': [], 'warnings': []})), \
             patch.object(workflow_inputs, 'plugin_skills', AsyncMock(return_value=[{'bundled': True}, {'bundled': False}])):
            result = await plugin_readiness.simulate(None, version, project, None)
        self.assertEqual(result['project']['name'], '保存 {count}')
        checks = {row['key']: row for row in result['checks']}
        self.assertEqual(checks['skills']['detailMessage']['params'], {'count': 2, 'bundled': 1})
        self.assertIn('2', checks['skills']['detail'])
        self.assertEqual(checks['trust']['detailMessage']['key'], 'plugin.trust.ready')
        self.assertTrue(all(row['labelMessage']['fallback'] == row['label'] for row in result['checks']))

    async def test_workflow_without_ai_has_a_translatable_route_result(self):
        result = await plugin_route_readiness.check(None, SimpleNamespace(workflow={'nodes': []}))
        self.assertEqual(result['check']['detailMessage']['key'], 'plugin.routes.unneeded')
        self.assertTrue(result['check']['detail'])
