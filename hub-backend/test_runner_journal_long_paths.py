"""Real deep filesystem paths, DPAPI, process recovery and queue ownership."""
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from app.services import durable_file
from app.services.runner_admission import AdmissionQueue, INTERACTIVE
from app.services.runner_admission_journal import Journal


class JournalLongPathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="soduwork-journal-long-")
        self.addCleanup(self.tmp.cleanup)
        # Identity, final record and WAL exceed MAX_PATH, but no component is
        # too long. Do not change the machine's LongPathsEnabled setting.
        self.root = Path(self.tmp.name) / ("a" * 95) / ("b" * 95) / "runner-queue"

    def test_deep_queue_survives_real_process_restart_and_releases_owner(self):
        store = Journal(self.root, "deep-runner", exclusive=True)
        self.addCleanup(store.close)
        queue = AdmissionQueue(journal=store)
        item = queue.submit("turn", "session", INTERACTIVE, "comment", {"text": "exact prompt"})[2]
        self.assertGreater(len(str(store.path(item.key))), 300)
        with self.assertRaises(OSError):
            Journal(self.root, "deep-runner", exclusive=True)
        blob = durable_file.read_bytes(store.path(item.key))
        if os.name == "nt":
            self.assertTrue(blob.startswith(b"DPAPI\n"))
            self.assertNotIn(b"exact prompt", blob)
        store.close()
        code = (
            "import json,sys; from app.services.runner_admission_journal import Journal; "
            "s=Journal(sys.argv[1], 'deep-runner', exclusive=True); "
            "print(json.dumps(s.read())); s.close()"
        )
        child = subprocess.run([sys.executable, "-c", code, str(self.root)],
                               cwd=Path(__file__).parent, capture_output=True, text=True, timeout=30)
        self.assertEqual(child.returncode, 0, child.stderr)
        rows = json.loads(child.stdout)
        self.assertEqual(rows[0]["payload"]["text"], "exact prompt")
        restored = Journal(self.root, "deep-runner", exclusive=True)
        try:
            restored.remove(item.key)
            self.assertEqual(restored.read(), [])
        finally:
            restored.close()

    def test_deep_wal_roundtrip_recovery_and_removal(self):
        store = Journal(self.root, "wal-runner")
        queue = AdmissionQueue(journal=store)
        item = queue.submit("wal-turn", "session", INTERACTIVE, "comment", {"text": "retained"})[2]
        with patch.object(durable_file.os, "replace", side_effect=OSError(errno.EXDEV, "injected")):
            queue.claim_next(0, 1, True)
        wal = Path(str(store.path(item.key)) + ".wal")
        self.assertTrue(wal.exists())
        with wal.open("ab") as stream:
            stream.write(b'{"incomplete":')
        restored = AdmissionQueue(journal=Journal(self.root, "wal-runner"))
        self.assertEqual(restored.get(item.key).state, "starting")
        restored.recover({})
        self.assertTrue(restored.get(item.key).result["uncertain"])
        self.assertIsNone(restored.claim_next(0, 1, True))
        store.remove(item.key)
        self.assertEqual(store.read(), [])
        self.assertFalse(wal.exists())

    @unittest.skipUnless(os.name == "nt", "Windows alias ownership")
    def test_normal_and_extended_path_share_the_same_lock_and_records(self):
        root = Path(self.tmp.name) / "legacy"
        first = Journal(root, "same-identity", exclusive=True)
        self.addCleanup(first.close)
        extended = "\\\\?\\" + str(root.resolve())
        with self.assertRaises(OSError):
            Journal(extended, "same-identity", exclusive=True)
        first.close()
        second = Journal(extended, "same-identity", exclusive=True)
        second.close()


if __name__ == "__main__":
    unittest.main()
