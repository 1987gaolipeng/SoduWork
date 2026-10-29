"""Pure usage normalization shared by Hub and database-free runners."""
from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

_QUALITY_RANK = {"unknown": 0, "estimated": 1, "reported": 2, "reconciled": 3}


def _number(value: Any) -> int:
    try:
        if isinstance(value, bool):
            return 0
        result = max(0, int(Decimal(str(value or 0))))
    except (TypeError, ValueError, OverflowError, InvalidOperation):
        return 0
    if result > 9_223_372_036_854_775_807:
        raise ValueError('Usage counter exceeds the supported range')
    return result


def _pick(data: dict, *names: str) -> int:
    for name in names:
        value = data.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            return _number(value)
    return 0


def _cost_microusd(data: dict) -> int:
    if 'costUsd' in data:
        try:
            return _number((Decimal(str(data['costUsd'])) * 1_000_000).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
        except InvalidOperation:
            return 0
    for key in ('cost_microusd', 'costMicrousd'):
        if key in data and isinstance(data[key], (int, float)) and not isinstance(data[key], bool):
            return _number(data[key])
    value = data.get("cost")
    if isinstance(value, dict):
        value = value.get("total")
    try:
        if isinstance(value, bool):
            return 0
        amount = (Decimal(str(value or 0)) * 1_000_000).quantize(Decimal('1'), rounding=ROUND_HALF_UP)
        return _number(amount)
    except (TypeError, ValueError, OverflowError, InvalidOperation):
        return 0


def _cost_known(data: dict) -> bool:
    if data.get('costKnown') is False or data.get('cost_known') is False:
        return False
    value = data.get('costUsd', data.get('costMicrousd', data.get('cost_microusd', data.get('cost'))))
    if isinstance(value, dict):
        value = value.get('total')
    try:
        amount = Decimal(str(value)) if value is not None else Decimal('NaN')
        if ('costUsd' in data or ('costMicrousd' not in data and 'cost_microusd' not in data)) and amount.is_finite() and 0 < amount < Decimal('0.0000005'):
            return False  # Preserve raw precision; this is not a known zero in the micro-USD ledger.
        return not isinstance(value, bool) and value is not None and amount.is_finite() and amount >= 0
    except (InvalidOperation, ValueError):
        return False


def _safe_raw(data: dict) -> dict:
    """Keep diagnostics, never arbitrary strings that may contain credentials."""
    out: dict = {}
    for key, value in data.items():
        if isinstance(value, (int, float, bool)) or value is None:
            out[str(key)[:80]] = value
        elif key == "cost" and isinstance(value, dict):
            out["cost"] = {
                str(k)[:40]: v for k, v in value.items()
                if isinstance(v, (int, float))
            }
        elif key == 'costUsd' and isinstance(value, str) and len(value) <= 50:
            try:
                if Decimal(value).is_finite() and Decimal(value) >= 0:
                    out[key] = value
            except InvalidOperation:
                pass
    return out


def normalize_usage(usage: dict | None) -> dict:
    """Normalize Pi/OpenCode/Codex/Claude usage without assuming a fixed agent list.

    OpenAI's cached_input_tokens is a subset of input_tokens. Anthropic cache read
    and creation tokens are separate. input_includes_cache makes that distinction
    explicit so cached input is never counted twice.
    """
    data = dict(usage or {})
    input_tokens = _pick(data, "input_tokens", "input", "prompt_tokens")
    output_tokens = _pick(data, "output_tokens", "output", "completion_tokens")
    cache_read = _pick(
        data, "cache_read_tokens", "cacheRead", "cache_read_input_tokens",
        "cached_input_tokens",
    )
    cache_write = _pick(
        data, "cache_write_tokens", "cacheWrite", "cache_creation_input_tokens",
        "cache_write_input_tokens",
    )
    reasoning = _pick(
        data, "reasoning_tokens", "reasoningTokens", "output_reasoning_tokens",
    )
    includes_cache = bool(data.get("input_includes_cache",
        data.get("inputIncludesCache", "cached_input_tokens" in data)))
    explicit_total = _pick(data, "total_tokens", "totalTokens", "total")
    output_tokens = max(output_tokens, reasoning)
    calculated = input_tokens + output_tokens
    if not includes_cache:
        calculated += cache_read + cache_write
    total = max(explicit_total, calculated)
    evidence = bool(total or _cost_microusd(data) or data.get("turns") or data.get("steps"))
    quality = str(data.get("quality") or ("reported" if evidence else "unknown")).lower()
    if quality not in _QUALITY_RANK:
        quality = "reported" if evidence else "unknown"
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": reasoning,
        "total_tokens": total,
        "input_includes_cache": includes_cache,
        "requests": _pick(data, "requests", "requestCount", "api_calls")
                    or (1 if evidence else 0),
        "turns": _pick(data, "turns", "rounds"),
        "steps": _pick(data, "steps", "tool_calls"),
        "duration_ms": _pick(data, "duration_ms", "durationMs"),
        "cost_microusd": _cost_microusd(data),
        "cost_known": _cost_known(data),
        "currency": str(data.get("currency") or "USD").upper()[:8],
        "quality": quality,
        "raw_usage": _safe_raw(data),
    }
