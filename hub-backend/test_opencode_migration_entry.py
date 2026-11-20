"""Legacy migration runs only at owned OpenCode launch boundaries."""
from __future__ import annotations

import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from app.services import acp_bridge, local_base, local_ctx, local_process, local_stream
from app.services import opencode_session_migration as migration
from app.services.opencode_runtime_config import OpenCodeEnvironmentError


class OpenCodeMigrationEntryTests(unittest.TestCase):
    def setUp(self):
        self.folder = self.enterContext(tempfile.TemporaryDirectory(prefix="soduwork-migration-entry-"))
        self.ref = "owned-run"
        self.run = {"cli": "opencode", "cliSid": "ses_owned", "ws": self.folder,
                    "state": "running", "round": 2, "cfg": {}}
        self.enterContext(patch.dict(local_process._RUNS, {self.ref: self.run}, clear=True))
        self.threads = set()
        self.enterContext(patch.object(local_process, "_THREADS", self.threads))
        self.enterContext(patch.object(local_process, "_save_meta"))
        self.enterContext(patch.object(local_process, "_append_raw"))
        self.environment = {"OPENCODE_DB": str(Path(self.folder) / "managed.db")}
        self.env_for = self.enterContext(patch.object(local_process, "_env_for", return_value=self.environment))
        self.command_argv = self.enterContext(patch.object(local_process, "_command_argv", return_value=["fixture-agent"]))
        self.attach_broker = self.enterContext(patch("app.services.access_broker.attach"))
        self.close_broker = self.enterContext(patch("app.services.access_broker.close"))
        self.prepare_spool = self.enterContext(patch.object(
            local_process.local_spool, "prepare", return_value=({"id": "fixture-spool"}, ["fixture-host"])))
        self.cleanup_spool = self.enterContext(patch.object(local_process.local_spool, "cleanup"))
        # Stop after launch admission, without starting an executable or model.
        self.launch = self.enterContext(patch.object(
            local_process.subprocess, "Popen", side_effect=OSError("fixture end of launch")))
        self.migrate = self.enterContext(patch.object(migration, "migrate_session"))
        self.finished = threading.Event()
        self.finish = Mock(side_effect=lambda *args: self.finished.set())

    def spawn(self, *, gate_error="", wait_finished=True):
        local_process.spawn("fixture-opencode", ["run"], "fixture prompt", self.folder, self.ref,
                            {"cliSid": "untrusted-input"}, {},
                            gate_check=lambda *args: gate_error, on_line=Mock(),
                            finish=self.finish, kill_tree=Mock())
        if wait_finished:
            self.assertTrue(self.finished.wait(3), "The launch boundary did not settle")
        for thread in list(self.threads):
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())

    def test_native_resume_migrates_the_archived_id_before_launch(self):
        def launched(*args, **kwargs):
            self.migrate.assert_called_once_with(self.environment, "ses_owned", self.folder,
                                                 "fixture-opencode")
            raise OSError("fixture end of launch")
        self.launch.side_effect = launched
        self.spawn()
        self.assertEqual(self.run["cliSid"], "ses_owned")
        self.env_for.assert_called_once_with({}, {"cliSid": "untrusted-input"}, runtime_ref=self.ref)
        self.launch.assert_called_once()

    def test_failed_migration_preserves_native_id_and_prevents_launch(self):
        reason = "Legacy session requires a compatible database"
        self.migrate.side_effect = migration.OpenCodeSessionMigrationError(reason)
        self.spawn()
        self.assertEqual(self.run["cliSid"], "ses_owned")
        self.assertEqual(self.run["ws"], self.folder)
        self.prepare_spool.assert_not_called()
        self.launch.assert_not_called()
        self.finish.assert_called_once_with(self.ref, 1, {}, reason)

    def test_model_gate_rejects_before_migration(self):
        self.spawn(gate_error="fixture admission denied")
        self.migrate.assert_not_called()
        self.env_for.assert_not_called()
        self.launch.assert_not_called()

    def test_new_opencode_turn_does_not_read_legacy_data(self):
        self.run["cliSid"] = ""
        self.spawn()
        self.migrate.assert_not_called()
        self.launch.assert_called_once()

    def test_other_agents_do_not_migrate_their_native_sessions(self):
        self.run["cli"] = "qwen"
        self.spawn()
        self.migrate.assert_not_called()
        self.launch.assert_called_once()

    def test_stop_during_migration_cannot_launch_the_agent(self):
        def stop(*args):
            self.run["stopping"] = True
        self.migrate.side_effect = stop
        self.spawn()
        self.launch.assert_not_called()
        self.assertEqual(self.run["cliSid"], "ses_owned")
        self.attach_broker.assert_not_called()
        self.close_broker.assert_not_called()
        self.prepare_spool.assert_not_called()

    def test_replaced_worker_during_migration_cannot_launch_or_settle_its_successor(self):
        replacement = {**self.run, "cliSid": "ses_replacement", "_workerIdentity": object(),
                       "stream": {"id": "newer-stream"}, "terminal": {"done": True}}
        def replace(*args):
            local_process._RUNS[self.ref] = replacement
        self.migrate.side_effect = replace
        self.spawn(wait_finished=False)
        self.launch.assert_not_called()
        self.finish.assert_not_called()
        self.assertEqual(replacement["state"], "running")
        self.assertEqual(replacement["cliSid"], "ses_replacement")
        self.assertEqual(replacement["stream"], {"id": "newer-stream"})
        self.assertEqual(replacement["terminal"], {"done": True})
        self.attach_broker.assert_not_called()
        self.close_broker.assert_not_called()
        self.prepare_spool.assert_not_called()

    def test_replaced_worker_before_broker_attachment_cannot_replace_its_channel(self):
        replacement = {**self.run, "_workerIdentity": object()}
        def replace(*args):
            local_process._RUNS[self.ref] = replacement
            return ["fixture-agent"]
        self.command_argv.side_effect = replace
        self.spawn(wait_finished=False)
        self.attach_broker.assert_not_called()
        self.close_broker.assert_not_called()
        self.prepare_spool.assert_not_called()
        self.launch.assert_not_called()

    def test_replaced_worker_during_spool_preparation_keeps_new_state_and_broker(self):
        replacement = {**self.run, "_workerIdentity": object(),
                       "stream": {"id": "newer-stream"}, "terminal": {"done": True}}
        def replace(*args):
            local_process._RUNS[self.ref] = replacement
            return {"id": "fixture-spool"}, ["fixture-host"]
        self.prepare_spool.side_effect = replace
        self.spawn(wait_finished=False)
        self.assertEqual(replacement["stream"], {"id": "newer-stream"})
        self.assertEqual(replacement["terminal"], {"done": True})
        self.attach_broker.assert_called_once()
        self.close_broker.assert_not_called()
        self.cleanup_spool.assert_called_once()
        self.launch.assert_not_called()
        self.finish.assert_not_called()

    def test_replaced_worker_after_spool_error_does_not_close_new_broker(self):
        replacement = {**self.run, "_workerIdentity": object()}
        def replace(*args):
            local_process._RUNS[self.ref] = replacement
            raise OSError("fixture preparation failure")
        self.prepare_spool.side_effect = replace
        self.spawn(wait_finished=False)
        self.close_broker.assert_not_called()
        self.launch.assert_not_called()
        self.finish.assert_not_called()

    def test_stop_during_spool_preparation_cleans_its_own_channel_without_new_stream(self):
        self.run.update(stream={"id": "previous-stream"}, terminal={"previous": True})
        def stop(*args):
            self.run["stopping"] = True
            return {"id": "fixture-spool"}, ["fixture-host"]
        self.prepare_spool.side_effect = stop
        self.spawn()
        self.assertEqual(self.run["stream"], {"id": "previous-stream"})
        self.assertEqual(self.run["terminal"], {"previous": True})
        self.close_broker.assert_called_once_with(self.ref)
        self.cleanup_spool.assert_called_once()
        self.launch.assert_not_called()


