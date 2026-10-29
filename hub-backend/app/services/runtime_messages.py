"""Normalize only explicitly exposed native thought/text and settled token data."""
from __future__ import annotations
import math


def short_arguments(value):
    if not isinstance(value, dict):
        return {}
    return {key: str(value[key])[:1500] for key in
            ("path", "filePath", "file_path", "command", "pattern", "query")
            if isinstance(value.get(key), (str, int, float))}


def input_usage(value):
    """Request input including cache exactly once; no input is distinct from zero."""
    if not isinstance(value, dict):
        return None
    def pick(row, *names):
        for name in names:
            n = row.get(name)
            if isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) and n >= 0:
                return int(n)
        return None
    inp = pick(value, "input", "input_tokens", "prompt_tokens", "inputTokens", "promptTokens")
    cache = value.get("cache") if isinstance(value.get("cache"), dict) else {}
    read = pick(value, "cacheRead", "cache_read_tokens", "cache_read_input_tokens", "cached_input_tokens")
    write = pick(value, "cacheWrite", "cache_write_tokens", "cacheCreation", "cache_creation_input_tokens", "cache_write_input_tokens")
    read = pick(cache, "read") if read is None else read
    write = pick(cache, "write") if write is None else write
    if inp is None and read is None and write is None:
        return None
    includes = value.get("inputIncludesCache", value.get("input_includes_cache"))
    if includes is None:
        separate = any(key in value for key in ("cache_read_input_tokens", "cache_creation_input_tokens"))
        includes = "cached_input_tokens" in value or (not separate and any(
            key in value for key in ("input_tokens", "prompt_tokens", "inputTokens", "promptTokens")))
    inp = (inp or 0) + (0 if includes else (read or 0) + (write or 0))
    return {"input": inp, "cacheRead": read or 0, "cacheWrite": write or 0,
            "inputIncludesCache": True}


def usage(value):
    if not isinstance(value, dict):
        return None
    def pick(*names):
        for name in names:
            n = value.get(name)
            if isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) and n >= 0:
                return int(n)
        return 0
    inputs = input_usage(value) or {"input": 0, "cacheRead": 0, "cacheWrite": 0}
    inp, read, write = (inputs[key] for key in ("input", "cacheRead", "cacheWrite"))
    out = pick("output", "output_tokens", "completion_tokens")
    reasoning = pick("reasoning", "reasoning_tokens", "reasoningTokens", "output_reasoning_tokens")
    # A native zero text output with explicit reasoning is still consumption.
    # Otherwise providers normally already include reasoning in output tokens.
    out = max(out, reasoning)
    if not inp and not out:
        return None
    return {"input": inp, "output": out, "cacheRead": read, "cacheWrite": write,
            "reasoning": reasoning,
            "inputIncludesCache": True, "totalTokens": inp + out, "total": inp + out}


def billed_event(m):
    """Never treat a context watermark or a replayed partial as consumption."""
    kind = m.get("type")
    if kind == "step_finish" and not m.get("contextOnly"):
        part = m.get("part") or {}
        tokens = part.get("tokens")
        if isinstance(tokens, dict) and isinstance(part.get("cost"), (int, float)):
            # OpenCode places the provider cost beside tokens, not inside it.
            tokens = {**tokens, "cost": part["cost"]}
        return tokens, "step"
    if kind == "message_end" and isinstance(m.get("message"), dict) and m["message"].get("role") == "assistant":
        return m["message"].get("usage"), "message"
    if kind == "turn.completed":
        return m.get("usage"), "turn"
    if kind == "result":
        return m.get("usage"), "turn"
    return None, ""


def _row(kind, text, identity, *, done=True, delta=False):
    text = str(text or "")
    row = {"kind": kind, "tool": "", "text": text[:50000],
           "streamId": str(identity)[:240], "done": done, "delta": delta}
    if len(text) > 50000:
        row["textTruncated"] = True
    return row


