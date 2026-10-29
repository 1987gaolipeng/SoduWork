"""Contract tests for the conversation video plugin and virtual MCP server."""

import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.services import (plugin_builtin, plugin_conversation, plugin_packages,
                          video_generation)


class VideoPluginTests(unittest.IsolatedAsyncioTestCase):
    def test_conversation_grant_separates_builtin_mcp_from_external_connectors(self):
        from app.api import plugin_client_catalog

        self.assertEqual(
            plugin_client_catalog._external_mcp_names(
                ["soduwork-media", "feishu", "", "soduwork-media"]),
            ["feishu"])
        self.assertEqual(
            plugin_client_catalog._external_mcp_names(["soduwork-media"]), [])

    def test_conversation_context_labels_builtin_mcp_without_external_setup(self):
        guidance = plugin_conversation._mcp_guidance(
            ["soduwork-media", "feishu", "soduwork-media"])
        self.assertIn("本轮使用 SoduWork 内置能力：soduwork-media", guidance)
        self.assertIn("无需用户配置外部 MCP", guidance)
        self.assertIn("本轮依赖的企业 MCP：feishu", guidance)
        self.assertNotIn("本轮依赖的企业 MCP：soduwork-media", guidance)

    async def test_conversation_grant_keeps_virtual_server_without_readiness_lookup(self):
        from app.api import plugin_client_catalog

        actor = SimpleNamespace(org_id="org-1", user_id="user-1")
        client = SimpleNamespace(id="client-1")
        session = object()
        resolved = {
            "ok": True,
            "items": [{
                "pluginId": "viral-video-studio",
                "name": "疯传视频成片工坊",
                "version": "1.0.1",
                "capabilities": {"mcpServers": ["soduwork-media"]},
            }],
            "_bindingIds": [],
            "_versionIds": ["version-1"],
        }
        with patch.object(plugin_client_catalog, "_client_actor",
                          new=AsyncMock(return_value=actor)), \
                patch.object(plugin_client_catalog.plugin_conversation, "resolve",
                             new=AsyncMock(return_value=resolved)), \
                patch.object(plugin_client_catalog.plugin_mcp_gateway, "validate_versions",
                             new=AsyncMock()) as validate_versions, \
                patch.object(plugin_client_catalog.mcp_servers, "readiness",
                             new=AsyncMock()) as readiness, \
                patch.object(plugin_client_catalog.device_auth,
                             "issue_plugin_mcp_ticket", return_value=("ticket", 300)), \
                patch.object(plugin_client_catalog, "verify_claims",
                             return_value={"jti": "grant-1"}), \
                patch.object(plugin_client_catalog.plugin_mcp_limits,
                             "public_policy", return_value={"timeoutSeconds": 180}), \
                patch.object(plugin_client_catalog.audit, "log", new=AsyncMock()):
            result = await plugin_client_catalog.client_plugin_conversation_grant(
                {"pluginIds": ["viral-video-studio"],
                 "conversationId": "conversation-1", "resourceProtocol": 1},
                client, session)

        self.assertEqual(result["mcpGrant"]["servers"], ["soduwork-media"])
        readiness.assert_not_awaited()
        validate_versions.assert_awaited_once_with(session, client, ["version-1"])

    def test_manifest_is_a_ready_conversation_capability(self):
        source = Path(__file__).parent / "plugins" / "viral-video-studio.json"
        raw = json.loads(source.read_text(encoding="utf-8"))
        manifest, workflow, report = plugin_packages.normalize(raw)
        self.assertEqual(manifest["key"], "viral-video-studio")
        self.assertEqual(manifest["distribution"], "standalone")
        self.assertTrue(manifest["entrypoints"]["conversation"])
        self.assertFalse(manifest["entrypoints"]["task"])
        self.assertIn("soduwork-media", report["mcpServers"])
        mcp = next(item for item in report["components"] if item["kind"] == "mcp")
        self.assertEqual(mcp["state"], "ready")
        self.assertEqual([node["key"] for node in workflow["nodes"]], ["execute"])

    def test_virtual_server_exposes_image_and_video_generation(self):
        spec = plugin_builtin.virtual_spec("soduwork-media")
        self.assertEqual(spec["type"], "virtual")
        self.assertEqual(set(spec["allowedTools"]), {"generate_video", "generate_image"})
        tools = plugin_builtin.virtual_tools("soduwork-media")
        self.assertEqual({row["name"] for row in tools}, {"generate_video", "generate_image"})
        self.assertIn("prompt", tools[0]["inputSchema"]["required"])

    async def test_virtual_gateway_dispatches_the_signed_conversation_context(self):
        from app.services import plugin_mcp_gateway

        fake = AsyncMock(return_value={"ok": True, "artifact": {"kind": "video"}})
        with patch.object(video_generation, "generate_video", new=fake):
            result = await plugin_mcp_gateway._connector_call(
                "soduwork-media", plugin_builtin.virtual_spec("soduwork-media"),
                "generate_video", {"prompt": "demo"}, 180,
                client="client", session="session", claims={"ref": "conv-123"})
        self.assertEqual(result["artifact"]["kind"], "video")
        fake.assert_awaited_once_with(
            "session", "client", {"prompt": "demo"},
            conversation_id="conv-123", timeout_seconds=180)

    def test_openai_and_seedance_payloads_are_built_from_one_contract(self):
        generic, prompt, endpoint = video_generation._payload(
            {"prompt": "A product demo", "platform": "douyin", "duration": 20},
            {"model": "video-model", "provider": "openai", "config": {},
             "kind": "openai-compat"},
        )
        self.assertEqual(endpoint, "/videos/generations")
        self.assertEqual(prompt, "A product demo")
        self.assertEqual(generic["prompt"], "A product demo")
        self.assertEqual(generic["aspect_ratio"], "9:16")
        self.assertEqual(generic["model"], "video-model")

        chinese_platform, _, _ = video_generation._payload(
            {"prompt": "产品演示", "platform": "小红书"},
            {"model": "video-model", "provider": "openai", "config": {},
             "kind": "openai-compat"},
        )
        self.assertEqual(chinese_platform["aspect_ratio"], "9:16")

        ark, _, endpoint = video_generation._payload(
            {"prompt": "A product demo", "platform": "youtube"},
            {"model": "ep-test", "provider": "volcengine", "config": {
                "endpointPath": "/contents/generations/tasks",
                "statusPath": "/contents/generations/tasks/{id}",
            }, "kind": "openai-compat"},
        )
        self.assertEqual(endpoint, "/contents/generations/tasks")
        self.assertNotIn("prompt", ark)
        self.assertEqual(ark["content"][0]["text"], "A product demo")
        self.assertNotIn("aspect_ratio", ark)
        self.assertEqual(ark["ratio"], "16:9")

        seedance, _, _ = video_generation._payload(
            {"prompt": "A vertical product demo", "platform": "douyin"},
            {"model": "doubao-seedance-2-0", "provider": "volcengine", "config": {
                "endpointPath": "/contents/generations/tasks",
                "statusPath": "/contents/generations/tasks/{id}",
            }, "kind": "openai-compat"},
        )
        self.assertEqual(seedance["duration"], 10)
        with self.assertRaisesRegex(ValueError, "4 到 15 秒"):
            video_generation._payload(
                {"prompt": "A product demo", "duration": 20},
                {"model": "doubao-seedance-2-0", "provider": "volcengine",
                 "config": {"endpointPath": "/contents/generations/tasks"},
                 "kind": "openai-compat"},
            )

        with self.assertRaises(ValueError):
            video_generation._payload(
                {"prompt": "demo", "duration": 999},
                {"model": "video-model", "provider": "openai", "config": {},
                 "kind": "openai-compat"},
            )
        with self.assertRaises(ValueError):
            video_generation._payload(
                {"prompt": "demo", "extra": {"prompt": "replace"}},
                {"model": "video-model", "provider": "openai", "config": {},
                 "kind": "openai-compat"},
            )

    def test_result_urls_cannot_target_private_networks(self):
        for value in (
            "http://127.0.0.1/video.mp4",
            "http://169.254.169.254/video.mp4",
            "http://[::1]/video.mp4",
            "http://192.0.2.4/video.mp4",
        ):
            with self.assertRaises(ValueError):
                video_generation._safe_remote_url(value, "https://provider.test/v1")
        self.assertEqual(
            video_generation._safe_remote_url(
                "/contents/tasks/123/content", "https://provider.test/v1"),
            "/contents/tasks/123/content",
        )
        with self.assertRaises(ValueError):
            video_generation._safe_remote_url(
                "//other.example/video.mp4", "https://provider.test/v1")

    async def test_relative_result_url_uses_authenticated_provider_transport(self):
        conf = {"base": "https://provider.test/v1", "key": "secret"}
        data = b"\x00\x00\x00\x18ftypmp42video"
        request = AsyncMock(return_value=(data, "video/mp4"))
        with patch.object(video_generation, "_provider_request", new=request):
            result, content_type = await video_generation._download_url(
                "/contents/tasks/123/content", conf, 30)
        self.assertEqual(result, data)
        self.assertEqual(content_type, "video/mp4")
        request.assert_awaited_once_with(
            conf, "/contents/tasks/123/content", None, 30)

    def test_non_video_success_payload_is_rejected_before_storage(self):
        with self.assertRaises(ValueError):
            video_generation._assert_video_bytes(b"<html>not a video</html>", "text/html")
        with self.assertRaises(ValueError):
            video_generation._assert_video_bytes(b"<html>not a video</html>", "video/mp4")
        self.assertTrue(video_generation._is_binary_video(b"OggS" + b"\0" * 16))

    def test_filename_always_uses_a_video_suffix(self):
        self.assertEqual(video_generation._safe_filename("demo.txt"), "demo.mp4")
        self.assertEqual(video_generation._safe_filename("demo", ".webm"), "demo.webm")
        self.assertEqual(video_generation._safe_filename("demo.mp4", ".webm"), "demo.webm")
        self.assertTrue(video_generation._safe_filename("x" * 500).endswith(".mp4"))

    def test_virtual_only_capability_is_ready_and_does_not_claim_enterprise_binding(self):
        raw = {
            "schemaVersion": 1, "key": "virtual-only", "name": "Virtual only",
            "version": "1.0.0", "description": "test",
            "capabilities": {"mcpServers": ["soduwork-media"]},
            "entrypoints": {"conversation": True},
        }
        manifest, workflow, report = plugin_packages.normalize(raw)
        self.assertEqual(
            next(item for item in report["components"] if item["kind"] == "mcp")["state"],
            "ready")
        reasons = dict(report.get("permissionSummary") or {}).get("reasons") or []
        self.assertFalse(any("企业 MCP" in reason for reason in reasons))

    async def test_async_provider_result_is_polled_until_mp4(self):
        conf = {"base": "https://provider.test/v1", "key": "secret"}
        config = {"statusPath": "/tasks/{id}", "resultPath": "/tasks/{id}/content"}
        calls = []

        async def request(_conf, path, _body, _timeout):
            calls.append(path)
            if path == "/tasks/create":
                return b'{"id":"job/1","status":"queued"}', "application/json"
            if path == "/tasks/job%2F1":
                return b'{"status":"succeeded"}', "application/json"
            return b"\x00\x00\x00\x18ftypmp42video", "video/mp4"

        with patch.object(video_generation, "_provider_request", new=request), \
                patch.object(video_generation, "POLL_INTERVAL_SECONDS", 0):
            data, content_type = await video_generation._resolve_bytes(
                conf, config, b'{"id":"job/1","status":"queued"}',
                "application/json", video_generation.time.monotonic() + 5)
        self.assertTrue(data.startswith(b"\x00\x00\x00\x18ftyp"))
        self.assertEqual(content_type, "video/mp4")
        self.assertIn("/tasks/job%2F1", calls)



if __name__ == "__main__":
    unittest.main()
