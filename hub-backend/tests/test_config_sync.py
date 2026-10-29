"""Regression checks for synchronized configuration persistence."""

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class ConfigEndpointServerOwnedFieldTests(unittest.TestCase):
    def setUp(self):
        self.source = (ROOT / "app" / "api" / "config.py").read_text(encoding="utf-8")
        self.tree = ast.parse(self.source)

    def _find_function(self, name):
        for node in ast.walk(self.tree):
            if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == name:
                return node
        return None

    def test_get_config_strips_server_owned_fields_before_returning(self):
        get_cfg = self._find_function("get_config")
        calls = [ast.unparse(n.func) for n in ast.walk(get_cfg) if isinstance(n, ast.Call)]
        self.assertTrue(
            any("_strip_server_owned" in c for c in calls),
            "GET /config 返回前必须剥离服务端专属字段（_strip_server_owned），否则客户端会被回灌污染",
        )

    def test_put_config_no_longer_rejects_server_owned_fields(self):
        """Strip and ignore legacy modelProviders so ordinary settings uploads remain accepted."""
        put_cfg = self._find_function("put_config")
        raises = [n for n in ast.walk(put_cfg) if isinstance(n, ast.Raise)]
        self.assertEqual(raises := len(raises), 0, f"PUT /config 不应再有 raise（当前 {raises} 处）")

    def test_put_config_strips_before_merge_and_guard(self):
        put_cfg = self._find_function("put_config")
        body_lines = [ast.unparse(n) for n in ast.walk(put_cfg)]
        merged = "\n".join(body_lines)
        self.assertIn("_strip_server_owned(patch)", merged, "PUT 合并前必须剥离服务端专属字段")
        # Strip server-only fields before guards or merging.
        strip_pos = self.source.find("_strip_server_owned(patch)")
        guard_pos = self.source.find("model_config_guard.personal")
        merge_pos = self.source.find("client.config = {")
        self.assertLess(strip_pos, guard_pos, "剥离必须发生在并发防护之前")
        self.assertLess(strip_pos, merge_pos, "剥离必须发生在合并进 client.config 之前")

    def test_get_config_returns_copied_dict_not_live_orm_value(self):
        """Return a copy without mutating the ORM client.config JSON value in place."""
        get_cfg = self._find_function("get_config")
        text = ast.unparse(get_cfg)
        self.assertIn("dict(", text, "GET 必须在副本上剥离，不得原地把 ORM 值改掉")


if __name__ == "__main__":
    unittest.main()
