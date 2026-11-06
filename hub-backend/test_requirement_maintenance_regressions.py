"""Offline release entry for requirement maintenance and receipt audiences."""
import unittest


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(loader.loadTestsFromName(name) for name in (
        "tests.test_requirement_maintenance.RequirementMaintenanceTests",
        "tests.test_requirement_maintenance_policy.RequirementMaintenancePolicyTests",
        "tests.test_handoff_maintenance_boundary.HandoffMaintenanceBoundaryTests",
        "tests.test_notice_audience_regression.NoticeAudienceRegressionTests",
        "tests.test_requirement_review_access.RequirementReviewAccessTests",
    ))


if __name__ == "__main__":
    unittest.main()
