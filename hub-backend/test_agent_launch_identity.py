"""Bind child Node lookup to the command selected for this launch."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from app.services import local_base as L, local_process as P, pty_term


class AgentLaunchIdentityTests(unittest.TestCase):
    def bind(self, env, argv):
        binder = getattr(L, 'bind_command_environment', None)
        self.assertTrue(callable(binder), 'Launch must bind PATH from final argv')
        binder(env, argv)
        return env

    def test_environment_does_not_rediscover_switched_installation(self):
        discover = Mock(return_value='new-install/adapter.cmd')
        prof = {'acp_key': 'synthetic', 'bin': discover}
        with patch.object(L._acp_agents, 'home_env'), patch.object(
                L._acp_agents, 'executable_command', return_value=['new/node', 'new/entry.js']):
            env = L._env_for(prof, {})
        discover.assert_not_called()
        old_node = str(Path('old-install/node.exe').absolute())
        self.bind(env, [sys.executable, L._acp_agents._bridge_path(),
                        '--agent-name', 'synthetic', '--', old_node, 'old/entry.js'])
        self.assertEqual(env['PATH'].split(os.pathsep)[0], str(Path(old_node).parent))

    def test_concurrent_commands_bind_only_their_own_child_environments(self):
        original = os.environ.get('PATH')
        def run(index):
            node = str(Path(f'isolated-{index}/node.exe').absolute())
            env = self.bind({'PATH': 'inherited'}, [node, 'entry.js'])
            return env['PATH'], str(Path(node).parent)
        with ThreadPoolExecutor(max_workers=4) as pool:
            for actual, expected in pool.map(run, range(12)):
                self.assertEqual(actual, expected + os.pathsep + 'inherited')
        self.assertEqual(os.environ.get('PATH'), original)

    def test_native_custom_wrapper_and_bundled_electron_are_unchanged(self):
        for argv in ([str(Path('wrapper.cmd').absolute()), '--agent-name', 'x', '--', '/other/node'],
                     [str(Path('electron.exe').absolute()), 'pi.js'], ['native-agent']):
            env = {'PATH': 'original', 'ELECTRON_RUN_AS_NODE': '1', 'CUSTOM_BOOT': 'yes'}
            self.bind(env, argv)
            self.assertEqual(env, {'PATH': 'original', 'ELECTRON_RUN_AS_NODE': '1', 'CUSTOM_BOOT': 'yes'})

    def test_frozen_bridge_binds_its_child_node(self):
        node = str(Path('selected/node.exe').absolute())
        env = self.bind({'PATH': ''}, [sys.executable, '--acp-bridge',
                         '--agent-name', 'synthetic', '--', node, 'entry.js'])
        self.assertEqual(env['PATH'], str(Path(node).parent))

    @unittest.skipUnless(shutil.which('node'), 'Node is required for the real child process regression')
    def test_real_worker_parent_and_child_use_the_selected_node_after_switch(self):
        node = str(Path(shutil.which('node')).resolve())
        before = os.environ.get('PATH')
        done = threading.Event()
        result, lines = [], []
        with tempfile.TemporaryDirectory(prefix='soduwork-launch-identity-') as root, ExitStack() as stack:
            script = Path(root, 'parent.cjs')
            script.write_text("const c=require('node:child_process').spawnSync('node', ['-p', 'process.execPath'], {encoding:'utf8'}); console.log(JSON.stringify({parent:process.execPath,child:c.stdout && c.stdout.trim(),error:c.error && c.error.code})); process.exit(c.status===0?0:1);", encoding='utf-8')
            ref = 'synthetic-node-launch-identity'
            P._RUNS[ref] = {'state': 'running', 'cli': 'synthetic', 'round': 1}
            self.addCleanup(P._RUNS.pop, ref, None)
            discover = Mock(return_value='switched-install/adapter.cmd')
            prof = {'acp_key': 'synthetic', 'bin': discover,
                    'command': lambda exe, args, ws, cfg: [exe, *args]}
            stack.enter_context(patch.dict(os.environ, {'PATH': ''}))
            stack.enter_context(patch.object(L._acp_agents, 'home_env'))
            stack.enter_context(patch.object(L._acp_agents, 'executable_command',
                return_value=[str(Path(root, 'wrong-node', 'node.exe')), 'wrong.js']))
            for name in ('_save_meta', '_append_raw', '_watchdog'):
                stack.enter_context(patch.object(P, name))
            stack.enter_context(patch.object(P, '_store_dir', return_value=root))
            def finish(ref, code, term, error):
                result.append((code, error))
                P._RUNS[ref]['state'] = 'done'
                done.set()
            P.spawn(node, [str(script)], '', root, ref, {}, prof,
                    gate_check=lambda *a: '', on_line=lambda ref, line, term, **kw: lines.append(line),
                    finish=finish, kill_tree=lambda *a, **kw: False)
            self.assertTrue(done.wait(15), 'Worker did not finish')
            threads = [t for t in P._THREADS if t.name == 'ai_local:' + ref[:8]]
            for thread in threads:
                thread.join(5)
            proc = P._RUNS[ref].get('proc')
            if proc:
                proc.wait(timeout=5)
            self.assertEqual(result, [(0, '')], ''.join(lines))
            receipt = next(json.loads(line) for line in lines if line.startswith('{'))
            self.assertEqual(os.path.normcase(receipt['parent']), os.path.normcase(node))
            self.assertEqual(receipt['child'], receipt['parent'])
            discover.assert_not_called()
        self.assertEqual(os.environ.get('PATH'), before)

    def test_terminal_binds_final_argv_without_mutating_supplied_environment(self):
        terminal = object.__new__(pty_term.Term)
        node = str(Path('terminal-node/node.exe').absolute())
        terminal.argv = [node, 'pi.js']
        terminal.id, terminal.ws, terminal.rows, terminal.cols = 'synthetic', '.', 24, 80
        supplied = {'PATH': 'original'}
        spawn = Mock(side_effect=RuntimeError('stop before starting terminal'))
        with patch.object(pty_term, '_WIN', True), patch.object(pty_term, '_win_cmd_file', return_value='fake.cmd'), patch.dict(
                sys.modules, {'winpty': Mock(PtyProcess=Mock(spawn=spawn))}):
            with self.assertRaisesRegex(RuntimeError, 'stop before'):
                terminal._start(supplied)
        self.assertEqual(spawn.call_args.kwargs['env']['PATH'], str(Path(node).parent) + os.pathsep + 'original')
        self.assertEqual(supplied, {'PATH': 'original'})

    def test_explicit_probe_binds_command_selected_before_installation_switch(self):
        from app.services import agent_setup as setup
        node = str(Path('probe-selected/node.exe').absolute())
        discover = Mock(return_value='changed/adapter.cmd')
        prof = {'bin': discover, 'command': lambda exe, args, ws, cfg: [exe, 'entry.js']}
        stream = Mock(side_effect=RuntimeError('stop before model request'))
        with ExitStack() as stack:
            stack.enter_context(patch.dict(setup._PROFILES, {'synthetic': prof}))
            stack.enter_context(patch.object(setup, '_bin_of', return_value=node))
            stack.enter_context(patch.object(setup, '_short', return_value='1.0.0'))
            stack.enter_context(patch.object(setup, '_probe_args', return_value=[]))
            stack.enter_context(patch.object(setup, '_stream', stream))
            for name in ('_say', '_save_probe', '_done'):
                stack.enter_context(patch.object(setup, name))
            setup._run_probe_once('synthetic', 'synthetic', {}, workspace='.')
        self.assertEqual(stream.call_args.args[1], [node, 'entry.js'])
        self.assertEqual(stream.call_args.kwargs['env']['PATH'].split(os.pathsep)[0],
                         str(Path(node).parent))
        discover.assert_not_called()


if __name__ == '__main__':
    unittest.main()
