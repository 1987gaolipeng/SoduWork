"""Offline tests for usage-detail normalization and bounded observability.

Normalize supported camelCase token details to the OpenAI-compatible format.
Keep unavailable values unknown, and preserve other response bytes.
"""
import json
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-ai-proxy-usage-test-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-ai-proxy-usage-test-password")

from app.api import ai_proxy
from model_test_support import FakeResponse


def _chat_body(usage: dict) -> bytes:
    return json.dumps({
        "id": "chatcmpl-x", "object": "chat.completion", "model": "glm_5.3_flash",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "好的"},
                     "finish_reason": "stop"}],
        "usage": usage,
    }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class UsagePassthroughTests(unittest.TestCase):
    """Verify _usage_passthrough as a pure function."""

    def test_snake_null_details_pass_through_byte_identical(self):
        raw = _chat_body({"prompt_tokens": 17, "total_tokens": 33, "completion_tokens": 16,
                          "prompt_tokens_details": None})
        with self.assertLogs(ai_proxy.log, level="INFO") as captured:
            out = ai_proxy._usage_passthrough(raw, model="glm_5.3_flash",
                                              provider="company", mode="complete")
        self.assertEqual(out, raw, "无需补写时必须逐字节原样返回")
        self.assertIn(b'"prompt_tokens_details":null', out, "缺失就是缺失，不编造结构")
        usage_line = " ".join(c.message for c in captured.records
                              if c.getMessage().startswith("[ai-proxy] usage"))
        self.assertIn("prompt=17", usage_line)
        self.assertIn("cached=-", usage_line, "上游没给数值就记 '-'，不写 0")

    def test_camel_details_are_backfilled_as_standard_fields(self):
        raw = _chat_body({"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150,
                          "prompt_tokens_details": None,
                          "inputTokensDetails": {"cached_tokens": 95},
                          "outputTokensDetails": {"reasoning_tokens": 123}})
        out = ai_proxy._usage_passthrough(raw, model="m", provider="p", mode="complete")
        obj = json.loads(out)
        self.assertEqual(obj["usage"]["prompt_tokens_details"]["cached_tokens"], 95)
        self.assertEqual(obj["usage"]["completion_tokens_details"]["reasoning_tokens"], 123)
        self.assertEqual(obj["usage"]["inputTokensDetails"]["cached_tokens"], 95,
                         "camelCase 原字段保留，客户端新旧形态都能读")

    def test_existing_standard_details_win_over_camel(self):
        raw = _chat_body({"prompt_tokens": 10, "total_tokens": 15, "completion_tokens": 5,
                          "prompt_tokens_details": {"cached_tokens": 5},
                          "inputTokensDetails": {"cached_tokens": 95}})
        out = ai_proxy._usage_passthrough(raw, model="m", provider="p", mode="complete")
        obj = json.loads(out)
        self.assertEqual(obj["usage"]["prompt_tokens_details"]["cached_tokens"], 5,
                         "标准字段已有真实值时绝不覆盖")

    def test_non_json_body_untouched(self):
        raw = b"<html>502 upstream</html>"
        with self.assertNoLogs(ai_proxy.log, level="INFO"):
            out = ai_proxy._usage_passthrough(raw, model="m", provider="p", mode="complete")
        self.assertEqual(out, raw)

    def test_body_without_usage_untouched(self):
        raw = json.dumps({"object": "list", "data": []}).encode("utf-8")
        out = ai_proxy._usage_passthrough(raw, model="m", provider="p", mode="complete")
        self.assertEqual(out, raw)

    def test_camel_inner_camel_variant(self):
        raw = _chat_body({"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
                          "outputTokensDetails": {"reasoningTokens": 7}})
        obj = json.loads(ai_proxy._usage_passthrough(raw, model="m", provider="p", mode="complete"))
        self.assertEqual(obj["usage"]["completion_tokens_details"]["reasoning_tokens"], 7)

    def test_responses_shape_backfills_details(self):
        raw = json.dumps({"id": "r1", "object": "response",
                          "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15,
                                    "inputTokensDetails": {"cachedTokens": 8}}}).encode("utf-8")
        obj = json.loads(ai_proxy._usage_passthrough(raw, model="m", provider="p", mode="responses"))
        self.assertEqual(obj["usage"]["input_tokens_details"]["cached_tokens"], 8)

    def test_streaming_flag_does_not_touch_stream_path(self):
        # Streaming remains byte passthrough; _usage_passthrough applies only to non-streaming responses.
        self.assertIn("yield chunk", _source_of("_stream_upstream_response"))


def _source_of(func_name: str) -> str:
    import inspect
    return __import__("inspect").getsource(getattr(ai_proxy, func_name))


class ChatEndpointUsageTests(unittest.IsolatedAsyncioTestCase):
    """Test non-streaming chat/completions with mocked upstream and catalog, without a database."""

    async def test_non_stream_chat_response_usage_normalized(self):
        upstream = _chat_body({"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150,
                               "inputTokensDetails": {"cached_tokens": 95}})
        conf = {"base": "http://upstream.test", "key": "k", "model": "m1",
                "provider": "p1", "kind": "openai-compat"}
        request = MagicMock()
        request.json = AsyncMock(return_value={"model": "m1",
                                               "messages": [{"role": "user", "content": "hi"}]})
        request.is_disconnected = AsyncMock(return_value=False)
        with patch.object(ai_proxy.model_catalog, "usable",
                          AsyncMock(return_value=[{"name": "m1", "providerId": "p1"}])), \
             patch.object(ai_proxy, "_resolve_catalog", AsyncMock(return_value=conf)), \
             patch.object(ai_proxy.multimodal_proxy, "open_request",
                          AsyncMock(return_value=FakeResponse(upstream))), \
             self.assertLogs(ai_proxy.log, level="INFO") as captured:
            response = await ai_proxy.chat_completions(request=request,
                                                       client=MagicMock(), session=None)
        obj = json.loads(response.body)
        self.assertEqual(obj["usage"]["prompt_tokens_details"]["cached_tokens"], 95)
        usage_line = " ".join(c.message for c in captured.records
                              if "usage" in c.getMessage())
        self.assertIn("cached=95", usage_line)
        self.assertIn("reasoning=-", usage_line)


if __name__ == "__main__":
    unittest.main()
