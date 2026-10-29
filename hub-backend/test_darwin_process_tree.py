"""Simulated Darwin process ownership and cancellation; no signals reach the host."""
from __future__ import annotations

import importlib
import types
import unittest
from dataclasses import replace
from unittest.mock import patch


class DarwinTreeTest(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec("app.services.darwin_process_tree"),
                             "Darwin cancellation needs descendant-aware cleanup")
        return importlib.import_module("app.services.darwin_process_tree")

    def run_tree(self, *, root_group=100, root_uid=501, root_session=100,
                 replaced=False, failure=False, late_child=False, survives=False):
        tree = self.module()
        process = tree.Process
        rows = {
            100: process(100, 10, root_group, root_uid, "root-start", "S"),
            101: process(101, 100, 101, 501, "child-start", "S"),
            102: process(102, 101, 102, 501, "terminal-start", "S"),
            # Group membership alone must never grant cancellation ownership.
            200: process(200, 10, 101, 501, "unrelated-start", "S"),
        }
        signals, snapshots = [], []
        sig = types.SimpleNamespace(SIGSTOP=17, SIGCONT=19, SIGKILL=9)
        def snapshot():
            snapshots.append(True)
            return dict(rows)
        def read(pid):
            return rows.get(pid)
        def send(pid, signal):
            signals.append((pid, signal))
            if signal == sig.SIGSTOP:
                if failure and pid == 101:
                    raise PermissionError("fixture denied stop")
                rows[pid] = replace(rows[pid], state="T")
                if late_child and pid == 101:
                    rows[103] = process(103, 101, 103, 501, "late-start", "S")
                if replaced and pid == 102:
                    rows[102] = process(102, 200, 102, 501, "replacement-start", "S")
            elif signal == sig.SIGCONT:
                rows[pid] = replace(rows[pid], state="S")
            elif signal == sig.SIGKILL and not (survives and pid == 102):
                rows.pop(pid, None)
        ticks = iter(range(100))
        with (patch.object(tree, "_snapshot", side_effect=snapshot),
              patch.object(tree, "read_process", side_effect=read),
              patch.object(tree, "signal", sig),
              patch.object(tree.os, "kill", side_effect=send),
              patch.object(tree.os, "getpid", return_value=10),
              patch.object(tree.os, "getuid", return_value=501, create=True),
              patch.object(tree.os, "getsid", return_value=root_session, create=True),
              patch.object(tree.time, "monotonic", side_effect=lambda: next(ticks) * .2),
              patch.object(tree.time, "sleep")):
            error = None
            try:
                tree.kill_owned_tree(100)
            except (PermissionError, ValueError, TimeoutError) as exc:
                error = exc
        return rows, signals, error

    def test_detached_child_sessions_stop_before_root_and_unrelated_process_survives(self):
        rows, signals, error = self.run_tree()
        self.assertIsNone(error)
        self.assertEqual(set(rows), {200})
        killed = [pid for pid, signal in signals if signal == 9]
        self.assertEqual(set(killed), {100, 101, 102})
        self.assertEqual(killed[-1], 100)
        self.assertFalse(any(pid == 200 for pid, _ in signals))

    def test_pid_replacement_is_not_killed_or_resumed(self):
        rows, signals, error = self.run_tree(replaced=True)
        self.assertIsNone(error)
        self.assertEqual(rows[102].started, "replacement-start")
        self.assertNotIn((102, 9), signals)
        self.assertNotIn((102, 19), signals)

    def test_descendant_created_while_parents_stop_is_collected(self):
        rows, signals, error = self.run_tree(late_child=True)
        self.assertIsNone(error)
        self.assertEqual(set(rows), {200})
        self.assertIn((103, 9), signals)

    def test_nonprivate_root_is_rejected_before_any_signal(self):
        for invalid in ({"root_group": 10}, {"root_uid": 502}, {"root_session": 10}):
            with self.subTest(invalid=invalid):
                _rows, signals, error = self.run_tree(**invalid)
                self.assertIsInstance(error, ValueError)
                self.assertEqual(signals, [])

    def test_failed_collection_resumes_owned_processes_without_claiming_completion(self):
        rows, signals, error = self.run_tree(failure=True)
        self.assertIsInstance(error, PermissionError)
        self.assertEqual(rows[100].state, "S")
        self.assertIn((100, 19), signals)
        self.assertFalse(any(signal == 9 for _, signal in signals))

    def test_live_descendant_prevents_root_exit_and_false_stop_confirmation(self):
        rows, signals, error = self.run_tree(survives=True)
        self.assertIsInstance(error, TimeoutError)
        self.assertIn(100, rows)
        self.assertIn(102, rows)
        self.assertNotIn((100, 9), signals)
        self.assertEqual(rows[100].state, "S")
        self.assertEqual(rows[102].state, "S")

    def test_local_stop_routes_darwin_to_descendant_cleanup_and_reports_failure(self):
        from app.services import local_stream
        tree = self.module()
        proc = object()
        with (patch.object(local_stream, "_WIN", False),
              patch.object(local_stream, "sys", types.SimpleNamespace(platform="darwin")),
              patch.object(local_stream, "_pid_alive", return_value=False),
              patch.object(tree, "kill_owned_tree") as kill):
            self.assertTrue(local_stream._kill_pid_tree(100, proc))
            kill.assert_called_once_with(100, proc)
            kill.side_effect = TimeoutError("fixture live descendant")
            with self.assertLogs("uvicorn.error", level="WARNING"):
                self.assertFalse(local_stream._kill_pid_tree(100, proc))

    def test_ps_snapshot_uses_fixed_program_locale_timeout_and_rejects_malformed_rows(self):
        tree = self.module()
        result = types.SimpleNamespace(returncode=0,
            stdout="100 10 100 501 S Tue Oct 20 12:30:45 2026\n", stderr="")
        with patch.object(tree.subprocess, "run", return_value=result) as run:
            snapshot = tree._snapshot()
        self.assertEqual(snapshot[100].started, "Tue Oct 20 12:30:45 2026")
        self.assertEqual(run.call_args.args[0][0], "/bin/ps")
        self.assertEqual(run.call_args.kwargs["env"]["LC_ALL"], "C")
        self.assertLessEqual(run.call_args.kwargs["timeout"], 3)
        result.stdout = "invalid process row"
        with patch.object(tree.subprocess, "run", return_value=result):
            with self.assertRaises(ValueError):
                tree._snapshot()


if __name__ == "__main__":
    unittest.main()
