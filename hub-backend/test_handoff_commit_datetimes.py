"""Offline release entry for the SQLite handoff commit retry fence."""
import sys
import unittest

import test_cloud_conversations as cloud


def suite():
    names = (
        "test_recent_sqlite_commit_fence_preserves_retry_without_redispatch",
        "test_stale_sqlite_commit_fence_can_resume_once",
        "test_legacy_unknown_commit_time_retains_the_fence",
    )
    return unittest.TestSuite(cloud.CloudConversationTests(name) for name in names)


def load_tests(loader, tests, pattern):
    return suite()


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(suite())
    sys.exit(not result.wasSuccessful())
