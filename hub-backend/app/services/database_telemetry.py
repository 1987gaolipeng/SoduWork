"""Bounded, process-local DB timings. Never retain SQL, parameters or URLs."""
from __future__ import annotations

from collections import deque
from contextvars import ContextVar
from dataclasses import dataclass, field
import json
import logging
import re
import time

from sqlalchemy import event
from sqlalchemy.exc import TimeoutError as PoolTimeout
from sqlalchemy.pool import AsyncAdaptedQueuePool


_log = logging.getLogger("soduwork.database.performance")
_current: ContextVar[Observation | None] = ContextVar("soduwork_db_observation", default=None)
_recent: deque[dict] = deque(maxlen=500)
_HOLD = "soduwork_db_observation"
_METRICS = ("acquireMs", "sqlMs", "holdMs")


@dataclass
class Observation:
    started: float = field(default_factory=time.perf_counter)
    acquire_ms: float = 0
    sql_ms: float = 0
    hold_ms: float = 0
    acquisitions: int = 0
    queries: int = 0
    pool_timeouts: int = 0
    acquire_errors: int = 0
    sql_errors: int = 0
    holds: dict[int, float] = field(default_factory=dict)
    ended: bool = False
    published: bool = False
    metadata: dict = field(default_factory=dict)

    def snapshot(self):
        now = time.perf_counter()
        return {
            "acquireMs": round(self.acquire_ms, 2), "sqlMs": round(self.sql_ms, 2),
            "holdMs": round(self.hold_ms + sum((now - start) * 1000 for start in self.holds.values()), 2),
            "acquisitions": self.acquisitions, "queries": self.queries,
            "poolTimeouts": self.pool_timeouts, "sqlErrors": self.sql_errors,
            "acquireErrors": self.acquire_errors,
        }


class ObservedAsyncAdaptedQueuePool(AsyncAdaptedQueuePool):
    def connect(self):
        # Public Pool.connect includes queue wait, creation/recycle and pre-ping.
        # Keep checkout/checkin and overflow behavior entirely in SQLAlchemy.
        observation = _current.get()
        if observation is None or observation.ended:
            return super().connect()
        started = time.perf_counter()
        try:
            return super().connect()
        except PoolTimeout:
            observation.pool_timeouts += 1
            raise
        except Exception:
            observation.acquire_errors += 1
            raise
        finally:
            observation.acquisitions += 1
            observation.acquire_ms += (time.perf_counter() - started) * 1000


def _slow(row):
    return (row["acquireMs"] >= 250 or row["sqlMs"] >= 500 or row["holdMs"] >= 1000
            or row["poolTimeouts"] > 0 or row["sqlErrors"] > 0 or row["acquireErrors"] > 0)


def _publish(observation):
    if observation.published or not observation.ended or observation.holds:
        return
    observation.published = True
    if not observation.acquisitions and not observation.queries:
        return
    row = {**observation.metadata, **observation.snapshot()}
    _recent.append(row)
    if _slow(row):
        try:
            _log.warning("database_latency %s", json.dumps(row, ensure_ascii=True))
        except Exception:
            pass  # A diagnostic sink must never turn a successful DB call into an error.