class OpenCodeAcpMigrationEntryTests(unittest.TestCase):
    def setUp(self):
        self.folder = self.enterContext(tempfile.TemporaryDirectory(prefix="soduwork-acp-migration-"))
        self.personal = str(Path(self.folder) / "personal.db")
        self.root = Path(self.folder) / "runner"
        self.enterContext(patch.dict(os.environ, {"OPENCODE_DB": self.personal,
            "SODUWORK_DATA_ROOT": str(self.root), "SODUWORK_APPROVAL_CHANNEL": ""}))
        self.migrate = self.enterContext(patch.object(migration, "migrate_session"))
        self.launch = self.enterContext(patch.object(acp_bridge.subprocess, "Popen"))
        self.enterContext(patch.object(acp_bridge.threading, "Thread"))
        self.enterContext(patch.object(acp_bridge, "OwnedProcessGroup"))
        observer = Mock()
        observer.environment.side_effect = lambda env: env
        self.enterContext(patch.object(acp_bridge.opencode_turn_outcome, "Observer", return_value=observer))

    def test_old_parent_acp_resume_repairs_paths_before_migration(self):
        bridge = acp_bridge.AcpBridge(["fixture-opencode", "acp"], self.folder,
                                     "opencode", "workspace", session_id="ses_owned")
        bridge.start()
        self.migrate.assert_called_once()
        env, sid, workspace, executable = self.migrate.call_args.args
        self.assertEqual(sid, "ses_owned")
        self.assertEqual(workspace, self.folder)
        self.assertEqual(executable, "fixture-opencode")
        self.assertEqual(env["SODUWORK_OPENCODE_LEGACY_DB"], self.personal)
        self.assertEqual(Path(env["OPENCODE_DB"]),
                         self.root / "agents/opencode/data/opencode/opencode.db")
        self.assertEqual(self.launch.call_args.kwargs["env"], env)
        self.assertEqual(bridge.session_id, "ses_owned")

    def test_acp_migration_failure_does_not_start_agent_or_replace_session(self):
        self.migrate.side_effect = migration.OpenCodeSessionMigrationError("Unsupported legacy schema")
        bridge = acp_bridge.AcpBridge(["fixture-opencode", "acp"], self.folder,
                                     "opencode", "workspace", session_id="ses_owned")
        with self.assertRaisesRegex(acp_bridge.BridgeError, "Unsupported legacy schema"):
            bridge.start()
        self.launch.assert_not_called()
        self.assertEqual(bridge.session_id, "ses_owned")

    def test_acp_environment_failure_preserves_safe_diagnostic_before_launch(self):
        reason = "OpenCode's private and personal data directories must be separate."
        runtime_config = acp_bridge.opencode_runtime_config
        bridge = acp_bridge.AcpBridge(["fixture-opencode", "acp"], self.folder,
                                     "opencode", "workspace", session_id="ses_owned")
        with patch.object(runtime_config, "prepare_environment", side_effect=
                          runtime_config.OpenCodeEnvironmentError(reason)):
            with self.assertRaises(acp_bridge.BridgeError) as failure:
                bridge.start()
        self.assertEqual(str(failure.exception), reason)
        self.migrate.assert_not_called()
        self.launch.assert_not_called()
        self.assertEqual(bridge.session_id, "ses_owned")

    def test_other_acp_agents_keep_their_environment_and_session(self):
        bridge = acp_bridge.AcpBridge(["fixture-qwen", "--acp"], self.folder,
                                     "qwen", "workspace", session_id="qwen-owned")
        bridge.start()
        self.migrate.assert_not_called()
        self.assertEqual(self.launch.call_args.kwargs["env"]["OPENCODE_DB"], self.personal)
        self.assertEqual(bridge.session_id, "qwen-owned")


