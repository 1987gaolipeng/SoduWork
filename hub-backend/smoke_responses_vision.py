# -*- coding: utf-8 -*-
"""Responses image blocks never reach a text-only main model."""
import asyncio
import base64
import json

from app.services import responses_vision


ok = fail = 0


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        print("PASS", name)
    else:
        fail += 1
        print("FAIL", name, str(extra)[:300])


def body():
    image = base64.b64encode(b"small-test-image").decode("ascii")
    return {
        "model": "text-main",
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": "Inspect the website and continue."},
                {"type": "input_image", "image_url": "data:image/png;base64," + image},
            ],
        }],
    }


async def main():
    captured = {}

    async def observe(images, context):
        captured["images"] = images
        captured["context"] = context
        return {
            "ok": True,
            "model": "vision-model",
            "imageCount": len(images),
            "observation": {"summary": "page rendered", "details": ["hero visible"]},
            "warnings": [],
        }

    source = body()
    safe, meta = await responses_vision.prepare(source, observe)
    encoded = json.dumps(safe, ensure_ascii=False)
    chk("original request remains immutable",
        source["input"][0]["content"][1]["type"] == "input_image")
    chk("raw image is removed before the main model",
        "input_image" not in encoded and "data:image/" not in encoded, encoded)
    chk("trusted observation replaces the screenshot",
        "trusted-vision-router" in encoded and "page rendered" in encoded, encoded)
    chk("vision receives image and useful text context",
        len(captured.get("images") or []) == 1 and
        "Inspect the website" in captured.get("context", ""), captured)
    chk("routing diagnostics are explicit",
        meta == {"imageBlocks": 1, "routed": True, "reason": ""}, meta)

    async def unavailable(images, context):
        return {"ok": False, "reason": "vision is not configured"}

    fallback, meta = await responses_vision.prepare(body(), unavailable)
    encoded = json.dumps(fallback, ensure_ascii=False)
    chk("vision failure still protects the text model",
        "input_image" not in encoded and "data:image/" not in encoded, encoded)
    chk("fallback tells the agent to use inspectable evidence",
        "vision-unavailable" in encoded and "DOM" in encoded and "\u63a7\u5236\u53f0" in encoded,
        encoded)
    chk("fallback reason remains observable",
        not meta["routed"] and meta["reason"] == "vision is not configured", meta)

    plain = {"model": "text-main", "input": "hello"}
    untouched, meta = await responses_vision.prepare(
        plain, lambda images, context: None)
    chk("text-only request is unchanged", untouched == plain and meta["imageBlocks"] == 0)


asyncio.run(main())
print("\nresponses vision smoke: %d passed, %d failed" % (ok, fail))
raise SystemExit(1 if fail else 0)
