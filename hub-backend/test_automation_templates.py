"""Release entry point for automation template validation and persistence."""
import unittest


def load_tests(loader, _standard_tests, _pattern):
    return loader.loadTestsFromName("tests.test_automation_template_validation")


if __name__ == "__main__":
    unittest.main(verbosity=2)
