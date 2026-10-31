"""Release entry for notification audience regression checks."""
import unittest


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromName(
        "tests.test_notice_audience_regression.NoticeAudienceRegressionTests"
    )


if __name__ == "__main__":
    unittest.main()
