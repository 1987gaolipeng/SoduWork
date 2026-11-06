"""Low-cardinality, dependency-free request telemetry for the Hub process.

This is deliberately a bounded live window, not a replacement for Prometheus/OpenTelemetry.
It gives the product an honest operational view today and keeps the export boundary small.
"""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import math
import time


_STARTED = time.time()
_WINDOW_MINUTES = 30
_LATENCY_BUCKETS = (50, 100, 250, 500, 1000, 2500, 5000, math.inf)
_TIMING_FIELDS = ("admissionMs", "upstreamHeadersMs", "bodyMs", "totalMs")
_minutes: dict[int, dict[tuple[str, str], dict]] = {}
_recent_errors: deque[dict] = deque(maxlen=30)
_stream_minutes: dict[int, dict] = {}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _trim(now_minute: int) -> None:
    oldest = now_minute - _WINDOW_MINUTES + 1
    for key in tuple(_minutes):
        if key < oldest:
            _minutes.pop(key, None)
    for key in tuple(_stream_minutes):
        if key < oldest:
            _stream_minutes.pop(key, None)


def record_stream(route: str, outcome: str, duration_ms: float, request_id: str = "",
                  status: int = 0, source: str = "") -> None:
    """Record stream completion independently of the already-sent HTTP status."""
    minute = int(time.time() // 60)
    _trim(minute)
    row = _stream_minutes.setdefault(minute, {"completed": 0, "failed": 0, "cancelled": 0, "totalMs": 0.0})
    final = outcome if outcome in {"completed", "failed", "cancelled"} else "failed"
    row[final] += 1
    row["totalMs"] += max(0.0, float(duration_ms))
    if final == "failed":
        _recent_errors.appendleft({"at": _now_ms(), "requestId": request_id,
            "method": "STREAM", "route": str(route)[:180], "status": int(status),
            "type": source if source in {"admission", "upstream", "proxy"} else "stream"})


def record(method: str, route: str, status: int, duration_ms: float,
           request_id: str = "", error_type: str = "", timing=None) -> None:
    """Record one completed request. ``route`` must be a normalized framework route."""
    if route.startswith("/assets/"):
        return
    minute = int(time.time() // 60)
    _trim(minute)
    key = (str(method or "GET")[:10], str(route or "unmatched")[:180])
    bucket = _minutes.setdefault(minute, {}).setdefault(key, {
        "count": 0, "errors": 0, "sumMs": 0.0, "maxMs": 0.0,
        "latency": [0] * len(_LATENCY_BUCKETS),
        "timing": {key: [0.0, 0] for key in _TIMING_FIELDS},
    })
    ms = max(0.0, float(duration_ms or 0))
    bucket["count"] += 1
    bucket["errors"] += int(status >= 500)
    bucket["sumMs"] += ms
    bucket["maxMs"] = max(bucket["maxMs"], ms)
    for index, ceiling in enumerate(_LATENCY_BUCKETS):
        if ms <= ceiling:
            bucket["latency"][index] += 1
            break
    timing_stats = bucket.setdefault(
        "timing", {field: [0.0, 0] for field in _TIMING_FIELDS})
    for field in _TIMING_FIELDS:
        value = timing.get(field) if isinstance(timing, dict) else None
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            timing_stats[field][0] += max(0.0, float(value))
            timing_stats[field][1] += 1
    if status >= 500:
        _recent_errors.appendleft({
            "at": _now_ms(), "requestId": request_id, "method": key[0],
            "route": key[1], "status": int(status), "type": str(error_type or "")[:80],
        })


def _percentile(histogram: list[int], total: int, quantile: float) -> int:
    if total <= 0:
        return 0
    target, seen = max(1, math.ceil(total * quantile)), 0
    for count, ceiling in zip(histogram, _LATENCY_BUCKETS):
        seen += count
        if seen >= target:
            return 5000 if math.isinf(ceiling) else int(ceiling)
    return 5000


def summary() -> dict:
    minute = int(time.time() // 60)
    _trim(minute)
    merged: dict[tuple[str, str], dict] = {}
    for rows in _minutes.values():
        for key, row in rows.items():
            out = merged.setdefault(key, {
                "count": 0, "errors": 0, "sumMs": 0.0, "maxMs": 0.0,
                "latency": [0] * len(_LATENCY_BUCKETS),
                "timing": {key: [0.0, 0] for key in _TIMING_FIELDS},
            })
            for field in ("count", "errors", "sumMs"):
                out[field] += row[field]
            out["maxMs"] = max(out["maxMs"], row["maxMs"])
            out["latency"] = [a + b for a, b in zip(out["latency"], row["latency"])]
            row_timing = row.get("timing") or {}
            for field in _TIMING_FIELDS:
                values = row_timing.get(field, (0.0, 0))
                out["timing"][field][0] += values[0]
                out["timing"][field][1] += values[1]
    total = sum(x["count"] for x in merged.values())
    errors = sum(x["errors"] for x in merged.values())
    histogram = [sum(x["latency"][i] for x in merged.values())
                 for i in range(len(_LATENCY_BUCKETS))]
    routes = []
    for key, row in merged.items():
        timing = {field: {"avgMs": round(total / count, 1)}
                  for field, (total, count) in row["timing"].items() if count}
        routes.append({
            "method": key[0], "route": key[1], "requests": row["count"],
            "errors": row["errors"],
            "avgMs": round(row["sumMs"] / row["count"], 1) if row["count"] else 0,
            "p95Ms": _percentile(row["latency"], row["count"], .95),
            "maxMs": round(row["maxMs"], 1),
            **({"timing": timing} if timing else {}),
        })
    routes.sort(key=lambda x: (x["errors"], x["requests"]), reverse=True)
    return {
        "windowMinutes": _WINDOW_MINUTES, "requests": total, "errors": errors,
        "errorRate": round(errors / total, 4) if total else 0,
        "p95Ms": _percentile(histogram, total, .95),
        "uptimeSeconds": max(0, int(time.time() - _STARTED)),
        "startedAt": int(_STARTED * 1000), "routes": routes[:12],
        "recentErrors": list(_recent_errors),
        "streams": {key: sum(row[key] for row in _stream_minutes.values())
                    for key in ("completed", "failed", "cancelled", "totalMs")},
    }


def reset_for_test() -> None:
    _minutes.clear()
    _recent_errors.clear()
    _stream_minutes.clear()
