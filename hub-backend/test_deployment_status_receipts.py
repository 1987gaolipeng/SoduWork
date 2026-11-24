"""Deployment progress and completion follow the Hub's dispatch-time check plan."""
import unittest
from types import SimpleNamespace

from app.services import deployments


class DeploymentStatusReceiptTests(unittest.TestCase):
    def setUp(self):
        self.check = {"type": "http", "name": "Readiness"}
        plan = deployments._runner_check_plan([self.check, {"type": "screenshot"}])
        self.run = SimpleNamespace(state="queued", result={"hubRunnerChecks": plan},
                                   started_at=None, finished_at=None, logs="", error="")

    def test_completion_waits_for_the_dispatched_check(self):
        self.assertTrue(deployments._apply_runner_status(self.run, {"state": "running"}))
        self.assertFalse(deployments._apply_runner_status(self.run, {"state": "succeeded"}))
        self.assertEqual(self.run.state, "running")
        self.assertIsNone(self.run.finished_at)
        receipt = {"state": "succeeded", "result": {"checks": [{**self.check, "ok": True}]}}
        self.assertTrue(deployments._apply_runner_status(self.run, receipt))
        self.assertEqual(self.run.state, "succeeded")
        self.assertIsNotNone(self.run.finished_at)
        self.assertFalse(deployments._apply_runner_status(self.run, {"state": "running"}))
        self.assertEqual(self.run.result["checks"], receipt["result"]["checks"])

    def test_unrecognized_progress_preserves_the_last_receipt(self):
        self.assertTrue(deployments._apply_runner_status(self.run, {"state": "running", "log": "started"}))
        for state in ("unknown", "", False, None, "queued"):
            with self.subTest(state=state):
                self.assertFalse(deployments._apply_runner_status(self.run, {"state": state}))
                self.assertEqual((self.run.state, self.run.logs), ("running", "started"))

    def test_idempotent_start_can_return_completed_checks(self):
        response = {"state": "succeeded", "result": {"checks": [{**self.check, "ok": True}]}}
        self.assertTrue(deployments._apply_runner_status(self.run, response, "running"))
        self.assertEqual(self.run.state, "succeeded")

    def test_in_flight_legacy_receipt_can_complete_without_a_plan(self):
        self.run.result = {}
        self.assertTrue(deployments._apply_runner_status(
            self.run, {"state": "succeeded", "result": {"checks": [{"ok": True}]}}))
        self.assertEqual(self.run.state, "succeeded")


if __name__ == "__main__":
    unittest.main()
