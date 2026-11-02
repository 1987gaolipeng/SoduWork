"""Exercise the installer's Python stage without network or model calls."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


INSTALLER = Path(__file__).parent / 'installers/runner-install.sh'
BOOTSTRAP = INSTALLER.read_text(encoding='utf-8').split("<<'BOOTSTRAP_PY'\n", 1)[1].split('\nBOOTSTRAP_PY', 1)[0]


class AgentBootstrapTests(unittest.TestCase):
    def run_stage(self, root, *, existing=False, corrupt=False, fail_install=False,
                  collision=False, fail_ready=False, fail_publish=False, execute_denied=False):
        calls = []
        runtime = types.SimpleNamespace(node_env=Mock(side_effect=(
            [{'ok': True, 'node': 'v22.23.3', 'npm': '10.9.9'}] if existing else
            [{'ok': False}, {'ok': not fail_ready, 'node': 'v22.23.3', 'npm': '10.9.9'}])))
        runtime.clean_env = Mock(return_value={'FIXTURE_CLEAN': '1'})
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
                    (binaries / command).chmod(0o755)
                npm = binaries.parent / 'lib/node_modules/npm/bin/npm-cli.js'
                npm.parent.mkdir(parents=True)
                npm.write_text('fixture')
            else:
                executable = Path(argv[0])
                if executable.name == 'node':
                    self.assertEqual(kwargs.get('env'), {'FIXTURE_CLEAN': '1'})
                    if not executable.is_file() or executable.read_text() == 'broken':
                        raise subprocess.CalledProcessError(1, argv)
                    if argv[1] == '-p':
                        marker = executable.read_text()
                        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps({
                            'node': '18.20.0' if marker == 'incompatible' else '22.23.3',
                            'electron': marker == 'electron'}))
                    if not Path(argv[1]).is_file() or Path(argv[1]).read_text() == 'broken':
                        raise subprocess.CalledProcessError(1, argv)
                    npm_cli = executable.parent.parent / 'lib/node_modules/npm/bin/npm-cli.js'
                    if not npm_cli.is_file() or npm_cli.read_text() == 'broken':
                        raise subprocess.CalledProcessError(1, argv)
                    return subprocess.CompletedProcess(argv, 0, stdout='10.9.9\n')
            return subprocess.CompletedProcess(argv, 0)

        rename = Path.rename
        def publish(path, target):
            if fail_publish and path.name == name and path.parent.name.startswith('node-bootstrap-'):
                raise OSError('fixture publish failure')
            return rename(path, target)
        access = os.access
        def executable(path, mode):
            if execute_denied and Path(path).resolve() == (root / 'agent-runtimes' / name / 'bin/npx').resolve():
                return Path(path).read_text() == 'fixture'
            return access(path, mode)

        with patch.dict(sys.modules, {'app': app, 'app.services': services}), \
                patch.object(sys, 'argv', ['installer-stage', str(root)]), \
                patch('platform.machine', return_value='x86_64'), \
                patch('urllib.request.urlopen', return_value=io.BytesIO(manifest)), \
                patch('subprocess.run', side_effect=run), \
                patch.object(Path, 'rename', publish), \
                patch('os.access', side_effect=executable), \
                patch('time.sleep'), patch('sys.stdout', new=io.StringIO()):
            try:
                exec(compile(BOOTSTRAP, str(INSTALLER), 'exec'), {})
            except (SystemExit, OSError, subprocess.SubprocessError) as error:
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

    def existing_runtime(self, root, *, node='original', npm='original'):
        target = root / 'agent-runtimes/node-v22.23.3-linux-x64'
        (target / 'bin').mkdir(parents=True)
        for command in ('node', 'npm', 'npx'):
            (target / 'bin' / command).write_text(node if command == 'node' else 'original')
            (target / 'bin' / command).chmod(0o755)
        cli = target / 'lib/node_modules/npm/bin/npm-cli.js'
        cli.parent.mkdir(parents=True)
        cli.write_text(npm)
        return target

    def test_corrupt_managed_node_or_npm_is_replaced_by_verified_stage(self):
        for broken in ('node', 'npm'):
            with self.subTest(broken=broken), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                target = self.existing_runtime(root, **{broken: 'broken'})
                error, _, _ = self.run_stage(root)
                self.assertIsNone(error)
                self.assertEqual((target / 'bin/node').read_text(), 'fixture')
                self.assertEqual((root / 'agent-runtimes/npm/bin/node').resolve(), (target / 'bin/node').resolve())
                self.assertFalse(list(target.parent.glob('*.rollback-*')))

    def test_healthy_fixed_runtime_is_retained_when_repairing_command_links(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = self.existing_runtime(root)
            error, _, _ = self.run_stage(root)
            self.assertIsNone(error)
            self.assertEqual((target / 'bin/node').read_text(), 'original')
            self.assertEqual((root / 'agent-runtimes/npm/bin/node').resolve(), (target / 'bin/node').resolve())

    def test_incompatible_identity_and_missing_launchers_are_repaired(self):
        for defect in ('incompatible', 'electron', 'npm', 'npx'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                target = self.existing_runtime(root, node=defect if defect in ('incompatible', 'electron') else 'original')
                if defect in ('npm', 'npx'):
                    (target / 'bin' / defect).unlink()
                error, _, _ = self.run_stage(root)
                self.assertIsNone(error)
                self.assertEqual((target / 'bin/node').read_text(), 'fixture')
                self.assertTrue((target / 'bin/npm').is_file())
                self.assertTrue((target / 'bin/npx').is_file())

    def test_non_executable_managed_launcher_is_repaired(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = self.existing_runtime(root)
            error, _, _ = self.run_stage(root, execute_denied=True)
            self.assertIsNone(error)
            self.assertEqual((target / 'bin/npx').read_text(), 'fixture')

    def test_failed_publish_or_discovery_restores_runtime_and_existing_links(self):
        for failure in ('fail_publish', 'fail_ready'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                target = self.existing_runtime(root, node='broken')
                links = root / 'agent-runtimes/npm/bin'
                links.mkdir(parents=True)
                previous = '../previous-node'
                (links / 'node').symlink_to(previous)
                error, _, setup = self.run_stage(root, **{failure: True})
                self.assertIsNotNone(error)
                self.assertEqual((target / 'bin/node').read_text(), 'broken')
                self.assertEqual(os.readlink(links / 'node'), previous)
                self.assertFalse((links / 'npm').is_symlink())
                self.assertFalse((links / 'npx').is_symlink())
                self.assertFalse(list(target.parent.glob('*.rollback-*')))
                setup.start_install.assert_not_called()

    def test_failed_first_activation_leaves_no_partial_runtime_or_links(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            error, _, setup = self.run_stage(root, fail_ready=True)
            self.assertIsNotNone(error)
            self.assertFalse((root / 'agent-runtimes/node-v22.23.3-linux-x64').exists())
            self.assertFalse(any((root / 'agent-runtimes/npm/bin').iterdir()))
            setup.start_install.assert_not_called()

    def test_managed_directory_symlinks_never_modify_their_targets(self):
        for child in ('node-v22.23.3-linux-x64', 'npm', 'npm/bin'):
            with self.subTest(child=child), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                outside = root / 'outside'
                outside.mkdir()
                (outside / 'untouched').write_text('user data')
                link = root / 'agent-runtimes' / child
                link.parent.mkdir(parents=True)
                link.symlink_to(outside, target_is_directory=True)
                error, calls, setup = self.run_stage(root)
                self.assertIsNotNone(error)
                self.assertTrue(link.is_symlink())
                self.assertEqual([p.name for p in outside.iterdir()], ['untouched'])
                self.assertEqual(calls, [])
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
