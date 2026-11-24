"""Installation selection must retain the executable's own package identity."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from app.services import acp_agents, agent_installation, agent_npm_runtime as N, agent_setup as A, local_base as L


class InstallationDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_signed_desktop_codex_precedes_unowned_global_install_on_macos(self):
        with patch.object(N, 'runtime_target', return_value=('darwin', 'arm64')), \
                patch.object(L, '_WIN', False), patch.object(N, 'private_bin', return_value=''), \
                patch.object(agent_installation, 'macos_codex_cli', return_value='/desktop/codex'):
            self.assertEqual(L._codex_bin(), '/desktop/codex')
            with patch.object(A, '_cached_version_probe', return_value='codex-cli desktop') as version:
                self.assertEqual(A._version_of('codex'), ('codex-cli desktop', 'cli', ''))
                self.assertEqual(version.call_args.args[0], '/desktop/codex')
            with patch.object(N, 'private_bin', return_value='/managed/codex'):
                self.assertEqual(L._codex_bin(), '/managed/codex')

    def test_desktop_codex_checks_signature_again_after_replacement(self):
        candidate = self.root / 'codex'
        candidate.write_bytes(b'original')
        candidate.chmod(0o755)
        with patch.object(agent_installation.sys, 'platform', 'darwin'), \
                patch.object(agent_installation, '_MACOS_CODEX_CLI', (str(candidate),)), \
                patch.object(agent_installation.subprocess, 'run', side_effect=[
                    subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 1)]) as verify:
            self.assertEqual(agent_installation.macos_codex_cli(), str(candidate))
            self.assertEqual(agent_installation.macos_codex_cli(), str(candidate))
            candidate.write_bytes(b'replacement')
            self.assertEqual(agent_installation.macos_codex_cli(), '')
            self.assertEqual(verify.call_count, 2)
            self.assertEqual(verify.call_args.args[0][0], '/usr/bin/codesign')
            self.assertIn('anchor apple generic', verify.call_args.args[0][3])

    def package(self, root, version):
        directory = root / '@openma/deepseek-harness-acp'
        directory.mkdir(parents=True)
        entry = directory / 'cli.js'
        entry.write_text('// fixture', encoding='utf8')
        (directory / 'package.json').write_text(json.dumps({
            'name': '@openma/deepseek-harness-acp', 'version': version,
            'bin': {'dsh-acp': 'cli.js'}, 'engines': {'node': '>=22.15.0'}}), encoding='utf8')
        return entry

    def npm_shim(self, binary, entry, kind='cmd'):
        fixtures = json.loads((Path(__file__).parent / 'tests/fixtures/npm-node-shims.json').read_text())
        relative = os.path.relpath(entry, binary.parent).replace('\\', '/')
        text = fixtures[kind].replace('node_modules/@fixture/agent/cli.js', relative)
        text = text.replace('node_modules\\@fixture\\agent\\cli.js', relative.replace('/', '\\'))
        binary.write_text(text, encoding='utf8')

    @unittest.skipUnless(os.name == 'nt', 'Windows PATH quote semantics')
    def test_windows_quoted_path_with_spaces_discovers_native_agents(self):
        directory = self.root / 'tools with spaces'
        directory.mkdir()
        codex = directory / 'codex.exe'
        dsh = directory / 'dsh-acp.exe'
        for binary in (codex, dsh):
            binary.write_bytes(b'native fixture')
        later = self.root / 'later tools'
        later.mkdir()
        (later / 'codex.exe').write_bytes(b'other native fixture')
        (later / 'dsh-acp.exe').write_bytes(b'other native fixture')
        for value in (str(directory), '"' + str(directory) + '"'):
            with self.subTest(path=value), \
                    patch.dict(os.environ, {'PATH': os.pathsep.join((str(self.root / 'absent'), value, str(later))),
                                            'PATHEXT': '.EXE;.CMD'}, clear=True), \
                    patch.object(L, '_npm_roots', return_value=[]), \
                    patch.object(L, '_npm_root', return_value=''), \
                    patch.object(N, 'private_root', return_value=''), \
                    patch.object(N, 'private_bin', return_value=''), \
                    patch.object(N, 'runtime_target', return_value=('win32', 'x64')):
                self.assertEqual(L._codex_bin(), str(codex))
                self.assertEqual(os.path.normcase(acp_agents.find_bin('dsh') or ''), os.path.normcase(str(dsh)))

    @unittest.skipUnless(os.name == 'nt', 'Windows PATH separator semantics')
    def test_forward_slash_windowsapps_path_still_excludes_internal_codex(self):
        blocked = self.root / 'WindowsApps/OpenAI.Codex_fixture'
        blocked.mkdir(parents=True)
        (blocked / 'codex.exe').write_bytes(b'fixture')
        valid = self.root / 'valid native'
        valid.mkdir()
        (valid / 'codex.exe').write_bytes(b'fixture')
        with patch.dict(os.environ, {'PATH': os.pathsep.join((blocked.as_posix(), str(valid)))}), \
                patch.object(L, '_npm_roots', return_value=[]), \
                patch.object(L, '_npm_root', return_value=''), \
                patch.object(N, 'private_root', return_value=''), \
                patch.object(N, 'runtime_target', return_value=('win32', 'x64')):
            self.assertEqual(L._codex_bin(), str(valid / 'codex.exe'))

    def test_selected_external_package_is_not_shadowed_by_private_metadata(self):
        private = self.root / 'private/node_modules'
        self.package(private, '0.4.40')
        external = self.package(self.root / 'external/node_modules', '0.4.41')
        with patch.object(N, 'private_root', return_value=str(private)), \
                patch.object(A, '_npm_root', return_value=''), \
                patch.object(A, '_bin_of', return_value=str(external)):
            self.assertEqual(A._pkg_version('@openma/deepseek-harness-acp'), '0.4.41')

    def test_detection_checks_selected_packages_node_engine(self):
        private = self.root / 'private/node_modules'
        self.package(private, '0.4.40')
        external = self.package(self.root / 'external/node_modules', '0.4.41')
        manifest = external.parent / 'package.json'
        info = json.loads(manifest.read_text())
        info['engines']['node'] = '>=24.0.0'
        manifest.write_text(json.dumps(info))
        with patch.object(N, 'private_root', return_value=str(private)), \
                patch.object(A, '_bin_of', return_value=str(external)), \
                patch.object(A, '_runtime_issue', return_value=''), \
                patch.object(A, 'node_env', return_value={'why': 'fixture node incompatible'}) as node:
            result = A.detect('dsh', probes={})
        self.assertEqual(node.call_args.kwargs['engine'], '>=24.0.0')
        self.assertFalse(result['installed'])

    def test_cli_only_does_not_borrow_unrelated_metadata(self):
        root = self.root / 'private/node_modules'
        self.package(root, '0.4.40')
        binary = self.root / 'unrelated/dsh-acp'
        binary.parent.mkdir()
        binary.write_text('fixture')
        with patch.object(N, 'private_root', return_value=str(root)), \
                patch.object(A, '_npm_root', return_value=''), \
                patch.object(A, '_bin_of', return_value=str(binary)):
            self.assertEqual(A._pkg_version('@openma/deepseek-harness-acp'), '')

    def test_posix_configured_npm_root_is_considered(self):
        root = self.root / 'custom/lib/node_modules'
        root.mkdir(parents=True)
        with patch.object(L, '_WIN', False), patch.object(N.sys, 'platform', 'linux'), patch.dict(os.environ, {}, clear=True), \
                patch.object(N, 'configured_global_root', return_value=str(root)):
            self.assertEqual(L._npm_root(), str(root))

    def test_nvm_versions_are_real_package_roots(self):
        root = self.root / '.nvm/versions/node/v22.23.0/lib/node_modules'
        root.mkdir(parents=True)
        with patch.object(L, '_WIN', False), patch.object(N.sys, 'platform', 'linux'), patch.dict(os.environ, {}, clear=True), \
                patch.object(N, 'configured_global_root', return_value=''), \
                patch.object(os.path, 'expanduser', return_value=str(self.root)), \
                patch.object(L.shutil, 'which', return_value=None):
            self.assertIn(str(root), L._npm_roots())

    def test_acp_finds_external_prefix_when_private_tree_has_only_metadata(self):
        entry = self.package(self.root / 'external/lib/node_modules', '0.4.41')
        binary = self.root / 'external/bin/dsh-acp'
        binary.parent.mkdir(parents=True)
        binary.write_text('#!/bin/sh\nexec node "$basedir/../lib/node_modules/@openma/deepseek-harness-acp/cli.js"')
        binary.chmod(0o700)
        with patch.object(N.sys, 'platform', 'linux'), \
                patch.object(N, 'private_bin', return_value=''), \
                patch.object(acp_agents.shutil, 'which', return_value=None), \
                patch.object(L, '_npm_roots', return_value=[str(self.root / 'empty'), str(entry.parents[2])]):
            self.assertEqual(acp_agents.find_bin('dsh'), str(binary))

    def test_runtime_metadata_follows_selected_adapter(self):
        from app.services import dsh_runtime
        entry = self.package(self.root / 'external/node_modules', '0.4.41')
        manifest = entry.parent / 'package.json'
        info = json.loads(manifest.read_text())
        info['dshAcp'] = {'standaloneDsh': '1.3.4'}
        manifest.write_text(json.dumps(info))
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(dsh_runtime.adapter_expected_version(str(entry)), '1.3.4')

    def test_pi_searches_beyond_unrelated_first_root(self):
        root = self.root / 'external/lib/node_modules'
        directory = root / '@earendil-works/pi-coding-agent'
        directory.mkdir(parents=True)
        entry = directory / 'cli.js'
        entry.write_text('// fixture')
        (directory / 'package.json').write_text(json.dumps({'bin': {'pi': 'cli.js'}}))
        with patch.object(L, '_bundled_pi_cli_js', return_value=None), \
                patch.object(N, 'private_root', return_value=''), \
                patch.object(L, '_npm_root', return_value=str(self.root / 'empty')), \
                patch.object(L, '_npm_roots', return_value=[str(self.root / 'empty'), str(root)]):
            self.assertEqual(L._pi_cli_js(), str(entry))

    def test_gui_pi_detection_and_launch_use_validated_node_outside_path(self):
        root = self.root / 'homebrew/lib/node_modules'
        package = root / '@earendil-works/pi-coding-agent'
        package.mkdir(parents=True)
        entry = package / 'cli.js'
        entry.write_text('// fixture')
        (package / 'package.json').write_text(json.dumps({
            'name': '@earendil-works/pi-coding-agent', 'version': '1.0.0',
            'bin': {'pi': 'cli.js'}, 'engines': {'node': '>=24.0.0'}}))
        node = str(self.root / 'homebrew/bin/node')
        pair = {'nodePath': node, 'node': 'v24.2.0', 'npm': '11.0.0',
                'platform': 'darwin', 'arch': 'arm64'}
        with patch.object(N.sys, 'platform', 'darwin'), \
                patch.dict(os.environ, {'PATH': ''}, clear=True), \
                patch.object(L, '_bundled_pi_cli_js', return_value=None), \
                patch.object(L, '_bundled_pi_node', return_value=None), \
                patch.object(N, 'private_root', return_value=''), \
                patch.object(L, '_npm_root', return_value=str(root)), \
                patch.object(L, '_npm_roots', return_value=[str(root)]), \
                patch.object(N, 'resolve', return_value=pair), \
                patch.object(A, '_short', return_value='1.0.0') as probe:
            detected = A.detect('pi', probes={})
            self.assertTrue(detected['installed'])
            self.assertEqual(detected['bin'], node)
            self.assertEqual(detected['entry'], str(entry))
            prof = L._PROFILES['pi']
            cfg = {'llm': {'model': 'fixture-model'}}
            argv = L._command_argv(prof['bin'](), prof['start']('fixture', 'work', str(self.root), cfg),
                                   str(self.root), cfg, prof)
            self.assertEqual(argv[:2], [node, str(entry)])
            self.assertEqual(probe.call_args.args[:2], (node, [str(entry), '--version']))
            # Discovery and dispatch must both reject a native pair older than
            # this selected package's engine, even if another Node is on PATH.
            pair['node'] = 'v22.23.0'
            self.assertIsNone(prof['bin']())

    def test_package_engine_selects_later_compatible_node_pair(self):
        nodes = []
        for name in ('old', 'new'):
            directory = self.root / name
            directory.mkdir()
            node = directory / ('node.exe' if os.name == 'nt' else 'node')
            node.write_bytes(b'native fixture')
            npm = directory / 'node_modules/npm/bin/npm-cli.js'
            npm.parent.mkdir(parents=True)
            npm.write_text('// fixture')
            nodes.append(node)
        def probe(argv, _stamp):
            return ('11.0.0' if argv[-1] == '--version' else
                    json.dumps({'node': '22.23.0' if argv[0] == str(nodes[0]) else '24.2.0'}))
        with patch.dict(os.environ, {'PATH': os.pathsep.join(str(p.parent) for p in nodes)}), \
                patch.object(N, '_probe', side_effect=probe):
            selected = N.node_env('pi', engine='>=24.0.0')
            self.assertTrue(selected['ok'])
            self.assertEqual(selected['nodePath'], str(nodes[1]))
        def older_probe(argv, _stamp):
            return ('11.0.0' if argv[-1] == '--version' else
                    json.dumps({'node': '20.20.0' if argv[0] == str(nodes[0]) else '22.17.0'}))
        with patch.dict(os.environ, {'PATH': os.pathsep.join(str(p.parent) for p in nodes)}), \
                patch.object(N, '_probe', side_effect=older_probe):
            selected = N.node_env('qwen', engine='>=22.15.0')
            self.assertTrue(selected['ok'])
            self.assertEqual(selected['nodePath'], str(nodes[1]))

    def test_acp_probe_and_launch_bypass_adjacent_obsolete_node_in_npm_shim(self):
        root = self.root / 'external/node_modules'
        entry = self.package(root, '0.4.41')
        binary = root.parent / 'dsh-acp.cmd'
        self.npm_shim(binary, entry)
        (root.parent / 'node.exe').write_bytes(b'obsolete node fixture')
        node = str(self.root / 'new/node.exe')
        pair = {'nodePath': node, 'node': 'v24.2.0', 'npm': '11.0.0'}
        with patch.object(N, 'resolve', return_value=pair), \
                patch.object(A, '_bin_of', return_value=str(binary)), \
                patch.object(A, '_short', return_value='0.4.41') as probe:
            A._selected_cli_version('dsh', cached=False)
            self.assertEqual(probe.call_args.args, (node, [str(entry), '--version']))
            argv = acp_agents.command_argv('dsh', str(binary), [], str(self.root))
            self.assertEqual(argv[argv.index('--') + 1:][:2], [node, str(entry)])
            from app.services import dsh_runtime
            with patch.object(dsh_runtime, '_host_env'), \
                    patch.object(dsh_runtime.subprocess, 'Popen', side_effect=OSError('fixture')) as boot:
                dsh_runtime._probe_runtime(str(binary), str(self.root), str(self.root / 'probe'), 1)
                self.assertEqual(boot.call_args.args[0], [node, str(entry)])

    def test_kimi_probe_and_launch_use_selected_external_entry_and_engine(self):
        package_name = acp_agents.CATALOG['kimi']['pkg']
        package = (self.root / 'external/node_modules').joinpath(*package_name.split('/'))
        package.mkdir(parents=True)
        entry = package / 'cli.mjs'
        entry.write_text('// fixture')
        (package / 'package.json').write_text(json.dumps({
            'name': package_name, 'version': A._SPECS['kimi']['version'],
            'bin': {'kimi': 'cli.mjs'}, 'engines': {'node': '>=24.0.0'}}))
        with patch.object(A, '_bin_of', return_value=str(entry)), \
                patch.object(N, 'node_env', return_value={'ok': True, 'nodePath': '/new/node'}) as node, \
                patch.object(N, 'package_entry', side_effect=AssertionError('unrelated private entry')), \
                patch.object(A, '_short', return_value=A._SPECS['kimi']['version']) as probe:
            A._selected_cli_version('kimi', cached=False)
            self.assertEqual(probe.call_args.args, ('/new/node', [str(entry), '--version']))
            argv = acp_agents.command_argv('kimi', str(entry), [], str(self.root))
            self.assertEqual(argv[argv.index('--') + 1:][:2], ['/new/node', str(entry)])
            self.assertEqual(node.call_args.kwargs['engine'], '>=24.0.0')

    def test_codex_harness_selected_entry_does_not_switch_to_private_install(self):
        package_name = acp_agents.CATALOG['codex-harness']['pkg']
        package = (self.root / 'external/node_modules').joinpath(*package_name.split('/'))
        package.mkdir(parents=True)
        entry = package / 'cli.mjs'
        entry.write_text('// fixture')
        (package / 'package.json').write_text(json.dumps({
            'name': package_name, 'bin': {'codex-acp': 'cli.mjs'}}))
        with patch.object(N, 'node_env', return_value={'ok': True, 'nodePath': '/validated/node'}), \
                patch.object(N, 'package_entry', side_effect=AssertionError('unrelated private entry')):
            argv = acp_agents.command_argv('codex-harness', str(entry), [], str(self.root))
            self.assertEqual(argv[argv.index('--') + 1:][:2], ['/validated/node', str(entry)])
            argv = acp_agents.command_argv('codex-harness', '/explicit/native-adapter', [], str(self.root))
            self.assertEqual(argv[argv.index('--') + 1:][:1], ['/explicit/native-adapter'])

    def test_dsh_boot_cache_tracks_actual_node_and_entry(self):
        from app.services import dsh_runtime
        entry = self.package(self.root / 'external/node_modules', '0.4.41')
        with patch.object(N, 'node_env', return_value={'ok': True, 'nodePath': '/first/node'}) as node:
            first = dsh_runtime._fingerprint(str(entry), str(self.root), 'fixture')
            node.return_value['nodePath'] = '/second/node'
            second = dsh_runtime._fingerprint(str(entry), str(self.root), 'fixture')
            self.assertNotEqual(first, second)
            entry.write_text('// changed entry size and contents')
            self.assertNotEqual(second, dsh_runtime._fingerprint(str(entry), str(self.root), 'fixture'))

    def test_real_node_starts_selected_entry_despite_broken_adjacent_node(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('requires a native Node executable')
        identity = json.loads(subprocess.check_output(
            [node, '-p', 'JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch})'],
            env=N.clean_env(), text=True, timeout=5))
        if N.version_tuple(identity['node']) < N.NODE_MINIMUMS['dsh']:
            self.skipTest('requires Node compatible with the reviewed DSH host')
        entry = self.package(self.root / 'external/node_modules', '0.4.41')
        entry.write_text('console.log(JSON.stringify({execPath:process.execPath,args:process.argv.slice(2)}));')
        binary = entry.parents[3] / 'dsh-acp.cmd'
        self.npm_shim(binary, entry)
        (binary.parent / 'node.exe').write_bytes(b'intentionally invalid adjacent Node')
        pair = {**identity, 'nodePath': node, 'npm': 'fixture native pair'}
        with patch.object(N, 'resolve', return_value=pair):
            command = acp_agents.executable_command('dsh', str(binary))
            result = subprocess.run([*command, 'argument with spaces'], env=N.clean_env(),
                                    capture_output=True, text=True, timeout=5, check=True)
        output = json.loads(result.stdout)
        self.assertEqual(os.path.normcase(os.path.realpath(output['execPath'])),
                         os.path.normcase(os.path.realpath(node)))
        self.assertEqual(output['args'], ['argument with spaces'])

    def test_selected_node_is_in_child_environment_without_mutating_parent_path(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('requires a native Node executable')
        version = subprocess.check_output([node, '-p', 'process.versions.node'], text=True, timeout=5).strip()
        if N.version_tuple(version) < (22, 15, 0):
            self.skipTest('requires a compatible native Node')
        entry = self.package(self.root / 'external/node_modules', '0.4.41')
        entry.write_text("const c=require('node:child_process').spawnSync('node',['-p','process.execPath'],{encoding:'utf8'});"
                         "const canonical=p=>{const r=require('node:fs').realpathSync(p);"
                         "return process.platform==='win32'?r.toLowerCase():r;};"
                         "console.log(JSON.stringify({status:c.status,sameNode:c.status===0&&"
                         "canonical(c.stdout.trim())===canonical(process.execPath)}));")
        profile = {'acp_key': 'path-fixture', 'bin': lambda: str(entry), 'needs_llm': False}
        with patch.dict(acp_agents.CATALOG, {'path-fixture': {'pkg': '@openma/deepseek-harness-acp'}}), \
                patch.dict(os.environ, {'PATH': ''}), \
                patch.object(N, 'resolve', return_value={'nodePath': node, 'node': version, 'npm': 'fixture'}):
            env = L._env_for(profile, {}, runtime_root=str(self.root))
            command = acp_agents.executable_command('path-fixture', str(entry))
            L.bind_command_environment(env, command)
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=5, check=True)
            self.assertEqual(os.environ['PATH'], '')
            from app.services.agent_setup_runtime import _short
            probe_output = json.loads(_short(node, [str(entry)], timeout=5))
            self.assertEqual(probe_output['status'], 0, probe_output)
            self.assertTrue(probe_output['sameNode'], probe_output)
        output = json.loads(result.stdout)
        self.assertEqual(output['status'], 0, output)
        self.assertTrue(output['sameNode'], output)

    def test_windows_external_discovery_ignores_extensionless_shell_shim(self):
        entry = self.package(self.root / 'external/node_modules', '0.4.41')
        binary = self.root / 'external/dsh-acp.cmd'
        binary.write_text('@ECHO off\nnode "%dp0%\\node_modules\\@openma\\deepseek-harness-acp\\cli.js" %*')
        (binary.parent / 'dsh-acp').write_text('#!/bin/sh')
        with patch.object(N.sys, 'platform', 'win32'), \
                patch.object(N, 'private_bin', return_value=''), \
                patch.object(acp_agents.shutil, 'which', return_value=None), \
                patch.object(L, '_npm_roots', return_value=[str(entry.parents[2])]):
            self.assertEqual(acp_agents.find_bin('dsh'), str(binary))

    def test_invalid_explicit_override_never_falls_back(self):
        with patch.dict(os.environ, {'SODUWORK_AGENT_DSH_BIN': str(self.root / 'absent')}), \
                patch.object(N, 'private_bin', return_value='/private/dsh-acp') as private:
            self.assertIsNone(acp_agents.find_bin('dsh'))
            private.assert_not_called()

    def test_gui_macos_has_homebrew_and_nvm_candidates(self):
        from app.services import agent_installation as I
        root = self.root / '.nvm/versions/node/v24.2.0/bin'
        root.mkdir(parents=True)
        with patch.object(N.sys, 'platform', 'darwin'), \
                patch.dict(os.environ, {}, clear=True), \
                patch.object(os.path, 'expanduser', return_value=str(self.root)):
            self.assertIn(str(root), I.known_bin_dirs())
            self.assertIn(str(Path('/opt/homebrew/bin')), I.known_bin_dirs())

    def test_unrelated_same_prefix_shim_cannot_borrow_package_identity(self):
        from app.services.agent_installation import selected_manifest
        self.package(self.root / 'external/node_modules', '0.4.41')
        binary = self.root / 'external/dsh-acp.cmd'
        binary.write_text('@ECHO off\nnode "%dp0%\\unrelated.js" %*')
        self.assertEqual(selected_manifest('@openma/deepseek-harness-acp', str(binary)), '')

    def test_custom_npm_wrappers_keep_environment_flags_and_hooks(self):
        root = self.root / 'external/node_modules'
        self.package(root, '0.4.41')
        binary = root.parent / 'dsh-acp.cmd'
        reference = '"%dp0%/node_modules/@openma/deepseek-harness-acp/cli.js"'
        for content in (
                '@ECHO off\nSET CUSTOM_BOOT=enabled\nnode --require "%dp0%/custom-bootstrap.cjs" ' + reference + ' %*',
                '@ECHO off\nnode ' + reference + ' --custom-flag %*',
                '@ECHO off\nnode ' + reference + ' %*\ncall cleanup.cmd'):
            binary.write_text(content)
            with self.subTest(content=content), patch.object(N, 'node_env', side_effect=AssertionError('custom wrapper must run intact')):
                self.assertEqual(acp_agents.executable_command('dsh', str(binary)), [str(binary)])
        shell = root.parent / 'dsh-acp'
        shell.write_text('#!/bin/sh\nexport CUSTOM_BOOT=enabled\n'
                         'exec node --require "$basedir/custom-bootstrap.cjs" '
                         '"$basedir/node_modules/@openma/deepseek-harness-acp/cli.js" "$@"')
        with patch.object(N, 'node_env', side_effect=AssertionError('custom shell wrapper must run intact')):
            self.assertEqual(acp_agents.executable_command('dsh', str(shell)), [str(shell)])

    def test_generated_npm_shims_rewrite_but_added_custom_commands_do_not(self):
        entry = self.package(self.root / 'external/node_modules', '0.4.41')
        for kind, suffix in (('cmd', '.cmd'), ('sh', ''), ('ps1', '.ps1')):
            binary = entry.parents[3] / ('dsh-acp' + suffix)
            self.npm_shim(binary, entry, kind)
            with self.subTest(kind=kind), patch.object(N, 'node_env', return_value={'ok': True, 'nodePath': '/validated/node'}):
                self.assertEqual(acp_agents.executable_command('dsh', str(binary)), ['/validated/node', str(entry)])
            binary.write_text(binary.read_text() + '\necho custom-post-hook\n')
            with self.subTest(kind=kind, custom=True), patch.object(N, 'node_env', side_effect=AssertionError('customized template must stay intact')):
                self.assertEqual(acp_agents.executable_command('dsh', str(binary)), [str(binary)])

    def test_npm_shims_under_directory_alias_keep_selected_package_identity(self):
        from app.services.agent_installation import selected_manifest, selected_node_entry
        prefix = self.root / 'real-prefix'
        entry = self.package(prefix / 'node_modules', '0.4.41')
        alias = self.root / 'aliased-prefix'
        if os.name == 'nt':
            import _winapi
            _winapi.CreateJunction(str(prefix), str(alias))
            self.addCleanup(alias.rmdir)
        else:
            alias.symlink_to(prefix, target_is_directory=True)
            self.addCleanup(alias.unlink)
        aliased_entry = alias / entry.relative_to(prefix)
        self.assertNotEqual(str(aliased_entry.absolute()), str(aliased_entry.resolve()))
        for kind, suffix in (('cmd', '.cmd'), ('sh', ''), ('ps1', '.ps1')):
            binary = alias / ('dsh-acp' + suffix)
            self.npm_shim(binary, aliased_entry, kind)
            with self.subTest(kind=kind):
                manifest = selected_manifest('@openma/deepseek-harness-acp', str(binary))
                self.assertTrue(manifest)
                self.assertEqual(Path(manifest).resolve(), entry.with_name('package.json').resolve())
                self.assertEqual(selected_node_entry('@openma/deepseek-harness-acp', str(binary)),
                                 (str(entry.resolve()), '>=22.15.0'))
                binary.write_text(binary.read_text() + '\necho custom-post-hook\n')
                self.assertEqual(selected_node_entry('@openma/deepseek-harness-acp', str(binary)), ('', ''))

    def test_direct_js_preserves_shebang_flags_interpreters_and_bom(self):
        entry = self.package(self.root / 'external/node_modules', '0.4.41')
        for first in (b'#!/usr/bin/env -S node --conditions=fixture\n',
                      b'\xef\xbb\xbf#!/usr/bin/env -S node --conditions=fixture\r\n',
                      b'#!/usr/bin/env bun\n', b'#!/usr/bin/node --require fixture.cjs\n',
                      b'\xef\xbb\xbf#!/usr/bin/env node' + b' ' * 5000 + b'\r\n',
                      b'\xef\xbb\xbf#!/usr/bin/env node' + b' ' * 5000 + b'--conditions=fixture\r\n',
                      b'#!/usr/bin/env node ' + b'x' * 5000 + b'\n'):
            entry.write_bytes(first + b'console.log("fixture");')
            with self.subTest(first=first[:80]), patch.object(N, 'node_env', side_effect=AssertionError('entry flags must remain intact')):
                self.assertEqual(acp_agents.executable_command('dsh', str(entry)), [str(entry)])

    def test_direct_js_without_flags_uses_validated_node(self):
        entry = self.package(self.root / 'external/node_modules', '0.4.41')
        for first in (b'', b'#!/usr/bin/env node\n', b'#!/usr/bin/node\r\n',
                      b'\xef\xbb\xbf#!/usr/bin/env node\r\n'):
            entry.write_bytes(first + b'console.log("fixture");')
            with self.subTest(first=first), patch.object(N, 'node_env', return_value={'ok': True, 'nodePath': '/validated/node'}):
                self.assertEqual(acp_agents.executable_command('dsh', str(entry)), ['/validated/node', str(entry)])

    def test_posix_npm_symlink_preserves_target_shebang_flags(self):
        import io
        import posixpath
        from pathlib import PurePosixPath
        from types import SimpleNamespace
        from app.services import agent_installation as I
        binary = '/usr/local/bin/dsh-acp'
        package = '/usr/local/lib/node_modules/@openma/deepseek-harness-acp'
        target = package + '/cli.js'
        files = {package + '/package.json': json.dumps({
            'name': '@openma/deepseek-harness-acp', 'bin': {'dsh-acp': 'cli.js'}}).encode()}
        class VirtualPath(PurePosixPath):
            def resolve(self): return VirtualPath(target if str(self) == binary else str(self))
            def absolute(self): return self
            def is_file(self): return str(self.resolve()) in files
            def open(self, mode='r', encoding=None):
                try: content = files[str(self.resolve())]
                except KeyError: raise FileNotFoundError(str(self))
                return io.BytesIO(content) if 'b' in mode else io.StringIO(content.decode(encoding or 'utf8'))
            def read_text(self, encoding='utf8'):
                with self.open(encoding=encoding) as stream: return stream.read()
        paths = SimpleNamespace(abspath=posixpath.abspath, relpath=posixpath.relpath,
                                realpath=lambda path: target if str(path) == binary else str(path))
        with patch.object(I, 'Path', VirtualPath), patch.object(I, 'os', SimpleNamespace(path=paths)):
            files[target] = b'#!/usr/bin/env -S node --conditions=fixture\n'
            self.assertEqual(I.selected_node_entry('@openma/deepseek-harness-acp', binary), ('', ''))
            files[target] = b'#!/usr/bin/env node\n'
            self.assertEqual(I.selected_node_entry('@openma/deepseek-harness-acp', binary), (target, ''))

    def test_windows_codex_skips_excluded_first_path_candidate(self):
        blocked = r'C:\Program Files\WindowsApps\OpenAI.Codex_1\codex.exe'
        valid = str(self.root / 'tools/codex.exe')
        def which(name, path=None):
            return valid if path == 'valid' else (str(self.root / 'shim/codex.cmd') if path == 'shim' else blocked)
        with patch.object(L, '_WIN', True), patch.object(N, 'private_root', return_value=''), \
                patch.object(L, '_npm_root', return_value=''), patch.object(L, '_npm_roots', return_value=[]), \
                patch.object(N, 'runtime_target', return_value=('win32', 'x64')), \
                patch.object(L.shutil, 'which', side_effect=which), \
                patch.dict(os.environ, {'PATH': os.pathsep.join(('blocked', 'shim', 'valid'))}):
            self.assertEqual(L._codex_bin(), valid)


if __name__ == '__main__':
    unittest.main()
