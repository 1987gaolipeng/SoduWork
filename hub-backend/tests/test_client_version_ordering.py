"""Staging beta candidates order before the same stable release."""

import unittest

from app.services.client_updates import newer, parse_version


class ClientVersionOrderingTests(unittest.TestCase):
    def test_prerelease_versions_parse_with_index(self):
        self.assertEqual(parse_version("1.13.11-beta.1"), (1, 13, 11, 0, 1))
        self.assertEqual(parse_version("1.13.11-beta.10"), (1, 13, 11, 0, 10))
        self.assertEqual(parse_version("1.13.11"), (1, 13, 11, 1, 0))
        self.assertIsNone(parse_version("1.13.11-beta"))
        self.assertIsNone(parse_version("1.13.11-beta.x"))
        self.assertIsNone(parse_version("1.13.11-beta.0"))
        self.assertIsNone(parse_version("1.13"))

    def test_beta_indexes_compare_numerically(self):
        self.assertTrue(newer("1.13.11-beta.2", "1.13.11-beta.1"))
        self.assertTrue(newer("1.13.11-beta.10", "1.13.11-beta.9"))
        self.assertFalse(newer("1.13.11-beta.9", "1.13.11-beta.10"))

    def test_prerelease_precedes_the_same_stable_version(self):
        self.assertTrue(newer("1.13.11", "1.13.11-beta.9"))
        self.assertFalse(newer("1.13.11-beta.9", "1.13.11"))

    def test_next_stable_version_supersedes_beta_candidates(self):
        self.assertTrue(newer("1.13.12", "1.13.11-beta.9"))
        self.assertTrue(newer("1.13.11-beta.1", "1.12.68"))