def _exposed(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(str(x.get("text") or "") for x in value
                         if isinstance(x, dict) and x.get("type") in ("text", "summary_text", "reasoning_text"))
    return ""


def items(m, run):
    kind = str(m.get("type") or "")
    state = run.setdefault("_messageStream", {})
    segment = run.get("segment", 1)
    if state.get("segment") != segment:
        state.clear()
        state["segment"] = segment
    if kind == "message_start":
        state["piMessage"] = str((m.get("message") or {}).get("timestamp") or
                                 int(state.get("counter") or 0) + 1)
        state["counter"] = int(state.get("counter") or 0) + 1
        return None
    part = m.get("part")
    from .runtime_tool_preparation import items as preparing_items
    rows = preparing_items(m, run)
    if rows is not None and kind in {"error", "turn.failed"}:
        # Cancellation is extra UI state, not a replacement for the original
        # provider diagnostic/failure parser (which owns the error output).
        state["additional"] = rows
        rows = None
    # ACP text chunks carry a stream id and delta marker so they can be
    # projected immediately.  Keep complete legacy `type=text` snapshots on
    # the local_stream fallback path for compatibility with older agents.
    stream_text = (kind == "text" and isinstance(part, dict) and
                   (part.get("streamId") or "delta" in part or "done" in part))
    if isinstance(part, dict) and (kind == "reasoning" or stream_text):
        # Keep the established `say` archive kind so existing history and
        # completion logic remain compatible; the stream metadata lets the
        # desktop renderer update one assistant block incrementally.
        block = "thinking" if kind == "reasoning" else "say"
        identity = part.get("streamId") or part.get("id") or "reasoning"
        rows = [_row(block, part.get("delta") if "delta" in part else part.get("text"), identity,
                     done=part.get("done", not isinstance(part.get("time"), dict) or bool(part["time"].get("end"))) is not False, delta="delta" in part)]
    ame = m.get("assistantMessageEvent")
    if isinstance(ame, dict) and str(ame.get("type") or "").startswith("thinking_"):
        event = ame["type"]
        identity = "pi:%s:%s" % (state.get("piMessage", state.get("counter", 0)), ame.get("contentIndex", 0))
        if event == "thinking_start":
            return []
        rows = [_row("thinking", ame.get("delta") if event == "thinking_delta" else ame.get("content"),
                     identity, done=event == "thinking_end", delta=event == "thinking_delta")]
    if kind in ("item.started", "item.updated", "item.completed") and isinstance(m.get("item"), dict):
        item = m["item"]
        if item.get("type") == "reasoning":
            text = _exposed(item.get("text")) or _exposed(item.get("summary"))
            rows = [_row("thinking", text, "codex:" + str(item.get("id") or "reasoning"),
                         done=kind == "item.completed")]
    if kind in ("assistant", "stream_event"):
        from .runtime_claude_messages import items as claude_items
        thoughts = claude_items(m, run)
        if kind == "assistant":
            state["additional"] = thoughts or []
        else:
            rows = thoughts
    raw_usage, scope = billed_event(m)
    token_usage = usage(raw_usage)
    if token_usage:
        if rows is None:
            state["usage"] = {"kind": "usage", "usage": token_usage, "usageScope": scope,
                              "text": "", "tool": ""}
        else:
            rows.append({"kind": "usage", "usage": token_usage, "usageScope": scope, "text": "", "tool": ""})
    if rows is not None:
        # ACP/Pi deltas can repeat the same word legitimately. Their ordinal
        # makes them distinct from replay-filtered final snapshots.
        for row in rows:
            if row.get("delta"):
                state["delta"] = int(state.get("delta") or 0) + 1
                row["_sourceId"] = "stream:%s:%s:%s" % (segment, row.get("streamId"), state["delta"])
            elif row.get("streamId"):
                row["_sourceId"] = "stream:%s:%s:%s" % (segment, row["streamId"], row.get("done"))
    return rows


def augment(m, run, rows):
    state = run.get("_messageStream") or {}
    additional = state.pop("additional", [])
    usage_row = state.pop("usage", None)
    result = additional + rows + ([usage_row] if usage_row else [])
    return result


def cancel_fields(item):
    # This reason is emitted only for an unexecuted approval withdrawn by the
    # trusted host. Never neutralize a true failure with contradictory metadata.
    if item.get("state") == "cancelled" and item.get("cancelReason") == "access-change" and item.get("isError") is False:
        return {"state": "cancelled", "cancelReason": "access-change"}
    return {}


def public_fields(item):
    """Small, explicit metadata shared by live, heartbeat and archived replay."""
    result = cancel_fields(item)
    from . import turn_correlation
    result.update(turn_correlation.public(item))
    if item.get("textTruncated") is True:
        result["textTruncated"] = True
    if item.get("streamId"):
        result["streamId"] = str(item["streamId"])[:240]
        result["done"] = item.get("done") is True
        result["delta"] = item.get("delta") is True
    if item.get("kind") == "tool-preparing":
        from .runtime_tool_preparation import path_arguments
        result["arguments"] = path_arguments(item.get("arguments"))
        if item.get("phase") in {"preparing", "cancelled"}:
            result["phase"] = item["phase"]
    elif isinstance(item.get("arguments"), dict):
        result["arguments"] = short_arguments(item["arguments"])
    if epoch_ms(item.get("sentAt")):
        result["sentAt"] = epoch_ms(item["sentAt"])
    if item.get("toolKind"):
        result["toolKind"] = str(item["toolKind"])[:40]
    if item.get("callId"):
        result["callId"] = str(item["callId"])[:360]
    if "isError" in item:
        result["isError"] = bool(item["isError"])
    # Cloud website runners may report a dev server as structured metadata.
    # Preserve only the small, display-safe address contract for the client;
    # it still validates the URL before opening it in the workbench.
    for key in ("serviceUrl", "previewUrl", "host"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            result[key] = value.strip()[:2000]
    port = item.get("port")
    if isinstance(port, (int, float)) and not isinstance(port, bool) and int(port) == port and 0 < int(port) < 65536:
        result["port"] = int(port)
    services = item.get("services")
    if isinstance(services, list):
        rows = []
        for service in services[:8]:
            if not isinstance(service, dict):
                continue
            row = {key: str(service[key]).strip()[:500] for key in ("url", "previewUrl", "name", "label")
                   if isinstance(service.get(key), str) and service[key].strip()}
            if row:
                rows.append(row)
        if rows:
            result["services"] = rows
    if item.get("kind") == "usage" and item.get("usageScope") in ("step", "message", "turn"):
        normalized = usage(item.get("usage"))
        if normalized:
            result.update(usage=normalized, usageScope=item["usageScope"])
    return result


def epoch_ms(value):
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 < value <= 8640000000000000 else 0
