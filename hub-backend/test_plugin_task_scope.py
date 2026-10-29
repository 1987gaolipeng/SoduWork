"""Discovery and execution share inherited scope, without widening tenant access.

Uses a private in-memory database. Route probing alone is stubbed; organization,
binding, version, project and audience checks run against real ORM rows.
"""
import os
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ.setdefault("AUTH_SECRET", "isolated-plugin-task-scope-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-plugin-task-scope-password")

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.db import Base
from app import models, automation_models as am
from app.services import (plugin_access, plugin_service as plugins,
                          task_execution_options as options)


class PluginTaskScopeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.session.add_all([
            models.OrgUnit(id='company', name='Company'),
            models.OrgUnit(id='department', name='Department', parent_id='company'),
            models.OrgUnit(id='sibling', name='Other department', parent_id='company'),
            models.OrgUnit(id='unrelated', name='Other company'),
            models.User(id='user', username='scope-test', org_id='department'),
            models.Client(id='client', user_ref='user'),
        ])
        self.task = SimpleNamespace(id='', repo_id=None, project_id=None, owner_client_id='client')
        for key, org in [('parent', 'company'), ('own', 'department'),
                         ('sibling', 'sibling'), ('foreign', 'unrelated'), ('global', None)]:
            self.session.add_all([
                am.Plugin(id=key, key=key, name=key, org_id=org, enabled=True),
                am.PluginVersion(id=key+'-v', plugin_id=key, version='1.0.0',
                                 checksum=key, enabled=True, trust_state='approved',
                                 manifest={'entrypoints': {'task': True, 'automation': True}}),
                am.PluginBinding(id=key+'-b', plugin_id=key, version_id=key+'-v',
                                 org_id=org, enabled=True),
                am.PluginInstallation(plugin_id=key, version_id=key+'-v',
                                      user_id='user', enabled=True),
            ])
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()

    async def available(self, **kwargs):
        with patch.object(plugins.plugin_route_readiness, 'context_for_task', AsyncMock(return_value={})), \
             patch.object(plugins.plugin_route_readiness, 'catalog_check', AsyncMock(return_value={'ok': True})):
            return await plugins.available_bindings(self.session, self.task, **kwargs)

    async def test_task_and_automation_inherit_only_parent_and_own_bindings(self):
        for entry in ['task', 'automation']:
            rows = await self.available(entrypoint=entry)
            self.assertEqual({row['pluginId'] for row in rows}, {'parent', 'own', 'global'})

    async def test_explicit_and_inferred_selection_use_same_inherited_scope(self):
        for key in ['parent', 'own', 'global']:
            for selector in [{'binding_id': key+'-b'}, {'plugin_id': key}]:
                row = await plugins.resolve_binding(self.session, self.task, **selector)
                self.assertEqual(row.id, key+'-b')

    async def test_sibling_and_other_company_cannot_be_selected_by_id(self):
        for key in ['sibling', 'foreign']:
            for selector in [{'binding_id': key+'-b'}, {'plugin_id': key}]:
                with self.assertRaises(ValueError):
                    await plugins.resolve_binding(self.session, self.task, **selector)

    async def test_explicit_admin_scope_remains_an_additional_restriction(self):
        with self.assertRaises(ValueError):
            await plugins.resolve_binding(self.session, self.task,
                                          binding_id='parent-b', org_ids={'department'})

    async def test_unscoped_task_does_not_inherit_any_company(self):
        self.task.owner_client_id = ''
        self.assertEqual({row['pluginId'] for row in await self.available()}, {'global'})
        with self.assertRaises(ValueError):
            await plugins.resolve_binding(self.session, self.task, binding_id='parent-b')

    async def test_project_specific_binding_still_requires_exact_project(self):
        binding = await self.session.get(am.PluginBinding, 'parent-b')
        binding.project_id = 'another-project'
        await self.session.commit()
        self.assertNotIn('parent', {row['pluginId'] for row in await self.available()})
        with self.assertRaises(ValueError):
            await plugins.resolve_binding(self.session, self.task, binding_id='parent-b')

    async def test_user_limited_version_stays_blocked_until_explicitly_granted(self):
        version = await self.session.get(am.PluginVersion, 'parent-v')
        version.visibility = 'users'
        await self.session.commit()
        self.assertNotIn('parent', {row['pluginId'] for row in await self.available()})
        with self.assertRaises(ValueError):
            await plugins.resolve_binding(self.session, self.task, binding_id='parent-b')
        self.session.add(am.PluginAudience(plugin_id='parent', version_id='parent-v', org_id='company',
                                          principal_type='user', principal_id='user'))
        await self.session.commit()
        self.assertIn('parent', {row['pluginId'] for row in await self.available()})
        self.assertEqual((await plugins.resolve_binding(self.session, self.task, binding_id='parent-b')).id, 'parent-b')

    async def test_binding_cannot_launder_a_foreign_plugin_as_global(self):
        binding = await self.session.get(am.PluginBinding, 'foreign-b')
        binding.org_id = None
        await self.session.commit()
        self.assertNotIn('foreign', {row['pluginId'] for row in await self.available()})
        with self.assertRaises(ValueError):
            await plugins.resolve_binding(self.session, self.task, binding_id='foreign-b')

    async def test_revoked_version_is_unavailable_in_both_paths(self):
        version = await self.session.get(am.PluginVersion, 'parent-v')
        version.trust_state = 'revoked'
        await self.session.commit()
        self.assertNotIn('parent', {row['pluginId'] for row in await self.available()})
        with self.assertRaises(ValueError):
            await plugins.resolve_binding(self.session, self.task, binding_id='parent-b')

    async def execution_options(self, *, existing=True, blocked=(), request=None):
        """Build execution options through the real ORM catalog; replace only model recommendations
        and machine probes.
        """
        task = models.Task(id='catalog-task', owner_client_id='client', title='目录测试',
                           work_scenario_key='office', work_scenario_name='办公',
                           work_routing={'defaultPluginKey': 'parent'})
        self.session.add(task)
        await self.session.commit()
        client = await self.session.get(models.Client, 'client')

        async def readiness(_session, version, *_args, **_kwargs):
            unavailable = version.plugin_id in blocked
            return {'ok': not unavailable,
                    'blockers': ['没有符合要求的在线 Agent'] if unavailable else []}

        with ExitStack() as stack:
            stack.enter_context(patch.object(options.work_catalog, 'recommend',
                                             AsyncMock(return_value={})))
            stack.enter_context(patch.object(options.work_catalog, 'routing_snapshot',
                                             return_value={'defaultPluginKey': 'parent'}))
            stack.enter_context(patch.object(plugins.plugin_route_readiness, 'context_for_task',
                                             AsyncMock(return_value={})))
            stack.enter_context(patch.object(plugins.plugin_route_readiness, 'catalog_check',
                                             side_effect=readiness))
            stack.enter_context(patch.object(options.ai_exec, 'load', AsyncMock(return_value={})))
            stack.enter_context(patch.object(options.ai_exec, 'list_assignees_sync', return_value={'agents': []}))
            stack.enter_context(patch.object(options.ai_exec, 'model_choices', return_value={}))
            stack.enter_context(patch.object(options.ai_exec, 'default_assignee', return_value={}))
            stack.enter_context(patch.object(options.model_catalog, 'choices', AsyncMock(return_value={})))
            stack.enter_context(patch.object(options.task_assignment, 'project_route', AsyncMock(return_value={})))
            body = {'taskId': task.id} if existing else {}
            body.update(request or {})
            return await options.build(self.session, client, body)

    async def test_execution_catalog_includes_other_authorized_plugins_and_blocked_diagnostics(self):
        result = await self.execution_options(blocked={'global'})
        self.assertEqual({row['key'] for row in result['workflows']}, {'parent', 'own'})
        self.assertEqual({row['key'] for row in result['blockedWorkflows']}, {'global'})
        self.assertFalse(next(row for row in result['workflows'] if row['key'] == 'own')['recommended'])
        self.assertEqual(result['blockedWorkflows'][0]['readiness']['blockers'], ['没有符合要求的在线 Agent'])
        self.assertFalse(result['recommendation']['workflowRequired'])
        self.assertEqual(result['substrates'], [])

    async def test_creation_catalog_keeps_existing_recommendation_scope(self):
        result = await self.execution_options(existing=False)
        self.assertEqual({row['key'] for row in result['workflows']}, {'parent'})

    async def test_execution_catalog_uses_selected_repo_without_mutating_task(self):
        self.session.add_all([
            models.Project(id='selected-project', name='工程', org_id='department'),
            models.Repo(id='selected-repo', project_id='selected-project', name='仓库', org_id='department'),
        ])
        binding = await self.session.get(am.PluginBinding, 'parent-b')
        binding.project_id = 'selected-project'
        await self.session.commit()
        result = await self.execution_options(request={'repoId': 'selected-repo'})
        self.assertEqual(result['selection']['projectId'], 'selected-project')
        self.assertIn('parent', {row['key'] for row in result['workflows']})
        task = await self.session.get(models.Task, 'catalog-task')
        self.assertFalse(task.project_id)
        self.assertFalse(task.repo_id)

    async def test_execution_catalog_preserves_audience_project_and_version_restrictions(self):
        own = await self.session.get(am.PluginVersion, 'own-v')
        own.visibility = 'users'
        parent = await self.session.get(am.PluginVersion, 'parent-v')
        parent.trust_state = 'revoked'
        global_binding = await self.session.get(am.PluginBinding, 'global-b')
        global_binding.project_id = 'another-project'
        await self.session.commit()
        result = await self.execution_options()
        self.assertEqual(result['workflows'], [])
        self.assertEqual(result['blockedWorkflows'], [])

    async def test_execution_catalog_marks_current_user_installed_plugins(self):
        result = await self.execution_options()
        self.assertEqual({row['pluginId'] for row in result['workflows']},
                         {'parent', 'own', 'global'})
        for row in result['workflows']:
            self.assertEqual(row['selectionSource'], 'installed')
            self.assertTrue(row['installed'])
            self.assertFalse(row['builtin'])

    async def test_execution_catalog_hides_others_disabled_and_uninstalled_market_plugins(self):
        await self.session.execute(delete(am.PluginInstallation))
        self.session.add_all([
            am.PluginInstallation(plugin_id='parent', version_id='parent-v',
                                  user_id='another-user', enabled=True),
            am.PluginInstallation(plugin_id='own', version_id='own-v',
                                  user_id='user', enabled=False),
        ])
        await self.session.commit()
        result = await self.execution_options(blocked={'global'})
        self.assertEqual(result['workflows'], [])
        self.assertEqual(result['blockedWorkflows'], [])
        self.assertEqual(result['recommendation']['workflowBindingId'], '')

    async def test_execution_catalog_keeps_uninstalled_builtin_and_installed_blockers(self):
        parent = await self.session.get(am.Plugin, 'parent')
        parent.source_kind = 'builtin'
        await self.session.execute(delete(am.PluginInstallation).where(
            am.PluginInstallation.plugin_id.in_(['parent', 'global'])))
        await self.session.commit()
        result = await self.execution_options(blocked={'parent', 'own', 'global'})
        self.assertEqual(result['workflows'], [])
        blocked = {row['pluginId']: row for row in result['blockedWorkflows']}
        self.assertEqual(set(blocked), {'parent', 'own'})
        self.assertEqual(blocked['parent']['selectionSource'], 'builtin')
        self.assertTrue(blocked['parent']['builtin'])
        self.assertFalse(blocked['parent']['installed'])
        self.assertEqual(blocked['own']['selectionSource'], 'installed')
        for row in blocked.values():
            self.assertFalse(row['runnable'])
            self.assertEqual(row['readiness']['blockers'], ['没有符合要求的在线 Agent'])

    async def test_execution_catalog_never_overrides_explicit_use_denial(self):
        for key in ['parent', 'own']:
            plugin = await self.session.get(am.Plugin, key)
            if key == 'parent':
                plugin.source_kind = 'builtin'
            await plugin_access.save(self.session, plugin, {'use': {'mode': 'none'}}, 'admin')
        result = await self.execution_options(blocked={'parent', 'own'})
        self.assertEqual({row['pluginId'] for row in result['workflows']}, {'global'})
        self.assertEqual(result['blockedWorkflows'], [])


if __name__ == '__main__':
    unittest.main()