def install(engine):
    """Install once on an AsyncEngine; events do not execute additional SQL."""
    sync = engine.sync_engine
    if getattr(sync, "_soduwork_database_observed", False):
        return
    sync._soduwork_database_observed = True

    def checkout(_connection, record, _proxy):
        observation = _current.get()
        if observation is not None and not observation.ended:
            observation.holds[id(record)] = time.perf_counter()
            # record_info survives invalidation; info belongs to the DBAPI connection.
            record.record_info[_HOLD] = observation

    def release(_connection, record):
        observation = record.record_info.pop(_HOLD, None)
        if observation is None:
            return
        started = observation.holds.pop(id(record), None)
        if started is not None:
            observation.hold_ms += (time.perf_counter() - started) * 1000
        _publish(observation)

    def before(_connection, _cursor, _statement, _parameters, context, _many):
        observation = _current.get()
        if observation is not None and not observation.ended:
            context._soduwork_query_timing = (observation, time.perf_counter())

    def finish(context, failed=False):
        timing = getattr(context, "_soduwork_query_timing", None)
        if timing is None:
            return
        context._soduwork_query_timing = None
        observation, started = timing
        observation.queries += 1
        observation.sql_errors += int(failed)
        observation.sql_ms += (time.perf_counter() - started) * 1000

    event.listen(sync.pool, "checkout", checkout)
    event.listen(sync.pool, "checkin", release)
    event.listen(sync.pool, "detach", release)
    event.listen(sync, "before_cursor_execute", before)
    event.listen(sync, "after_cursor_execute", lambda _c, _cur, _s, _p, ctx, _many: finish(ctx))
    event.listen(sync, "handle_error", lambda context: finish(context.execution_context, True))


class DatabaseTimingMiddleware:
    """Pure ASGI scope keeps timings through streaming and dependency cleanup."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        observation = Observation()
        token = _current.set(observation)
        status = 500
        completed = False

        async def timed_send(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                timings = observation.snapshot()
                suffix = (f'db-acquire;dur={timings["acquireMs"]}, '
                          f'db-sql;dur={timings["sqlMs"]}, db-hold;dur={timings["holdMs"]}').encode("ascii")
                headers = list(message.get("headers", []))
                for index, (name, value) in enumerate(headers):
                    if name.lower() == b"server-timing":
                        headers[index] = (name, value + b", " + suffix)
                        break
                else:
                    headers.append((b"server-timing", suffix))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, timed_send)
            completed = True
        finally:
            _current.reset(token)
            observation.ended = True
            route = getattr(scope.get("route"), "path", None) or "__unmatched__"
            request_id = str(scope.get("state", {}).get("request_id", ""))
            observation.metadata = {
                "at": int(time.time() * 1000), "route": str(route)[:180],
                "method": str(scope.get("method", "GET"))[:10], "status": status,
                "completed": completed,
                "requestId": request_id if re.fullmatch(r"[A-Za-z0-9._:-]{8,64}", request_id) else "",
                "totalMs": round((time.perf_counter() - observation.started) * 1000, 2),
            }
            _publish(observation)


def summary(engine):
    """Recent bounded sample, not an all-time counter or cluster-wide aggregate."""
    cutoff = time.time() * 1000 - 30 * 60 * 1000
    rows = [row for row in _recent if row["at"] >= cutoff]
    routes = {}
    for row in rows:
        key = (row["method"], row["route"])
        group = routes.setdefault(key, {"method": key[0], "route": key[1], "samples": 0,
                                       "poolTimeouts": 0, "sqlErrors": 0, "acquireErrors": 0,
                                       **{metric: {"sum": 0, "maxMs": 0} for metric in _METRICS}})
        group["samples"] += 1
        for field_name in ("poolTimeouts", "sqlErrors", "acquireErrors"):
            group[field_name] += row[field_name]
        for metric in _METRICS:
            group[metric]["sum"] += row[metric]
            group[metric]["maxMs"] = max(group[metric]["maxMs"], row[metric])
    for group in routes.values():
        for metric in _METRICS:
            group[metric]["avgMs"] = round(group[metric].pop("sum") / group["samples"], 2)
    pool = engine.sync_engine.pool
    pool_state = {"kind": type(pool).__name__}
    for name in ("size", "checkedin", "checkedout", "overflow"):
        method = getattr(pool, name, None)
        if callable(method):
            pool_state[name] = max(0, method())
    return {"sampleLimit": _recent.maxlen, "windowMinutes": 30, "samples": len(rows), "pool": pool_state,
            "routes": sorted(routes.values(), key=lambda row: row["acquireMs"]["maxMs"], reverse=True)[:30],
            "recentSlow": [dict(row) for row in reversed(rows) if _slow(row)][:30]}


def reset_for_test():
    _recent.clear()
