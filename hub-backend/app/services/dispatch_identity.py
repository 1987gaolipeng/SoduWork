"""Stable, non-secret identities shared by Hub and Runner dispatch paths.

The transport request id only correlates one WebSocket round trip.  A direct
dispatch needs a business id that survives retries, reconnects and process
restarts.  ``execution_ref`` deliberately contains no task, user or credential
data and can therefore be persisted and logged safely.
"""
from __future__ import annotations

import re
import uuid


_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
_NAMESPACE = uuid.UUID("9af442c8-cd1d-4b91-a668-22da2b2635bf")


def clean_dispatch_id(value) -> str:
    """Return a bounded dispatch id or an empty string for legacy calls."""
    text = str(value or "").strip()
    return text if _SAFE_ID.fullmatch(text) else ""


def execution_ref(dispatch_id) -> str:
    """Map one dispatch attempt to the same UUID on every machine."""
    clean = clean_dispatch_id(dispatch_id)
    return str(uuid.uuid5(_NAMESPACE, clean)) if clean else ""
