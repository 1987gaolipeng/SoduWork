"""Shared catalog, explicit optional installs and real declaration-only ACP I/O."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent


def fixture_entry():
    return {
        'id': 'fixture-acp', 'displayName': 'Fixture ACP', 'transport': 'runner',
        'modelMode': 'managed', 'goalMode': 'native', 'group': 'more', 'order': 100,
        'summary': 'Test-only protocol executable',
        'accessControl': {'schema': 'soduwork.access-policy/v1', 'supported': False,
                          'modes': [], 'approval': '', 'sandbox': False},
        'runner': {'adapter': 'acp', 'bins': ['fixture-acp'],
                   'args': ['-u', str(ROOT / 'tests/catalog_acp_agent.py')],
                   'home': {'env': 'FIXTURE_HOME', 'folder': '.fixture-acp'},
                   'modelEnv': {'FIXTURE_BASE': 'base', 'FIXTURE_KEY': 'key', 'FIXTURE_MODEL': 'model'}},
        'install': {'installer': 'manual', 'pkg': '', 'blurb': 'Test fixture',
                    'config_how': 'Environment only', 'config_path': '', 'install_how': 'Provide a reviewed executable'},
    }


class CatalogTest(unittest.TestCase):
    def test_catalog_drives_profiles_installs_models_and_names(self):
        from app import agent_catalog
        from app.services import local_base, agent_setup, agent_execution_options, agent_naming
        self.assertEqual(set(agent_catalog.AGENTS), set(local_base._PROFILES))
        self.assertEqual(set(agent_catalog.AGENTS), set(agent_setup._SPECS))
        for key, row in agent_catalog.AGENTS.items():
            self.assertEqual(local_base._PROFILES[key]['name'], row['displayName'])
            self.assertEqual('local:' + key in agent_execution_options.GATEWAY_MODEL_KINDS,
                             row['modelMode'] == 'managed')
            self.assertEqual(agent_naming.cli_from_name('开发机 · ' + row['displayName']), key)

    def test_malformed_declarations_fail_before_registration(self):
        from app.agent_catalog import load_catalog
        cases = [
            lambda row: row.update(id='../escape'),
            lambda row: row.update(transport='direct'),
            lambda row: row.update(goalMode='script'),
            lambda row: row.pop('accessControl'),
            lambda row: row['accessControl'].update(modes=['full']),
            lambda row: row['runner'].update(adapter='remote-script'),
            lambda row: row['runner'].update(args='shell command'),
            lambda row: row['runner']['home'].update(folder='../outside'),
            lambda row: row['runner']['modelEnv'].update(FIXTURE_KEY='file:/secret'),
            lambda row: row['install'].update(installer='managed'),
            lambda row: row['install'].update(installer='npm', pkg='pkg && command'),
        ]
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'catalog.json'
            for mutate in cases:
                row = fixture_entry()
                mutate(row)
                target.write_text(json.dumps({'schemaVersion': 1, 'agents': [row]}), encoding='utf-8')
                with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                    load_catalog(target)

    def test_opencode_detection_never_installs_and_ignores_retired_bundle(self):
        from app.services import agent_setup, managed_agents, local_base
        with tempfile.TemporaryDirectory() as directory:
            old = Path(directory) / 'old-opencode.exe'
            old.write_bytes(b'old bundled fixture')
            with (patch.dict(os.environ, {'SODUWORK_BUNDLED_OPENCODE': str(old)}),
                  patch.object(managed_agents, 'managed_binary', return_value=''),
                  patch.object(managed_agents, '_read_active', return_value=''),
                  patch.object(agent_setup, '_pkg_version', return_value=''),
                  patch.object(local_base, '_npm_root', return_value=''),
                  patch.object(local_base.shutil, 'which', return_value=None),
                  patch.object(managed_agents, 'install') as install):
                result = agent_setup.detect('opencode', probes={})
                self.assertFalse(result['installed'])
                self.assertFalse(result['bundled'])
                self.assertEqual(result['state'], 'missing')
                install.assert_not_called()

    def test_existing_opencode_installations_remain_available(self):
        from app.services import local_base, managed_agents
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'opencode.exe'
            executable.write_bytes(b'local installed fixture')
            with patch.object(managed_agents, 'managed_binary', return_value=str(executable)):
                self.assertEqual(local_base._opencode_bin(), str(executable))
            with (patch.object(managed_agents, 'managed_binary', return_value=''),
                  patch.object(local_base, '_npm_root', return_value=''),
                  patch.object(local_base.shutil, 'which', return_value=str(executable))):
                self.assertEqual(local_base._opencode_bin(), str(executable))

    def test_install_only_starts_for_explicit_valid_action(self):
        from app.services import agent_setup, managed_agents
        with patch.object(agent_setup, '_spawn') as spawn:
            job = agent_setup.start_install('opencode', 'install')
            self.assertTrue(job)
            spawn.assert_called_once_with(job, agent_setup._run_managed, 'opencode', 'install')
        with patch.object(managed_agents, '_download') as download:
            with self.assertRaises(ValueError):
                managed_agents.install('startup', lambda line: None)
            with self.assertRaises(ValueError):
                agent_setup.start_install('not-registered', 'install')
            with self.assertRaises(ValueError):
                agent_setup.start_install('opencode', 'startup')
            download.assert_not_called()

    def test_new_acp_declaration_dispatches_writes_delivers_and_resumes(self):
        from app import agent_catalog
        data = {'schemaVersion': 1, 'agents': [*copy.deepcopy(list(agent_catalog.AGENTS.values())), fixture_entry()]}
        with tempfile.TemporaryDirectory(prefix='soduwork-catalog-test-') as directory:
            catalog = Path(directory) / 'catalog.json'
            catalog.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
            env = {**os.environ, 'SODUWORK_DATA_ROOT': str(Path(directory) / 'data'),
                   'SODUWORK_AGENT_FIXTURE_ACP_BIN': sys.executable, 'PYTHONUTF8': '1'}
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                                     '--fixture', str(catalog), directory],
                                    cwd=ROOT, env=env, capture_output=True, text=True,
                                    encoding='utf-8', timeout=45)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('CATALOG_DISPATCH_RESUME_OK', result.stdout)


def run_fixture(catalog_path, directory):
    # Simulates adding exactly one reviewed JSON entry before normal startup.
    # No runtime dispatch, profile registry or ACP bridge implementation is patched.
    from app import agent_catalog
    agent_catalog.AGENTS = agent_catalog.load_catalog(Path(catalog_path))
    from app.services import agent_setup, local_base, ai_local, agent_execution_options, access_policy
    from app.services.local_ctx import prepare_resume
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from types import SimpleNamespace
    import threading
    import time

    class ModelReachability(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
        def log_message(self, *_args):
            pass

    server = HTTPServer(('127.0.0.1', 0), ModelReachability)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    workspace = Path(directory) / 'work'
    workspace.mkdir()
    cfg = {'local_workspace_root': str(workspace), 'llm': {
        'base': f'http://127.0.0.1:{server.server_port}', 'key': 'fixture-secret', 'model': 'fixture-model'}}
    assert 'fixture-acp' in agent_setup._SPECS
    assert agent_setup.detect('fixture-acp', probes={})['installed']
    assert 'local:fixture-acp' in agent_execution_options.GATEWAY_MODEL_KINDS
    assert not access_policy.capability('fixture-acp')['supported']
    assignee = ai_local.resolve_assignee_sync(cfg, 'local:fixture-acp')
    assert assignee and assignee['cliName'] == 'Fixture ACP'
    task = SimpleNamespace(id='catalog-task', title='Write a report', note='Create catalog-result.md')
    receipt = ai_local.dispatch_sync(cfg, task, assignee=assignee, ctx={
        'workDir': str(workspace), 'requiredCapabilities': ['files'],
        'conversationMode': 'adaptive', 'conversationUserText': 'Write a report'})
    assert receipt.get('ok'), receipt
    ref = receipt['issueId']

    def finish():
        deadline = time.monotonic() + 15
        while local_base._RUNS[ref]['state'] == 'running' and time.monotonic() < deadline:
            time.sleep(.05)
        run = local_base._RUNS[ref]
        assert run['state'] == 'done', (run['state'], run.get('error'), run.get('lines'))
        assert run['cliSid'] == 'catalog-fixture-session', run['cliSid']
        status = ai_local.status_sync(cfg, ref)
        assert any(item['filename'] == 'catalog-result.md' for item in status['attachments']), status
        assert 'catalog-result.md' in status['finalText'], status

    finish()
    assert 'First turn delivered' in (workspace / 'catalog-result.md').read_text(encoding='utf-8')
    resumed = prepare_resume(ref, 'Continue and revise the report', cfg)
    assert resumed.get('ok'), resumed
    finish()
    assert 'Resumed successfully' in (workspace / 'catalog-result.md').read_text(encoding='utf-8')
    server.shutdown()
    server.server_close()
    print('CATALOG_DISPATCH_RESUME_OK')


if __name__ == '__main__':
    if '--fixture' in sys.argv:
        run_fixture(sys.argv[2], sys.argv[3])
    else:
        unittest.main()
