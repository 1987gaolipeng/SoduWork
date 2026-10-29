"""Runner upload cleanup uses private directories and never launches an Agent."""
from __future__ import annotations

import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""

import runner_main
from app.services import ai_local, dispatch_identity, local_base


class RunnerInputCleanupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-input-cleanup-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        data_root = patch.object(local_base, "_data_root", return_value=self.temp.name)
        data_root.start()
        self.addCleanup(data_root.stop)
        self.machine = runner_main.Runner.__new__(runner_main.Runner)
        self.machine.work_root = self.temp.name
        self.machine.capability_grants = []
        self.machine.boot_id = "fixture-boot"
        self.machine._dispatching_refs = set()
        self.machine._skill_inventory = []
        self.machine._skill_catalog = []
        gate = patch.object(runner_main, "_capability_gate", return_value=None)
        gate.start()
        self.addCleanup(gate.stop)

    def upload(self, transfer):
        root = Path(runner_main._input_root(transfer))
        root.mkdir(parents=True)
        (root / "00.bin").write_bytes(b"private fixture upload")
        return root

    def message(self, transfer, *, admitted=False):
        return {"op": "job.dispatch", "dispatchId": "d" * 32,
                "_admitted": admitted, "task": {"id": "fixture-task"},
                "files": {"transfer": transfer}, "skills": {"transfer": transfer}}

    async def test_message_keep_filter_preserves_original_upload_and_local_files(self):
        original = self.upload("a" * 32)
        duplicate = self.upload("b" * 32)
        local_file = self.root / "user-owned.txt"
        local_file.write_text("local parent input", encoding="utf-8")
        await self.machine._drop_message_transfers({
            "files": {"transfer": "b" * 32}, "skills": {"transfer": "a" * 32},
            "localFiles": [{"path": str(local_file)}],
        }, keep={"a" * 32})
        self.assertFalse(duplicate.exists())
        self.assertTrue(original.exists())
        self.assertEqual(local_file.read_text(encoding="utf-8"), "local parent input")

    async def test_message_cleanup_keeps_packet_order_and_runs_off_event_loop(self):
        files, skills = self.upload("a" * 32), self.upload("b" * 32)
        event_thread = threading.get_ident()
        removed = []
        rmtree = runner_main.shutil.rmtree

        def remove(root, ignore_errors):
            removed.append((Path(root), ignore_errors, threading.get_ident()))
            return rmtree(root, ignore_errors)

        with patch.object(runner_main.shutil, "rmtree", side_effect=remove):
            await self.machine._drop_message_transfers({
                "files": {"transfer": "a" * 32}, "skills": {"transfer": "b" * 32}})
        self.assertEqual([item[:2] for item in removed], [(files, True), (skills, True)])
        self.assertTrue(all(item[2] != event_thread for item in removed))

    async def test_invalid_or_malformed_packets_cannot_remove_user_directory(self):
        local_file = self.root / "user-owned.txt"
        local_file.write_bytes(b"keep")
        for packet in ({"transfer": "../"}, {"transfer": str(self.root)}, [], "bad", None):
            with self.subTest(packet=packet):
                await self.machine._drop_message_transfers({"files": packet})
        self.assertEqual(local_file.read_bytes(), b"keep")

    async def test_persisted_duplicate_deduplicates_transfer_and_never_dispatches(self):
        upload = self.upload("a" * 32)
        ref = dispatch_identity.execution_ref("d" * 32)
        with patch.dict(ai_local._RUNS, {ref: {"state": "running"}}, clear=True), \
             patch.object(ai_local, "status_sync", return_value={"status": "running"}), \
             patch.object(ai_local, "dispatch_sync") as dispatch, \
             patch.object(runner_main.shutil, "rmtree", wraps=runner_main.shutil.rmtree) as remove:
            result = await self.machine._job(self.message("a" * 32))
        self.assertTrue(result["data"]["duplicate"])
        self.assertEqual(result["data"]["ref"], ref)
        dispatch.assert_not_called()
        remove.assert_called_once_with(str(upload), True)
        self.assertFalse(upload.exists())

    async def test_inflight_duplicate_cleans_only_its_upload_and_keeps_fence(self):
        upload = self.upload("a" * 32)
        ref = dispatch_identity.execution_ref("d" * 32)
        self.machine._dispatching_refs.add(ref)
        with patch.dict(ai_local._RUNS, {}, clear=True), \
             patch.object(ai_local, "dispatch_sync") as dispatch:
            result = await self.machine._job(self.message("a" * 32, admitted=True))
        self.assertEqual(result["code"], "DISPATCH_IN_PROGRESS")
        self.assertTrue(result["uncertain"])
        self.assertEqual(self.machine._dispatching_refs, {ref})
        dispatch.assert_not_called()
        self.assertFalse(upload.exists())

    async def test_dispatch_cleans_after_consuming_upload_and_releases_fence(self):
        upload = self.upload("a" * 32)
        ref = dispatch_identity.execution_ref("d" * 32)
        events = []
        rmtree = runner_main.shutil.rmtree

        def dispatch(*_args, **_kwargs):
            self.assertTrue(upload.exists())
            events.append("dispatch")
            return {"ok": True, "issueId": ref}

        def remove(root, ignore_errors):
            events.append("cleanup")
            return rmtree(root, ignore_errors)

        with patch.dict(ai_local._RUNS, {}, clear=True), \
             patch.object(ai_local, "dispatch_sync", side_effect=dispatch), \
             patch.object(runner_main.shutil, "rmtree", side_effect=remove):
            result = await self.machine._job(self.message("a" * 32, admitted=True))
        self.assertTrue(result["ok"])
        self.assertEqual(events, ["dispatch", "cleanup"])
        self.assertFalse(upload.exists())
        self.assertEqual(self.machine._dispatching_refs, set())

    async def test_preflight_failure_still_deduplicates_cleanup_and_releases_fence(self):
        upload = self.upload("a" * 32)
        with patch.dict(ai_local._RUNS, {}, clear=True), \
             patch.object(runner_main, "_read_packet", side_effect=ValueError("fixture packet refused")), \
             patch.object(runner_main.shutil, "rmtree", wraps=runner_main.shutil.rmtree) as remove:
            with self.assertRaisesRegex(ValueError, "fixture packet refused"):
                await self.machine._job(self.message("a" * 32, admitted=True))
        remove.assert_called_once_with(str(upload), True)
        self.assertFalse(upload.exists())
        self.assertEqual(self.machine._dispatching_refs, set())


if __name__ == "__main__":
    unittest.main()
