"""DSH provider routing without credential files or native-permission changes."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from app.services import acp_agents, dsh_gateway


class DshGatewayTests(unittest.TestCase):
    def setUp(self):
        self.llm = {"base": "http://127.0.0.1:1234/v1", "key": "managed-test-secret",
                    "model": "new-enterprise-model", "contextWindow": 32000,
                    "maxOutputTokens": 8192, "input": ["text", "image"]}

    def test_managed_route_uses_env_only_and_preserves_capabilities(self):
        env = {"DEEPSEEK_API_KEY": "old", "DEEPSEEK_BASE_URL": "https://native.invalid",
               "DSH_PERMISSION_MODE": "read-only"}
        with patch.object(Path, "write_text", side_effect=AssertionError("must not write credentials")):
            acp_agents.inject_llm_env("dsh", env, self.llm)
        profile = json.loads(env[dsh_gateway.PROFILE_ENV])[dsh_gateway.PROVIDER]
        self.assertEqual(profile["api"], "openai-completions")
        self.assertEqual(profile["apiKeyEnv"], dsh_gateway.KEY_ENV)
        self.assertEqual(env[dsh_gateway.KEY_ENV], self.llm["key"])
        self.assertNotIn(self.llm["key"], env[dsh_gateway.PROFILE_ENV])
        self.assertEqual(profile["models"], [{"id": self.llm["model"], "name": self.llm["model"],
            "contextWindow": 32000, "maxTokens": 8192, "input": ["text", "image"]}])
        self.assertEqual(env["DSH_ACP_MODELS"], self.llm["model"])
        self.assertEqual(env["DSH_MAX_TOKENS"], "8192")
        self.assertEqual(env["DSH_PERMISSION_MODE"], "read-only")
        self.assertNotIn("DEEPSEEK_API_KEY", env)
        self.assertNotIn("DEEPSEEK_BASE_URL", env)

    def test_anthropic_route_and_output_limit_are_explicit(self):
        env = {}
        dsh_gateway.inject_env(env, {**self.llm, "kind": "anthropic", "contextWindow": 4096})
        profile = json.loads(env[dsh_gateway.PROFILE_ENV])[dsh_gateway.PROVIDER]
        self.assertEqual(profile["api"], "anthropic-messages")
        self.assertNotIn("compat", profile)
        self.assertEqual(profile["models"][0]["maxTokens"], 4096)
        self.assertEqual(env["DSH_MAX_TOKENS"], "4096")

    def test_official_bundle_is_packaged_and_no_credential_in_argv(self):
        cfg = {"llm": self.llm}
        args = acp_agents._agent_args("dsh", cfg)
        self.assertIn("--bundle", args)
        bundle = Path(args[args.index("--bundle") + 1])
        manifest = json.loads((bundle / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["dsh"]["bundle"]["patch"], "./cordis.patch.yml")
        text = (bundle / "cordis.patch.yml").read_text(encoding="utf-8")
        self.assertIn("id: llm-pi-ai", text)
        self.assertIn("process.env.SODUWORK_DSH_PROVIDERS", text)
        self.assertNotIn(self.llm["key"], " ".join(args) + text)
        self.assertNotIn("--bundle", acp_agents._agent_args("dsh", {}))
        self.assertNotIn("--bundle", acp_agents._agent_args("qwen", cfg))
        spec = Path(__file__).with_name("runner.spec").read_text(encoding="utf-8")
        self.assertIn('"dsh_gateway_bundle"', spec)


if __name__ == "__main__":
    unittest.main()
