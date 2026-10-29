"""Exercise the installer's Python stage without network or model calls."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


INSTALLER = Path(__file__).parent / 'installers/runner-install.sh'
BOOTSTRAP = INSTALLER.read_text().split("<<'BOOTSTRAP_PY'\n", 1)[1].split('\nBOOTSTRAP_PY', 1)[0]


class AgentBootstrapTests(unittest.TestCase):
    def run_stage(self, root, *, existing=False, corrupt=False, fail_install=False,
                  collision=False):
        calls = []
        runtime = types.SimpleNamespace(node_env=Mock(side_effect=(
            [{'ok': True, 'node': 'v22.23.3', 'npm': '10.9.9'}] if existing else
            [{'ok': False}, {'ok': True, 'node': 'v22.23.3', 'npm': '10.9.9'}])))
        before = {'installed': existing, 'version': 'fixture', 'warnNow': ''}
        after = {'installed': True, 'version': 'fixture', 'warnNow': ''}
        setup = types.SimpleNamespace(
            detect=Mock(side_effect=[before] if existing else [before, after]),
            start_install=Mock(return_value='fixture-job'),
            job=Mock(side_effect=[{'state': 'running', 'lines': ['installing']},
                                 {'state': 'done', 'lines': ['installing', 'done'],
                                  'ok': not fail_install, 'detail': 'fixture install failed'}]))
        services = types.ModuleType('app.services')
        services.agent_npm_runtime = runtime
        services.agent_setup = setup
        app = types.ModuleType('app')
        app.services = services
        name = 'node-v22.23.3-linux-x64'
        payload = b'fixture official archive'
        digest = '0' * 64 if corrupt else hashlib.sha256(payload).hexdigest()
        manifest = f'{digest}  {name}.tar.gz\n'.encode()
        if collision:
            dest = root / 'agent-runtimes/npm/bin'
            dest.mkdir(parents=True)
            (dest / 'node').write_text('user file')

        def run(argv, **kwargs):
            calls.append(argv)
            if argv[0] == 'curl':
                if 'SHASUMS256.txt' in argv[-1]:
                    return subprocess.CompletedProcess(argv, 0, stdout=manifest.decode())
                Path(argv[-1]).write_bytes(payload)
            elif argv[0] == 'tar':
                binaries = Path(argv[-1]) / name / 'bin'
                binaries.mkdir(parents=True)
                for command in ('node', 'npm', 'npx'):
                    (binaries / command).write_text('fixture')
            return subprocess.CompletedProcess(argv, 0)

        with patch.dict(sys.modules, {'app': app, 'app.services': services}), \
                patch.object(sys, 'argv', ['installer-stage', str(root)]), \
                patch('platform.machine', return_value='x86_64'), \
                patch('urllib.request.urlopen', return_value=io.BytesIO(manifest)), \
                patch('subprocess.run', side_effect=run), \
                patch('time.sleep'), patch('sys.stdout', new=io.StringIO()):
            try:
                exec(compile(BOOTSTRAP, str(INSTALLER), 'exec'), {})
            except SystemExit as error:
                return error, calls, setup
        return None, calls, setup

    def test_fresh_install_verifies_node_and_installs_pi_through_shared_job(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            error, calls, setup = self.run_stage(root)
            self.assertIsNone(error)
            self.assertTrue((root / 'agent-runtimes/npm/bin/node').resolve().is_file())
            self.assertEqual([c[0] for c in calls].count('curl'), 2)
            self.assertTrue(all('https://npmmirror.com/' in ' '.join(c) for c in calls if c[0] == 'curl'))
            setup.start_install.assert_called_once_with('pi', 'install')
            self.assertEqual(setup.job.call_count, 2)
            self.assertEqual(setup.detect.call_count, 2)

    def test_existing_environment_needs_no_network_or_agent_install(self):
        with tempfile.TemporaryDirectory() as temp:
            error, calls, setup = self.run_stage(Path(temp), existing=True)
            self.assertIsNone(error)
            self.assertEqual(calls, [])
            setup.start_install.assert_not_called()

    def test_checksum_failure_never_extracts_or_installs_agent(self):
        with tempfile.TemporaryDirectory() as temp:
            error, calls, setup = self.run_stage(Path(temp), corrupt=True)
            self.assertIn('校验失败', str(error))
            self.assertFalse(any(c[0] == 'tar' for c in calls))
            setup.start_install.assert_not_called()

    def test_agent_install_failure_stops_before_claiming_success(self):
        with tempfile.TemporaryDirectory() as temp:
            error, _, setup = self.run_stage(Path(temp), fail_install=True)
            self.assertIn('fixture install failed', str(error))
            self.assertEqual(setup.detect.call_count, 1)

    def test_existing_private_file_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            error, _, setup = self.run_stage(root, collision=True)
            self.assertIn('未覆盖', str(error))
            self.assertEqual((root / 'agent-runtimes/npm/bin/node').read_text(), 'user file')
            setup.start_install.assert_not_called()

    def test_config_rerun_preserves_existing_identity_options_and_custom_paths(self):
        source = INSTALLER.read_text()
        writer = source.split('"$PY" -c \'\n', 1)[1].split("\n' \"$HUB\"", 1)[0]
        with tempfile.TemporaryDirectory() as temp:
            cfg = Path(temp) / 'runner.json'
            previous = {'tags': ['custom'], 'dataRoot': '/private/data', 'workRoot': '/private/work',
                        'customSetting': True, 'runnerId': 'fixture-runner', 'key': 'fixture-key'}
            cfg.write_text(json.dumps(previous))
            subprocess.run([sys.executable, '-c', writer, 'https://fixture.invalid',
                            'fixture-runner', 'fixture-key', '', '/private/work',
                            '/private/data', str(cfg)], check=True)
            current = json.loads(cfg.read_text())
            for key, value in previous.items():
                self.assertEqual(current[key], value)


if __name__ == '__main__':
    unittest.main()
