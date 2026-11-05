"""Provider-neutral context accounting. Only error channels trigger recovery."""
from __future__ import annotations
import json
import re

from . import context_window

OVERFLOW = re.compile(
    r"context[_ ]?overflow|context_length_exceeded|context[_ ]window[_ ]exceeded|"
    r"(?:maximum |exceeded |exceeds? .*|out of )context (?:length|window)|"
    r"context (?:length|window).*(?:exceed|full|limit|too)|prompt (?:is )?too long|"
    r"too many tokens|range of input length should be|input token count.{0,80}exceeds.{0,50}(?:maximum|limit)|"
    r"input (?:is too long|length.*(?:exceed|limit))|longer than the model|"
    r"上下文.{0,12}(?:超限|已满|超过)|超出.{0,12}上下文", re.I)

def window(cfg: dict) -> int:
    llm = (cfg or {}).get("llm") or {}
    # A gateway may explicitly mark its metadata as unknown.  Keep a numeric
    # conservative estimate for compaction and the context meter instead of
    # disabling both paths for that turn.
    return context_window.resolve(llm)["contextWindow"]

def error_text(event: dict) -> str:
    error = event.get("error")
    if error:
        return json.dumps(error, ensure_ascii=False) if isinstance(error, dict) else str(error)
    message = event.get("message")
    if event.get("type") == "agent_end":
        message = next((m for m in reversed(event.get("messages") or [])
                        if isinstance(m, dict) and m.get("role") == "assistant"), None)
    if isinstance(message, dict) and message.get("stopReason") == "error":
        return str(message.get("errorMessage") or "")
    if event.get("type") in ("error", "turn.failed"):
        return str(message or event.get("detail") or "")
    if event.get("type") == "result" and event.get("is_error"):
        return str(event.get("result") or event.get("errors") or "")
    return ""

def observe(run: dict, event: dict, terminal: dict) -> str:
    text = error_text(event)
    if text and (OVERFLOW.search(text) or text.strip().lower() == "context length"):
        terminal.update(overflow=True, isError=True, result=text[:600])
    # Native agents can compact/retry inside the same process. A recovered
    # successful turn must not be replayed merely because an earlier step failed.
    message = event.get("message")
    if event.get("type") == "agent_end":
        message = next((m for m in reversed(event.get("messages") or [])
                        if isinstance(m, dict) and m.get("role") == "assistant"), None)
    recovered = event.get("type") == "turn.completed" or (
        event.get("type") == "result" and event.get("is_error") is False) or (
        event.get("type") == "step_finish" and (event.get("part") or {}).get("reason") == "stop") or (
        event.get("type") in ("message_end", "agent_end") and isinstance(message, dict)
        and message.get("stopReason") in ("stop", "toolUse"))
    if recovered and terminal.get("overflow"):
        for key in ("overflow", "isError", "result"):
            terminal.pop(key, None)
    size = (event.get("part") or {}).get("contextWindow")
    if isinstance(size, (int, float)) and 1024 <= size <= 8_000_000:
        run.update(ctxWindow=int(size), ctxWindowKnown=True)
    return text

def context_input(tokens: dict) -> int:
    from .runtime_messages import input_usage
    return (input_usage(tokens) or {}).get("input", 0)


def update_usage(run: dict, event: dict) -> None:
    """Only settled request usage or an explicit native watermark is context.

    Codex legacy turn.completed.usage is cumulative across model requests.
    Claude result is also a turn total. Neither may replace the last request.
    """
    from .runtime_messages import input_usage, usage
    kind = event.get("type")
    if kind == "turn.completed" and run.get("stopping"):
        # A terminal cumulative bill does not invalidate the last measured
        # request when the user stops the turn.
        return
    if kind in ("compaction_start", "compaction_end", "turn.completed"):
        run["tokens"] = {}
        return
    raw = None
    reason = None
    if kind == "step_finish":
        part = event.get("part") or {}
        raw = part.get("tokens")
        reason = part.get("reason")
    elif kind in ("message_end", "assistant"):
        message = event.get("message")
        if isinstance(message, dict) and message.get("role", "assistant") == "assistant":
            raw = message.get("usage")
            reason = message.get("stopReason")
    occupancy = input_usage(raw)
    if occupancy is None:
        return
    if occupancy["input"] == 0 and input_usage({
            key: raw[key] for key in ("input", "input_tokens", "prompt_tokens", "inputTokens", "promptTokens")
            if key in raw}) is None:
        # Zero cache counters alone do not report input occupancy. Output can
        # still be present in an incomplete terminal usage payload.
        return
    measured = usage(raw)
    # Interrupted providers can return their initial all-zero counters before
    # receiving a usage receipt. An explicit native occupancy update is valid.
    interrupted = run.get("stopping") or reason in ("aborted", "cancelled", "canceled", "error")
    if measured is None and interrupted and not event.get("contextOnly"):
        return
    run["tokens"] = measured or {"input": 0, "inputIncludesCache": True}


def error_window(text: str) -> int | None:
    match = re.search(r"(?:maximum context length(?: is| of)?|context window(?: is| of)?|"
                      r"context length(?: limit)?(?: is| of)?)[^0-9]{0,16}([0-9][0-9,]{3,})",
                      str(text or ""), re.I)
    n = int(match.group(1).replace(",", "")) if match else 0
    return n if 1024 <= n <= 8_000_000 else None
