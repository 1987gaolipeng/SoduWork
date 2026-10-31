"""Release entry for requirement maintenance lifecycle checks."""
import unittest


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromName(
        "tests.test_requirement_maintenance.RequirementMaintenanceTests"
    )


if __name__ == "__main__":
    unittest.main()
