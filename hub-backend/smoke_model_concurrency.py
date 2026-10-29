"""Release regression gate: model admission, config races and async protocols."""
import os
import unittest

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

suite = unittest.defaultTestLoader.loadTestsFromNames([
    "test_model_runtime", "test_model_config_guard", "test_multimodal_proxy",
    "test_media_model_proxy", "test_mate_message_draft", "test_model_capabilities",
    "test_model_provider_cache", "test_model_runtime_cancellation", "test_model_runtime_renewal",
])
if not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful():
    raise SystemExit(1)
