"""Plugin wire-policy keys remain readable by old and current installed Runners."""
import unittest

from app.services.plugin_runtime import apply_mcp_tools


class PluginPolicyBrandCompatTests(unittest.TestCase):
    def test_dispatch_overwrites_both_aliases_without_expanding_grants(self):
        source = {"servers": {
            "allowed": {"command": "fixture", "soduworkPolicy": {"maxResultChars": 500_000}},
            "not-granted": {"command": "other"},
        }}
        result = apply_mcp_tools(source, {"allowed": ["read"]}, {
            "timeoutSeconds": 12, "maxResultChars": 2000,
        })
        self.assertEqual(list(result["servers"]), ["allowed"])
        spec = result["servers"]["allowed"]
        self.assertEqual(spec["allowedTools"], ["read"])
        for key in ("soduworkPolicy", "soduWorkPolicy"):
            self.assertEqual(spec[key], {"timeoutSeconds": 12, "maxResultChars": 2000})
        spec["soduworkPolicy"]["maxResultChars"] = 4000
        self.assertEqual(spec["soduWorkPolicy"]["maxResultChars"], 2000)
        self.assertEqual(source["servers"]["allowed"]["soduworkPolicy"]["maxResultChars"], 500_000)


if __name__ == "__main__":
    unittest.main()
