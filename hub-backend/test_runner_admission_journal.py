"""Durable admission rules, privacy and conservative crash recovery."""
import os
import asyncio
import errno
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from app.services.runner_admission import AdmissionQueue, INTERACTIVE, MANUAL
from app.services.runner_admission_journal import Journal
from app.services import durable_file


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="soduwork-queue-test-")
        self.addCleanup(self.tmp.cleanup)
        self.store = Journal(self.tmp.name, "isolated-runner")

    def queue(self):
        return AdmissionQueue(journal=self.store)

    def submit(self, queue, key="turn-one", ref="session", operation="comment"):
        return queue.submit(key, ref, INTERACTIVE, operation,
                            {"cfg": {"key": "secret-test-value"}, "text": "exact prompt"})[2]

    def test_private_payload_roundtrips_and_is_removed_after_launch(self):
        queue = self.queue()
        item = self.submit(queue)
        blob = self.store.path(item.key).read_bytes()
        if os.name == "nt":
            self.assertTrue(blob.startswith(b"DPAPI\n"))
            self.assertNotIn(b"secret-test-value", blob)
        else:
            self.assertEqual(stat.S_IMODE(self.store.path(item.key).stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(self.store.root.stat().st_mode), 0o700)
        restored = self.queue().get(item.key)
        self.assertEqual(restored.payload["cfg"]["key"], "secret-test-value")
        queue.mark_running(item.key, {"ref": item.ref})
        self.assertIsNone(self.queue().get(item.key).payload)

    def test_restart_keeps_order_priority_cancellation_and_dedup(self):
        queue = self.queue()
        queue.submit("background", "bg", MANUAL, "dispatch", {})
        self.submit(queue, "first", "a")
        self.submit(queue, "second", "b")
        self.submit(queue, "cancel", "c")
        queue.cancel_ref("c")
        restored = self.queue()
        restored.recover({})
        self.assertEqual(restored.claim_next(0, 2, True).key, "first")
        restored.finish("first", "completed")
        self.assertEqual(restored.claim_next(0, 2, True).key, "second")
        self.assertEqual(restored.get("cancel").state, "cancelled")
        self.assertEqual(restored.submit("first", "a", INTERACTIVE, "comment", {})[1], "duplicate")

    def test_starting_crash_is_not_replayed_or_confused_with_previous_turn(self):
        queue = self.queue()
        self.submit(queue)
        queue.claim_next(0, 1, True)
        restored = self.queue()
        restored.recover({"session": {"state": "done", "admissionKey": "previous-turn"}})
        self.assertEqual(restored.get("turn-one").state, "failed")
        self.assertTrue(restored.get("turn-one").result["uncertain"])
        self.assertIsNone(restored.claim_next(0, 1, True))

    def test_matching_native_turn_recovers_without_relaunch(self):
        queue = self.queue()
        self.submit(queue)
        queue.claim_next(0, 1, True)
        restored = self.queue()
        restored.recover({"session": {"state": "running", "admissionKey": "turn-one"}})
        self.assertEqual(restored.get("turn-one").state, "running")
        self.assertIsNone(restored.claim_next(0, 1, True))

    def test_write_failure_never_acknowledges_or_claims_work(self):
        queue = self.queue()
        with patch.object(self.store, "write", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.submit(queue)
        self.assertIsNone(queue.get("turn-one"))
        self.submit(queue)
        with patch.object(self.store, "write", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                queue.claim_next(0, 1, True)
        self.assertEqual(queue.get("turn-one").state, "queued")
        self.assertEqual(self.queue().get("turn-one").state, "queued")

    def test_corruption_and_other_runner_do_not_silently_replay(self):
        queue = self.queue()
        item = self.submit(queue)
        self.assertEqual(Journal(self.tmp.name, "different-runner").read(), [])
        self.store.path(item.key).write_bytes(b"broken")
        with self.assertRaises((OSError, ValueError)):
            self.queue()

    def test_exdev_keeps_dpapi_and_restart_receipt_without_duplicate_launch(self):
        queue = self.queue()
        with patch.object(durable_file.os, "replace", side_effect=OSError(errno.EXDEV, "injected")):
            item = self.submit(queue)
        encoded = durable_file.read_bytes(self.store.path(item.key))
        if os.name == "nt":
            self.assertTrue(encoded.startswith(b"DPAPI\n"))
            self.assertNotIn(b"secret-test-value", encoded)
        restored = self.queue()
        self.assertEqual(restored.get(item.key).payload["cfg"]["key"], "secret-test-value")
        self.assertEqual(restored.submit(item.key, item.ref, INTERACTIVE, "comment", {})[1], "duplicate")
        restored.claim_next(0, 1, True)
        recovered = self.queue()
        recovered.recover({})
        self.assertEqual(recovered.get(item.key).state, "failed")
        self.assertTrue(recovered.get(item.key).result["uncertain"])
        self.assertIsNone(recovered.claim_next(0, 1, True))

    def test_interrupted_update_keeps_acknowledged_queue_on_restart(self):
        queue = self.queue()
        self.submit(queue)
        with patch.object(durable_file.os, "replace", side_effect=OSError(errno.EXDEV, "injected")):
            queue.claim_next(0, 1, True)
        path = Path(str(self.store.path("turn-one")) + ".wal")
        with path.open("ab") as out:
            out.write(b'{"size":123,"data":"interrupted')
        recovered = self.queue()
        self.assertEqual(recovered.get("turn-one").state, "starting")
        recovered.recover({})
        self.assertIsNone(recovered.claim_next(0, 1, True))

    def test_non_exdev_storage_failure_keeps_old_durable_and_memory_state(self):
        queue = self.queue()
        self.submit(queue)
        with patch.object(durable_file.os, "replace", side_effect=OSError(errno.EACCES, "injected")):
            with self.assertRaises(OSError):
                queue.claim_next(0, 1, True)
        self.assertEqual(queue.get("turn-one").state, "queued")
        self.assertEqual(self.queue().get("turn-one").state, "queued")

    def test_interrupted_same_extension_staging_is_never_admitted(self):
        queue = self.queue()
        item = self.submit(queue)
        encoded = self.store.path(item.key).read_bytes()
        (self.store.root / ".soduwork-write-0123456789abcdef.queue").write_bytes(encoded)
        (self.store.root / ".soduwork-write-fedcba9876543210.queue").write_bytes(encoded[:10])
        restored = self.queue()
        self.assertEqual([row["key"] for row in self.store.read()], [item.key])
        self.assertEqual(restored.claim_next(0, 1, True).key, item.key)
        self.assertIsNone(restored.claim_next(0, 2, True))

    def test_only_one_runner_can_own_queue_and_lock_releases_on_close(self):
        first = Journal(self.tmp.name, "leased", exclusive=True)
        self.addCleanup(first.close)
        with self.assertRaises(OSError):
            Journal(self.tmp.name, "leased", exclusive=True)
        first.close()
        replacement = Journal(self.tmp.name, "leased", exclusive=True)
        replacement.close()

    def test_deep_data_root_stays_under_windows_max_path(self):
        """LongPathsEnabled=0 machines reject paths beyond 260 characters.

        The runner mounts the journal at <dataRoot>/runner-queue/<sha256>; the
        hashed identity directory plus the temporary record name dominated the
        path length, so a deep data root (as in installer compatibility fixtures
        under a long %TEMP%) used to fail every dispatch with
        RUNNER_QUEUE_STORAGE. The temporary name must stay short enough that a
        queue root of 95 characters still fits within MAX_PATH.
        """
        base = tempfile.mkdtemp(prefix="soduwork-queue-maxpath-")
        target = 95
        if len(base) < target:
            pad = "x" * (target - len(base) - 1)  # minus the path separator
            root = os.path.join(base, pad)
            os.makedirs(root, exist_ok=True)
        else:
            root = base
        self.assertLessEqual(len(root), target)
        store = Journal(root, "deep-root-runner")
        queue = AdmissionQueue(journal=store)
        item = queue.submit("turn-one", "session", INTERACTIVE, "comment", {"text": "work"})[2]
        self.assertEqual(queue.get("turn-one").state, "queued")
        restored = AdmissionQueue(journal=Journal(root=Path(root), identity="deep-root-runner")).get("turn-one")
        self.assertIsNotNone(restored)
        self.assertEqual(restored.ref, item.ref)


class RunnerStopReceiptTests(unittest.IsolatedAsyncioTestCase):
    """A failed native stop must not acknowledge cancellation or release a lane."""

    def setUp(self):
        from runner_main import Runner
        self.tmp = tempfile.TemporaryDirectory(prefix="soduwork-stop-receipt-")
        self.addCleanup(self.tmp.cleanup)
        self.store = Journal(self.tmp.name, "stop-test")
        self.runner = object.__new__(Runner)
        self.runner._admission = AdmissionQueue(journal=self.store)
        self.runner._admission_wake = asyncio.Event()
        self.runner._admission_workers = set()
        self.runner._job = AsyncMock(return_value={"ok": True, "data": {"ref": "session"}})
        self.queue = self.runner._admission
        self.item = self.queue.submit("first", "session", INTERACTIVE, "comment", {"text": "work"})[2]
        self.queue.claim_next(0, 1, True)
        self.queue.cancel_ref("session")

    def assert_still_owned(self):
        self.assertEqual(self.item.state, "running")
        self.assertTrue(self.item.cancel_requested)
        self.assertEqual(AdmissionQueue(journal=self.store).get("first").state, "running")
        self.queue.submit("next", "session", INTERACTIVE, "comment", {"text": "next turn"})
        self.assertIsNone(self.queue.claim_next(0, 2, True), "failed stop cannot release same-session serialization")

    async def test_failed_stop_after_launch_keeps_durable_running_state(self):
        with patch("app.services.local_stream.stop_sync", return_value={"ok": False, "error": "kill denied"}):
            await self.runner._run_admitted(self.item)
        self.assert_still_owned()
        with patch("app.services.local_stream.stop_sync", return_value={"ok": True, "stopped": True}):
            await self.runner._stop_admitted(self.item)
        self.assertEqual(self.item.state, "cancelled")
        self.assertEqual(self.queue.claim_next(0, 2, True).key, "next")

    async def test_stop_exception_after_launch_does_not_destroy_worker_or_ack_cancel(self):
        with patch("app.services.local_stream.stop_sync", side_effect=OSError("control pipe unavailable")):
            await self.runner._run_admitted(self.item)
        self.assert_still_owned()
        self.assertTrue(self.runner._admission_wake.is_set())

    async def test_restart_failed_stop_keeps_same_session_fence(self):
        from app.services import ai_local
        stop = Mock(return_value={"ok": False, "error": "kill denied"})
        self.runner._resource_budget = SimpleNamespace(snapshot=lambda: SimpleNamespace(limit=1, can_start=False))
        with patch.object(ai_local, "reclaim"), patch.dict(ai_local._RUNS, {
            "session": {"state": "running", "admissionKey": "first"}}, clear=True), \
                patch("app.services.local_stream.stop_sync", stop):
            loop = asyncio.create_task(self.runner._admission_loop())
            try:
                for _ in range(100):
                    if stop.called:
                        break
                    await asyncio.sleep(0.005)
                await asyncio.sleep(0.01)
                self.assertTrue(stop.called)
                self.assertFalse(loop.done(), "a refused cancellation must not terminate admission scheduling")
                self.assert_still_owned()
            finally:
                loop.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await loop


if __name__ == "__main__":
    unittest.main()
