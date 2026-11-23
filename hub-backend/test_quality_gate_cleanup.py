"""Real owned process-tree cleanup at the offline quality gate entry point."""
import io
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import venv
from contextlib import redirect_stdout
from unittest.mock import patch

import quality_gate


class QualityGateCleanupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-gate-cleanup-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.marker = self.root / "owned-child.json"
        self.nonce = secrets.token_hex(16)
        self.peer = self.root / "peer.py"
        self.peer.write_text('''import json,os,signal,socket,sys,time
from pathlib import Path
if os.name != 'nt': signal.signal(signal.SIGTERM,signal.SIG_IGN)
sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen();sock.settimeout(.1)
Path(sys.argv[1]).write_text(json.dumps({'pid':os.getpid(),'port':sock.getsockname()[1]}))
deadline=time.monotonic()+60
while time.monotonic()<deadline:
    try:
        connection,_=sock.accept()
        with connection:
            connection.settimeout(.2)
            if connection.recv(100).decode()==sys.argv[2]: break
    except (OSError,UnicodeError): pass
''', encoding="utf-8")
        self.parent = self.root / "parent.py"
        self.parent.write_text('''import os,subprocess,sys,time
from pathlib import Path
peer,marker,nonce,mode=sys.argv[1:]
if mode=='grandchild':
    child=subprocess.Popen([sys.executable,__file__,peer,marker,nonce,'relay'])
    child.wait(timeout=5)
else:
    child=subprocess.Popen([sys.executable,peer,marker,nonce],
        stdout=subprocess.DEVNULL if mode=='discard' else None,
        stderr=subprocess.DEVNULL if mode=='discard' else None,
        start_new_session=mode=='detached')
deadline=time.monotonic()+5
while not Path(marker).exists() and time.monotonic()<deadline: time.sleep(.01)
if not Path(marker).exists(): raise RuntimeError('Peer startup failed')
os.write(1,b'partial stdout\\xff')
os.write(2,b' partial stderr')
if mode in ('wait','detached'): time.sleep(60)
if mode=='failed': raise SystemExit(7)
''', encoding="utf-8")
        self.addCleanup(self.cleanup_fixture)

    def command(self, mode="wait"):
        python = getattr(sys, "_base_executable", sys.executable)
        return [python, str(self.parent), str(self.peer), str(self.marker), self.nonce, mode]

    def child(self):
        return json.loads(self.marker.read_text(encoding="utf-8"))

    def cleanup_fixture(self):
        # Fixture-only authenticated socket shutdown: never kill an unverified PID.
        if self.marker.exists():
            try:
                with socket.create_connection(("127.0.0.1", self.child()["port"]), timeout=.2) as connection:
                    connection.sendall(self.nonce.encode())
            except OSError:
                pass

    def assert_child_stopped(self):
        child = self.child()
        for _ in range(100):
            try:
                connection = socket.create_connection(("127.0.0.1", child["port"]), timeout=.1)
            except OSError:
                return
            connection.close()
            time.sleep(.02)
        self.fail("Check left its owned descendant listening")

    def test_timeout_preserves_deadline_command_and_partial_output(self):
        args = self.command()
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired) as raised:
            quality_gate._run("owned timeout", args, self.root, dict(os.environ), 1)
        self.assertEqual(raised.exception.cmd, args)
        self.assertEqual(raised.exception.timeout, 1)
        self.assertIn("partial stdout\ufffd partial stderr", raised.exception.output)
        self.assertLess(time.monotonic() - started, 20, "Cleanup exceeded its bounded deadline")
        self.assert_child_stopped()

    @unittest.skipUnless(sys.platform.startswith("linux") or sys.platform == "darwin", "POSIX detached sessions")
    def test_timeout_reaps_a_descendant_in_its_own_session(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            quality_gate._run("detached session", self.command("detached"), self.root, dict(os.environ), 1)
        self.assert_child_stopped()

    def test_exited_leaders_and_grandchildren_are_reaped_without_waiting_for_stdout_eof(self):
        for mode in ("inherit", "discard", "failed", "grandchild"):
            with self.subTest(mode=mode), redirect_stdout(io.StringIO()):
                self.marker.unlink(missing_ok=True)
                started = time.monotonic()
                passed, output = quality_gate._run(mode, self.command(mode), self.root, dict(os.environ), 3)
                self.assertEqual(passed, mode != "failed")
                self.assertIn("partial stdout\ufffd partial stderr", output)
                self.assertLess(time.monotonic() - started, 20)
                self.assert_child_stopped()

    def test_interruption_and_unexpected_errors_preserve_the_original_and_reap_the_tree(self):
        original_wait = subprocess.Popen.wait
        for exception in (KeyboardInterrupt("interrupt"), SystemExit(13), RuntimeError("wait failed")):
            with self.subTest(exception=type(exception).__name__):
                self.marker.unlink(missing_ok=True)
                interrupted = False

                def interrupt(process, *args, **kwargs):
                    nonlocal interrupted
                    if not interrupted and kwargs.get("timeout") == 30:
                        deadline = time.monotonic() + 5
                        while not self.marker.exists() and time.monotonic() < deadline:
                            time.sleep(.02)
                        self.assertTrue(self.marker.exists(), "Fixture did not start")
                        interrupted = True
                        raise exception
                    return original_wait(process, *args, **kwargs)

                original_stop = quality_gate._stop_check

                def cleanup_error(*args):
                    original_stop(*args)
                    raise RuntimeError("cleanup diagnostic")

                with patch.object(subprocess.Popen, "wait", interrupt), \
                     patch.object(quality_gate, "_stop_check", cleanup_error), \
                     self.assertRaises(type(exception)) as raised:
                    quality_gate._run("owned interruption", self.command(), self.root, dict(os.environ), 30)
                self.assertIs(raised.exception, exception)
                self.assertIn("cleanup diagnostic", " ".join(exception.__notes__))
                self.assert_child_stopped()

    def test_an_unrelated_service_survives_while_owned_tree_stops(self):
        sentinel_marker = self.root / "sentinel.json"
        sentinel = subprocess.Popen([sys.executable, str(self.peer), str(sentinel_marker), self.nonce],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 5
            while not sentinel_marker.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(sentinel_marker.exists())
            with self.assertRaises(subprocess.TimeoutExpired):
                quality_gate._run("owned timeout", self.command(), self.root, dict(os.environ), 1)
            self.assert_child_stopped()
            self.assertIsNone(sentinel.poll())
            port = json.loads(sentinel_marker.read_text(encoding="utf-8"))["port"]
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                pass
        finally:
            sentinel.kill()
            sentinel.wait(timeout=3)

    @unittest.skipUnless(os.name == "nt", "Windows Job startup handshake")
    def test_job_assignment_failure_does_not_start_the_command(self):
        with patch.object(quality_gate.WindowsCheckJob, "attach", side_effect=RuntimeError("assignment rejected")), \
             self.assertRaisesRegex(RuntimeError, "assignment rejected"):
            quality_gate._run("rejected ownership", self.command(), self.root, dict(os.environ), 3)
        self.assertFalse(self.marker.exists())

    @unittest.skipUnless(os.name == "nt", "Native Windows Job ownership")
    def test_native_job_identity_rejection_does_not_release_the_command(self):
        import quality_check_process

        created = quality_check_process._created_milliseconds
        with patch.object(quality_check_process, "_created_milliseconds", side_effect=lambda pid: created(pid) + 1), \
             self.assertRaisesRegex(RuntimeError, "Job assignment failed"):
            quality_gate._run("identity rejected", self.command(), self.root, dict(os.environ), 3)
        self.assertFalse(self.marker.exists())

    @unittest.skipUnless(os.name == "nt", "Windows kill-on-close Job ownership")
    def test_job_owner_loss_reaps_descendants_and_preserves_original_timeout(self):
        stop = quality_gate.WindowsCheckJob.stop

        def lose_owner(job):
            job.process.kill()
            return stop(job)

        with patch.object(quality_gate.WindowsCheckJob, "stop", lose_owner), \
             self.assertRaises(subprocess.TimeoutExpired) as raised:
            quality_gate._run("lost owner", self.command(), self.root, dict(os.environ), 1)
        self.assertEqual(raised.exception.timeout, 1)
        self.assertIn("partial stdout\ufffd partial stderr", raised.exception.output)
        self.assertIn("Job cleanup failed", " ".join(raised.exception.__notes__))
        self.assert_child_stopped()

    @unittest.skipUnless(os.name == "nt", "Windows virtualenv redirector")
    def test_running_the_gate_from_a_virtualenv_still_owns_descendants(self):
        environment = self.root / "venv with spaces"
        venv.EnvBuilder(with_pip=False).create(environment)
        probe = subprocess.run([
            str(environment / "Scripts/python.exe"), "-c",
            "import json,os,sys; from pathlib import Path; import quality_gate; "
            "passed,_=quality_gate._run('venv ownership',json.loads(sys.argv[1]),"
            "Path(sys.argv[2]),dict(os.environ),3); raise SystemExit(0 if passed else 1)",
            json.dumps(self.command("inherit")), str(self.root),
        ], cwd=quality_gate.BACKEND, env=dict(os.environ, PYTHONUTF8="1"),
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
        self.assertEqual(probe.returncode, 0, probe.stdout + probe.stderr)
        self.assert_child_stopped()

    def test_missing_executable_remains_an_os_error(self):
        with self.assertRaises(FileNotFoundError):
            quality_gate._run("missing", [str(self.root / "missing-executable")],
                              self.root, dict(os.environ), 3)

    def test_output_keeps_universal_newline_text_semantics(self):
        with redirect_stdout(io.StringIO()):
            passed, output = quality_gate._run("text output",
                [sys.executable, "-c", "import os; os.write(1,b'one\\r\\ntwo\\rthree\\n')"],
                self.root, dict(os.environ), 5)
        self.assertTrue(passed)
        self.assertEqual(output, "one\ntwo\nthree\n")

    def test_completed_checks_preserve_output_failure_status_environment_and_cwd(self):
        with redirect_stdout(io.StringIO()):
            env = dict(os.environ, QUALITY_CHECK_FIXTURE="value with spaces")
            passed, output = quality_gate._run("normal output", [sys.executable, "-c",
                "import os,sys; print(os.environ['QUALITY_CHECK_FIXTURE']); print(os.getcwd()); print(sys.prefix)"],
                self.root, env, 5)
            failed, failure = quality_gate._run("failed output",
                [sys.executable, "-c", "print('failed'); raise SystemExit(7)"],
                self.root, dict(os.environ), 5)
        self.assertTrue(passed)
        self.assertIn("value with spaces", output)
        self.assertIn(str(self.root), output)
        self.assertIn(sys.prefix, output)
        self.assertFalse(failed)
        self.assertIn("Process exit code: 7", failure)
        self.assertIn("failed", failure)

    def test_main_failure_report_keeps_timeout_output(self):
        # Execute the real CLI loop and real child timeout, limiting only its manifest.
        original_run = quality_gate._run

        def run(name, args, cwd, env, timeout):
            return original_run(name, self.command(), self.root, env, 1)

        original_stop = quality_gate._stop_check

        def cleanup_error(*args):
            original_stop(*args)
            raise RuntimeError("cleanup diagnostic")

        output = io.StringIO()
        with patch.object(sys, "argv", ["quality_gate.py", "--scope", "backend"]), \
             patch.object(quality_gate, "audit_manifest", return_value=[]), \
             patch.object(quality_gate, "scripts_for", return_value=[]), \
             patch.object(quality_gate, "_stop_check", cleanup_error), \
             patch.object(quality_gate, "_run", run), redirect_stdout(output):
            self.assertEqual(quality_gate.main(), 1)
        self.assertIn("QUALITY GATE FAILED", output.getvalue())
        self.assertIn("timed out after 1s\npartial stdout\ufffd partial stderr", output.getvalue())
        self.assertIn("Quality check cleanup failed: RuntimeError('cleanup diagnostic')", output.getvalue())
        self.assert_child_stopped()


if __name__ == "__main__":
    unittest.main()
