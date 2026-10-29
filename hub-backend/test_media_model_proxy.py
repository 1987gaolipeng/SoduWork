"""Media model catalog and generation proxy tests without network or database."""

import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from app.api import ai_proxy
from app.models import ModelDef, ModelProvider
from app.services import model_catalog, model_errors, model_transport
from model_test_support import FakeResponse
from test_model_runtime import IsolatedDatabase


class MediaModelBootstrapTests(IsolatedDatabase):
    async def test_stale_builtin_seedance_config_is_repaired_once(self):
        async with self.sessions() as session, session.begin():
            session.add(ModelProvider(
                id="volcengine", name="Volcengine", builtin=True,
                enabled=True))
            session.add(ModelDef(
                id="volcengine:doubao-seedance-2-0",
                provider_id="volcengine", name="doubao-seedance-2-0",
                label="Seedance 2.0", builtin=True, enabled=True,
                modality="video", config={
                    "endpointPath": "/videos/generations",
                    "defaults": {"resolution": "720p"},
                }))
        async with self.sessions() as session, session.begin():
            self.assertEqual(
                await model_catalog._repair_builtin_media_model_config(session), 1)
        async with self.sessions() as session, session.begin():
            row = await session.get(
                ModelDef, "volcengine:doubao-seedance-2-0")
            self.assertEqual(
                row.config["endpointPath"], "/contents/generations/tasks")
            self.assertEqual(
                row.config["statusPath"], "/contents/generations/tasks/{id}")
            self.assertEqual(row.config["defaults"], {"resolution": "720p"})
            self.assertEqual(
                await model_catalog._repair_builtin_media_model_config(session), 0)

    async def test_custom_seedance_endpoint_is_preserved(self):
        async with self.sessions() as session, session.begin():
            session.add(ModelProvider(
                id="volcengine", name="Volcengine", builtin=True,
                enabled=True))
            session.add(ModelDef(
                id="volcengine:doubao-seedance-2-0",
                provider_id="volcengine", name="doubao-seedance-2-0",
                label="Seedance 2.0", builtin=True, enabled=True,
                modality="video", config={
                    "endpointPath": "/custom/videos/create",
                    "statusPath": "/custom/videos/{id}",
                    "defaults": {},
                }))
        async with self.sessions() as session, session.begin():
            self.assertEqual(
                await model_catalog._repair_builtin_media_model_config(session), 0)
            row = await session.get(
                ModelDef, "volcengine:doubao-seedance-2-0")
            self.assertEqual(row.config["endpointPath"], "/custom/videos/create")


