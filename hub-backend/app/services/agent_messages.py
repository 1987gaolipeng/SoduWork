"""Machine-readable presentation descriptors for Agent setup responses.

The legacy ``why`` and ``warnNow`` strings remain in every response so older
clients keep rendering the same text. New clients can use the descriptors to
look up locale-specific copy without parsing or translating diagnostics.
"""
from __future__ import annotations


_STATUS_KEYS = {
    "missing": "agent.setup.missing",
    "setup": "agent.setup.prepare",
    "disabled": "agent.setup.disabled",
    "broken": "agent.setup.broken",
    "nollm": "agent.setup.model_required",
    "unauthed": "agent.auth.required",
    "unknown": "agent.setup.unknown",
    "ready": "agent.ready",
    "ok": "agent.probe.passed",
    "bad": "agent.probe.failed",
}


def descriptor(key: str, fallback: str = "", *, params: dict | None = None) -> dict:
    """Return a bounded descriptor while keeping the human fallback available."""
    return {
        "key": str(key or "agent.message.unknown")[:120],
        "params": dict(params or {}),
        "fallback": str(fallback or "")[:1000],
    }


def status_descriptor(agent: dict, *, fallback: str = "") -> dict:
    """Describe the status copy of an Agent without exposing implementation details."""
    key = str(agent.get("key") or "agent")[:80]
    name = str(agent.get("name") or key)[:160]
    state = str(agent.get("setupState") or agent.get("state") or "unknown")
    message_key = _STATUS_KEYS.get(state, "agent.setup.status")
    params = {"agent": key, "name": name, "state": state}
    if fallback:
        params["detail"] = str(fallback)[:400]
    return descriptor(message_key, fallback, params=params)


def runtime_descriptor(detail: str) -> dict:
    """Describe a runtime or environment failure with its diagnostic as a parameter."""
    text = str(detail or "")[:1000]
    return descriptor("agent.runtime.issue", text, params={"detail": text})


def copy_descriptor(agent_key: str, field: str, value: str) -> dict:
    """Give stable lookup keys for catalog copy while preserving legacy text."""
    key = str(agent_key or "agent").strip().lower()[:80] or "agent"
    name = str(field or "text").strip()[:80] or "text"
    return descriptor(f"agent.{key}.{name}", value)


def decorate(agent: dict) -> dict:
    """Add non-breaking descriptors to a setup payload from either a local or old Runner."""
    result = dict(agent or {})
    why = str(result.get("why") or result.get("runtimeIssue") or "")
    issue = str(result.get("runtimeIssue") or result.get("warnNow") or "")
    result.setdefault("whyMessage", status_descriptor(result, fallback=why))
    if issue:
        result.setdefault("warnMessage", runtime_descriptor(issue))
    agent_key = str(result.get("key") or "agent")
    copy = dict(result.get("copy") or {}) if isinstance(result.get("copy"), dict) else {}
    for field in ("name", "blurb", "warn", "configHow"):
        value = str(result.get(field) or "")
        if value:
            copy.setdefault(field, copy_descriptor(agent_key, field, value))
    if copy:
        result["copy"] = copy
    return result


def decorate_many(items) -> list[dict]:
    """Decorate an iterable defensively, retaining malformed legacy rows unchanged."""
    return [decorate(item) if isinstance(item, dict) else item for item in (items or [])]