class OpenCodeCompactionMigrationTests(unittest.TestCase):
    def setUp(self):
        self.folder = self.enterContext(tempfile.TemporaryDirectory(prefix="soduwork-migration-context-"))
        self.ref = "owned-context"
        self.run = {"cli": "opencode", "cliSid": "ses_owned", "ws": self.folder,
                    "state": "done", "round": 1, "cfg": {}, "ctxWindowKnown": True,
                    "ctxWindow": 10000, "tokens": {"input": 9000}}
        self.enterContext(patch.dict(local_base._RUNS, {self.ref: self.run}, clear=True))
        self.enterContext(patch.dict(local_base._PROFILES["opencode"], {"bin": lambda: "fixture-opencode"}))
        self.enterContext(patch.object(local_ctx, "_save_meta"))
        self.enterContext(patch.object(local_ctx, "_note"))
        self.enterContext(patch.object(local_ctx, "_env_for", return_value={"OPENCODE_DB": "fixture"}))
        self.enterContext(patch.object(local_ctx, "_opencode_bin", return_value="fixture-opencode"))
        self.enterContext(patch.object(local_base, "ctx_pct", return_value=90))
        self.enterContext(patch.object(local_base, "_record_terminal"))
        self.enterContext(patch.object(local_stream, "_window_for", return_value=(10000, True)))
        self.enterContext(patch("app.services.skill_read_scope.for_run"))
        self.enterContext(patch("app.services.access_policy.prepare", return_value=None))
        self.launch = self.enterContext(patch.object(local_stream, "_spawn"))
        self.relay = self.enterContext(patch.object(local_ctx, "_relay"))

    def test_near_full_migration_failure_cannot_become_a_lossy_handoff(self):
        with patch.object(migration, "migrate_session", side_effect=
                          migration.OpenCodeSessionMigrationError("Unsupported legacy schema")) as migrate, \
             patch.object(local_ctx.subprocess, "Popen") as native_server:
            result = local_ctx.prepare_resume(self.ref, "follow up", {})
        self.assertFalse(result["ok"])
        self.assertIn("Unsupported legacy schema", result["error"])
        self.assertEqual(self.run["cliSid"], "ses_owned")
        self.relay.assert_not_called()
        migrate.assert_called_once()
        native_server.assert_not_called()
        self.launch.assert_not_called()

    def test_native_compaction_migration_failure_cannot_replace_overflow_history(self):
        self.run["state"] = "running"
        with patch.dict(local_base._PROFILES["opencode"], {"compact": Mock(side_effect=
                        migration.OpenCodeSessionMigrationError("Unsupported legacy schema"))}):
            result = local_ctx._recover_overflow(self.ref)
        self.assertFalse(result)
        self.assertEqual(self.run["cliSid"], "ses_owned")
        self.relay.assert_not_called()
        self.launch.assert_not_called()

    def test_near_full_environment_guard_cannot_become_a_lossy_handoff(self):
        reason = "The managed OpenCode storage is not isolated"
        with patch.object(local_ctx, "_free_port", return_value=12345), \
                patch.object(local_ctx, "_env_for", side_effect=OpenCodeEnvironmentError(reason)), \
                patch.object(local_ctx.subprocess, "Popen") as native_server:
            result = local_ctx.prepare_resume(self.ref, "follow up", {})
        self.assertEqual(result, {"ok": False, "error": reason})
        self.assertEqual(self.run["state"], "failed")
        self.assertEqual(self.run["cliSid"], "ses_owned")
        self.relay.assert_not_called()
        self.launch.assert_not_called()
        native_server.assert_not_called()

    def test_overflow_environment_guard_cannot_replace_the_original_history(self):
        self.run["state"] = "running"
        reason = "The managed OpenCode storage is not isolated"
        with patch.object(local_ctx, "_free_port", return_value=12345), \
                patch.object(local_ctx, "_env_for", side_effect=OpenCodeEnvironmentError(reason)), \
                patch.object(local_ctx.subprocess, "Popen") as native_server:
            self.assertFalse(local_ctx._recover_overflow(self.ref))
        self.assertEqual(self.run["cliSid"], "ses_owned")
        local_ctx._note.assert_any_call(self.ref, reason)
        self.relay.assert_not_called()
        self.launch.assert_not_called()
        native_server.assert_not_called()

    def test_stop_during_compaction_migration_does_not_start_native_server(self):
        with patch.object(migration, "migrate_session", side_effect=lambda *args: self.run.update(stopping=True)), \
             patch.object(local_ctx.subprocess, "Popen") as native_server:
            self.assertFalse(local_ctx._oc_compact(self.run))
        native_server.assert_not_called()
        self.assertEqual(self.run["cliSid"], "ses_owned")

    def test_acknowledged_stop_wins_over_migration_failure_during_resume(self):
        def stop_and_fail(*args):
            self.assertEqual(local_stream.stop_sync({}, self.ref), {"ok": True, "stopped": True})
            raise migration.OpenCodeSessionMigrationError("Unsupported legacy schema")

        with patch.object(local_ctx, "_free_port", return_value=12345), \
             patch.object(local_stream, "_save_meta"), \
             patch("app.services.access_broker.close"), \
             patch.object(migration, "migrate_session", side_effect=stop_and_fail), \
             patch.object(local_ctx.subprocess, "Popen") as native_server:
            result = local_ctx.prepare_resume(self.ref, "follow up", {})
        self.assertEqual(result, {"ok": True, "stopped": True})
        self.assertEqual(self.run["state"], "stopped")
        self.assertFalse(self.run["stopping"])
        self.assertFalse(self.run["contextCompacting"])
        self.assertEqual(self.run["cfg"], {})
        self.assertEqual(self.run["cliSid"], "ses_owned")
        native_server.assert_not_called()
        self.relay.assert_not_called()
        self.launch.assert_not_called()
        with patch.object(local_stream, "_STORE", self.folder):
            self.assertEqual(local_stream.forget_sync({}, self.ref), {"ok": True, "forgotten": True})

    def test_acknowledged_stop_wins_over_migration_failure_during_overflow(self):
        self.run["state"] = "running"

        def stop_and_fail(*args):
            self.assertEqual(local_stream.stop_sync({}, self.ref), {"ok": True, "stopped": True})
            raise migration.OpenCodeSessionMigrationError("Unsupported legacy schema")

        with patch.dict(local_base._PROFILES["opencode"], {"compact": stop_and_fail}), \
             patch.object(local_stream, "_save_meta"), \
             patch("app.services.access_broker.close"):
            self.assertTrue(local_ctx._recover_overflow(self.ref))
        self.assertEqual(self.run["state"], "stopped")
        self.assertFalse(self.run["stopping"])
        self.assertFalse(self.run["contextCompacting"])
        self.assertEqual(self.run["cliSid"], "ses_owned")
        self.relay.assert_not_called()
        self.launch.assert_not_called()

    def test_replaced_execution_during_resume_compaction_keeps_successor_state(self):
        for replace_run in (False, True):
            for fails in (False, True):
                with self.subTest(replace_run=replace_run, fails=fails):
                    self.run.update(state="done", stopping=False, _workerIdentity=object())
                    local_base._RUNS[self.ref] = self.run
                    successor = self.run.copy() if replace_run else self.run
                    expected = {}

                    def replace(*args):
                        successor.update(state="running", stopping=True, contextCompacting=True,
                                         _workerIdentity=object(), cliSid="ses_successor",
                                         cfg={"successor": True})
                        local_base._RUNS[self.ref] = successor
                        expected.update(successor)
                        if fails:
                            raise migration.OpenCodeSessionMigrationError("Unsupported legacy schema")
                        return False

                    with patch.dict(local_base._PROFILES["opencode"], {"compact": replace}):
                        result = local_ctx.prepare_resume(self.ref, "follow up", {})
                    self.assertEqual(result, {"ok": True, "stopped": True})
                    self.assertIs(local_base._RUNS[self.ref], successor)
                    self.assertEqual(successor, expected)
                    self.relay.assert_not_called()
                    self.launch.assert_not_called()

    def test_replaced_execution_during_binary_probe_cannot_compact_or_fail_its_successor(self):
        for replace_run in (False, True):
            for missing in (False, True):
                with self.subTest(replace_run=replace_run, missing=missing):
                    self.run.update(state="done", stopping=False, _workerIdentity=object())
                    local_base._RUNS[self.ref] = self.run
                    successor = self.run.copy() if replace_run else self.run
                    expected = {}
                    compact = Mock(return_value=True)
                    local_ctx._note.reset_mock()
                    local_ctx._save_meta.reset_mock()

                    def replace_during_probe():
                        successor.update(state="running", stopping=False, contextCompacting=False,
                                         _workerIdentity=object(), cliSid="ses_successor",
                                         cfg={"successor": True}, tokens={"input": 100})
                        local_base._RUNS[self.ref] = successor
                        expected.update(successor)
                        return None if missing else "fixture-opencode"

                    with patch.dict(local_base._PROFILES["opencode"], {
                            "bin": replace_during_probe, "compact": compact}):
                        result = local_ctx.prepare_resume(self.ref, "old follow up", {})
                    self.assertEqual(result, {"ok": True, "stopped": True})
                    self.assertIs(local_base._RUNS[self.ref], successor)
                    self.assertEqual(successor, expected)
                    compact.assert_not_called()
                    local_ctx._note.assert_not_called()
                    local_ctx._save_meta.assert_not_called()
                    self.relay.assert_not_called()
                    self.launch.assert_not_called()

    def test_replaced_execution_before_overflow_compaction_cannot_be_compacted(self):
        original_compact = local_ctx._try_compact
        for replace_run in (False, True):
            with self.subTest(replace_run=replace_run):
                self.run.update(state="running", stopping=False, overflowTried=0, _workerIdentity=object())
                local_base._RUNS[self.ref] = self.run
                successor = self.run.copy() if replace_run else self.run
                expected = {}
                compact = Mock(return_value=True)
                local_ctx._note.reset_mock()
                local_ctx._save_meta.reset_mock()

                def replace_before_compaction(*args, **kwargs):
                    successor.update(state="running", stopping=False, contextCompacting=False,
                                     _workerIdentity=object(), cliSid="ses_successor",
                                     cfg={"successor": True}, tokens={"input": 100})
                    local_base._RUNS[self.ref] = successor
                    expected.update(successor)
                    return original_compact(*args, **kwargs)

                with patch.dict(local_base._PROFILES["opencode"], {"compact": compact}), \
                        patch.object(local_ctx, "_try_compact", side_effect=replace_before_compaction):
                    self.assertTrue(local_ctx._recover_overflow(self.ref))
                self.assertEqual(successor, expected)
                compact.assert_not_called()
                local_ctx._note.assert_not_called()
                local_ctx._save_meta.assert_not_called()
                self.relay.assert_not_called()
                self.launch.assert_not_called()

    def test_replaced_execution_during_overflow_failure_cannot_receive_old_diagnostic(self):
        self.run.update(state="running", _workerIdentity=object())
        successor = self.run.copy()
        expected = {}

        def replace_and_fail(*args):
            successor.update(state="running", stopping=True, contextCompacting=True,
                             _workerIdentity=object(), cliSid="ses_successor", cfg={"successor": True})
            local_base._RUNS[self.ref] = successor
            expected.update(successor)
            raise migration.OpenCodeSessionMigrationError("Unsupported legacy schema")

        with patch.dict(local_base._PROFILES["opencode"], {"compact": replace_and_fail}):
            self.assertTrue(local_ctx._recover_overflow(self.ref))
        self.assertEqual(successor, expected)
        self.assertNotIn("Unsupported legacy schema", [call.args[1] for call in local_ctx._note.call_args_list])
        self.relay.assert_not_called()
        self.launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
