"""Execution receipts cannot replace confirmation that the trusted host exited."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from app.services import access_transition, local_base, local_ctx, local_process, local_spool, local_stream


class ExecutionHostCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='soduwork-host-cleanup-')
        self.addCleanup(self.temp.cleanup)
        self.ref = 'isolated-execution-cleanup'
        self.spec = {'id': 'isolated', 'status': 'status'}
        self.owner = object()
        self.run = {'state': 'running', 'pid': 12345, 'stream': self.spec,
                    '_workerIdentity': self.owner, 'accessPolicy': {'mode': 'full'}}
        local_process._RUNS[self.ref] = self.run
        self.addCleanup(local_process._RUNS.pop, self.ref, None)
        self.stack = self.enterContext(ExitStack())
        self.stack.enter_context(patch.object(local_process, '_store_dir', return_value=self.temp.name))
        self.stack.enter_context(patch.object(local_process, '_save_meta'))
        self.kill = Mock(return_value=False)

    def join(self, proc=None):
        return local_process._join_execution_host(
            self.ref, self.spec, 0, self.kill, proc=proc,
            pid=self.run['pid'], owner=self.owner)

    def test_real_finished_agent_with_slow_host_shutdown_preserves_success(self):
        spec, launch = local_spool.prepare(self.temp.name,
            [sys.executable, '-c', "print('synthetic-answer-completed')"], self.temp.name)
        wrapper = Path(self.temp.name, 'slow_exit.py')
        release = Path(self.temp.name, 'release-host')
        wrapper.write_text(
            'import atexit, os, runpy, sys, time\n'
            'release = sys.argv[1]\n'
            'def await_release():\n'
            '    deadline = time.monotonic() + 45\n'
            '    while not os.path.exists(release):\n'
            '        if time.monotonic() >= deadline:\n'
            '            os._exit(91)\n'
            '        time.sleep(.01)\n'
            'atexit.register(await_release)\n'
            'sys.argv = sys.argv[2:]\n'
            'sys.path.insert(0, os.path.dirname(sys.argv[0]))\n'
            'runpy.run_path(sys.argv[0], run_name="__main__")\n', encoding='utf-8')
        proc = subprocess.Popen([sys.executable, str(wrapper), str(release), *launch[1:]],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def terminate():
            if proc.poll() is None:
                proc.kill()
        watchdog = threading.Timer(45, terminate)
        watchdog.daemon = True
        watchdog.start()
        worker = None
        result, errors = [], []
        done = threading.Event()
        def join():
            try:
                result.append(self.join(proc))
            except Exception as exc:
                errors.append(exc)
            finally:
                done.set()
        try:
            self.spec = spec
            self.run.update(pid=proc.pid, stream=spec, proc=proc)
            lines = []
            code, outcome = local_spool.follow(self.temp.name, spec,
                lambda stream, line, end: lines.append(line), proc=proc)
            self.assertEqual((code, outcome), (0, 'completed'))
            self.assertIn('synthetic-answer-completed', ''.join(lines))
            self.assertIsNone(proc.poll())
            worker = threading.Thread(target=join, daemon=True)
            worker.start()
            deadline = time.monotonic() + 10
            while not self.run.get('_hostCleanup') and not done.is_set() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertIn('_hostCleanup', self.run, 'The joiner never entered host cleanup')
            start = time.monotonic()
            self.assertFalse(done.wait(3.25), 'Host cleanup failed before the controlled release')
            self.assertGreater(time.monotonic() - start, 3,
                'The fixture must exceed the former three-second false-failure deadline')
            self.assertIsNone(proc.poll())
            self.kill.assert_not_called()
            release.touch()
            self.assertTrue(done.wait(10), 'The joiner did not observe the released host exit')
            self.assertEqual(errors, [])
            self.assertEqual(result, [(True, '')])
            self.assertEqual(proc.wait(timeout=1), 0)
            self.assertNotIn('_hostCleanup', self.run)
        finally:
            release.touch()
            watchdog.cancel()
            terminate()
            proc.wait(timeout=5)
            if worker is not None:
                worker.join(timeout=5)

    def test_fast_exit_preserves_the_native_result_without_killing(self):
        proc = Mock(pid=12345, poll=Mock(return_value=0))
        self.assertEqual(self.join(proc), (True, ''))
        self.kill.assert_not_called()

    def test_abnormal_wrapper_exit_is_not_masked_by_successful_agent_receipt(self):
        proc = Mock(pid=12345, poll=Mock(return_value=42))
        self.assertEqual(self.join(proc),
            (True, 'Permission-controlled execution host exited abnormally'))

    def test_unconfirmed_kill_keeps_the_host_active_and_blocks_resume(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        self.addCleanup(lambda: child.kill() if child.poll() is None else None)
        self.run.update(pid=child.pid, proc=child)
        result = []
        with patch.object(local_process, '_HOST_EXIT_GRACE_S', .05):
            worker = threading.Thread(target=lambda: result.append(self.join(child)), daemon=True)
            worker.start()
            deadline = time.monotonic() + 3
            while not self.kill.called and time.monotonic() < deadline:
                time.sleep(.01)
            self.kill.assert_called_once_with(self.ref, expected_pid=child.pid, expected_proc=child)
            self.assertTrue(worker.is_alive())
            self.assertEqual(result, [])
            self.assertEqual(self.run['state'], 'running')
            self.assertIs(self.run['proc'], child)
            self.assertEqual(self.run['pid'], child.pid)
            self.assertEqual(self.run['error'], local_process._HOST_EXIT_ERROR)
            self.assertFalse(local_ctx.prepare_resume(self.ref, 'must not launch', {})['ok'])
            self.assertFalse(access_transition.apply(self.ref, {}, 0)['ok'])
            child.terminate()
            child.wait(timeout=3)
            worker.join(timeout=3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result, [(True, local_process._HOST_EXIT_ERROR)])

    def test_a_successful_kill_request_still_requires_observed_exit(self):
        self.kill.return_value = True
        proc = Mock(pid=12345)
        polls = [None, None, None, 0]
        proc.poll.side_effect = lambda: polls.pop(0)
        with patch.object(local_process, '_HOST_EXIT_GRACE_S', 0):
            self.assertEqual(self.join(proc), (True, local_process._HOST_EXIT_ERROR))
        self.assertEqual(proc.poll.call_count, 4)

    def test_metadata_and_termination_exceptions_do_not_remove_the_exit_fence(self):
        self.kill.side_effect = OSError('synthetic termination failure')
        proc = Mock(pid=12345, poll=Mock(side_effect=[None, None, 0]))
        with patch.object(local_process, '_HOST_EXIT_GRACE_S', 0), \
                patch.object(local_process, '_save_meta', side_effect=OSError('synthetic disk failure')):
            self.assertEqual(self.join(proc), (True, local_process._HOST_EXIT_ERROR))
        self.assertEqual(proc.poll.call_count, 3)

    def test_permission_transition_after_join_observes_confirmed_exit_only(self):
        proc = Mock(pid=12345, poll=Mock(return_value=0))
        self.assertEqual(self.join(proc), (True, ''))
        self.run['_accessTransition'] = {'phase': 'ready'}
        self.assertTrue(access_transition.finish(self.ref, 0, ''))
        self.assertTrue(self.run['_accessTransition']['oldExited'])
        self.assertEqual(self.run['state'], 'access-changing')

    def test_cancelled_and_permission_transition_turns_do_not_get_cleanup_extension(self):
        for change in ({'stopping': True}, {'_accessTransition': {'phase': 'ready'}}):
            with self.subTest(change=change):
                self.run.update(change)
                proc = Mock(pid=12345)
                proc.poll.side_effect = lambda: 0 if self.kill.called else None
                self.kill.reset_mock()
                with patch.object(local_spool, 'status_code', return_value=0), \
                        patch.object(local_process, '_HOST_EXIT_GRACE_S', 0):
                    self.assertEqual(self.join(proc), (True, local_process._HOST_EXIT_ERROR))
                self.kill.assert_called_once()
                for key in change:
                    self.run.pop(key)

    def test_old_worker_never_kills_or_settles_a_replacement(self):
        replacement = {**self.run, 'pid': 54321, '_workerIdentity': object()}
        proc = Mock(pid=12345)
        def poll():
            local_process._RUNS[self.ref] = replacement
            return 0
        proc.poll.side_effect = poll
        with patch.object(local_process, '_HOST_EXIT_GRACE_S', 0):
            self.assertEqual(self.join(proc), (False, ''))
        self.kill.assert_not_called()
        self.assertEqual(replacement['state'], 'running')
        self.assertNotIn('_hostCleanup', replacement)

    def test_recovery_requires_a_conclusive_pid_exit_on_every_platform(self):
        for platform in ('win32', 'darwin', 'linux'):
            with self.subTest(platform=platform), \
                    patch.object(local_process.sys, 'platform', platform), \
                    patch('app.services.local_stream._pid_alive', side_effect=[True, False]) as alive:
                self.assertEqual(self.join(), (True, ''))
                self.assertEqual(alive.call_count, 2)
                self.kill.assert_not_called()

    def test_windows_pid_probe_does_not_create_a_console(self):
        from app.services import local_stream
        result = subprocess.CompletedProcess([], 0, stdout=b'"runner.exe","12345"\n')
        with patch.object(local_stream, '_WIN', True), \
                patch.object(subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True), \
                patch.object(subprocess, 'run', return_value=result) as query:
            self.assertTrue(local_stream._pid_alive(12345))
        self.assertEqual(query.call_args.kwargs['creationflags'], 0x08000000)

    def test_targeted_termination_rejects_a_replacement_and_releases_global_lock(self):
        from app.services import local_stream
        proc = Mock()
        self.run['proc'] = proc
        acquired = threading.Event()
        def acquire():
            with local_process._LOCK:
                acquired.set()
        def terminate(pid, observed):
            self.assertEqual(pid, 12345)
            self.assertIs(observed, proc)
            worker = threading.Thread(target=acquire)
            worker.start()
            self.assertTrue(acquired.wait(1), 'Process termination held the global session lock')
            worker.join(timeout=1)
            return True
        with patch.object(local_stream, '_kill_pid_tree', side_effect=terminate) as kill:
            self.assertTrue(local_stream._kill_tree(self.ref, expected_pid=12345, expected_proc=proc))
            self.run['_hostCleanup'] = object()
            self.assertFalse(local_stream._kill_tree(self.ref, expected_pid=12345,
                expected_proc=proc, skip_host_cleanup=True))
            self.run.update(pid=54321, proc=Mock())
            self.assertFalse(local_stream._kill_tree(self.ref, expected_pid=12345, expected_proc=proc))
            kill.assert_called_once()

    def test_watchdog_rechecks_cleanup_ownership_after_poll_before_killing(self):
        for trigger in ('pi', 'timeout'):
            with self.subTest(trigger=trigger):
                self.run.update(cli='pi' if trigger == 'pi' else 'qwen',
                    started=1, lastOut=time.time() if trigger == 'pi' else 1,
                    piFinalResponseAt=time.time() - 60 if trigger == 'pi' else 0)
                proc = Mock()
                self.run['proc'] = proc
                self.run.pop('_hostCleanup', None)
                def poll():
                    self.run['_hostCleanup'] = object()
                    return None
                proc.poll.side_effect = poll
                with patch.object(local_process.threading, 'Thread') as thread:
                    local_process._watchdog(self.ref, proc, finish=Mock(), kill_tree=self.kill)
                target = thread.call_args.kwargs['target']
                with patch.object(local_process.time, 'sleep', side_effect=[None, RuntimeError('stop fixture')]):
                    with self.assertRaisesRegex(RuntimeError, 'stop fixture'):
                        target()
                self.kill.assert_not_called()
                self.assertNotIn('piSettledByWatchdog', self.run)
                self.assertNotIn('timedOut', self.run)

    def test_stop_never_kills_a_successor_published_during_broker_shutdown(self):
        self.run.update(proc=Mock(), queue=[])
        successor = {**self.run, 'pid': 54321, 'proc': Mock(),
                     '_workerIdentity': object(), 'stopping': False}
        def replace(_):
            local_process._RUNS[self.ref] = successor
        with patch('app.services.access_broker.close', side_effect=replace), \
                patch.object(local_stream, '_kill_pid_tree', return_value=True) as terminate:
            result = local_stream.stop_sync({}, self.ref)
        self.assertFalse(result['ok'])
        terminate.assert_not_called()
        self.assertEqual(successor['pid'], 54321)
        self.assertEqual(successor['state'], 'running')
        self.assertFalse(successor['stopping'])

    def test_exit_receipt_protects_host_before_joiner_publishes_its_fence(self):
        self.run.update(cli='pi', started=1, lastOut=1,
            piFinalResponseAt=time.time() - 60, stream={**self.spec, 'version': 1})
        proc = Mock(poll=Mock(return_value=None))
        self.run['proc'] = proc
        with patch.object(local_process.threading, 'Thread') as thread:
            local_process._watchdog(self.ref, proc, finish=Mock(), kill_tree=self.kill)
        target = thread.call_args.kwargs['target']
        with patch.object(local_process.time, 'sleep', side_effect=[None, RuntimeError('stop fixture')]), \
                patch.object(local_spool, 'status_code', return_value=0):
            with self.assertRaisesRegex(RuntimeError, 'stop fixture'):
                target()
        self.kill.assert_not_called()
        self.assertNotIn('_hostCleanup', self.run)
        self.assertNotIn('piSettledByWatchdog', self.run)
        self.assertNotIn('timedOut', self.run)

    def test_failed_in_process_policy_restore_cannot_clear_the_pending_host(self):
        proc = Mock(pid=12345)
        self.run.update(proc=proc, _hostCleanup=object(),
            _accessTransition={'phase': 'in-process-applying'})
        old = {'accessPolicy': {'mode': 'standard'}}
        with patch('app.services.local_stream._kill_tree', return_value=False), \
                patch('app.services.access_broker.close'):
            result = access_transition._restore_failed(self.ref, self.run, old)
        self.assertFalse(result['ok'])
        self.assertEqual(self.run['state'], 'running')
        self.assertEqual(self.run['pid'], 12345)
        self.assertIs(self.run['proc'], proc)
        self.assertTrue(self.run['_accessTransition']['cancelled'])
        self.assertEqual(self.run['accessPolicy'], old['accessPolicy'])

    def test_spawn_settles_only_after_the_shared_joiner_confirms_exit(self):
        finished = threading.Event()
        finish = Mock(side_effect=lambda *args: finished.set())
        proc = Mock(pid=12345)
        proc.stdin = Mock()
        with patch.object(local_process, '_env_for', return_value={}), \
                patch.object(local_process, '_command_argv', return_value=['synthetic']), \
                patch('app.services.access_broker.attach'), patch('app.services.access_broker.close'), \
                patch.object(local_process, '_append_raw'), patch.object(local_process, '_watchdog'), \
                patch.object(local_process.subprocess, 'Popen', return_value=proc), \
                patch.object(local_spool, 'prepare', return_value=(self.spec, ['synthetic'])), \
                patch.object(local_spool, 'follow', return_value=(0, 'completed')), \
                patch.object(local_spool, 'cleanup'), \
                patch.object(local_process, '_join_execution_host', return_value=(True, '')) as join:
            local_process.spawn('synthetic', [], 'hello', self.temp.name, self.ref,
                {'accessPolicy': {'mode': 'full'}}, {}, gate_check=lambda *args: '',
                on_line=Mock(), finish=finish, kill_tree=self.kill)
            self.assertTrue(finished.wait(2))
        join.assert_called_once()
        self.assertIs(join.call_args.kwargs['proc'], proc)
        finish.assert_called_once_with(self.ref, 0, {}, '')

    def test_recovery_does_not_finish_or_remove_spool_after_losing_ownership(self):
        finished = Mock()
        joined = threading.Event()
        def join(*args, **kwargs):
            self.assertEqual(kwargs['pid'], 12345)
            joined.set()
            return False, ''
        with patch.object(local_spool, 'follow', return_value=(0, 'completed')), \
                patch.object(local_spool, 'cleanup') as cleanup, \
                patch.object(local_process, '_join_execution_host', side_effect=join):
            before = set(local_process._THREADS)
            local_process.recover(self.ref, on_line=Mock(), finish=finished, kill_tree=self.kill)
            self.assertTrue(joined.wait(2))
            for worker in local_process._THREADS - before:
                worker.join(timeout=2)
            finished.assert_not_called()
            cleanup.assert_not_called()

    def test_recovery_read_failure_still_requires_exit_confirmation(self):
        finished = Mock()
        with patch.object(local_spool, 'follow', side_effect=OSError('synthetic read failure')), \
                patch.object(local_spool, 'cleanup'), \
                patch.object(local_process, '_join_execution_host', return_value=(True, '')) as join:
            before = set(local_process._THREADS)
            local_process.recover(self.ref, on_line=Mock(), finish=finished, kill_tree=self.kill)
            for worker in local_process._THREADS - before:
                worker.join(timeout=2)
            join.assert_called_once_with(self.ref, self.spec, None, self.kill,
                pid=12345, allow_grace=False)
            finished.assert_called_once()
            self.assertEqual(finished.call_args.args[1], 1)

    def test_recovery_tick_cannot_kill_a_replacement_stream(self):
        replacement = {**self.run, 'pid': 54321, 'stream': {'id': 'replacement'},
            'cli': 'pi', 'piFinalResponseAt': time.time() - 60, 'started': 1}
        def follow(*args, **kwargs):
            local_process._RUNS[self.ref] = replacement
            kwargs['on_tick']()
            return 0, 'completed'
        finished = Mock()
        with patch.object(local_spool, 'follow', side_effect=follow), \
                patch.object(local_spool, 'cleanup') as cleanup:
            before = set(local_process._THREADS)
            local_process.recover(self.ref, on_line=Mock(), finish=finished, kill_tree=self.kill)
            for worker in local_process._THREADS - before:
                worker.join(timeout=2)
        self.kill.assert_not_called()
        finished.assert_not_called()
        cleanup.assert_not_called()
        self.assertNotIn('piSettledByWatchdog', replacement)


class ExecutionSettlementTests(unittest.TestCase):
    def setUp(self):
        self.folder = self.enterContext(tempfile.TemporaryDirectory(prefix='soduwork-settlement-'))
        self.ref = 'settlement-fixture'
        self.run = {'state': 'running', 'cli': 'pi', 'ws': self.folder, 'cfg': {},
                    'seq': 0, 'lines': [], 'round': 1, 'segment': 1,
                    'conversationMode': 'interactive'}
        self.enterContext(patch.dict(local_base._RUNS, {self.ref: self.run}))
        self.enterContext(patch.object(local_base, '_STORE', self.folder))

    def test_hard_failure_precedes_cancel_timeout_and_semantic_failures(self):
        initial = dict(self.run)
        error = 'Permission-controlled execution host exited abnormally'
        for fields in (
            {'timedOut': 'synthetic timeout'},
            {'stopping': True},
            {'failureKind': 'workspace_permission', 'failurePath': 'fixture'},
            {'failureKind': 'execution_incomplete'},
            {'failureKind': 'execution_host_cleanup'},
        ):
            with self.subTest(fields=fields):
                self.run.clear()
                self.run.update(initial, **fields)
                terminal = {'overflow': True, 'outputTruncated': True}
                with patch.object(local_stream, '_resume') as resume, \
                        patch.object(local_stream, 'authorization_required_sync', return_value=False), \
                        patch.object(local_ctx, '_recover_overflow') as recover:
                    local_stream._finish(self.ref, 1, terminal, error)
                resume.assert_not_called()
                recover.assert_not_called()
                expected_kind = ('execution_host_cleanup'
                                 if fields.get('failureKind') == 'execution_host_cleanup' else None)
                persisted = json.loads(Path(self.folder, self.ref, 'meta.json').read_text(encoding='utf-8'))
                for result in (self.run, persisted):
                    self.assertEqual(result['state'], 'failed')
                    self.assertEqual(result['error'], error)
                    self.assertEqual(result.get('failureKind'), expected_kind)
                    self.assertFalse(result.get('failurePath'))
                self.assertFalse(self.run['stopping'])

    def test_confirmed_cancellation_remains_stopped(self):
        self.run['stopping'] = True
        with patch.object(local_stream, '_resume') as resume:
            local_stream._finish(self.ref, 1, {}, '')
        self.assertEqual(self.run['state'], 'stopped')
        resume.assert_not_called()

    def test_timeout_without_hard_failure_can_resume(self):
        self.run['timedOut'] = 'synthetic timeout'
        with patch.object(local_stream, '_STALL_RETRY_LIMIT', 1), \
                patch.object(local_stream, 'authorization_required_sync', return_value=False), \
                patch.object(local_stream, '_resume', return_value={'ok': True}) as resume:
            local_stream._finish(self.ref, 1, {}, '')
        resume.assert_called_once()
        self.assertEqual(self.run['stallRetries'], 1)
        self.assertEqual(self.run['state'], 'recovering')


class ExecutionLaunchIsolationTests(unittest.TestCase):
    def setUp(self):
        self.folder = self.enterContext(tempfile.TemporaryDirectory(prefix='soduwork-launch-isolation-'))
        self.ref = 'slow-launch'
        self.run = dict(cli='opencode', state='running', cfg={}, queue=[], round=1, seq=0)
        self.enterContext(patch.dict(local_base._RUNS, {self.ref: self.run}))
        self.threads = set()
        self.enterContext(patch.object(local_process, '_THREADS', self.threads))
        self.addCleanup(self.join_workers)
        for name in ('_save_meta', '_append_raw', '_watchdog', '_capture_started'):
            self.enterContext(patch.object(local_process, name))
        self.enterContext(patch.object(local_process, '_store_dir', return_value=self.folder))
        self.enterContext(patch.object(local_stream, '_save_meta'))
        self.enterContext(patch.object(local_process, '_env_for', return_value=dict(os.environ)))
        self.command = self.enterContext(patch.object(local_process, '_command_argv', return_value=['fixture-agent']))
        self.real_prepare = local_spool.prepare
        self.prepare = self.enterContext(patch.object(local_spool, 'prepare',
            return_value=({'id': 'fixture-spool'}, ['fixture-host'])))
        self.enterContext(patch.object(local_spool, 'cleanup'))
        self.enterContext(patch.object(local_spool, 'follow', return_value=(0, 'completed')))
        self.enterContext(patch('app.services.access_broker.attach'))
        self.close_broker = self.enterContext(patch('app.services.access_broker.close'))
        self.real_kill_tree = local_stream._kill_tree
        self.kill = self.enterContext(patch.object(local_stream, '_kill_tree', return_value=True))
        self.finished = threading.Event()
        def finish(*_):
            self.run.update(state='stopped' if self.run.get('stopping') else 'done', proc=None)
            self.finished.set()
        self.finish = Mock(side_effect=finish)

    def join_workers(self):
        for thread in self.threads:
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive(), 'A launch worker leaked')

    def launch(self):
        local_process.spawn('fixture-agent', [], 'private fixture prompt', self.folder, self.ref, {}, {},
            gate_check=lambda *_: '', on_line=Mock(), finish=self.finish, kill_tree=self.kill)

    def await_cancel(self):
        deadline = time.monotonic() + 1
        while not self.run.get('stopping') and time.monotonic() < deadline:
            time.sleep(.005)
        self.assertTrue(self.run.get('stopping'), 'Pending Popen prevented recording cancellation')

    def test_account_and_managed_runtimes_require_an_active_registered_run(self):
        for cli in ('codex', 'codex-harness', 'opencode'):
            with self.subTest(cli=cli), \
                    patch.object(local_process.subprocess, 'Popen') as popen:
                self.run['cli'] = cli
                self.run.pop('state', None)
                self.finished.clear()
                self.launch()
                self.assertTrue(self.finished.wait(3))
                popen.assert_not_called()

    def test_slow_launch_does_not_block_another_session_lock_or_stop(self):
        entered, release, acquired, stopped = (threading.Event() for _ in range(4))
        proc = Mock(pid=22222, poll=Mock(return_value=0))
        def popen(*_args, **_kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return proc
        other_ref = 'unrelated-active-session'
        self.enterContext(patch.dict(local_base._RUNS, {other_ref: {'state': 'running', 'pid': 33333}}))
        def query_and_stop():
            with local_base._LOCK:
                acquired.set()
            local_stream.stop_sync({}, other_ref)
            stopped.set()
        with patch.object(local_process.subprocess, 'Popen', side_effect=popen):
            self.launch()
            self.assertTrue(entered.wait(3))
            other = threading.Thread(target=query_and_stop, daemon=True)
            other.start()
            try:
                self.assertTrue(acquired.wait(.5), 'Slow launch held the global session lock')
                self.assertTrue(stopped.wait(.5), 'Slow launch blocked another session stop')
            finally:
                release.set()
                other.join(timeout=3)
            self.assertTrue(self.finished.wait(3))

    def test_cancelled_launch_kills_new_pid_without_feeding_the_prompt(self):
        entered, release, stopped = (threading.Event() for _ in range(3))
        proc = Mock(pid=22222, poll=Mock(return_value=0))
        results = []
        def popen(*_args, **_kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return proc
        def stop():
            results.append(local_stream.stop_sync({}, self.ref))
            stopped.set()
        with patch.object(local_process.subprocess, 'Popen', side_effect=popen):
            self.launch()
            self.assertTrue(entered.wait(3))
            stopper = threading.Thread(target=stop, daemon=True)
            stopper.start()
            try:
                self.await_cancel()
                self.assertFalse(stopped.wait(.05), 'Stop acknowledged a still-pending launch')
                self.assertEqual(self.run['state'], 'running')
            finally:
                release.set()
                stopper.join(timeout=3)
            self.assertTrue(self.finished.wait(3))
        self.assertTrue(results[0]['ok'])
        self.kill.assert_called_once_with(self.ref, expected_pid=proc.pid, expected_proc=proc)
        proc.stdin.write.assert_not_called()
        self.assertEqual(self.run['state'], 'stopped')

    def test_unconfirmed_launch_cleanup_retains_the_active_session_fence(self):
        entered, release, exited = (threading.Event() for _ in range(3))
        saved = []
        local_process._save_meta.side_effect = lambda _: saved.append(
            (self.run.get('pid'), self.run['state'], self.run.get('stopping')))
        proc = Mock(pid=22222, poll=Mock(side_effect=lambda: 0 if exited.is_set() else None))
        def popen(*_args, **_kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return proc
        with patch.object(local_process.subprocess, 'Popen', side_effect=popen), \
                patch.object(local_stream, '_LAUNCH_STOP_TIMEOUT_S', .05):
            self.launch()
            self.assertTrue(entered.wait(3))
            try:
                result = local_stream.stop_sync({}, self.ref)
                self.assertFalse(result['ok'])
                self.assertTrue(self.run['stopping'])
                release.set()
                deadline = time.monotonic() + 2
                while not self.kill.called and time.monotonic() < deadline:
                    time.sleep(.005)
                self.assertTrue(self.kill.called)
                self.assertIn((proc.pid, 'running', True), saved, 'The pending PID was not archived')
                self.assertFalse(self.finished.is_set(), 'A kill request was treated as observed exit')
                self.assertEqual(self.run['state'], 'running')
                self.assertIs(self.run['proc'], proc)
                self.assertIn('_launchPending', self.run)
                self.assertFalse(local_ctx.prepare_resume(self.ref, 'must not replace', {})['ok'])
            finally:
                release.set()
                exited.set()
            self.assertTrue(self.finished.wait(3))
        proc.stdin.write.assert_not_called()
        self.assertEqual(self.run['state'], 'stopped')

    def test_replaced_worker_cleans_only_its_own_returned_process(self):
        entered, release = threading.Event(), threading.Event()
        proc = Mock(pid=22222, poll=Mock(return_value=0))
        def popen(*_args, **_kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return proc
        with patch.object(local_process.subprocess, 'Popen', side_effect=popen), \
                patch.object(local_stream, '_kill_pid_tree', return_value=True) as orphan_kill:
            self.launch()
            self.assertTrue(entered.wait(3))
            replacement = {**self.run, '_workerIdentity': object(), 'pid': 44444,
                           'proc': Mock(), 'stream': {'id': 'successor'}, 'terminal': {'done': True}}
            local_base._RUNS[self.ref] = replacement
            release.set()
            self.join_workers()
        orphan_kill.assert_called_once_with(proc.pid, proc)
        self.kill.assert_not_called()
        self.finish.assert_not_called()
        self.close_broker.assert_not_called()
        self.assertEqual(replacement['pid'], 44444)
        self.assertEqual(replacement['stream'], {'id': 'successor'})
        self.assertEqual(replacement['terminal'], {'done': True})
        self.assertEqual(replacement['state'], 'running')
        self.assertIs(replacement['_launchPending'], self.run['_launchPending'])
        self.assertIs(replacement['_hostCleanup'], self.run['_hostCleanup'])

    def test_replaced_worker_cannot_overwrite_successor_during_spool_preparation(self):
        entered, release = threading.Event(), threading.Event()

        def prepare(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return {'id': 'old-worker-spool'}, ['fixture-host']

        self.prepare.side_effect = prepare
        with patch.object(local_process.subprocess, 'Popen') as popen:
            self.launch()
            self.assertTrue(entered.wait(3))
            replacement = {**self.run, '_workerIdentity': object(), 'pid': 44444,
                           'stream': {'id': 'successor'}, 'terminal': {'done': True}}
            local_base._RUNS[self.ref] = replacement
            release.set()
            self.join_workers()
        self.assertEqual(popen.call_count, 0, 'A replaced worker must not launch another process')
        self.finish.assert_not_called()
        self.close_broker.assert_not_called()
        self.assertEqual(replacement['pid'], 44444)
        self.assertEqual(replacement['stream'], {'id': 'successor'})
        self.assertEqual(replacement['terminal'], {'done': True})
        self.assertEqual(replacement['state'], 'running')

    def test_parent_exit_after_failed_tree_cleanup_cannot_release_the_launch(self):
        entered, release = threading.Event(), threading.Event()
        proc = Mock(pid=22222, poll=Mock(return_value=0))
        self.kill.return_value = False
        def popen(*_args, **_kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return proc
        with patch.object(local_process.subprocess, 'Popen', side_effect=popen), \
                patch.object(local_stream, '_LAUNCH_STOP_TIMEOUT_S', .05):
            self.launch()
            self.assertTrue(entered.wait(3))
            try:
                self.assertFalse(local_stream.stop_sync({}, self.ref)['ok'])
                release.set()
                deadline = time.monotonic() + 2
                while not self.kill.called and time.monotonic() < deadline:
                    time.sleep(.005)
                self.assertTrue(self.kill.called)
                self.assertFalse(self.finished.wait(.1), 'Parent exit replaced tree cleanup confirmation')
                self.assertEqual(self.run['state'], 'running')
                self.assertTrue(self.run['stopping'])
                self.assertIn('_hostCleanup', self.run)
                attempts = self.kill.call_count
                self.kill.return_value = True
                self.run['_launchPending']['retry'].set()
                self.assertFalse(local_stream.stop_sync({}, self.ref)['ok'])
                self.assertFalse(self.finished.wait(.1), 'A dead-host retry replaced the failed tree receipt')
                self.assertEqual(self.kill.call_count, attempts)
            finally:
                release.set()
                # Invalidate only the disposable fixture owner to retire its
                # blocked worker after verifying the production fence.
                self.run['_workerIdentity'] = object()
                self.run['_launchPending']['retry'].set()
                self.join_workers()
        self.finish.assert_not_called()
        proc.stdin.write.assert_not_called()

    def test_failed_permission_restore_cannot_release_an_inflight_launch(self):
        entered, release = threading.Event(), threading.Event()
        proc = Mock(pid=22222, poll=Mock(return_value=0))
        def popen(*_args, **_kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return proc
        with patch.object(local_process.subprocess, 'Popen', side_effect=popen):
            self.launch()
            self.assertTrue(entered.wait(3))
            try:
                self.run['_accessTransition'] = {'phase': 'in-process-applying'}
                result = access_transition._restore_failed(self.ref, self.run,
                    {'accessPolicy': {'mode': 'standard'}})
                self.assertFalse(result['ok'])
                self.assertEqual(self.run['state'], 'running')
                self.assertIn('_hostCleanup', self.run)
                self.run['stopping'] = True
            finally:
                release.set()
            self.assertTrue(self.finished.wait(3))
        proc.stdin.write.assert_not_called()

    def test_real_os_launch_cancellation_waits_for_its_process_tree(self):
        entered, release, stopped = (threading.Event() for _ in range(3))
        marker = Path(self.folder, 'prompt-was-executed')
        self.command.return_value = [sys.executable, '-c',
            'import pathlib,sys,time; sys.stdin.read(); pathlib.Path(sys.argv[1]).touch(); time.sleep(60)',
            str(marker)]
        self.prepare.side_effect = self.real_prepare
        self.kill.side_effect = self.real_kill_tree
        real_popen = subprocess.Popen
        processes, results = [], []
        def popen(argv, *args, **kwargs):
            proc = real_popen(argv, *args, **kwargs)
            if 'local_spool_worker.py' in str(argv):
                processes.append(proc)
                entered.set()
                self.assertTrue(release.wait(10))
            return proc
        def stop():
            result = local_stream.stop_sync({}, self.ref)
            results.append((result, processes[0].poll()))
            stopped.set()
        with patch.object(local_process.subprocess, 'Popen', side_effect=popen), \
                patch.object(local_stream, '_LAUNCH_STOP_TIMEOUT_S', 8):
            self.launch()
            self.assertTrue(entered.wait(5))
            stopper = threading.Thread(target=stop, daemon=True)
            stopper.start()
            try:
                self.await_cancel()
                self.assertFalse(stopped.wait(.05))
                self.assertIsNone(processes[0].poll())
                self.assertFalse(marker.exists())
                release.set()
                self.assertTrue(stopped.wait(10))
                self.assertTrue(self.finished.wait(5))
                self.assertTrue(results[0][0]['ok'])
                self.assertIsNotNone(results[0][1], 'Stop acknowledged before the OS process exited')
                self.assertFalse(marker.exists(), 'A cancelled launch received the user prompt')
            finally:
                release.set()
                for proc in processes:
                    if proc.poll() is None:
                        self.real_kill_tree(self.ref, expected_pid=proc.pid, expected_proc=proc)
                    proc.wait(timeout=5)
                stopper.join(timeout=10)

    def test_real_surviving_descendant_keeps_failed_launch_cleanup_active(self):
        entered, release = threading.Event(), threading.Event()
        child_file = Path(self.folder, 'isolated-child-pid')
        source = ('import pathlib,subprocess,sys; '
                  'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"], '
                  'start_new_session=True); pathlib.Path(sys.argv[1]).write_text(str(p.pid))')
        argv = [sys.executable, '-c', source, str(child_file)]
        self.prepare.return_value = ({'id': 'fixture-spool'}, argv)
        self.kill.return_value = False
        real_popen = subprocess.Popen
        parents = []
        child_pid = 0
        def popen(command, *args, **kwargs):
            proc = real_popen(command, *args, **kwargs)
            if command == argv:
                parents.append(proc)
                entered.set()
                self.assertTrue(release.wait(10))
            return proc
        with patch.object(local_process.subprocess, 'Popen', side_effect=popen), \
                patch.object(local_stream, '_LAUNCH_STOP_TIMEOUT_S', .1):
            self.launch()
            self.assertTrue(entered.wait(5))
            try:
                deadline = time.monotonic() + 5
                while not child_file.exists() and time.monotonic() < deadline:
                    time.sleep(.005)
                child_pid = int(child_file.read_text())
                self.assertFalse(local_stream.stop_sync({}, self.ref)['ok'])
                release.set()
                self.assertEqual(parents[0].wait(timeout=3), 0)
                deadline = time.monotonic() + 3
                while not self.kill.called and time.monotonic() < deadline:
                    time.sleep(.005)
                self.assertTrue(self.kill.called)
                self.assertTrue(local_stream._pid_alive(child_pid))
                self.assertFalse(self.finished.wait(.1), 'A surviving child lost its admission fence')
                self.assertEqual(self.run['state'], 'running')
                self.assertTrue(local_stream._kill_pid_tree(child_pid))
                self.kill.return_value = True
                self.assertFalse(local_stream.stop_sync({}, self.ref)['ok'])
                self.assertFalse(self.finished.wait(.1), 'A dead-host retry bypassed the unverified tree')
            finally:
                release.set()
                if child_pid:
                    local_stream._kill_pid_tree(child_pid)
                self.kill.return_value = True
                if self.run.get('_launchPending'):
                    self.run['_workerIdentity'] = object()
                    self.run['_launchPending']['retry'].set()
                self.join_workers()
                for proc in parents:
                    proc.wait(timeout=5)
                    proc.stdin.close()


if __name__ == '__main__':
    unittest.main()
