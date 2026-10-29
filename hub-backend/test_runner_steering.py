"""Actual Runner and native child-process lifecycle, with no business/model IO."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from tests import steering_readiness


class RunnerSteeringTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux owned-tree cancellation')
    def test_cancel_stops_nested_sessions_without_touching_unrelated_process(self):
        import ctypes
        import signal
        from app.services import linux_process_tree, local_stream, local_base
        libc = ctypes.CDLL(None, use_errno=True)
        previous = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(previous), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        with tempfile.TemporaryDirectory(prefix='soduwork-owned-tree-') as directory:
            marker = Path(directory) / 'ready'
            peer = ("import os,pathlib,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                    "pathlib.Path(" + repr(str(marker)) + ").write_text(str(os.getpid())); time.sleep(60)")
            parent = ("import subprocess,sys,time; subprocess.Popen([sys.executable,'-c'," + repr(peer) +
                      "],start_new_session=True); time.sleep(60)")
            root = subprocess.Popen([sys.executable, '-c', parent], start_new_session=True)
            unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],
                                         start_new_session=True)
            child = None
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                child = int(marker.read_text())
                self.assertNotEqual(os.getpgid(child), os.getpgid(root.pid))
                # Deterministically defer the child's exit after its kill was
                # requested. The spool root must remain alive throughout that
                # wait, otherwise its watcher can announce a false terminal.
                attempted, observed = threading.Event(), threading.Event()
                actual_send, actual_read = linux_process_tree._send, linux_process_tree.read_process
                signals, result = [], []

                def delayed_send(process, sig):
                    signals.append((process.pid, sig))
                    if process.pid == child and sig == signal.SIGKILL:
                        attempted.set()
                        return True
                    return actual_send(process, sig)

                def observed_read(pid):
                    current = actual_read(pid)
                    if pid == child and attempted.is_set():
                        observed.set()
                    return current

                with patch.object(linux_process_tree, '_send', side_effect=delayed_send), \
                        patch.object(linux_process_tree, 'read_process', side_effect=observed_read):
                    worker = threading.Thread(target=lambda: result.append(local_stream._kill_pid_tree(root.pid, root)))
                    worker.start()
                    try:
                        self.assertTrue(observed.wait(5), 'cleanup did not wait for the child')
                        self.assertNotIn((root.pid, signal.SIGKILL), signals)
                        self.assertIsNone(root.poll(), 'root must not publish a terminal before its child exits')
                    finally:
                        os.kill(child, signal.SIGKILL)
                        worker.join(5)
                    self.assertFalse(worker.is_alive())
                    self.assertEqual(result, [True])
                self.assertIsNotNone(root.poll())
                self.assertFalse(local_base._pid_alive(child), 'zombie is no longer executing')
                self.assertIsNone(unrelated.poll(), 'another task must remain running')
                # We own the adopted fixture child; reap it and prove SIGKILL,
                # rather than treating a missing heartbeat as an exit receipt.
                pid, status = os.waitpid(child, 0)
                self.assertEqual(pid, child)
                self.assertTrue(os.WIFSIGNALED(status))
                self.assertEqual(os.WTERMSIG(status), signal.SIGKILL)
                child = None
                self.assertTrue(local_stream._kill_pid_tree(root.pid, root))
                self.assertIsNone(unrelated.poll())
                with self.assertRaises(ValueError):
                    linux_process_tree.kill_owned_tree(os.getpid())
            finally:
                if root.poll() is None:
                    root.kill()
                    root.wait(timeout=5)
                if child:
                    try:
                        os.kill(child, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    os.waitpid(child, 0)
                unrelated.terminate()
                unrelated.wait(timeout=5)
                libc.prctl(36, previous.value, 0, 0, 0)

    def test_linux_cancel_rejects_reused_pid_and_treats_zombie_as_exited(self):
        from app.services import linux_process_tree as tree
        old = tree.Process(123, 1, 123, 123, 7, 'S')
        reused = tree.Process(123, 1, 123, 123, 8, 'S')
        with patch.object(tree, 'read_process', return_value=reused), patch.object(tree.os, 'kill') as kill:
            self.assertFalse(tree._send(old, 9))
            kill.assert_not_called()
        self.assertFalse(tree.alive(tree.Process(123, 1, 123, 123, 7, 'Z')))

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux owned-tree cancellation')
    def test_linux_cancel_failure_resumes_only_processes_it_paused(self):
        from app.services import linux_process_tree as tree
        import signal
        root = tree.Process(123, 1, 123, 123, 7, 'S')
        paused = tree.Process(123, 1, 123, 123, 7, 'T')
        state = [root]
        sent = []

        def send(pid, sig):
            sent.append((pid, sig))
            state[0] = paused if sig == signal.SIGSTOP else root

        with patch.object(tree, 'read_process', side_effect=lambda _pid: state[0]), \
                patch.object(tree, '_snapshot', side_effect=[{123: root}, PermissionError('fixture')]), \
                patch.object(tree.os, 'kill', side_effect=send):
            with self.assertRaises(PermissionError):
                tree.kill_owned_tree(123)
        self.assertEqual(sent, [(123, signal.SIGSTOP), (123, signal.SIGCONT)])

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux owned-tree cancellation')
    def test_linux_child_exit_timeout_keeps_root_and_reports_failure(self):
        from app.services import linux_process_tree as tree
        import signal
        from dataclasses import replace
        states = {123: tree.Process(123, 1, 123, 123, 7, 'S'),
                  124: tree.Process(124, 123, 124, 124, 8, 'S')}
        sent, clock = [], [0.0]

        def send(pid, sig):
            sent.append((pid, sig))
            state = 'T' if sig == signal.SIGSTOP else 'S'
            if sig == signal.SIGKILL:
                state = 'D' if pid == 124 else 'Z'
            states[pid] = replace(states[pid], state=state)

        with patch.object(tree, 'read_process', side_effect=states.get), \
                patch.object(tree, '_snapshot', side_effect=lambda: dict(states)), \
                patch.object(tree.os, 'kill', side_effect=send), \
                patch.object(tree.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(tree.time, 'sleep', side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)):
            with self.assertRaises(TimeoutError):
                tree.kill_owned_tree(123)
        self.assertNotIn((123, signal.SIGKILL), sent)
        self.assertIn((123, signal.SIGCONT), sent)
        self.assertIn((124, signal.SIGCONT), sent)
        self.assertEqual(states[123].state, 'S')

    def test_readiness_rejects_empty_partial_and_invalid_content(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-ready-read-") as directory:
            marker = Path(directory) / "first-ready"
            self.assertIsNone(steering_readiness.read_pid(marker))
            for content in (b"", b"12", b"0\n", b"-12\n", b"12x\n", b"12\n13\n", b"\xff\n"):
                with self.subTest(content=content):
                    marker.write_bytes(content)
                    self.assertIsNone(steering_readiness.read_pid(marker))
            marker.write_bytes(b"1234\n")
            self.assertEqual(steering_readiness.read_pid(marker), 1234)

    def test_both_ready_files_publish_only_after_complete_file_is_closed(self):
        # Force the exact scheduling window; no timing-dependent stress is
        # needed to prove readers cannot observe the writer's empty file.
        for name in ("first-ready", "followup-ready"):
            with self.subTest(marker=name), tempfile.TemporaryDirectory(prefix="soduwork-ready-publish-") as directory:
                marker = Path(directory) / name
                publishing, release = threading.Event(), threading.Event()
                failures = []
                actual_replace = os.replace

                def delayed_replace(source, target):
                    self.assertEqual(Path(source).read_bytes(), b"1234\n")
                    self.assertEqual(Path(source).parent, marker.parent)
                    publishing.set()
                    if not release.wait(5):
                        raise TimeoutError("Test did not release readiness publication")
                    actual_replace(source, target)

                def write():
                    try:
                        steering_readiness.publish_pid(marker, 1234)
                    except BaseException as error:
                        failures.append(error)

                with patch.object(steering_readiness.os, "replace", delayed_replace):
                    writer = threading.Thread(target=write)
                    writer.start()
                    try:
                        self.assertTrue(publishing.wait(5), failures)
                        self.assertFalse(marker.exists())
                        self.assertIsNone(steering_readiness.read_pid(marker))
                    finally:
                        release.set()
                        writer.join(5)
                self.assertFalse(writer.is_alive())
                self.assertEqual(failures, [])
                self.assertEqual(steering_readiness.read_pid(marker), 1234)
                self.assertEqual(list(Path(directory).iterdir()), [marker])

    def test_all_runtime_profiles_stop_and_resume_same_session(self):
        from app.services.local_base import _PROFILES
        script = Path(__file__).with_name("tests") / "runner_steering_fixture.py"
        self.assertTrue(_PROFILES)
        for agent in sorted(_PROFILES):
            with self.subTest(agent=agent), tempfile.TemporaryDirectory(prefix="soduwork-steer-" + agent) as directory:
                process = subprocess.run([sys.executable, str(script), agent, directory, "--stop-followup"],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=65,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
                self.assertEqual(process.returncode, 0, process.stdout + "\n" + process.stderr)
                result = json.loads(process.stdout.strip().splitlines()[-1])
                self.assertTrue(result["ok"])
                print(json.dumps(result), flush=True)


if __name__ == "__main__":
    unittest.main()
