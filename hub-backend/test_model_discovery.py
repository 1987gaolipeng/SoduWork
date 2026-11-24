"""Discovery classifies explicit upstream declarations and keeps legacy IDs."""
import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.services import model_discovery


class FakeResponse:
    def __init__(self, status, payload=None, raw=None):
        self.status_code = status
        self._raw = raw if raw is not None else json.dumps(payload).encode()

    @property
    def content(self):
        return self._raw


def _client_factory(responses):
    """responses: dict path -> FakeResponse or Exception raised by client.get."""
    class FakeClient:
        async def get(self, url, headers=None):
            out = responses.get(str(url))
            if isinstance(out, Exception):
                raise out
            return out

        async def aclose(self):
            pass

    return lambda **kwargs: FakeClient()


BASE = "https://gateway.example/v1"


class ModelDiscoveryTests(unittest.TestCase):
    def run_async(self, coro):
        import asyncio
        return asyncio.run(coro)

    def test_openai_envelope_names_and_dedupe(self):
        responses = {BASE + "/models": FakeResponse(200, {"data": [
            {"id": "model-a"}, {"id": "model-b"}, {"id": "model-a"}, {"id": "  "}]})}
        with patch.object(model_discovery.httpx, "AsyncClient", _client_factory(responses)):
            result = self.run_async(model_discovery.discover(BASE, "secret"))
        self.assertTrue(result["ok"])
        self.assertEqual(result["models"], ["model-a", "model-b"])
        self.assertEqual(result["counts"], {"total": 2, "chat": 0, "unknown": 2})

    def test_candidates_count_declared_outputs_and_never_infer_from_ids_or_input(self):
        payload = {"data": [
            "vision-chat-model",
            {"id": "policy", "output": "decision", "input": ["text"]},
            {"id": "vision-in", "architecture": {"input_modalities": ["image"]}},
            {"id": "assistant", "input": ["image"], "architecture": {"output_modalities": ["text"]}},
            {"id": "both", "output": ["image", "text"]},
            {"id": "assistant", "output": "TEXT"},
            {"id": "media", "output": ["video"]},
            {"id": "future", "output": "arbitrary-new-type"},
        ]}
        with patch.object(model_discovery.httpx, "AsyncClient", _client_factory(
                {BASE + "/models": FakeResponse(200, payload)})):
            result = self.run_async(model_discovery.discover(BASE, "fixture"))
        expected = [
            ("vision-chat-model", [], "unknown"), ("policy", [], "unsupported"),
            ("vision-in", [], "unknown"), ("assistant", ["chat"], "declared"),
            ("both", ["chat", "image"], "declared"), ("media", ["video"], "declared"),
            ("future", [], "unknown"),
        ]
        self.assertEqual(result["models"], [name for name, _, _ in expected])
        self.assertEqual(result["candidates"], [
            {"id": name, "purposes": purposes, "status": status} for name, purposes, status in expected])
        self.assertEqual(result["counts"], {"total": 7, "chat": 2, "unknown": 3})

    def test_only_exact_endpoint_paths_and_consistent_declarations_establish_purpose(self):
        cases = [
            ({"supported_endpoints": ["/v1/chat/completions"]}, ["chat"], "declared"),
            ({"endpoints": ["/v1/images/generations"]}, ["image"], "declared"),
            ({"endpoints": ["/embeddings"]}, [], "unsupported"),
            ({"endpoints": ["/v1/systemone"]}, [], "unsupported"),
            ({"endpoint": "/v1/ocr"}, [], "unsupported"),
            ({"supported_endpoint_types": ["openai"]}, [], "unknown"),
            ({"endpoints": ["https://gateway.example/debug/v1/chat/completions"]}, [], "unknown"),
            ({"output": "text", "architecture": {"output_modalities": ["image"]}}, [], "unknown"),
            ({"output": "text", "endpoints": ["/embeddings"]}, [], "unsupported"),
            ({"output": "text", "endpoint": "/v1/ocr"}, [], "unsupported"),
            ({"output": "text", "endpoint": "/v1/systemone"}, [], "unsupported"),
            ({"output": "text", "endpoints": ["/v1/ocr", "/v1/chat/completions"]}, ["chat"], "declared"),
            ({"output": "text", "endpoints": ["/v1/images/generations"]}, [], "unknown"),
            ({"output": "text", "architecture": {"output_modalities": ["text", "image"]}}, ["chat"], "declared"),
            ({"output": ["text", "image"], "endpoints": ["/v1/chat/completions"]}, ["chat"], "declared"),
            ({"output": ["text", "image"], "endpoints": ["/v1/images/generations"]}, ["image"], "declared"),
            ({"output": "decision", "architecture": None}, [], "unsupported"),
            ({"output": {"unknown": "text"}, "architecture": ["text"]}, [], "unknown"),
        ]
        for metadata, purposes, status in cases:
            with self.subTest(metadata=metadata):
                found = model_discovery._candidates({"items": [{"id": "opaque", **metadata}]})
                self.assertEqual(found, [{"id": "opaque", "purposes": purposes, "status": status}])

    def test_duplicate_metadata_remains_consistent_at_the_unique_id_limit(self):
        rows = ["first", {"id": "second", "output": "text"}, {"id": "over-limit", "output": "text"},
                {"id": "first", "output": "image"}, {"id": "second", "output": "decision"}]
        with patch.object(model_discovery, "MAX_MODELS", 2):
            self.assertEqual(model_discovery._candidates(rows), [
                {"id": "first", "purposes": ["image"], "status": "declared"},
                {"id": "second", "purposes": [], "status": "unknown"}])

    def test_falls_back_to_v1_models_when_root_missing(self):
        responses = {
            BASE + "/models": FakeResponse(404),
            BASE + "/v1/models": FakeResponse(200, {"data": [{"id": "m"}]}),
        }
        with patch.object(model_discovery.httpx, "AsyncClient", _client_factory(responses)):
            result = self.run_async(model_discovery.discover(BASE, "secret"))
        self.assertTrue(result["ok"], result["detail"])
        self.assertEqual(result["path"], "/v1/models")

    def test_no_models_endpoint_is_a_soft_failure(self):
        responses = {BASE + "/models": FakeResponse(404), BASE + "/v1/models": FakeResponse(405)}
        with patch.object(model_discovery.httpx, "AsyncClient", _client_factory(responses)):
            result = self.run_async(model_discovery.discover(BASE, "secret"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["models"], [])
        self.assertIn("不提供模型列表接口", result["detail"])

    def test_fallback_can_succeed_after_a_denial_but_preserves_auth_errors(self):
        for alternate, expected_ok in [(FakeResponse(200, ["model-a"]), True), (FakeResponse(404), False)]:
            responses = {BASE + "/models": FakeResponse(401), BASE + "/v1/models": alternate}
            with patch.object(model_discovery.httpx, "AsyncClient", _client_factory(responses)):
                result = self.run_async(model_discovery.discover(BASE, "fixture-key"))
            self.assertEqual(result["ok"], expected_ok)
            if not expected_ok:
                self.assertEqual(result["params"]["status"], "HTTP 401")

    def test_auth_failure_is_reported_not_raised(self):
        responses = {BASE + "/models": FakeResponse(401), BASE + "/v1/models": FakeResponse(401)}
        with patch.object(model_discovery.httpx, "AsyncClient", _client_factory(responses)):
            result = self.run_async(model_discovery.discover(BASE, "bad"))
        self.assertFalse(result["ok"])
        self.assertIn("HTTP 401", result["detail"])

    def test_draft_can_distinguish_a_valid_empty_list_from_an_error_body(self):
        for payload, expected in [({"data": []}, True), ([], True), ({"error": "private"}, False),
                                  ({"data": [], "error": {}}, False), ({}, False),
                                  ({"data": [{"message": "private"}]}, False)]:
            with self.subTest(payload=payload), patch.object(
                    model_discovery.httpx, "AsyncClient", _client_factory({BASE + "/models": FakeResponse(200, payload)})):
                result = self.run_async(model_discovery.discover(BASE, "fixture", allow_empty=True))
                self.assertEqual(result["ok"], expected, result)
                self.assertEqual(result["models"], [])
                if expected:
                    self.assertEqual(result["candidates"], [])
                    self.assertEqual(result["counts"], {"total": 0, "chat": 0, "unknown": 0})
                self.assertNotIn("private", str(result))

    def test_network_error_is_classified(self):
        responses = {BASE + "/models": httpx.ConnectError("refused")}
        with patch.object(model_discovery.httpx, "AsyncClient", _client_factory(responses)):
            result = self.run_async(model_discovery.discover(BASE, "secret"))
        self.assertFalse(result["ok"])
        self.assertIn("ConnectError", result["detail"])

    def test_non_json_body_fails_soft(self):
        responses = {BASE + "/models": FakeResponse(200, raw=b"<html>not json</html>")}
        with patch.object(model_discovery.httpx, "AsyncClient", _client_factory(responses)):
            result = self.run_async(model_discovery.discover(BASE, "secret"))
        self.assertFalse(result["ok"])
        self.assertIn("JSON", result["detail"])

    def test_anthropic_uses_its_own_header_pair(self):
        seen = {}

        class CapturingClient:
            async def get(self, url, headers=None):
                seen["url"] = str(url)
                seen["headers"] = dict(headers or {})
                return FakeResponse(200, {"data": [{"id": "claude-x"}]})

            async def aclose(self):
                pass

        with patch.object(model_discovery.httpx, "AsyncClient", lambda **kw: CapturingClient()):
            result = self.run_async(model_discovery.discover("https://api.anthropic.com",
                                                             "secret", "anthropic"))
        self.assertTrue(result["ok"])
        self.assertEqual(seen["url"], "https://api.anthropic.com/v1/models")
        self.assertEqual(seen["headers"].get("x-api-key"), "secret")
        self.assertNotIn("Authorization", seen["headers"])

    def test_missing_base_or_key_never_touches_network(self):
        for base, key in (("", "k"), ("ftp://x", "k"), ("https://x", "")):
            result = self.run_async(model_discovery.discover(base, key))
            self.assertFalse(result["ok"])
            self.assertEqual(result["models"], [])

    def test_anthropic_accepts_versioned_base_without_repeating_v1(self):
        responses = {BASE + "/models": FakeResponse(200, [])}
        with patch.object(model_discovery.httpx, "AsyncClient", _client_factory(responses)):
            result = self.run_async(model_discovery.discover(BASE + "/", "fixture", "anthropic", allow_empty=True))
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
