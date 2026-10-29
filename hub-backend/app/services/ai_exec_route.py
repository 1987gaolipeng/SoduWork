"""Fast provider routing shared by the AI execution facade."""
from __future__ import annotations

from . import ai_local

LOCAL_PREFIX = "local:"
REMOTE_PREFIX = "runner:"


def cli_of(aid: str) -> str:
    """Resolve a recipient ID such as local:pi or runner:<rid>:pi to its runtime key. Return empty
    for unknown formats so callers use their default.
    """
    value = str(aid or "").strip()
    if value.startswith(LOCAL_PREFIX):
        return value[len(LOCAL_PREFIX):].strip().lower()
    if value.startswith(REMOTE_PREFIX):
        # Runner IDs are issued internally and cannot contain colons.
        parts = value[len(REMOTE_PREFIX):].split(":", 1)
        return parts[1].strip().lower() if len(parts) == 2 else ""
    return ""


def by_assignee(aid: str):
    """Choose a provider from an assignee id; bare ids remain hosted."""
    value = str(aid or "")
    if value.startswith(LOCAL_PREFIX):
        return ai_local
    if value.startswith(REMOTE_PREFIX):
        from . import ai_remote
        return ai_remote
    return None


def by_ref(ref: str):
    """Resolve a run locally first, then ask online runners."""
    try:
        if ref and ref in getattr(ai_local, "_RUNS", {}):
            return ai_local
    except Exception:  # noqa: BLE001
        pass
    try:
        if ref:
            from . import ai_remote, runner_hub
            if runner_hub.online() and ai_remote._runner_of_ref(ref) is not None:
                return ai_remote
    except Exception:  # noqa: BLE001
        pass
    return None


async def by_ref_async(ref: str):
    """Async-safe run lookup; remote RPC must never block the event loop."""
    try:
        if ref and ref in getattr(ai_local, "_RUNS", {}):
            return ai_local
    except Exception:  # noqa: BLE001
        pass
    if not ref:
        return None
    try:
        from . import ai_remote, runner_hub
        if runner_hub.online() and await ai_remote.runner_of_ref_async(ref) is not None:
            return ai_remote
    except Exception:  # noqa: BLE001
        pass
    return None
