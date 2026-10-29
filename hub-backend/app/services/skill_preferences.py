"""Device Skill defaults and explicit opt-outs; enterprise policy still gates use.

Legacy empty selections did not distinguish an untouched device from all-off.
The new default intentionally treats that ambiguous value as all available on.
A nonempty legacy selection stays a whitelist. The first explicit save records
opt-outs, including all-off, so subsequent reads never reset that choice.
"""
from __future__ import annotations

KEY = "skillPreferences"


def _preference(client):
    config = getattr(client, "config", None)
    value = config.get(KEY) if isinstance(config, dict) else None
    return value if isinstance(value, dict) and value.get("version") == 1 else None


def selected_names(client, rows) -> set[str]:
    if client is None:
        return set()
    previous = {str(name) for name in (getattr(client, "skills", None) or [])}
    preference = _preference(client)
    if preference is not None:
        disabled = preference.get("disabled")
        if not isinstance(disabled, list) or any(not isinstance(name, str) for name in disabled):
            return previous  # Malformed preferences never broaden the selection.
        return ({row["name"] for row in rows} | previous) - set(disabled)
    if KEY in (getattr(client, "config", None) or {}):
        return previous
    return previous or {row["name"] for row in rows}


def save_selection(client, requested, rows, visible) -> list[str]:
    """Update only visible choices; preserve opt-outs while a Skill is unavailable."""
    visible = set(visible)
    chosen = list(dict.fromkeys(name for name in requested if name in visible))
    preference = _preference(client)
    if preference is not None:
        disabled = set(preference.get("disabled") or [])
    else:
        previous = set(getattr(client, "skills", None) or [])
        disabled = {row["name"] for row in rows} - previous if previous else set()
    known = {row["name"] for row in rows}
    disabled = (disabled | ((visible & known) - set(chosen))) - set(chosen)
    client.config = {**(getattr(client, "config", None) or {}),
                     KEY: {"version": 1, "disabled": sorted(disabled)}}
    client.skills = chosen
    return chosen


def enable(client, name):
    """Explicit create/import actions also clear a previous opt-out for this name."""
    chosen = list(getattr(client, "skills", None) or [])
    preference = _preference(client)
    if preference is not None or not chosen:
        disabled = set((preference or {}).get("disabled") or []) - {name}
        client.config = {**(getattr(client, "config", None) or {}),
                         KEY: {"version": 1, "disabled": sorted(disabled)}}
    client.skills = list(dict.fromkeys([*chosen, name]))[:200]
