"""Fault injection at real local conversation storage and admission boundaries."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import local_base, local_ctx, local_process, local_stream, runner_comments


class HistoryStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.object(local_base, "_STORE", self.temp))
        self.ref = "test-history"
        self.run = {"state": "running", "round": 1, "segment": 1, "seq": 0,
                    "lines": [], "cli": "pi", "ws": self.temp, "admissionKey": "dispatch:fixture"}
        self.enterContext(patch.dict(local_base._RUNS, {self.ref: self.run}))
        self.path = Path(local_base._store_dir(self.ref), "events.jsonl")

    def test_failed_input_is_not_acknowledged_or_dispatched(self):
        self.path.mkdir()
        with patch.object(local_stream, "comment_sync", return_value={"ok": True}) as send:
            response = asyncio.run(runner_comments.comment(None, {
                "ref": self.ref, "_admitted": True, "recordUser": True, "text": "first",
            }, None))
        self.assertFalse(response["ok"])
        send.assert_not_called()
        self.assertEqual((self.run["seq"], self.run["lines"]), (0, []))
        self.path.rmdir()
        self.assertTrue(local_stream.record_user_sync(self.ref, "first")["ok"])
        self.assertEqual([item["seq"] for item in local_base._read_events(self.ref)], [1])

    def test_native_output_failure_preserves_spool_cursor_and_blocks_replay(self):
        self.path.mkdir()
        stream = {"id": "stream-id", "offsets": {"out": 3}}
        self.run["stream"] = stream
        with self.assertRaises(OSError):
            local_process._consume_stream(self.ref, stream, {}, "out", json.dumps({
                "type": "text", "part": {"text": "native answer"}}), 80, local_stream._on_line)
        self.assertEqual(self.run["stream"]["offsets"], {"out": 3})
        self.assertEqual(self.run["seq"], 0)
        local_stream._finish(self.ref, 0, {"completed": True}, "")
        self.assertEqual(self.run["state"], "failed")
        self.assertFalse(local_ctx.prepare_resume(self.ref, "automatic", {}, recovery=True)["ok"])
        self.assertEqual(json.loads(self.path.with_name("meta.json").read_text())["state"], "failed")

    def test_running_sidecar_stops_and_retains_unacknowledged_output(self):
        self.path.mkdir()
        args = ["-c", "import time; print('fixture output', flush=True); time.sleep(30)"]
        workers = set(local_process._THREADS)
        with (patch.object(local_process, "_env_for", return_value={}),
              patch.object(local_process, "_command_argv", return_value=[sys.executable, *args])):
            local_process.spawn(sys.executable, args, "fixture", self.temp, self.ref, {}, {},
                                gate_check=lambda *a: "", on_line=local_stream._on_line,
                                finish=local_stream._finish, kill_tree=local_stream._kill_tree)
            worker, = set(local_process._THREADS) - workers
            try:
                worker.join(timeout=15)
                self.assertFalse(worker.is_alive())
                self.assertEqual(self.run["state"], "failed")
                self.assertIsNone(self.run["pid"])
                stream = self.run["stream"]
                self.assertEqual(stream["offsets"]["out"], 0)
                spool = self.path.with_name(stream["stdout"])
                self.assertIn(b"fixture output", spool.read_bytes())
            finally:
                proc = self.run.get("proc")
                if proc is not None and proc.poll() is None:
                    local_stream._kill_tree(self.ref, expected_pid=proc.pid, expected_proc=proc)
                worker.join(timeout=10)

    def test_duplicate_callbacks_acknowledge_each_stream_position_only_once(self):
        stream = {"id": "current", "offsets": {"out": 0, "err": 0}}
        self.run["stream"] = stream

        def consume(line_stream):
            local_process._consume_stream(self.ref, stream, {}, line_stream, line_stream, 52,
                                          lambda ref, raw, term, **kwargs: local_base._record_event(
                                              ref, {"kind": "say", "text": raw}))

        with ThreadPoolExecutor(max_workers=5) as pool:
            list(pool.map(consume, ["out", "err"] * 5))
        self.assertCountEqual([e["text"] for e in local_base._read_events(self.ref)], ["out", "err"])
        self.assertEqual(self.run["stream"]["offsets"], {"out": 52, "err": 52})

    def test_recovery_uses_only_offsets_from_the_current_spool(self):
        self.run.update(stream={"id": "second", "offsets": {"out": 0}}, turnStartSeq=5,
                        lines=[{"seq": 3, "_stream": "out", "_streamEnd": 9999},
                               {"seq": 6, "_stream": "out", "_streamId": "first", "_streamEnd": 8888},
                               {"seq": 7, "_stream": "out", "_streamId": "second", "_streamEnd": 84}])
        local_base._restore_stream_checkpoint(self.run)
        self.assertEqual(self.run["stream"]["offsets"], {"out": 84})

    def test_terminal_is_idempotent_after_journal_commit_before_metadata_replacement(self):
        self.run["state"] = "done"
        local_base._save_meta(self.ref)
        del self.run["turnEndIdentity"]
        local_base._restore_stream_checkpoint(self.run)
        local_base._save_meta(self.ref)
        self.assertEqual([event["kind"] for event in local_base._read_events(self.ref)], ["turn-end"])

    def test_followup_rehydrates_a_cold_archive_before_recording(self):
        self.run["state"] = "done"
        local_base._save_meta(self.ref)
        del local_base._RUNS[self.ref]
        result = local_stream.record_user_sync(self.ref, "another question")
        self.assertTrue(result["ok"])
        self.assertEqual([event["kind"] for event in local_base._read_events(self.ref)], ["turn-end", "user"])

    def test_failed_terminal_is_not_committed_as_done(self):
        self.path.mkdir()
        self.run["state"] = "done"
        local_base._save_meta(self.ref)
        self.assertEqual(self.run["state"], "failed")
        self.assertFalse(self.run.get("turnEndIdentity"))
        self.assertEqual((self.run["seq"], self.run["lines"]), (0, []))
        self.assertEqual(json.loads(self.path.with_name("meta.json").read_text())["state"], "failed")

    def test_failed_fsync_keeps_previous_committed_bytes(self):
        local_stream.record_user_sync(self.ref, "first")
        previous = self.path.read_bytes()
        with patch.object(local_base.os, "fsync", side_effect=OSError("disk full")):
            self.assertFalse(local_stream.record_user_sync(self.ref, "second")["ok"])
        self.assertEqual(self.path.read_bytes(), previous)
        self.assertEqual(self.run["seq"], 1)
        self.assertTrue(local_stream.record_user_sync(self.ref, "second")["ok"])
        self.assertEqual([r["text"] for r in local_base._read_events(self.ref)], ["first", "second"])

    def test_concurrent_writes_have_identical_file_and_visible_order(self):
        with ThreadPoolExecutor(max_workers=5) as pool:
            results = list(pool.map(lambda n: local_stream.record_user_sync(self.ref, str(n)), range(30)))
        self.assertTrue(all(r["ok"] for r in results))
        self.assertEqual(self.run["lines"], local_base._read_events(self.ref))
        self.assertEqual([r["seq"] for r in self.run["lines"]], list(range(1, 31)))


if __name__ == "__main__":
    unittest.main()
