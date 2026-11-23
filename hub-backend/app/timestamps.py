"""Serialize stored instants for API clients."""
from datetime import datetime, timezone


def iso_utc(value: datetime | None) -> str | None:
    """Return an ISO-8601 instant with an explicit UTC offset.

    Columns are declared ``DateTime(timezone=True)``, but SQLite returns naive
    values. They are UTC, as ``schemas._ms`` already assumes; without an offset
    JavaScript ``Date`` parses them as local time.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()
