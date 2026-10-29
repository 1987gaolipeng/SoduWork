"""Reclaimed permission sessions remain active until process cleanup is confirmed."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from app.services import access_policy, ai_local, local_base, local_stream, runner_admission
from runner_main import Runner


class LocalRestartCleanupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-restart-cleanup-")
        self.addCleanup(self.temp.cleanup)
        self.ref = "interrupted-access-cleanup"
        self.store = patch.object(local_base, "_STORE", self.temp.name)
        self.store.start()
        self.addCleanup(self.store.stop)
        self.addCleanup(local_base._RUNS.pop, self.ref, None)

    def _archive(self, pid=41234):
        target = Path(self.temp.name) / self.ref
        target.mkdir(parents=True)
        data = {"cli": "qwen", "cliSid": "original-cli-session", "state": "running",
                "taskId": "task", "ws": self.temp.name, "pid": pid, "started": 1,
                "seq": 0, "segment": 1, "round": 1,
                "accessPolicy": access_policy.normalize({"schema": access_policy.SCHEMA,
                    "mode": "standard", "revision": 1, "workspaceRoot": self.temp.name})}
        (target / "meta.json").write_text(json.dumps(data), encoding="utf-8")

    def _watch_target(self):
        worker = Mock()
        with patch.object(local_base.threading, "Thread", return_value=worker) as create:
            local_base._watch_detached(self.ref)
        self.addCleanup(local_base._THREADS.discard, worker)
        return create.call_args.kwargs["target"]

    def test_failed_reclaim_cleanup_keeps_running_and_persists_the_original_pid(self):
        self._archive()
        with patch.object(local_stream, "_kill_pid_tree", return_value=False) as terminate, \
                patch.object(local_base, "_watch_detached") as watch:
            result = local_base.reclaim()
        terminate.assert_called_once_with(41234)
        self.assertEqual(result, {"live": 1, "ended": 0})
        run = local_base._RUNS[self.ref]
        self.assertEqual(run["state"], "running")
        self.assertEqual(run["pid"], 41234)
        self.assertEqual(run["failureKind"], "access_reauthorization_cleanup")
        self.assertTrue(run["detached"])
        self.assertTrue(run["accessReauthorizationRequired"])
        self.assertEqual(run["appliedAccessPolicy"], {})
        watch.assert_called_once_with(self.ref)
        saved = json.loads((Path(self.temp.name) / self.ref / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["state"], "running")
        self.assertEqual(saved["pid"], 41234)

    def test_successful_reclaim_cleanup_keeps_the_existing_interrupted_contract(self):
        self._archive()
        with patch.object(local_stream, "_kill_pid_tree", return_value=True), \
                patch.object(local_base, "_watch_detached") as watch:
            result = local_base.reclaim()
        self.assertEqual(result, {"live": 0, "ended": 1})
        self.assertEqual(local_base._RUNS[self.ref]["state"], "interrupted")
        self.assertEqual(local_base._RUNS[self.ref]["failureKind"], "access_reauthorization")
        watch.assert_not_called()

    async def test_refused_followup_cannot_hide_reclaimed_live_process_from_job_session(self):
        self._archive()
        with patch.object(local_stream, "_kill_pid_tree", return_value=False), \
                patch.object(local_base, "_watch_detached"):
            local_base.reclaim()
        runner = object.__new__(Runner)
        runner._admission = runner_admission.AdmissionQueue()
        item = runner._admission.submit(
            "refused-followup", self.ref, runner_admission.INTERACTIVE, "comment", {})[2]
        runner._admission.finish(item.key, "failed", "followup never launched")
        result = await runner._job({"op": "job.session", "ref": self.ref, "since": 0})
        self.assertTrue(result["ok"] and result["data"]["ok"])
        self.assertEqual(result["data"]["status"], "running")
        self.assertTrue(result["data"]["canStop"])
        self.assertEqual(result["data"]["failureKind"], "access_reauthorization_cleanup")

    def _reclaimed_run(self, pid=41234):
        run = {"state": "running", "pid": pid, "accessReauthorizationRequired": True,
               "failureKind": "access_reauthorization_cleanup"}
        local_base._RUNS[self.ref] = run
        return run

    def test_unknown_exit_probe_does_not_settle_reclaimed_work(self):
        run = self._reclaimed_run()
        target = self._watch_target()
        with patch.object(local_base.time, "sleep", side_effect=[None, RuntimeError("test boundary")]), \
                patch.object(local_base, "_pid_alive", return_value=False), \
                patch.object(local_stream, "_pid_alive", return_value=True) as alive:
            with self.assertRaisesRegex(RuntimeError, "test boundary"):
                target()
        alive.assert_called_once_with(41234)
        self.assertEqual(run["state"], "running")
        self.assertNotIn("ended", run)

    def test_missing_pid_is_not_a_stopped_process_receipt(self):
        run = self._reclaimed_run(pid=None)
        target = self._watch_target()
        with patch.object(local_base.time, "sleep", side_effect=[None, RuntimeError("test boundary")]), \
                patch.object(local_stream, "_pid_alive", return_value=False) as alive:
            with self.assertRaisesRegex(RuntimeError, "test boundary"):
                target()
        alive.assert_not_called()
        self.assertEqual(run["state"], "running")

    def test_confirmed_exit_settles_reclaimed_work_as_interrupted(self):
        run = self._reclaimed_run()
        target = self._watch_target()
        with patch.object(local_base.time, "sleep"), \
                patch.object(local_stream, "_pid_alive", return_value=False), \
                patch.object(local_base, "_save_meta") as save:
            target()
        self.assertEqual(run["state"], "interrupted")
        self.assertEqual(run["failureKind"], "access_reauthorization")
        self.assertGreater(run["ended"], 0)
        save.assert_called_once_with(self.ref)

    def test_windows_failed_process_probe_is_inconclusive(self):
        result = subprocess.CompletedProcess(args=["tasklist"], returncode=1, stdout=b"", stderr=b"denied")
        with patch.object(local_stream, "_WIN", True), \
                patch.object(local_stream.subprocess, "run", return_value=result):
            self.assertTrue(local_stream._pid_alive(41234))

    def test_confirmed_cleanup_reopens_and_resumes_the_same_native_session(self):
        self._archive()
        with patch.object(local_stream, "_kill_pid_tree", return_value=False), \
                patch.object(local_base, "_watch_detached"):
            local_base.reclaim()
        target = self._watch_target()
        with patch.object(local_base.time, "sleep"), \
                patch.object(local_stream, "_pid_alive", return_value=False):
            target()

        # Discard the live mirror to exercise the persisted cleanup receipt.
        local_base._RUNS.pop(self.ref)
        reopened = local_base.rehydrate(self.ref)
        self.assertEqual(reopened["state"], "interrupted")
        self.assertEqual(reopened["cliSid"], "original-cli-session")
        self.assertEqual(reopened["ws"], self.temp.name)
        self.assertEqual(reopened["taskId"], "task")
        self.assertTrue(reopened["accessReauthorizationRequired"])
        cfg = {"accessPolicy": dict(reopened["accessPolicy"])}
        with patch.dict(local_base._PROFILES["qwen"], {"bin": lambda: sys.executable}), \
                patch.object(local_stream, "_resume", wraps=local_stream._resume) as resume, \
                patch.object(local_stream, "_spawn") as spawn:
            result = local_stream.comment_sync(cfg, self.ref, "Continue the original requirement")
        self.assertTrue(result.get("ok"), result)
        resume.assert_called_once_with(self.ref, "Continue the original requirement", cfg)
        spawn.assert_called_once()
        self.assertEqual(spawn.call_args.args[2], "Continue the original requirement")
        self.assertEqual(spawn.call_args.args[3:5], (self.temp.name, self.ref))
        self.assertFalse(reopened["detached"])
        self.assertEqual(reopened["cliSid"], "original-cli-session")
        saved = json.loads((Path(self.temp.name) / self.ref / "meta.json").read_text(encoding="utf-8"))
        self.assertFalse(saved["detached"])
        self.assertEqual(saved["cliSid"], "original-cli-session")

    def test_later_restart_successful_cleanup_clears_persisted_detached_state(self):
        self._archive()
        with patch.object(local_stream, "_kill_pid_tree", return_value=False), \
                patch.object(local_base, "_watch_detached"):
            local_base.reclaim()
        local_base._RUNS.pop(self.ref)
        with patch.object(local_stream, "_kill_pid_tree", return_value=True), \
                patch.object(local_base, "_watch_detached") as watch:
            result = local_base.reclaim()
        self.assertEqual(result, {"live": 0, "ended": 1})
        self.assertEqual(local_base._RUNS[self.ref]["state"], "interrupted")
        self.assertFalse(local_base._RUNS[self.ref]["detached"])
        saved = json.loads((Path(self.temp.name) / self.ref / "meta.json").read_text(encoding="utf-8"))
        self.assertFalse(saved["detached"])
        watch.assert_not_called()

    def test_exit_probe_cannot_settle_a_replacement_process(self):
        previous = self._reclaimed_run()
        target = self._watch_target()
        replacement = {**previous, "pid": 51234}

        def probe(_pid):
            local_base._RUNS[self.ref] = replacement
            return False

        with patch.object(local_base.time, "sleep"), \
                patch.object(local_stream, "_pid_alive", side_effect=probe), \
                patch.object(local_base, "_save_meta") as save:
            target()
        self.assertEqual(replacement["state"], "running")
        self.assertNotIn("ended", replacement)
        save.assert_not_called()

    def test_legacy_detached_exit_keeps_its_original_outcome(self):
        for stopping, expected in ((False, "done"), (True, "stopped")):
            with self.subTest(stopping=stopping):
                run = {"state": "running", "pid": 41234, "stopping": stopping}
                local_base._RUNS[self.ref] = run
                target = self._watch_target()
                with patch.object(local_base.time, "sleep"), \
                        patch.object(local_base, "_pid_alive", return_value=False), \
                        patch.object(local_stream, "_pid_alive") as strict_probe, \
                        patch.object(local_base, "_save_meta"):
                    target()
                self.assertEqual(run["state"], expected)
                strict_probe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