class MediaModelProxyTests(unittest.IsolatedAsyncioTestCase):
    def test_media_config_and_volcengine_builtins(self):
        image = model_catalog.clean_model_config({}, "image")
        video = model_catalog.clean_model_config({}, "video")
        self.assertEqual(image["endpointPath"], "/images/generations")
        self.assertEqual(video["endpointPath"], "/videos/generations")

        byte_config = model_catalog.clean_model_config({
            "endpointPath": "/contents/generations/tasks",
            "statusPath": "/contents/generations/tasks/{id}",
            "defaults": {"resolution": "1080p"},
        }, "video")
        self.assertEqual(
            byte_config["statusPath"], "/contents/generations/tasks/{id}")
        self.assertEqual(byte_config["defaults"], {"resolution": "1080p"})

        provider = next(
            item for item in model_catalog.BUILTIN_PROVIDERS
            if item["id"] == "volcengine")
        self.assertEqual(
            provider["base_url"], "https://ark.cn-beijing.volces.com/api/v3")
        byte_models = [
            item for item in model_catalog.BUILTIN_MODELS
            if item["provider_id"] == "volcengine"]
        self.assertEqual(
            {item.get("modality", "chat") for item in byte_models},
            {"chat", "image", "video"},
        )
        video_model = next(
            item for item in byte_models if item.get("modality") == "video")
        self.assertEqual(video_model["name"], "doubao-seedance-2-0")
        self.assertEqual(video_model["label"], "Seedance 2.0")
        self.assertEqual(
            model_catalog.canonical_model_name(
                "doubao-seedance-1-0-pro-250528"),
            "doubao-seedance-2-0",
        )

        cleaned = model_catalog.clean_model_config({
            "endpointPath": "/vendor/generate",
            "defaults": {
                "size": "1024x1024", "model": "must-not-win", "stream": True},
        }, "image")
        self.assertEqual(cleaned["defaults"], {"size": "1024x1024"})
        for path in (
            "https://other.invalid/generate", "//other.invalid/generate", "/../secret"
        ):
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    model_catalog.clean_model_config(
                        {"endpointPath": path}, "video")
        for path in ("/tasks/no-id", "https://other.invalid/tasks/{id}", "/../{id}"):
            with self.subTest(status_path=path):
                with self.assertRaises(ValueError):
                    model_catalog.clean_model_config(
                        {"statusPath": path}, "video")
        with self.assertRaises(ValueError):
            model_catalog.clean_model_config(
                {"statusPath": "/tasks/{id}"}, "image")

        native_config = model_catalog.clean_model_config(
            {"imageRouting": "native"}, "chat")
        self.assertEqual(native_config.get("imageRouting"), "native")
        self.assertEqual(
            model_catalog.normalize_image_routing("native-first"),
            "vision-fallback",
        )
        with self.assertRaises(ValueError):
            model_catalog.clean_model_config({"imageRouting": "guess"}, "chat")

    def test_chat_thinking_modes_are_normalized(self):
        always = model_catalog.clean_model_config({"thinkingMode": "always"}, "chat")
        self.assertEqual(always, {
            "thinkingMode": "always",
            "reasoning": True,
            "thinkingLevelMap": {"off": None},
        })
        controllable = model_catalog.clean_model_config({
            "thinkingMode": "controllable", "thinkingFormat": "openai",
            "supportsReasoningEffort": True,
        }, "chat")
        self.assertEqual(controllable["thinkingMode"], "controllable")
        self.assertTrue(controllable["reasoning"])
        self.assertEqual(controllable["thinkingFormat"], "openai")
        self.assertTrue(controllable["supportsReasoningEffort"])
        none = model_catalog.clean_model_config({"thinkingMode": "none"}, "chat")
        self.assertEqual(none, {"thinkingMode": "none", "reasoning": False})
        legacy_always = model_catalog.clean_model_config({"thinkingAlwaysOn": True}, "chat")
        self.assertEqual(legacy_always["thinkingMode"], "always")
        with self.assertRaises(ValueError):
            model_catalog.clean_model_config({"thinkingMode": "unsupported"}, "chat")

    async def test_image_and_byte_video_routes_use_configured_paths(self):
        client = SimpleNamespace(id="media-client")
        app = FastAPI()
        app.include_router(ai_proxy.router)
        app.dependency_overrides[ai_proxy._client_by_bearer] = lambda: client
        app.dependency_overrides[ai_proxy.current_ai_client] = lambda: client
        app.dependency_overrides[ai_proxy.get_session] = lambda: None

        async def usable(_session, _client, modality="chat"):
            if modality == "image":
                return [{
                    "name": "image-model", "label": "Image",
                    "providerId": "media", "modality": "image", "config": {}}]
            if modality == "video":
                return [{
                    "name": "video-model", "label": "Seedance",
                    "providerId": "volcengine", "modality": "video", "config": {}}]
            return [{
                "name": "chat-model", "providerId": "media", "modality": "chat"}]

        async def resolve(_session, _client, want="", modality="chat"):
            name = want or (modality + "-model")
            if modality == "image":
                config = {
                    "endpointPath": "/vendor/images",
                    "defaults": {"size": "1024x1024", "quality": "standard"},
                }
            elif modality == "video":
                config = {
                    "endpointPath": "/contents/generations/tasks",
                    "statusPath": "/contents/generations/tasks/{id}",
                    "resultPath": "/contents/generations/tasks/{id}/content",
                    "defaults": {"resolution": "1080p"},
                }
            else:
                config = {}
            return {
                "base": "http://127.0.0.1:9", "key": "fixture", "model": name,
                "kind": "openai-compat", "provider": "volcengine",
                "modality": modality, "config": config,
            }

        responses = [
            FakeResponse(b'{"kind":"image"}'),
            FakeResponse(b'{"id":"task 123","status":"queued"}'),
            FakeResponse(b'{"id":"task 123","status":"succeeded"}'),
            FakeResponse(b'video-bytes'),
        ]
        with (
            patch.object(
                ai_proxy.model_catalog, "usable", AsyncMock(side_effect=usable)),
            patch.object(
                ai_proxy.model_catalog, "resolve", AsyncMock(side_effect=resolve)),
            patch.object(
                ai_proxy.device_auth, "issue_proxy_ticket",
                return_value=("media-ticket", 60)),
            patch.object(
                model_transport, "open_response", side_effect=responses) as upstream,
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://fixture"
            ) as http:
                config = (await http.get("/api/v1/ai-proxy/media/config")).json()
                self.assertTrue(config["ok"])
                self.assertEqual(
                    config["models"]["image"][0]["name"], "image-model")
                self.assertEqual(
                    config["models"]["video"][0]["name"], "video-model")

                image_reply = await http.post(
                    "/api/v1/ai-proxy/v1/images/generations",
                    json={
                        "model": "image-model", "prompt": "a red kite",
                        "size": "512x512", "stream": True,
                    },
                )
                video_reply = await http.post(
                    "/api/v1/ai-proxy/v1/videos/generations",
                    json={"model": "video-model", "prompt": "a red kite moving"},
                )
                status_reply = await http.get(
                    "/api/v1/ai-proxy/v1/videos/generations/task%20123",
                    params={"model": "video-model"},
                )
                content_reply = await http.get(
                    "/api/v1/ai-proxy/v1/videos/generations/task%20123/content",
                    params={"model": "video-model"},
                )

        self.assertEqual(image_reply.status_code, 200)
        self.assertEqual(video_reply.status_code, 200)
        self.assertEqual(status_reply.status_code, 200)
        self.assertEqual(content_reply.status_code, 200)
        self.assertEqual(content_reply.content, b"video-bytes")

        self.assertEqual(upstream.call_args_list[0].args[1], "/vendor/images")
        image_payload = json.loads(upstream.call_args_list[0].args[2])
        self.assertEqual(image_payload["size"], "512x512")
        self.assertEqual(image_payload["quality"], "standard")
        self.assertEqual(image_payload["model"], "image-model")
        self.assertNotIn("stream", image_payload)

        self.assertEqual(
            upstream.call_args_list[1].args[1], "/contents/generations/tasks")
        video_payload = json.loads(upstream.call_args_list[1].args[2])
        self.assertEqual(video_payload["model"], "video-model")
        self.assertEqual(video_payload["resolution"], "1080p")
        self.assertEqual(
            upstream.call_args_list[2].args[1],
            "/contents/generations/tasks/task%20123",
        )
        self.assertIsNone(upstream.call_args_list[2].args[2])
        self.assertEqual(
            upstream.call_args_list[3].args[1],
            "/contents/generations/tasks/task%20123/content",
        )
        self.assertIsNone(upstream.call_args_list[3].args[2])


if __name__ == "__main__":
    unittest.main()
