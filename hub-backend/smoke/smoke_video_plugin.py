"""Offline video plugin gate: isolated ledger and loopback provider only."""
import os
import unittest

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromNames([
        "test_video_plugin", "test_video_generation_runtime", "test_plugin_mcp_limits_cluster",
    ])
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
