"""Real subprocess ownership tests for ACP shutdown (no model or network)."""
import gc
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from app.services.acp_bridge import AcpBridge, BridgeError, _Terminal


class AcpProcessLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-acp-lifecycle-")
        self.addCleanup(self.directory.cleanup)
        self.bridges = []
        self.addCleanup(self.close_bridges)

    def close_bridges(self):
        for bridge in self.bridges:
            bridge.close()

    def bridge(self, program, *, executable=None):
        bridge = AcpBridge([executable or sys.executable, "-u", "-c", program],
                           self.directory.name, "fixture", "workspace")
        self.bridges.append(bridge)
        bridge.start()
        return bridge

    def ready(self, bridge):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            kind, value = bridge.inbox.get(timeout=max(.01, deadline - time.monotonic()))
            if kind == "message" and value.get("ready"):
                return value
        self.fail("fixture did not become ready")

    def assert_closed(self, bridge):
        self.assertIsNotNone(bridge.proc.returncode, "native child must be waited, not left to Popen.__del__")
        self.assertFalse(any(reader.is_alive() for reader in bridge.readers))
        self.assertTrue(all(stream.closed for stream in (bridge.proc.stdin, bridge.proc.stdout, bridge.proc.stderr)))

    def test_natural_exit_drains_both_pipes_without_a_fixed_shutdown_delay(self):
        bridge = self.bridge("import sys; print('natural stdout'); print('natural stderr', file=sys.stderr)")
        bridge.proc.wait(timeout=5)
        start = time.monotonic()
        bridge.close()
        self.assertLess(time.monotonic() - start, 1)
        self.assert_closed(bridge)
        self.assertIn("natural stderr", bridge.stderr_tail)

    def test_exit_before_first_request_keeps_redacted_config_diagnostic(self):
        from app.services.acp_bridge import _friendly_bridge_error
        bridge = self.bridge(
            "import sys; print('ConfigJsonError: PRIVATE-FIXTURE apiKey=fixture-secret', "
            "file=sys.stderr, flush=True)")
        bridge.proc.wait(timeout=5)
        with self.assertRaises(BridgeError) as caught:
            bridge.request("initialize", {})
        message = _friendly_bridge_error("opencode", str(caught.exception))
        self.assertIn("配置无法解析", message)
        self.assertNotIn("PRIVATE-FIXTURE", message)
        self.assertNotIn("fixture-secret", message)

    def test_stdout_eof_waits_for_pending_stderr_diagnostic(self):
        # A Windows venv redirector retains the inherited stdout handle until
        # its child exits. Use the actual interpreter for an early pipe close.
        bridge = self.bridge(
            "import os,sys,time; os.close(1); time.sleep(.05); "
            "print('fixture startup failure', file=sys.stderr, flush=True)",
            executable=getattr(sys, "_base_executable", sys.executable))
        with self.assertRaisesRegex(BridgeError, "fixture startup failure"):
            bridge.request("initialize", {})

    def test_running_agent_is_reaped_and_repeated_close_is_safe(self):
        bridge = self.bridge("import json,time; print(json.dumps({'ready': True}), flush=True); time.sleep(60)")
        self.ready(bridge)
        bridge.close()
        self.assert_closed(bridge)
        result = bridge.proc.returncode
        bridge.close()
        self.assertEqual(bridge.proc.returncode, result)
        self.assert_closed(bridge)

    def test_stdout_eof_with_open_stderr_has_bounded_diagnostic_wait(self):
        bridge = self.bridge("import os,time; os.close(1); time.sleep(60)",
                             executable=getattr(sys, "_base_executable", sys.executable))
        start = time.monotonic()
        with self.assertRaisesRegex(BridgeError, "ACP Agent exited early"):
            bridge.request("initialize", {})
        self.assertLess(time.monotonic() - start, 2)
        self.assertIsNone(bridge.proc.poll(), "stderr must remain open during the bounded wait")

    def test_stdin_close_only_tolerates_windows_closed_pipe_einval(self):
        import errno
        import io
        from types import SimpleNamespace
        from unittest.mock import patch
        from app.services import acp_process

        class ClosedInput:
            def __init__(self, code):
                self.code = code

            def close(self):
                raise OSError(self.code, "fixture close failure")

        for platform, code, allowed in (("nt", errno.EINVAL, True),
                                         ("posix", errno.EINVAL, False),
                                         ("nt", errno.EBADF, False)):
            with self.subTest(platform=platform, code=code):
                proc = SimpleNamespace(stdin=ClosedInput(code), stdout=io.StringIO(),
                                       stderr=io.StringIO(), poll=lambda: 0)
                with patch.object(acp_process, "os", SimpleNamespace(name=platform)):
                    if allowed:
                        acp_process.close_process(proc, [])
                    else:
                        with self.assertRaises(acp_process.ProcessCleanupError):
                            acp_process.close_process(proc, [])
                self.assertTrue(proc.stdout.closed)
                self.assertTrue(proc.stderr.closed)

    def test_ignoring_term_cannot_leave_descendants_holding_reader_pipes(self):
        child = "import signal,time; signal.signal(signal.SIGTERM, lambda *_: None); time.sleep(60)"
        program = ("import json,signal,subprocess,sys,time; "
                   "signal.signal(signal.SIGTERM, lambda *_: None); "
                   "p=subprocess.Popen([sys.executable,'-u','-c'," + repr(child) + "]); "
                   "print(json.dumps({'ready': True, 'child': p.pid}),flush=True); time.sleep(60)")
        bridge = self.bridge(program)
        self.ready(bridge)
        start = time.monotonic()
        bridge.close()
        self.assertLess(time.monotonic() - start, 12, "cancellation must remain bounded")
        self.assert_closed(bridge)

    def test_terminal_release_reaps_process_and_closes_its_pipe(self):
        terminal = _Terminal(sys.executable, ["-u", "-c", "import time; print('ready',flush=True); time.sleep(60)"],
                             self.directory.name, os.environ.copy(), 8192)
        self.addCleanup(terminal.kill)
        terminal.kill()
        self.assertIsNotNone(terminal.proc.returncode)
        self.assertFalse(terminal.reader.is_alive())
        self.assertTrue(terminal.proc.stdout.closed)
        terminal.kill()

    def test_input_close_error_still_reaps_child_and_drains_output(self):
        bridge = self.bridge("import json,time; print(json.dumps({'ready': True}),flush=True); time.sleep(60)")
        self.ready(bridge)
        original = bridge.proc.stdin

        class BrokenClose:
            def close(self):
                original.close()
                raise OSError("fixture input close failed")

        bridge.proc.stdin = BrokenClose()
        try:
            with self.assertRaisesRegex(BridgeError, "fixture input close failed"):
                bridge.close()
        finally:
            bridge.proc.stdin = original
        self.assert_closed(bridge)

    def test_collected_bridge_cycle_does_not_poll_a_finalized_windows_handle(self):
        bridge = self.bridge("import json,time; print(json.dumps({'ready': True}),flush=True); time.sleep(60)")
        self.ready(bridge)
        bridge.close()
        self.assert_closed(bridge)
        # Transition references the bridge; collection must be safe while the
        # bridge/Popen/Windows handle graph is being finalized in any order.
        self.bridges.remove(bridge)
        failures = []
        original = sys.unraisablehook
        try:
            sys.unraisablehook = failures.append
            del bridge
            gc.collect()
        finally:
            sys.unraisablehook = original
        self.assertEqual(failures, [])


    @unittest.skipUnless(sys.platform == "linux", "Linux process-group regression; run in Linux acceptance")
    def test_parent_exits_on_term_but_ignoring_descendant_is_reaped(self):
        self.descendant_after_parent_exit(natural=False)

    @unittest.skipUnless(sys.platform == "linux", "Linux process-group regression; run in Linux acceptance")
    def test_parent_exits_naturally_but_ignoring_descendant_is_reaped(self):
        self.descendant_after_parent_exit(natural=True)

    def descendant_after_parent_exit(self, *, natural):
        import ctypes
        import signal
        libc = ctypes.CDLL(None, use_errno=True)
        previous = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(previous), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        child_program = (
            "import os,signal,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
            "os.write(int(sys.argv[1]),b'R'); os.close(int(sys.argv[1])); time.sleep(60)")
        program = (
            "import json,os,signal,subprocess,sys,time; "
            "signal.signal(signal.SIGTERM,lambda *_:sys.exit(0)); r,w=os.pipe(); "
            "p=subprocess.Popen([sys.executable,'-u','-c'," + repr(child_program) + ",str(w)],pass_fds=(w,)); "
            "os.close(w); assert os.read(r,1)==b'R'; os.close(r); "
            "print(json.dumps({'ready':True,'childPid':p.pid}),flush=True); " +
            ("sys.exit(0)" if natural else "time.sleep(60)"))
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                                     start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        bridge = None
        child_pid = None
        child_reaped = False

        def reap_child():
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                pid, status = os.waitpid(child_pid, os.WNOHANG)
                if pid == child_pid:
                    return status
                time.sleep(.01)
            self.fail("owned descendant was not reaped")

        try:
            bridge = self.bridge(program)
            child_pid = int(self.ready(bridge)["childPid"])
            group = bridge.process_group.leader_pid
            self.assertEqual(group, bridge.proc.pid)
            self.assertEqual(os.getpgid(child_pid), group)
            self.assertNotEqual(group, os.getpgrp())
            if natural:
                bridge.proc.wait(timeout=5)
            start = time.monotonic()
            bridge.close()
            self.assertLess(time.monotonic() - start, 5)
            self.assert_closed(bridge)
            self.assertEqual(bridge.proc.returncode, 0)
            self.assertFalse(bridge.process_group.active)
            status = reap_child()
            child_reaped = True
            self.assertTrue(os.WIFSIGNALED(status))
            self.assertEqual(os.WTERMSIG(status), signal.SIGKILL)
            self.assertIsNone(unrelated.poll(), "cleanup must not signal a different owned session")
            bridge.close()
            self.assertIsNone(unrelated.poll())
        finally:
            if child_pid is not None and not child_reaped:
                try:
                    group = bridge.process_group.leader_pid
                    self.assertEqual(os.getpgid(child_pid), group)
                    self.assertNotEqual(group, os.getpgrp())
                    os.killpg(group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                bridge.proc.wait(timeout=5)
                reap_child()
            unrelated.terminate()
            unrelated.wait(timeout=5)
            libc.prctl(36, previous.value, 0, 0, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
