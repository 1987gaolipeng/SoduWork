"""Claude's explicitly exposed thinking chunks; signatures are never displayed."""
from __future__ import annotations


def items(message: dict, run: dict):
    """None is unrelated; a list contains thought rows only.

    For `assistant`, the caller must also retain the ordinary text/tool parser.
    Its final thought snapshot replaces partial chunks using the same streamId.
    """
    kind = message.get("type")
    if kind not in ("stream_event", "assistant"):
        return None
    state = run.setdefault("_claudeMessages", {})
    segment = run.get("segment", 1)
    if state.get("segment") != segment:
        state.clear()
        state.update(segment=segment, channels={}, ordinal=0)
    parent = str(message.get("parent_tool_use_id") or "root")[:120]
    channels = state["channels"]
    channel = channels.setdefault(parent, {"message": "", "blocks": {}})
    while len(channels) > 128:
        del channels[next(iter(channels))]

    def row(text, index, identity, *, delta=False, done=False):
        state["ordinal"] += 1
        stream = "claude:%s:%s:%s" % (parent, str(identity)[:120], index)
        result = {"kind": "thinking", "text": str(text or "")[:50000],
                  "tool": "", "streamId": stream, "delta": delta, "done": done}
        if delta:
            result["_sourceId"] = "claude-delta:%s:%s" % (segment, state["ordinal"])
        return result

    if kind == "assistant":
        body = message.get("message") or {}
        identity = body.get("id") or channel["message"] or message.get("uuid") or "final"
        content = body.get("content")
        if not isinstance(content, list):
            return []
        return [row(block["thinking"], index, identity, done=True)
                for index, block in enumerate(content)
                if isinstance(block, dict) and block.get("type") == "thinking"
                and isinstance(block.get("thinking"), str) and block["thinking"]]

    event = message.get("event") or {}
    if not isinstance(event, dict):
        return []
    event_type = event.get("type")
    if event_type == "message_start":
        channel["message"] = str((event.get("message") or {}).get("id") or
                                 "partial-%s" % state["ordinal"])
        channel["blocks"] = {}
        return []
    identity = channel["message"]
    if not identity:
        return []  # Cannot safely associate an orphan partial with a message.
    index = event.get("index")
    if event_type == "message_stop":
        rows = [row("", i, identity, delta=True, done=True)
                for i, live in channel["blocks"].items() if live]
        channel["blocks"] = {}
        return rows
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        return []
    if event_type == "content_block_start":
        block = event.get("content_block") or {}
        if block.get("type") != "thinking":
            return []
        channel["blocks"][index] = True
        return [row(block.get("thinking"), index, identity)]
    if event_type == "content_block_delta":
        delta = event.get("delta") or {}
        if delta.get("type") != "thinking_delta" or not isinstance(delta.get("thinking"), str):
            return []
        channel["blocks"][index] = True
        return [row(delta["thinking"], index, identity, delta=True)]
    if event_type == "content_block_stop" and channel["blocks"].get(index):
        channel["blocks"][index] = False
        return [row("", index, identity, delta=True, done=True)]
    return []
