"""Provider-neutral context-window resolution.

Some gateways do not expose ``/models`` metadata.  A missing value must not
turn the context meter into an unknown state or disable safe compaction, so we
resolve an explicit value first, use a small catalogue for common models, and
fall back to a conservative 128k estimate.
"""
from __future__ import annotations

import re

DEFAULT_CONTEXT_WINDOW = 128_000
MIN_CONTEXT_WINDOW = 1_024
MAX_CONTEXT_WINDOW = 8_000_000

_KNOWN = (
    (re.compile(r"(?:^|[-_:/.])(?:gpt-4\.1|o[134](?:-mini)?)(?:$|[-_:/.])", re.I), 1_048_576),
    (re.compile(r"(?:^|[-_:/.])(?:claude|sonnet|opus|haiku)(?:$|[-_:/.])", re.I), 200_000),
    (re.compile(r"(?:^|[-_:/.])gemini-(?:1\.5|2(?:\.0|\.5)?)(?:$|[-_:/.])", re.I), 1_048_576),
    (re.compile(r"(?:^|[-_:/.])deepseek(?:$|[-_:/.])", re.I), 64_000),
    (re.compile(r"(?:^|[-_:/.])(?:qwen|通义千问)(?:$|[-_:/.])", re.I), 131_072),
    (re.compile(r"(?:^|[-_:/.])(?:glm|chatglm)(?:$|[-_:/.])", re.I), 128_000),
    (re.compile(r"(?:^|[-_:/.])(?:moonshot|kimi)(?:$|[-_:/.])", re.I), 128_000),
    (re.compile(r"(?:^|[-_:/.])(?:doubao|seed|llama|mistral)(?:$|[-_:/.])", re.I), 128_000),
)


def normalize(value) -> int:
    if isinstance(value, str):
        text = value.strip().replace(",", "").lower()
        match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(k|m|b)?(?:\s*tokens?)?", text)
        if match:
            amount = float(match.group(1))
            multiplier = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}.get(
                match.group(2), 1)
            value = amount * multiplier
    try:
        number = round(float(value))
    except (TypeError, ValueError, OverflowError):
        return 0
    return number if MIN_CONTEXT_WINDOW <= number <= MAX_CONTEXT_WINDOW else 0


def _explicit(value: dict) -> int:
    row = value if isinstance(value, dict) else {}
    model = row.get("model") if isinstance(row.get("model"), dict) else {}
    for candidate in (
        row.get("contextWindow"), row.get("context_window"), row.get("ctxWindow"),
        row.get("ctx_window"), row.get("maxContextTokens"), row.get("contextLength"),
        row.get("context_length"), model.get("contextWindow"), model.get("context_window"),
        model.get("ctxWindow"), model.get("ctx_window"), model.get("maxContextTokens"),
        model.get("contextLength"), model.get("context_length"),
    ):
        number = normalize(candidate)
        if number:
            return number
    return 0


def _infer(value: dict) -> int:
    row = value if isinstance(value, dict) else {}
    model = row.get("model") if isinstance(row.get("model"), dict) else {}
    name = str(row.get("modelName") or row.get("id") or model.get("id") or
               model.get("name") or "").strip()
    provider = str(row.get("provider") or row.get("providerId") or
                   model.get("provider") or model.get("providerId") or "").strip()
    suffix = re.search(r"(?:^|[-_./])(\d+(?:\.\d+)?)\s*(k|m|b)(?:$|[-_./])", name, re.I)
    if suffix:
        parsed = normalize(suffix.group(1) + suffix.group(2))
        if parsed:
            return parsed
    haystack = f"{name} {provider}".strip()
    for pattern, number in _KNOWN:
        if pattern.search(haystack):
            return number
    return 0


def resolve(value: dict | None = None) -> dict:
    configured = _explicit(value or {})
    if configured:
        return {"contextWindow": configured, "contextWindowKnown": True,
                "contextWindowEstimated": False, "contextWindowSource": "configured"}
    inferred = _infer(value or {})
    if inferred:
        return {"contextWindow": inferred, "contextWindowKnown": True,
                "contextWindowEstimated": True, "contextWindowSource": "catalog"}
    return {"contextWindow": DEFAULT_CONTEXT_WINDOW, "contextWindowKnown": True,
            "contextWindowEstimated": True, "contextWindowSource": "safe-default"}

