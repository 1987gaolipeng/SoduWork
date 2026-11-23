"""DSH native packages must match the Node which imports the standalone host."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from app.services import acp_agents as A, agent_npm_runtime as N, dsh_runtime as D


class DshNodeIdentityTests(unittest.TestCase):
    def test_native_packages_follow_selected_node_not_python_host(self):
        for system, host_arch, node_arch, host_libc, node_libc in (
            ('darwin', 'arm64', 'x64', '', ''),
            ('darwin', 'x86_64', 'arm64', '', ''),
            ('linux', 'x86_64', 'x64', 'glibc', 'musl'),
            ('linux', 'aarch64', 'arm64', 'musl', 'glibc'),
            ('win32', 'ARM64', 'x64', '', ''),
        ):
            with self.subTest(system=system, arch=node_arch, libc=node_libc), \
                    patch.object(D.sys, 'platform', system), \
                    patch.object(D.platform, 'machine', return_value=host_arch), \
                    patch.object(D, '_linux_libc', return_value=host_libc), \
                    patch.object(A, 'find_bin', return_value='/adapter'), \
                    patch.object(A, 'executable_command', return_value=['/selected/node', '/entry.js']), \
                    patch.object(N, '_probe', return_value=json.dumps({
                        'node': '24.2.0', 'platform': system, 'arch': node_arch, 'libc': node_libc})):
                self.assertEqual(D._native_target(), (system, node_arch, node_libc))
                sharp_system = 'linuxmusl' if node_libc == 'musl' else system
                self.assertIn(f'@img/sharp-{sharp_system}-{node_arch}', D._required_native_packages())

    def test_identified_node_never_falls_back_when_identity_is_unknown(self):
        for identity in ({}, {'node': '24.2.0', 'platform': 'linux', 'arch': 'x64', 'libc': ''},
                         {'node': '24.2.0', 'platform': 'darwin', 'arch': 'arm64'},
                         {'node': '24.2.0', 'platform': 'linux', 'arch': 'x64', 'libc': 'glibc', 'electron': True}):
            with self.subTest(identity=identity), patch.object(D.sys, 'platform', 'linux'), \
                    patch.object(D.platform, 'machine', return_value='x86_64'), \
                    patch.object(D, '_linux_libc', return_value='glibc'), \
                    patch.object(A, 'find_bin', return_value='/adapter'), \
                    patch.object(A, 'executable_command', return_value=['/selected/node', '/entry.js']), \
                    patch.object(N, '_probe', return_value=json.dumps(identity)):
                with self.assertRaises(RuntimeError):
                    D._native_target()

    def test_boot_probe_prepends_the_exact_node_it_launches(self):
        with tempfile.TemporaryDirectory() as root:
            selected_node = str(Path(root) / 'selected' / 'node.exe')
            with patch.dict(os.environ, {'PATH': 'old-runtime'}), \
                    patch.object(D, '_host_env'), \
                    patch.object(A, 'executable_command', return_value=[selected_node, '/entry.js']) as command, \
                    patch.object(D.subprocess, 'Popen', side_effect=OSError('fixture')) as spawn:
                D._probe_runtime('/adapter', root, str(Path(root) / 'probe'), 1)
            self.assertEqual(command.call_count, 1)
            self.assertEqual(spawn.call_args.args[0], [selected_node, '/entry.js'])
            self.assertEqual(spawn.call_args.kwargs['env']['PATH'].split(os.pathsep)[0],
                             str(Path(selected_node).parent))

    def test_explicit_adapter_identity_and_validation_remain_bound(self):
        identity = {'node': '24.2.0', 'platform': 'linux', 'arch': 'arm64', 'libc': 'musl'}
        with patch.object(D.sys, 'platform', 'linux'), \
                patch.object(A, 'find_bin', side_effect=AssertionError('must not reselect adapter')), \
                patch.object(A, 'executable_command', return_value=['/selected/node', '/entry.js']) as command, \
                patch.object(N, '_probe', return_value=json.dumps(identity)) as probe, \
                patch.object(D, '_installed_version_at', return_value='fixture'), \
                patch.object(D, '_native_specs', return_value=[{'name': 'fixture-native', 'version': '1'}]) as specs, \
                patch.object(D, '_has_exact_package', return_value=False) as has_package:
            issue = D.runtime_issue('/data', 'fixture', executable='/explicit/adapter')
        command.assert_called_once_with('dsh', '/explicit/adapter')
        self.assertEqual(probe.call_args.args[0][0], '/selected/node')
        target = ('linux', 'arm64', 'musl')
        self.assertEqual(specs.call_args.kwargs['target'], target)
        self.assertEqual(has_package.call_args.kwargs['target'], target)
        self.assertIn('fixture-native@1', issue)
        with patch.object(D, '_native_target', side_effect=AssertionError('must use supplied identity')):
            paths = D._native_files('/root', '@koromix/koffi-linux-arm64', '1', native_target=target)
        self.assertTrue(any(path.replace('\\', '/').endswith('/musl_arm64/koffi.node') for path in paths))

    def test_native_custom_wrapper_retains_host_target_and_launch(self):
        with patch.object(D.sys, 'platform', 'darwin'), \
                patch.object(D.platform, 'machine', return_value='arm64'), \
                patch.object(A, 'executable_command', return_value=['/custom/native']), \
                patch.object(N, '_probe', side_effect=AssertionError('must not run custom wrapper as Node')):
            self.assertEqual(D._native_target('/custom/native'), ('darwin', 'arm64', ''))
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'PATH': 'existing-path'}), \
                patch.object(D, '_host_env'), \
                patch.object(A, 'executable_command', return_value=['/custom/native']), \
                patch.object(D.subprocess, 'Popen', side_effect=OSError('fixture')) as spawn:
            D._probe_runtime('/custom/native', root, str(Path(root) / 'probe'), 1)
            self.assertEqual(spawn.call_args.args[0], ['/custom/native'])
            self.assertEqual(spawn.call_args.kwargs['env']['PATH'], 'existing-path')


if __name__ == '__main__':
    unittest.main()
