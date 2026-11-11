"""Offline cluster contract and SQL-read regression gate."""
import unittest
import test_cluster_bus
import test_cluster_endpoints
import test_performance_reads

suite = unittest.TestSuite([
    unittest.defaultTestLoader.loadTestsFromModule(test_cluster_bus),
    unittest.defaultTestLoader.loadTestsFromModule(test_cluster_endpoints),
    unittest.defaultTestLoader.loadTestsFromModule(test_performance_reads),
])
result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
