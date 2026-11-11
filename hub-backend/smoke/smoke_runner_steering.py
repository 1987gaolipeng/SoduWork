"""Offline real-process Runner steering regression (synthetic model boundary)."""
import unittest
import sys
from test_runner_steering import RunnerSteeringTests


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2, stream=sys.stdout).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(RunnerSteeringTests))
    raise SystemExit(0 if result.wasSuccessful() else 1)
