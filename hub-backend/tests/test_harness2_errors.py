"""Safe Harness² failure guidance; no provider text or credentials are emitted."""
from __future__ import annotations

import importlib
import json
import ssl
import unittest
import urllib.error

from app.services.acp_access import AccessError
from app.services.acp_bridge import BridgeError
from app.services.acp_process import ProcessCleanupError


class Harness2ErrorTests(unittest.TestCase):
    secret = "fixture-private-key"
    private = (
        " provider-private-body user-private-task "
        "Authorization: Bearer fixture-private-key "
        "https://fixture-user:fixture-password@example.invalid/?token=fixture-token"
    )

    def message(self, error, stage="session/prompt", secret=secret):
        name = "app.services.harness2_errors"
        self.assertIsNotNone(importlib.util.find_spec(name), "The safe error mapper must exist")
        return importlib.import_module(name).failure_message(error, stage, secret)

    def assert_private(self, message):
        for value in ("provider-private-body", "user-private-task", self.secret,
                      "fixture-user", "fixture-password", "fixture-token", "example.invalid"):
            self.assertNotIn(value, message)
        self.assertLessEqual(len(message), 240)

    def test_known_acp_errors_keep_actionable_categories_without_raw_diagnostics(self):
        cases = (
            ("ConfigInvalidError: EndOfFileExpected", "配置", ""),
            ("ProviderModelNotFoundError: company/fixture-model", "模型不存在", ""),
            ("Authentication required", "凭据", ""),
            ("upstream HTTP 401 Unauthorized", "凭据", "HTTP 401"),
            ("upstream HTTP 403 Forbidden", "权限", "HTTP 403"),
            ("upstream HTTP 429 Too Many Requests", "限流", "HTTP 429"),
            ("model not found", "模型不存在", ""),
            ("connect ETIMEDOUT", "超时", "ETIMEDOUT"),
            ("connect ECONNREFUSED", "连接", "ECONNREFUSED"),
            ("ACP Agent failed to start: PermissionError", "文件访问", ""),
            ("EACCES: permission denied", "文件访问", "EACCES"),
            ("EPERM: operation not permitted", "文件访问", "EPERM"),
            ("ACP Agent exited early (code 1)", "提前退出", ""),
        )
        for raw, category, code in cases:
            with self.subTest(category=category, code=code):
                result = self.message(BridgeError(raw + self.private))
                self.assertIn("调用模型", result)
                self.assertIn(category, result)
                if code:
                    self.assertIn(code, result)
                self.assert_private(result)

    def test_stage_names_are_fixed_and_unknown_stage_cannot_echo_user_input(self):
        stages = {
            "initialize": "初始化执行组件",
            "session/new": "创建执行会话",
            "session/load": "恢复执行会话",
            "session/resume": "恢复执行会话",
            "session/prompt": "调用模型",
            "cleanup": "清理执行组件",
        }
        for stage, label in stages.items():
            self.assertIn(label, self.message(RuntimeError(self.private), stage))
        result = self.message(RuntimeError(self.private), self.private)
        self.assert_private(result)
        self.assertIn("执行", result)

    def test_typed_errors_are_classified_even_without_message_markers(self):
        cases = (
            (json.JSONDecodeError("private", "private", 0), "配置"),
            (PermissionError(13, self.private), "文件访问"),
            (TimeoutError(self.private), "超时"),
            (ConnectionError(self.private), "连接"),
            (urllib.error.URLError(TimeoutError(self.private)), "超时"),
            (urllib.error.HTTPError("https://private.invalid", 403, self.private, {}, None), "HTTP 403"),
            (ssl.SSLError(self.private), "TLS"),
            (AccessError("ACCESS_POLICY_UNSUPPORTED" + self.private), "权限"),
            (ProcessCleanupError(self.private), "清理"),
        )
        for error, category in cases:
            with self.subTest(error=type(error).__name__):
                result = self.message(error)
                self.assertIn(category, result)
                self.assert_private(result)

    def test_unknown_error_exposes_only_a_bounded_safe_class_name(self):
        result = self.message(ValueError(self.private))
        self.assertIn("ValueError", result)
        self.assert_private(result)
        hostile_type = type("fixture-private-key\nprovider-private-body", (Exception,), {})
        result = self.message(hostile_type(self.private))
        self.assertIn("Exception", result)
        self.assert_private(result)
        secret_type = type("PrivateToken", (Exception,), {})
        result = self.message(secret_type(self.private), secret="PrivateToken")
        self.assertNotIn("PrivateToken", result)

    def test_numeric_ids_do_not_become_http_status_codes(self):
        result = self.message(BridgeError("request 403 failed" + self.private))
        self.assertNotIn("HTTP 403", result)
        self.assertIn("BridgeError", result)
        self.assert_private(result)

    def test_unprintable_exception_and_secret_markers_cannot_break_diagnostics(self):
        class UnprintableError(Exception):
            def __str__(self):
                raise RuntimeError("provider-private-body")
        result = self.message(UnprintableError())
        self.assertIn("UnprintableError", result)
        self.assert_private(result)
        result = self.message(BridgeError("HTTP 401"), secret="HTTP 401")
        self.assertNotIn("HTTP 401", result)


if __name__ == "__main__":
    unittest.main()
