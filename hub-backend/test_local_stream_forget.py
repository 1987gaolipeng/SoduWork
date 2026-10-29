import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import local_base, local_stream


class ForgetLocalSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-forget-")
        self.original_store = local_stream._STORE
        local_stream._STORE = self.temp.name

    def tearDown(self):
        local_stream._STORE = self.original_store
        self.temp.cleanup()

    def prepare(self, ref):
        target = Path(self.temp.name) / ref
        target.mkdir(parents=True)
        (target / "meta.json").write_text("{}", encoding="utf-8")
        local_stream._RUNS[ref] = {"state": "failed"}
        local_base._RAW_SIZE[ref] = 12
        self.addCleanup(local_stream._RUNS.pop, ref, None)
        self.addCleanup(local_base._RAW_SIZE.pop, ref, None)
        return target

    def test_forget_removes_durable_record_and_memory(self):
        ref = "chat-delete-success"
        target = self.prepare(ref)
        result = local_stream.forget_sync({}, ref)
        self.assertEqual(result, {"ok": True, "forgotten": True})
        self.assertFalse(target.exists())
        self.assertNotIn(ref, local_stream._RUNS)
        self.assertNotIn(ref, local_base._RAW_SIZE)

    def test_forget_keeps_memory_when_durable_delete_fails(self):
        ref = "chat-delete-denied"
        target = self.prepare(ref)
        with patch.object(local_stream.shutil, "rmtree", side_effect=PermissionError("locked")):
            result = local_stream.forget_sync({}, ref)
        self.assertFalse(result["ok"])
        self.assertIn("删除失败", result["error"])
        self.assertTrue(target.exists())
        self.assertIn(ref, local_stream._RUNS)

    def test_forget_refuses_running_record(self):
        ref = "chat-delete-running"
        target = self.prepare(ref)
        local_stream._RUNS[ref]["state"] = "running"
        result = local_stream.forget_sync({}, ref)
        self.assertFalse(result["ok"])
        self.assertTrue(target.exists())
        self.assertIn(ref, local_stream._RUNS)


if __name__ == "__main__":
    unittest.main()
