"""Shared launch, permissions and isolation for the new CLI adapters."""
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.agent_catalog import AGENTS
from app.services import acp_agents, claude_runtime, local_base, agent_setup, agent_shell
from app.services.acp_access import BridgeAccess, AccessError
from app.services.acp_bridge import AcpBridge


class CliRuntimeCompatibilityTests(unittest.TestCase):
    def test_permission_inputs_are_bound_to_the_exact_live_cli_tool_call(self):
        for key in ['kimi', 'claude']:
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

    def test_bundled_shell_replaces_stale_paths_without_requiring_global_git(self):
        with tempfile.TemporaryDirectory() as folder:
            shell = Path(folder) / 'bin' / 'bash.exe'
            shell.parent.mkdir()
            shell.touch()
            for key, variable in [('kimi', 'KIMI_SHELL_PATH'), ('claude', 'CLAUDE_CODE_GIT_BASH_PATH')]:
                env = {'PATH': '', 'SODUWORK_BUNDLED_SHELL': folder, variable: 'other-client/missing-bash.exe'}
                agent_shell.apply(env, key)
                self.assertEqual(env[variable], str(shell.resolve()))
                env.pop('SODUWORK_BUNDLED_SHELL')
                agent_shell.apply(env, key)
                self.assertEqual(env[variable], str(shell.resolve()))

    def test_native_login_command_quotes_paths_and_uses_the_execution_account_home(self):
        with tempfile.TemporaryDirectory(prefix="runner's space ") as folder:
            native = str(Path(folder) / 'claude.exe')
            with patch.object(claude_runtime.agent_native_install, 'active_binary', return_value=native):
                windows = claude_runtime.account_setup(folder, windows=True)
                unix = claude_runtime.account_setup(folder, windows=False)
            self.assertIn("runner''s space", windows['command'])
            self.assertIn('CLAUDE_CONFIG_DIR=', windows['command'])
            self.assertTrue(windows['command'].endswith(' auth login'))
            import shlex
            self.assertEqual(shlex.split(unix['command'])[1:], [native, 'auth', 'login'])

    def test_cli_titles_and_shared_transport(self):
        for key in ('kimi', 'claude'):
            self.assertNotIn('CLI', AGENTS[key]['displayName'])
            self.assertEqual(local_base._PROFILES[key]['acp_key'], key)
            self.assertFalse(local_base._PROFILES[key]['own_session'])

    def test_node_entry_avoids_windows_shims_and_keeps_arguments_separate(self):
        for key, command in [('kimi', ['acp']), ('claude', [])]:
            with (patch.object(acp_agents.agent_npm_runtime, 'package_entry', return_value='space dir/entry.js'),
                  patch.object(acp_agents.agent_npm_runtime, 'node_env', return_value={'ok': True, 'nodePath': 'node dir/node.exe'})):
                argv = acp_agents.command_argv(key, 'unsafe shim.cmd',
                    acp_agents.run_args('previous-session', 'work'), '.', {'requiredCapabilities': ['terminal']})
            self.assertEqual(argv[argv.index('--')+1:], ['node dir/node.exe', 'space dir/entry.js', *command])
            self.assertIn('previous-session', argv)
            self.assertIn('--terminal', argv)

    def test_all_access_modes_are_acknowledged_before_prompt(self):
        for key, modes in {'kimi': ['default', 'plan', 'yolo'], 'claude': ['default', 'plan', 'bypassPermissions']}.items():
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

    def test_claude_account_probe_and_execution_share_private_home(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': 'other-client', 'CLAUDECODE': '1'}):
            with patch.object(local_base, '_data_root', return_value=folder):
                env = local_base._env_for(local_base._PROFILES['claude'], {})
                self.assertEqual(env['CLAUDE_CONFIG_DIR'], str(Path(folder).resolve() / '.claude'))
                self.assertNotIn('CLAUDECODE', env)
                with patch.object(agent_setup, '_account_auth_probe', return_value=('unauthed', '')) as probe:
                    with patch.object(agent_setup, '_data_root', return_value=folder):
                        agent_setup._auth_probe('claude')
                self.assertEqual(probe.call_args.kwargs['env']['CLAUDE_CONFIG_DIR'], env['CLAUDE_CONFIG_DIR'])

    def test_claude_resume_receives_only_host_selected_configuration(self):
        bridge = AcpBridge(['unused'], '.', 'claude', 'workspace', session_id='previous-session')
        calls = []
        def request(method, params):
            calls.append((method, params))
            if method == 'initialize':
                return {'protocolVersion': 1, 'agentCapabilities': {'sessionCapabilities': {'resume': {}}}}
            if method == 'session/prompt':
                return {'stopReason': 'end_turn'}
            return {}
        with (patch.object(bridge, 'start'), patch.object(bridge, 'request', side_effect=request),
              patch.object(bridge.access, 'apply'), patch.object(bridge.transition, 'complete', return_value=False)):
            self.assertEqual(bridge.run('Continue with the previous result'), 0)
        resume = next(params for method, params in calls if method == 'session/resume')
        self.assertEqual(resume['sessionId'], 'previous-session')
        self.assertEqual(resume['_meta']['claudeCode']['options'], {'settingSources': [], 'strictMcpConfig': True})
        self.assertFalse(any(method == 'session/new' for method, _ in calls))


if __name__ == '__main__':
    unittest.main()
