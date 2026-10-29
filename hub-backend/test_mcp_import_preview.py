"""Public preflight must not reintroduce secrets through editor convenience fields."""
import copy
import json
import unittest

from app.services import mcp_import


class McpImportPreviewTests(unittest.TestCase):
    def preview(self, config):
        parsed = mcp_import.parse(json.dumps({"mcpServers": {"fixture": config}}).encode(), ".mcp.json")
        before = copy.deepcopy(parsed)
        preview = mcp_import.public_preview(parsed)
        self.assertEqual(parsed, before, "preview must not change the original import payload")
        return parsed, preview

    def test_command_arguments_and_private_path_do_not_escape_public_projection(self):
        for command in ("C:/private/bin/npx", "C:\\private\\bin\\npx", "/private/bin/npx"):
            with self.subTest(command=command):
                parsed, preview = self.preview({"command": command, "args": ["--token", "opaque-fixture"]})
                text = json.dumps(preview)
                self.assertNotIn("opaque-fixture", text)
                self.assertNotIn("private", text)
                self.assertEqual(preview["servers"][0]["target"], "npx · 2 个参数")
                imported = mcp_import.import_rows(parsed, [])["imported"][0]
                self.assertEqual(imported["args"], ["--token", "opaque-fixture"])
                self.assertEqual(imported["command"], command)
                self.assertFalse(imported["enabled"])

    def test_invalid_http_userinfo_query_and_fragment_are_not_echoed(self):
        _, preview = self.preview({"type": "http", "url":
            "https://fixture-user:fixture-pass@mcp.example.test/tools?token=fixture-token#fixture-fragment"})
        text = json.dumps(preview)
        for value in ("fixture-user", "fixture-pass", "fixture-token", "fixture-fragment"):
            self.assertNotIn(value, text)
        item = preview["servers"][0]
        self.assertFalse(item["valid"])
        self.assertEqual(item["config"]["url"], "https://mcp.example.test/tools")

    def test_plain_http_preview_and_credential_names_remain_available(self):
        _, preview = self.preview({"type": "http", "url": "https://mcp.example.test/tools",
                                  "headers": {"Authorization": "Bearer fixture-secret"}})
        item = preview["servers"][0]
        self.assertTrue(item["importable"])
        self.assertEqual(item["config"]["url"], "https://mcp.example.test/tools")
        self.assertIn("Authorization", item["credentialKeys"])
        self.assertNotIn("fixture-secret", json.dumps(preview))


if __name__ == "__main__":
    unittest.main()
