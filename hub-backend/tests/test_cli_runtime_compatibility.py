"""Shared launch, permissions and isolation for the new CLI adapters."""
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.agent_catalog import AGENTS
from app.services import acp_agents, local_base, agent_setup, agent_shell
from app.services.acp_access import BridgeAccess, AccessError
from app.services.acp_bridge import AcpBridge


class CliRuntimeCompatibilityTests(unittest.TestCase):
    def test_permission_inputs_are_bound_to_the_exact_live_cli_tool_call(self):
        for key in ['kimi']:
            access = BridgeAccess(json.dumps({'url': 'http://127.0.0.1:1', 'policy': {'mode': 'standard'}}), agent_name=key)
            requests = []
            access.call = lambda path, value: requests.append(value) or {'decision': 'deny'}
            access.observe_tool({'sessionUpdate': 'tool_call', 'toolCallId': '0:call-1', 'kind': 'execute',
                                 'status': 'in_progress', 'rawInput': {'command': 'printf fixture', 'timeout': 10}})
            self.assertFalse(access.native_permission({'toolCall': {'toolCallId': '0:call-1', 'title': 'Bash'}}))
            self.assertEqual(requests[-1]['arguments'], {'command': 'printf fixture', 'timeout': 10})
            self.assertEqual(requests[-1]['target'], 'printf fixture')
            access.native_permission({'toolCall': {'toolCallId': 'different', 'title': 'Bash'}})
            self.assertTrue(requests[-1]['arguments']['inputUnavailable'])
            access.native_permission({'toolCall': {'toolCallId': '0:call-1', 'kind': 'edit'}})
            self.assertTrue(requests[-1]['arguments']['inputUnavailable'])
            access.observe_tool({'sessionUpdate': 'tool_call_update', 'toolCallId': '0:call-1', 'status': 'completed'})
            access.native_permission({'toolCall': {'toolCallId': '0:call-1'}})
            self.assertTrue(requests[-1]['arguments']['inputUnavailable'])

    def test_early_permission_displays_explanation_without_inventing_execution_arguments(self):
        access = BridgeAccess(json.dumps({'url': 'http://127.0.0.1:1', 'policy': {'mode': 'standard'}}), agent_name='kimi')
        requests = []
        access.call = lambda path, value: requests.append(value) or {'decision': 'deny'}
        display = [{'type': 'content', 'content': {'type': 'text', 'text': 'printf fixture'}}]
        self.assertFalse(access.native_permission({'toolCall': {'toolCallId': '0:early', 'title': 'Bash', 'content': display}}))
        self.assertEqual(requests[-1]['arguments'], {'inputUnavailable': True, 'display': display})
        self.assertFalse(requests[-1]['allowSession'])
        self.assertEqual(requests[-1]['target'], '')

    def test_kimi_model_configuration_is_ephemeral_and_cannot_keep_stale_provider_fields(self):
        env = {'KIMI_MODEL_BASE_URL': 'wrong', 'KIMI_MODEL_HEADERS': 'wrong', 'KIMI_MODEL_API_KEY': 'wrong'}
        for kind in ['openai', 'anthropic']:
            acp_agents.inject_llm_env('kimi', env, {'base': 'https://model.invalid/v1', 'key': 'scoped-key', 'model': 'model-name', 'kind': kind})
            self.assertEqual(env['KIMI_MODEL_API_KEY'], 'scoped-key')
            self.assertEqual(env['KIMI_MODEL_NAME'], 'model-name')
            self.assertEqual(env['KIMI_MODEL_BASE_URL'], 'https://model.invalid/v1')
            self.assertEqual(env['KIMI_MODEL_PROVIDER_TYPE'], kind)
            self.assertNotIn('KIMI_MODEL_HEADERS', env)

    def test_kimi_anonymous_local_model_uses_a_non_secret_credential_placeholder(self):
        for kind in ('openai', 'anthropic'):
            for missing_key in ('', '   '):
                with self.subTest(kind=kind, key=missing_key):
                    llm = {'base': 'http://127.0.0.1:11434/v1', 'model': 'local-model',
                           'key': missing_key, 'kind': kind, 'localOnly': True}
                    original = dict(llm)
                    env = {'KIMI_MODEL_API_KEY': 'inherited-personal-key',
                           'KIMI_MODEL_HEADERS': 'inherited-personal-headers'}
                    acp_agents.inject_llm_env('kimi', env, llm)
                    self.assertEqual(env['KIMI_MODEL_API_KEY'], 'soduwork-anonymous-local')
                    self.assertEqual(env['KIMI_MODEL_BASE_URL'], llm['base'])
                    self.assertEqual(env['KIMI_MODEL_NAME'], 'local-model')
                    self.assertEqual(env['KIMI_MODEL_PROVIDER_TYPE'], kind)
                    self.assertNotIn('KIMI_MODEL_HEADERS', env)
                    self.assertEqual(llm, original, 'The placeholder is process-local, not saved model configuration')

    def test_kimi_placeholder_requires_explicit_local_model_and_preserves_supplied_keys(self):
        for local_only in (False, None, 'true', 1):
            with self.subTest(local_only=local_only):
                env = {}
                acp_agents.inject_llm_env('kimi', env, {
                    'base': 'https://model.invalid/v1', 'model': 'remote-model',
                    'localOnly': local_only})
                self.assertEqual(env, {}, 'An unauthenticated remote model must not acquire a placeholder')
        env = {}
        acp_agents.inject_llm_env('kimi', env, {
            'base': 'http://127.0.0.1:11434/v1', 'model': 'local-model',
            'key': 'explicit-local-key', 'localOnly': True})
        self.assertEqual(env['KIMI_MODEL_API_KEY'], 'explicit-local-key')

    def test_kimi_placeholder_does_not_change_other_agents_anonymous_model_contract(self):
        env = {'OPENAI_API_KEY': 'inherited-personal-key'}
        acp_agents.inject_llm_env('qwen', env, {
            'base': 'http://127.0.0.1:11434/v1', 'model': 'local-model', 'localOnly': True})
        self.assertNotIn('OPENAI_API_KEY', env)
        self.assertNotIn('KIMI_MODEL_API_KEY', env)
        self.assertEqual(env['OPENAI_MODEL'], 'local-model')

    def test_bundled_shell_replaces_stale_paths_without_requiring_global_git(self):
        with tempfile.TemporaryDirectory() as folder:
            shell = Path(folder) / 'bin' / 'bash.exe'
            shell.parent.mkdir()
            shell.touch()
            for key, variable in [('kimi', 'KIMI_SHELL_PATH')]:
                env = {'PATH': '', 'SODUWORK_BUNDLED_SHELL': folder, variable: 'other-client/missing-bash.exe'}
                agent_shell.apply(env, key)
                self.assertEqual(env[variable], str(shell.resolve()))
                env.pop('SODUWORK_BUNDLED_SHELL')
                agent_shell.apply(env, key)
                self.assertEqual(env[variable], str(shell.resolve()))


    def test_cli_titles_and_shared_transport(self):
        for key in ('kimi',):
            self.assertNotIn('CLI', AGENTS[key]['displayName'])
            self.assertEqual(local_base._PROFILES[key]['acp_key'], key)
            self.assertFalse(local_base._PROFILES[key]['own_session'])

    def test_node_entry_avoids_windows_shims_and_keeps_arguments_separate(self):
        for key, command in [('kimi', ['acp'])]:
            with (patch('app.services.agent_installation.selected_node_entry', return_value=('space dir/entry.js', '>=22.19.0')),
                  patch.object(acp_agents.agent_npm_runtime, 'node_env', return_value={'ok': True, 'nodePath': 'node dir/node.exe'})):
                argv = acp_agents.command_argv(key, 'unsafe shim.cmd',
                    acp_agents.run_args('previous-session', 'work'), '.', {'requiredCapabilities': ['terminal']})
            self.assertEqual(argv[argv.index('--')+1:], ['node dir/node.exe', 'space dir/entry.js', *command])
            self.assertIn('previous-session', argv)
            self.assertIn('--terminal', argv)

    def test_all_access_modes_are_acknowledged_before_prompt(self):
        for key, modes in {'kimi': ['default', 'plan', 'yolo']}.items():
            for mode, native in zip(['standard', 'readonly', 'full'], modes):
                requests = []
                access = BridgeAccess(json.dumps({'url': 'http://127.0.0.1:1', 'policy': {'mode': mode}}), agent_name=key)
                access.call = lambda path, value: requests.append((path, value)) or {'ok': True}
                bridge = SimpleNamespace(agent_name=key, session_id='same-session', request=lambda method, params: requests.append((method, params)))
                access.apply(bridge, {'modes': {'availableModes': [{'id': item} for item in modes]}})
                self.assertEqual(requests[0], ('session/set_mode', {'sessionId': 'same-session', 'modeId': native}))
                self.assertEqual(requests[1][0], '/applied')
                with self.assertRaises(AccessError):
                    access.apply(bridge, {'modes': {'availableModes': []}})




if __name__ == '__main__':
    unittest.main()
