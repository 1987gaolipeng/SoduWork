"""Cancellation across goal handoff, native launch, and queued admissions."""
import asyncio
from contextlib import ExitStack
import os
import secrets
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import AsyncMock, Mock, patch

_data = tempfile.TemporaryDirectory(prefix="soduwork-goal-stop-import-")
with patch.dict(os.environ, {"DATABASE_URL": "sqlite+aiosqlite:///:memory:",
                             "SODUWORK_DATA_ROOT": _data.name, "ADMIN_PASS": secrets.token_urlsafe(24)}):
    from app.services import access_broker, ai_local, local_base, local_completion, local_ctx, local_process, local_spool, local_stream
    from app.services import local_task_goal as goal, runner_admission
    from runner_main import Runner


class GoalLaunchStopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-goal-stop-")
        self.addCleanup(self.temp.cleanup)
        self.stack = self.enterContext(ExitStack())
        self.ref = "goal-stop-" + uuid.uuid4().hex
        self.run = dict(cli="dsh", state="running", ws=self.temp.name, cfg={}, seq=0, lines=[],
                        pid=11111, round=1, segment=1, queue=[], cliSid="retained")
        local_base._RUNS[self.ref] = self.run
        self.addCleanup(local_base._RUNS.pop, self.ref, None)
        goal.initialize(self.run, {"schemaVersion": 1, "objective": "Finish a synthetic fixture"})
        for module in (local_base, local_stream, ai_local):
            self.stack.enter_context(patch.object(module, "_STORE", self.temp.name))
        for name in ("_save_meta", "_append_raw", "_watchdog", "_capture_started"):
            self.stack.enter_context(patch.object(local_process, name))
        self.stack.enter_context(patch.object(local_process, "_env_for", return_value={}))
        self.stack.enter_context(patch.object(local_process, "_command_argv", return_value=["synthetic-agent"]))
        self.stack.enter_context(patch.object(local_spool, "prepare", return_value=({"id": "fixture"}, ["synthetic-host"])))
        self.stack.enter_context(patch.object(local_spool, "cleanup"))
        self.stack.enter_context(patch.object(local_spool, "follow", return_value=(0, "completed")))
        self.stack.enter_context(patch.object(access_broker, "attach"))
        self.stack.enter_context(patch.object(access_broker, "close"))
        self.kill = self.stack.enter_context(patch.object(local_stream, "_kill_tree", return_value=True))
        self.finished = threading.Event()
        self.results = []
        self.before_threads = set(local_process._THREADS)
        self.addCleanup(self.join_workers)

    def join_workers(self):
        for thread in set(local_process._THREADS) - self.before_threads:
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive(), "synthetic goal worker leaked")

    def launch(self, gate=None):
        def finished(*result):
            self.results.append(result)
            self.finished.set()
        local_process.spawn("synthetic-agent", [], "do not replay completed work", self.temp.name,
            self.ref, {}, {}, gate_check=gate or (lambda *_: ""), on_line=Mock(), finish=finished,
            kill_tree=self.kill)

    def test_pause_during_preflight_does_not_launch_a_replacement(self):
        entered, release = threading.Event(), threading.Event()
        def gate(*_):
            entered.set()
            self.assertTrue(release.wait(3), "preflight fixture was not released")
            return ""
        with patch.object(local_process.subprocess, "Popen", side_effect=AssertionError("native process started")) as popen:
            self.launch(gate)
            try:
                self.assertTrue(entered.wait(3))
                self.assertTrue(local_stream.stop_sync({"taskGoalControl": "pause"}, self.ref)["ok"])
                self.assertEqual(self.run["goalState"]["status"], "paused")
            finally:
                release.set()
            self.assertTrue(self.finished.wait(3))
            popen.assert_not_called()

    def test_stop_immediately_before_spawn_entry_does_not_disable_the_guard(self):
        self.assertTrue(local_stream.stop_sync({"taskGoalControl": "pause"}, self.ref)["ok"])
        with patch.object(local_process.subprocess, "Popen", side_effect=AssertionError("native process started")) as popen:
            self.launch()
            self.assertTrue(self.finished.wait(3))
            popen.assert_not_called()

    def test_stop_waiting_for_launch_kills_the_new_pid_not_the_previous_pid(self):
        entered, release, stopping, stopped = (threading.Event() for _ in range(4))
        process = Mock(pid=22222, stdin=Mock(), poll=Mock(return_value=0))
        killed = []
        self.kill.side_effect = lambda *_args, **_kwargs: killed.append(self.run.get("pid")) or True
        def popen(*_args, **_kwargs):
            entered.set()
            self.assertTrue(release.wait(3))
            return process
        def stop():
            stopping.set()
            local_stream.stop_sync({"taskGoalControl": "pause"}, self.ref)
            stopped.set()
        with patch.object(local_process.subprocess, "Popen", side_effect=popen):
            self.launch()
            self.assertTrue(entered.wait(3))
            stopper = threading.Thread(target=stop, daemon=True)
            stopper.start()
            try:
                self.assertTrue(stopping.wait(3))
                self.assertFalse(stopped.wait(.05), "stop bypassed the atomic PID publication lock")
            finally:
                release.set()
            stopper.join(timeout=3)
            self.assertTrue(stopped.is_set())
            self.assertTrue(self.finished.wait(3))
            self.assertEqual(killed, [22222])

    def test_normal_followup_after_goal_is_disabled_can_start(self):
        goal.control(self.run, "disable")
        self.run.update(stopping=False, state="running")
        with patch.object(local_process.subprocess, "Popen", side_effect=OSError("fixture launch observed")) as popen:
            self.launch()
            self.assertTrue(self.finished.wait(3))
            popen.assert_called_once()

    def test_paused_owned_turn_cannot_launch_even_after_failed_stop_clears_stopping(self):
        self.run["goalTurnOwned"] = True
        self.kill.return_value = False
        self.assertFalse(local_stream.stop_sync({"taskGoalControl": "pause"}, self.ref)["ok"])
        self.assertFalse(self.run["stopping"])
        with patch.object(local_process.subprocess, "Popen", side_effect=AssertionError("native process started")) as popen:
            self.launch()
            self.assertTrue(self.finished.wait(3))
            popen.assert_not_called()

    def test_failed_stop_followed_by_native_success_does_not_invoke_legacy_retries(self):
        self.run.update(goalTurnOwned=True, conversationMode="work", artifactMode="git")
        self.kill.return_value = False
        self.assertFalse(local_stream.stop_sync({"taskGoalControl": "pause"}, self.ref)["ok"])
        with patch.object(local_completion, "assess", return_value={"recover": True, "prompt": "legacy retry"}) as legacy, \
                patch.object(local_stream, "_ends_with_question", return_value=True), \
                patch.object(local_stream, "_resume") as resume, patch.object(ai_local, "_git_delivery"):
            local_stream._finish(self.ref, 0, {}, "")
        legacy.assert_not_called()
        resume.assert_not_called()
        self.assertNotIn("autoAnswered", self.run)
        self.assertEqual(self.run["state"], "stopped")

    def test_disabled_goal_manual_turn_does_not_reopen_legacy_goal_work(self):
        goal.control(self.run, "disable")
        self.run.update(goalTurnOwned=False, conversationMode="work", artifactMode="git")
        with patch.object(local_completion, "assess", return_value={"recover": True, "prompt": "legacy retry"}) as legacy, \
                patch.object(local_stream, "_ends_with_question", return_value=True), \
                patch.object(local_stream, "_resume") as resume, patch.object(ai_local, "_git_delivery"):
            local_stream._finish(self.ref, 0, {}, "")
        legacy.assert_not_called()
        resume.assert_not_called()
        self.assertEqual(self.run["state"], "done")
        self.assertNotIn("autoAnswered", self.run)

    def _context_fixture(self, block):
        self.run.update(goalTurnOwned=True, state="running", stopping=False, cliSid="retained",
                        overflowTried=0, mode="work", contextRequest="continue existing work")
        self.run.pop("goalUserPending", None)
        self.run["goalState"].update(status="working", elapsedMs=0, activeSince=time.time())
        def blocked(*_):
            if block == "human":
                self.run["goalUserPending"] = "new-human-turn"
            else:
                self.run["goalState"]["elapsedMs"] = 240 * 60000
            return True
        return blocked

    def test_human_queue_or_budget_during_relay_does_not_replace_native_session(self):
        profile = {"bin": lambda: "synthetic-agent", "start": lambda *_: ["new-session"], "own_session": False}
        for block in ("human", "budget"):
            with self.subTest(block=block):
                blocked = self._context_fixture(block)
                def handoff(*_):
                    blocked()
                    return "synthetic checkpoint"
                with patch.dict(local_base._PROFILES, {"dsh": profile}), \
                        patch.object(local_ctx, "_handoff_brief", side_effect=handoff), \
                        patch.object(local_stream, "_spawn") as spawn:
                    self.assertFalse(local_ctx._relay(self.ref, "original continuation"))
                self.assertEqual(self.run["cliSid"], "retained")
                self.assertEqual(self.run["segment"], 1)
                self.assertNotIn("contextSegments", self.run)
                spawn.assert_not_called()

    def test_human_queue_or_budget_during_compaction_does_not_resume_native_session(self):
        profile = dict(local_base._PROFILES["dsh"], bin=lambda: "synthetic-agent",
                       resume=lambda *_: ["retained"])
        for block in ("human", "budget"):
            with self.subTest(block=block):
                blocked = self._context_fixture(block)
                with patch.dict(local_base._PROFILES, {"dsh": profile}), \
                        patch.object(local_ctx, "_try_compact", side_effect=blocked), \
                        patch.object(local_stream, "_spawn") as spawn:
                    self.assertFalse(local_ctx._recover_overflow(self.ref))
                self.assertEqual(self.run["cliSid"], "retained")
                self.assertEqual(self.run["segment"], 1)
                spawn.assert_not_called()


class GoalAdmissionStopTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-admission-stop-")
        self.addCleanup(self.temp.cleanup)
        self.ref = "admission-stop-" + uuid.uuid4().hex
        self.run = dict(cli="dsh", state="running", ws=self.temp.name, cfg={}, seq=0,
                        lines=[], queue=[], pid=12345, segment=1, round=1)
        local_base._RUNS[self.ref] = self.run
        self.addCleanup(local_base._RUNS.pop, self.ref, None)
        goal.initialize(self.run, {"schemaVersion": 1, "objective": "Finish a synthetic fixture"})
        for module in (local_base, local_stream, ai_local):
            handle = patch.object(module, "_STORE", self.temp.name)
            handle.start()
            self.addCleanup(handle.stop)
        self.runner = object.__new__(Runner)
        self.runner._admission = runner_admission.AdmissionQueue()
        self.runner._admission_wake = asyncio.Event()
        self.runner._drop_message_transfers = AsyncMock()

    async def test_pause_and_disable_cancel_pending_admission_and_stop_native_goal(self):
        for admission_state in ("queued", "starting"):
            for action in ("pause", "disable"):
                with self.subTest(admission_state=admission_state, action=action):
                    self.run["goalState"]["status"] = "working"
                    self.run.update(state="running", stopping=False)
                    self.runner._admission = runner_admission.AdmissionQueue()
                    item = self.runner._admission.submit("queued-human", self.ref,
                        runner_admission.INTERACTIVE, "comment", {"text": "user correction"})[2]
                    item.state = admission_state
                    self.run["goalUserPending"] = item.key
                    with patch.object(local_stream, "_kill_tree", return_value=True) as kill:
                        result = await self.runner._job({"op": "job.stop", "ref": self.ref,
                                                         "taskGoalControl": action})
                    self.assertTrue(result["data"]["ok"])
                    self.assertEqual(result["data"]["taskGoal"]["status"],
                                     "paused" if action == "pause" else "disabled")
                    self.assertNotIn("goalUserPending", self.run)
                    self.assertTrue(self.run["stopping"])
                    self.assertEqual(item.state, "cancelled")
                    kill.assert_called_once_with(self.ref, expected_pid=12345, expected_proc=None)

    async def test_pi_queued_admission_cancellation_does_not_gain_goal_stop_behavior(self):
        self.run["cli"] = "pi"
        self.runner._admission.submit("queued-human", self.ref,
            runner_admission.INTERACTIVE, "comment", {"text": "queued"})
        with patch.object(local_stream, "stop_sync") as stop:
            result = await self.runner._job({"op": "job.stop", "ref": self.ref, "taskGoalControl": "pause"})
        self.assertTrue(result["ok"])
        stop.assert_not_called()
        self.assertEqual(self.run["goalState"]["status"], "working")


if __name__ == "__main__":
    unittest.main()
