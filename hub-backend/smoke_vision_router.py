# -*- coding: utf-8 -*-
"""Offline visual pre-routing contracts without real models or credentials."""
import asyncio
import os
import json
from types import SimpleNamespace

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from app.services import vision_router as vr
from app.api.ai_proxy import router as proxy_router
from app.services import model_transport
from model_test_support import FakeResponse

ok = fail = 0


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        print("  PASS ", name)
    else:
        fail += 1
        print("  FAIL ", name, str(extra)[:300])


async def main():
    original_settings = vr.get_settings
    original_resolve = vr.model_catalog.resolve
    original_open = model_transport.open_response
    captured = {}
    route_map = {(route.path, tuple(sorted(route.methods or []))): route.endpoint.__name__
                 for route in proxy_router.routes}
    chk("模型列表仍绑定 GET", route_map.get(("/api/v1/ai-proxy/v1/models", ("GET",))) == "list_models", route_map)
    chk("视觉分析独立绑定 POST", route_map.get(("/api/v1/ai-proxy/vision/analyze", ("POST",))) == "analyze_vision", route_map)
    chk("主模型对话仍绑定 POST", route_map.get(("/api/v1/ai-proxy/v1/chat/completions", ("POST",))) == "chat_completions", route_map)

    async def fake_resolve(session, client, model):
        captured["wanted"] = model
        return {"base": "https://vision.example/v1", "key": "server-only-key",
                "model": model, "provider": "vision", "kind": "openai-compat"}

    async def fake_open(conf, path, body, **kwargs):
        captured.update(base=conf['base'], key=conf['key'], path=path, payload=json.loads(body))
        return FakeResponse(json.dumps({"choices": [{"message": {"content": json.dumps({
            "summary": "设置页截图", "visibleText": ["保存"],
            "details": ["保存按钮可见"], "uncertainties": [], "suggestedFocus": ["检查权限"],
        }, ensure_ascii=False)}}]}).encode("utf-8"))

    try:
        vr.get_settings = lambda: SimpleNamespace(
            vl_model="qwen-vision-fixture", vl_base_url="", vl_api_key="", vl_timeout_seconds=30)
        vr.model_catalog.resolve = fake_resolve
        model_transport.open_response = fake_open
        image = {"mimeType": "image/png", "data": "eA=="}
        result = await vr.analyze(None, None, [image], "检查这个页面")
        chk("视觉模型按名称精确选择", captured.get("wanted") == "qwen-vision-fixture", captured)
        chk("视觉请求走服务端密钥", captured.get("key") == "server-only-key", captured)
        chk("视觉请求使用 image_url", captured["payload"]["messages"][1]["content"][1]["type"] == "image_url")
        chk("Qwen vision disables hidden reasoning", captured["payload"].get("chat_template_kwargs") == {"enable_thinking": False}, captured["payload"])
        chk("返回结构化观察", result.get("ok") and result["observation"]["summary"] == "设置页截图", result)
        chk("接口结果不回显密钥", "server-only-key" not in json.dumps(result, ensure_ascii=False), result)

        arbitrary = await vr.analyze(None, None, [{"mimeType": "image/svg+xml", "data": "eA=="}], "")
        chk("arbitrary image mime enters vision analysis", arbitrary.get("ok") and arbitrary.get("imageCount") == 1, arbitrary)
        vr.get_settings = lambda: SimpleNamespace(
            vl_model="qwen-vision-fixture", vl_base_url="https://vision.example/v1",
            vl_api_key="", vl_timeout_seconds=30)
        partial = await vr.analyze(None, None, [image], "")
        chk("环境配置不完整不静默回退", not partial.get("ok") and "同时配置" in partial.get("reason", ""), partial)
        from app.config import Settings
        from app.services import vision_policy
        chk("默认不指定视觉前置模型", Settings.model_fields["vl_model"].default == "")
        for base, key in (("", ""), ("https://vision.example/v1", "explicit-key")):
            vr.get_settings = lambda: SimpleNamespace(
                vl_model=" ", vl_base_url=base, vl_api_key=key, vl_timeout_seconds=30)
            captured.clear()
            missing = await vr.analyze(None, None, [image], "")
            chk("未指定模型时不调用目录或上游", not captured, captured)
            chk("缺失适配配置清楚提示且保留原图", not missing.get("ok") and missing.get("status") == 400
                and "原图已保留" in missing.get("reason", ""), missing)
        original_policy_settings = vision_policy.get_settings
        try:
            for name, base, key, expected in (("", "", "", False),
                    ("fixture", "", "", True), ("fixture", "https://fixture", "", False),
                    ("fixture", "https://fixture", "key", True)):
                vision_policy.get_settings = lambda: SimpleNamespace(vl_model=name, vl_base_url=base, vl_api_key=key)
                chk("可选视觉适配仅由完整显式配置启用", vision_policy.adapter_configured() is expected)
        finally:
            vision_policy.get_settings = original_policy_settings
    finally:
        vr.get_settings = original_settings
        vr.model_catalog.resolve = original_resolve
        model_transport.open_response = original_open

    print("PASS %d  FAIL %d" % (ok, fail))
    raise SystemExit(1 if fail else 0)


asyncio.run(main())
