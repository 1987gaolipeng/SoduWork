"""Small Pi file-tool preparation hints; never execution or delivery evidence."""
from __future__ import annotations

_FILE_TOOLS = frozenset({
    "read", "read_file", "readfile", "write", "write_file", "writefile",
    "create_file", "edit", "edit_file", "editfile", "delete", "delete_file",
    "deletefile", "remove_file",
})
_PATH_KEYS = ("path", "filePath", "file_path")


def path_arguments(value):
    if not isinstance(value, dict):
        return {}
    for key in _PATH_KEYS:
        path = value.get(key)
        if isinstance(path, str) and path.strip():
            return {key: path[:1500]}
    return {}


def _identity(value):
    return value[:360] if isinstance(value, str) else ""


def _hint(state, call, phase):
    state["revision"] += 1
    return {"kind": "tool-preparing", "callId": call["callId"],
            "tool": call["tool"], "text": next(iter(call["arguments"].values()), "")[:300],
            "arguments": dict(call["arguments"]), "phase": phase,
            "_sourceId": "preparing:%s:%s" % (state["scope"], state["revision"])}


def items(message, run):
    """None keeps the original parser; a list replaces only this event's rows.

    Pi SDK toolcall_start/delta expose the parsed partial content block. Do not
    parse delta JSON or retain its content/newText/body while a file is generated.
    Completed assistant snapshots are deliberately not replayed as tool starts.
    """
    scope = (run.get("segment", 1), run.get("round", 1))
    state = run.setdefault("_toolPreparation", {})
    if state.get("scope") != scope:
        state.clear()
        state.update(scope=scope, pending={}, published=set(), closed=set(), revision=0)
    pending, published, closed = state["pending"], state["published"], state["closed"]
    kind = message.get("type")
    ame = message.get("assistantMessageEvent")
    event = ame.get("type") if isinstance(ame, dict) else None
    if event in {"toolcall_start", "toolcall_delta"}:
        partial = ame.get("partial")
        content = partial.get("content") if isinstance(partial, dict) else None
        index = ame.get("contentIndex")
        if (not isinstance(content, list) or not isinstance(index, int)
                or isinstance(index, bool) or not 0 <= index < len(content)):
            return []
        call = content[index]
        if not isinstance(call, dict) or call.get("type") != "toolCall":
            return []
        identity = _identity(call.get("id"))
        name = call.get("name")
        if not identity or identity in closed or not isinstance(name, str):
            return []
        if name.lower() not in _FILE_TOOLS:
            old = pending.pop(identity, None)
            return [_hint(state, old, "cancelled")] if old else []
        value = {"callId": identity, "tool": name[:120],
                 "arguments": path_arguments(call.get("arguments"))}
        if pending.get(identity) == value:
            return []
        pending[identity] = value
        return [_hint(state, value, "preparing")]
    if event == "toolcall_end":
        call = ame.get("toolCall")
        identity = _identity(call.get("id")) if isinstance(call, dict) else ""
        if identity:
            pending.pop(identity, None)
            closed.add(identity)
            if identity in published:
                return []
            published.add(identity)
        return None  # Preserve the existing complete tool-call parser and policy.
    if kind == "tool_execution_start":
        identity = _identity(message.get("toolCallId"))
        old = pending.get(identity)
        name = message.get("toolName") or (old or {}).get("tool")
        if not isinstance(name, str) or not name:
            return []
        pending.pop(identity, None)
        if identity:
            closed.add(identity)
            if identity in published:
                return []
            published.add(identity)
        # A host can execute a tool without forwarding toolcall_end (e.g. ACP).
        # The start is execution evidence; preparation never creates this row.
        from .runtime_messages import short_arguments
        args = short_arguments(message.get("args") or message.get("arguments") or message.get("input"))
        if not args and old:
            args = old["arguments"]
        brief = next((args[key] for key in (*_PATH_KEYS, "command", "pattern", "query") if key in args), "")
        return [{"kind": "do", "callId": identity, "tool": name[:120],
                 "text": brief[:300], "arguments": args}]
    if kind == "tool_execution_end":
        identity = _identity(message.get("toolCallId"))
        pending.pop(identity, None)
        if identity:
            closed.add(identity)
        return None  # The existing out row clears preparation and keeps results.
    body = message.get("message")
    reason = body.get("stopReason") if isinstance(body, dict) else ""
    terminal = kind in {"agent_settled", "agent_end", "error", "turn.failed"}
    terminal = terminal or (kind == "message_end" and reason in {
        "error", "aborted", "length", "max_tokens", "stop"})
    if terminal and pending:
        rows = [_hint(state, call, "cancelled") for call in pending.values()]
        closed.update(pending)
        pending.clear()
        return rows
    return None
