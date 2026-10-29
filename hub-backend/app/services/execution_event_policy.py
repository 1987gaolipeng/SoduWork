"""Provider-neutral execution event identity and product-view compaction.

Runner archives keep the original structured events for diagnostics. Product
surfaces use the helpers here to remove transport replays and repeated progress
narration without hiding tool evidence or collapsing separate user turns.
"""
from __future__ import annotations

import re
from typing import Iterable


_SPACE = re.compile(r"\s+")
_ID_KEYS = ("event_id", "eventId", "message_id", "messageId", "call_id", "callId")
_ID_CONTAINERS = ("item", "part", "assistantMessageEvent", "toolCall", "message")


def _text(value) -> str:
    return _SPACE.sub(" ", str(value or "").replace("\u00a0", " ")).strip()


def _item_text(item: dict) -> str:
    return _text(item.get("full") or item.get("text") or "")


def _source_id(value, depth: int = 0) -> str:
    if not isinstance(value, dict) or depth > 3:
        return ""
    for key in _ID_KEYS:
        found = value.get(key)
        if isinstance(found, (str, int)) and str(found).strip():
            return str(found).strip()[:240]
    for key in _ID_CONTAINERS:
        found = _source_id(value.get(key), depth + 1)
        if found:
            return found
    # A top-level id is often a thread/session id shared by many events. Prefer
    # nested item/message ids and use this generic fallback only when no specific
    # provider identity exists.
    found = value.get("id")
    if isinstance(found, (str, int)) and str(found).strip():
        return str(found).strip()[:240]
    return ""


def tag_source_ids(message: dict | None, items: list[dict]) -> list[dict]:
    """Attach a stable provider event identity when the CLI exposes one."""
    if not isinstance(message, dict) or not items:
        return items
    source = _source_id(message)
    if not source:
        return items
    event_type = _text(message.get("type") or "event").lower()[:60]
    for index, item in enumerate(items):
        if isinstance(item, dict) and not item.get("_sourceId"):
            item["_sourceId"] = f"{event_type}:{source}:{index}"[:360]
    return items


def _source_key(item: dict) -> tuple[str, str, str, str] | None:
    source = _text(item.get("_sourceId") or item.get("sourceId"))
    if not source:
        return None
    return (source, _text(item.get("kind")).lower(),
            _text(item.get("tool")).lower(), _item_text(item))


def _say_key(item: dict) -> str:
    # Repeated chunks are content, not duplicate narration. Stream identity
    # already filters transport replays without losing punctuation or words.
    if item.get("streamId") or item.get("delta"):
        return ""
    return _item_text(item) if _text(item.get("kind")).lower() == "say" else ""


def filter_new(run: dict, items: Iterable[dict]) -> list[dict]:
    """Drop replayed provider events and repeated narration in one work round.

    Tool actions are never semantically collapsed: running the same command twice
    can be meaningful evidence. Exact assistant narration is collapsed until a
    new user turn/round starts, which removes the Codex/Pi progress floods while
    preserving normal multi-turn conversation.
    """
    current_round = max(1, int(run.get("round") or 1))
    seen_sources: set[tuple[str, str, str, str]] = set()
    seen_says: set[str] = set()
    for old in reversed(list(run.get("lines") or [])[-800:]):
        if not isinstance(old, dict):
            continue
        if _text(old.get("kind")).lower() == "user":
            break
        old_round = max(1, int(old.get("_round") or old.get("round") or 1))
        if old_round != current_round:
            break
        source = _source_key(old)
        if source:
            seen_sources.add(source)
        say = _say_key(old)
        if say:
            seen_says.add(say)

    accepted: list[dict] = []
    for value in items:
        if not isinstance(value, dict):
            continue
        item = dict(value)
        item["_round"] = current_round
        kind = _text(item.get("kind")).lower()
        if kind == "user":
            seen_sources.clear()
            seen_says.clear()
            accepted.append(item)
            continue
        source = _source_key(item)
        if source and source in seen_sources:
            continue
        say = _say_key(item)
        if say and say in seen_says:
            continue
        accepted.append(item)
        if source:
            seen_sources.add(source)
        if say:
            seen_says.add(say)
    return accepted


def visible_items(items: Iterable[dict]) -> list[dict]:
    """Return the canonical user-visible stream while preserving raw storage."""
    accepted: list[dict] = []
    seen_sources: set[tuple[str, str, str, str]] = set()
    seen_says: set[str] = set()
    scope = None
    for value in items:
        if not isinstance(value, dict):
            continue
        item = dict(value)
        round_value = item.get("round") or item.get("_round")
        next_scope = int(round_value) if str(round_value or "").isdigit() else scope
        if scope is not None and next_scope is not None and next_scope != scope:
            seen_sources.clear()
            seen_says.clear()
        if next_scope is not None:
            scope = next_scope
        kind = _text(item.get("kind")).lower()
        if kind == "user":
            seen_sources.clear()
            seen_says.clear()
            accepted.append(item)
            continue
        source = _source_key(item)
        if source and source in seen_sources:
            continue
        say = _say_key(item)
        if say and say in seen_says:
            continue
        accepted.append(item)
        if source:
            seen_sources.add(source)
        if say:
            seen_says.add(say)
    return accepted
