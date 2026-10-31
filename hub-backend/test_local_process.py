"""Focused process-watchdog contracts for provider-specific settlement recovery."""
import time
import threading
import unittest
from unittest.mock import patch

from app.services import local_process


class LocalProcessTests(unittest.TestCase):
    def test_pi_settlement_requires_a_quiet_grace_period(self):
        now = time.time()
        self.assertFalse(local_process._pi_settlement_due({"cli": "pi"}, now))
        self.assertFalse(local_process._pi_settlement_due(
            {"cli": "pi", "piFinalResponseAt": now - local_process._PI_SETTLE_GRACE_S + 0.1}, now))
        self.assertTrue(local_process._pi_settlement_due(
            {"cli": "pi", "piFinalResponseAt": now - local_process._PI_SETTLE_GRACE_S - 0.1}, now))

    def test_non_pi_processes_never_use_pi_settlement_fallback(self):
        now = time.time()
        for cli in ("opencode", "claude", "codex", ""):
            with self.subTest(cli=cli):
                self.assertFalse(local_process._pi_settlement_due(
                    {"cli": cli, "piFinalResponseAt": now - 60}, now))

    def test_invalid_settlement_timestamp_fails_closed(self):
        now = time.time()
        for value in ("not-a-time", object(), None):
            with self.subTest(value=type(value).__name__):
                self.assertFalse(local_process._pi_settlement_due(
                    {"cli": "pi", "piFinalResponseAt": value}, now))

    def test_watchdog_marks_and_kills_a_quiet_final_response(self):
        ref = "pi-settlement-watchdog-test"
        now = time.time()
        run = {
            "state": "running",
            "cli": "pi",
            "started": now - 30,
            "lastOut": now - 1,
            "piFinalResponseAt": now - local_process._PI_SETTLE_GRACE_S - 1,
        }
        killed = threading.Event()

        class LiveProcess:
            def poll(self):
                return None

        with local_process._LOCK:
            local_process._RUNS[ref] = run
        try:
            def kill_tree(target):
                self.assertEqual(target, ref)
                killed.set()
                return True

            with patch.object(local_process.time, "sleep", return_value=None):
                local_process._watchdog(ref, LiveProcess(), finish=lambda *args: None,
                                        kill_tree=kill_tree)
            self.assertTrue(killed.wait(1), "watchdog did not invoke the process killer")
            self.assertTrue(run["piSettledByWatchdog"])
        finally:
            with local_process._LOCK:
                local_process._RUNS.pop(ref, None)


if __name__ == "__main__":
    unittest.main()
