"""Small real capability checks; never run generated tools or echo upstream data."""
from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
import json
import re
import secrets
import struct
import zlib

from . import model_transport
from .model_errors import UpstreamError

CHECKS = ("connection", "imageInput", "toolCalling", "streaming")
TIMEOUT = 25
MAX_BYTES = 256 * 1024


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def image_challenge() -> tuple[str, str]:
    """Render a random six-digit challenge with a tiny dependency-free PNG writer."""
    code = "".join(secrets.choice("0123456789") for _ in range(6))
    width, height = 372, 108
    pixels = bytearray(b"\xff" * width * height * 3)
    segments = ("abcedf", "bc", "abged", "abgcd", "fgbc", "afgcd", "afgecd", "abc", "abcdefg", "abfgcd")
    boxes = {"a": (10, 5, 40, 11), "b": (40, 11, 47, 46), "c": (40, 53, 47, 88),
             "d": (10, 88, 40, 95), "e": (3, 53, 10, 88), "f": (3, 11, 10, 46),
             "g": (10, 46, 40, 53)}
    for i, digit in enumerate(code):
        for part in segments[int(digit)]:
            x1, y1, x2, y2 = boxes[part]
            for y in range(y1 + 5, y2 + 5):
                for x in range(x1 + i * 60 + 7, x2 + i * 60 + 7):
                    start = (y * width + x) * 3
                    pixels[start:start + 3] = b"\x18\x24\x3a"
    rows = b"".join(b"\0" + pixels[y * width * 3:(y + 1) * width * 3] for y in range(height))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    return code, "data:image/png;base64," + base64.b64encode(png).decode()


def _payload(conf: dict, check: str) -> tuple[dict, str]:
    expected = ""
    prompt = "Reply with the single word OK."
    body = {"model": conf["model"], "max_tokens": 256, "stream": check == "streaming"}
    if check == "imageInput":
        expected, image = image_challenge()
        prompt = [{"type": "text", "text": "Read the six digits in this image. Reply only with those digits."},
                  {"type": "image_url", "image_url": {"url": image}}]
    if check == "toolCalling":
        expected = secrets.token_hex(8)
        prompt = "Call soduwork_capability_echo with value " + expected + ". This is a capability check."
        body.update({"tools": [{"type": "function", "function": {
            "name": "soduwork_capability_echo", "description": "Echo the supplied check value; no side effects.",
            "parameters": {"type": "object", "properties": {"value": {"type": "string"}},
                           "required": ["value"], "additionalProperties": False}}}],
            "tool_choice": {"type": "function", "function": {"name": "soduwork_capability_echo"}}})
    body["messages"] = [{"role": "user", "content": prompt}]
    return body, expected


def _failure(error: UpstreamError, check: str) -> tuple[str, str]:
    if error.status in (408, 429, 502, 503, 504):
        return "inconclusive", "timeout" if error.status in (408, 504) else "temporarily_unavailable"
    if error.status in (401, 403):
        return "failed", "credentials_or_access"
    if error.status == 404:
        return "failed", "model_or_endpoint_missing"
    # A generic 400 or a malformed response does not prove a missing capability.
    text = str(error.body or "").lower()
    feature = {"imageInput": r"image|vision|multimodal", "toolCalling": r"tool|function.call", "streaming": r"stream"}.get(check)
    if (feature and error.status in (400, 422) and re.search(feature, text)
            and re.search(r"not support|unsupported|does not accept", text)):
        return "unsupported", "capability_not_supported"
    return "inconclusive", "request_not_accepted"


async def _stream(response) -> tuple[bool, bool]:
    buffer, size, observed, reasoning = "", 0, False, False
    async for raw in response.chunks():
        size += len(raw)
        if size > MAX_BYTES:
            break
        buffer += raw.decode("utf-8", "replace")
        lines = buffer.split("\n")
        buffer = lines.pop()
        for line in lines:
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                continue
            try:
                event = json.loads(data)
            except ValueError:
                continue
            for choice in event.get("choices", []):
                delta = choice.get("delta") or {}
                has_reasoning = bool(delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking"))
                reasoning = reasoning or has_reasoning
                observed = observed or has_reasoning or bool(delta.get("content") or delta.get("tool_calls"))
    return observed, reasoning


async def run(conf: dict, checks: list[str]) -> dict:
    results, reasoning = {}, False
    for check in checks:
        stamp = now()
        if conf.get("kind", "openai-compat") != "openai-compat":
            results[check] = {"status": "inconclusive", "code": "protocol_not_tested", "checkedAt": stamp}
            continue
        response = None
        try:
            async with asyncio.timeout(TIMEOUT):
                body, expected = _payload(conf, check)
                response = await model_transport.open_response(conf, "/chat/completions", json.dumps(body).encode(),
                    stream=check == "streaming", timeout=TIMEOUT)
                if check == "streaming":
                    passed, reported = await _stream(response)
                    reasoning = reasoning or reported
                else:
                    data = json.loads(await response.read(MAX_BYTES))
                    message = ((data.get("choices") or [{}])[0].get("message") or {})
                    content = message.get("content")
                    if check == "connection":
                        passed = bool(content or message.get("reasoning_content") or message.get("tool_calls"))
                    elif check == "imageInput":
                        passed = isinstance(content, str) and re.sub(r"\D", "", content) == expected
                    else:
                        passed = False
                        for call in message.get("tool_calls") or []:
                            function = call.get("function") or {}
                            if function.get("name") == "soduwork_capability_echo":
                                try:
                                    passed = json.loads(function.get("arguments") or "{}").get("value") == expected
                                except (ValueError, AttributeError, TypeError):
                                    pass
                                if passed:
                                    break
                status, code = ("passed", "verified") if passed else ("inconclusive", "expected_output_missing")
        except UpstreamError as exc:
            status, code = _failure(exc, check)
        except TimeoutError:
            status, code = "inconclusive", "timeout"
        except (ValueError, TypeError, KeyError, AttributeError):
            status, code = "inconclusive", "invalid_response"
        finally:
            if response is not None:
                await response.aclose()
        results[check] = {"status": status, "code": code, "checkedAt": stamp}
    return {"checkedAt": now(), "checks": results, "reasoningStreamReported": reasoning}
