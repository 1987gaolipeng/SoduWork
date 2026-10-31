"""Release entry for creator maintenance policy checks."""
import unittest


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromName(
        "tests.test_requirement_maintenance_policy.RequirementMaintenancePolicyTests"
    )


if __name__ == "__main__":
    unittest.main()
