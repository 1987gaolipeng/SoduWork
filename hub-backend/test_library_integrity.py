"""Include library data-preservation regressions in the backend release gate."""
import unittest


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromName("tests.test_library_integrity")


if __name__ == "__main__":
    unittest.main()
