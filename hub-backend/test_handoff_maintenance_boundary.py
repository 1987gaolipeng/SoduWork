"""Release entry for handoff maintenance boundary checks."""
import unittest


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromName(
        "tests.test_handoff_maintenance_boundary.HandoffMaintenanceBoundaryTests"
    )


if __name__ == "__main__":
    unittest.main()
