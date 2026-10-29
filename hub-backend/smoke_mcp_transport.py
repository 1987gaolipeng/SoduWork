"""MCP transport regression against isolated loopback peers; no business DB."""
import unittest

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromName("test_mcp_transport")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
