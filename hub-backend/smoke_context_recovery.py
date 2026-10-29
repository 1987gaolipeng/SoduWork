"""Offline regression gate for every SoduWork context recovery path."""
import os
import unittest
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
from test_context_recovery import ContextRecoveryTests

if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(ContextRecoveryTests))
    raise SystemExit(0 if result.wasSuccessful() else 1)
