"""Database-coordinated model admission; shared by every Hub worker.

Short transactions lock one AppSetting row (also on SQLite). No transaction or
database connection is held while waiting for capacity or for a model. Leases
are bounded and expire after a dead worker; no prompts or credentials are stored.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
import uuid
import weakref
from contextlib import asynccontextmanager

import anyio
from sqlalchemy import func, select, text, update

from ..config import get_settings
from ..db import SessionLocal
from ..models import AppSetting
from ..model_runtime_models import ModelRuntimeLease, ModelRuntimeMetric
from .model_errors import UpstreamError
from .model_runtime_transaction import AbortTransaction, CleanupBudget, finish_cleanup, transaction_boundary

STATE_KEY = "model_runtime_state_v1"
POLICY_KEY = "model_runtime_policy_v1"
LEASE_SECONDS = 45
RENEW_SECONDS = 10
RENEW_RETRY_SECONDS = 1
RENEW_TIMEOUT_SECONDS = 5
MAX_POLICY_CONCURRENCY = 4096
MAX_POLICY_QUEUE = 4096
MAX_POLICY_USER_QUEUE = 1024
log = logging.getLogger("uvicorn.error")
_transaction_locks = weakref.WeakKeyDictionary()
_capacity_events = weakref.WeakKeyDictionary()
_capacity_broadcast = weakref.WeakKeyDictionary()
# The admission guard remains bounded, but these defaults must not serialize
# ordinary teams behind the low limits shipped with the first runtime build.
DEFAULTS = dict(globalConcurrent=128, providerConcurrent=64, keyConcurrent=64,
                modelConcurrent=32, userConcurrent=16, queueSize=128, userQueueSize=16,
                queueTimeout=20, requestTimeout=900, readTimeout=300, connectTimeout=15,
                providers={}, models={})
# 1.12.49 could persist this exact initial policy before the capacity fix.
# Upgrade only an untouched default row; an administrator's explicit policy is
# authoritative and must remain unchanged.
LEGACY_DEFAULTS = dict(globalConcurrent=64, providerConcurrent=16, keyConcurrent=16,
                       modelConcurrent=8, userConcurrent=4, queueSize=32, userQueueSize=4,
                       queueTimeout=20, requestTimeout=900, readTimeout=300, connectTimeout=15,
                       providers={}, models={})
BOUNDS = {**{k: (1, MAX_POLICY_CONCURRENCY) for k in ("globalConcurrent", "providerConcurrent",
          "keyConcurrent", "modelConcurrent", "userConcurrent")},
          "queueSize": (0, MAX_POLICY_QUEUE), "userQueueSize": (0, MAX_POLICY_USER_QUEUE),
          "queueTimeout": (1, 120),
          "requestTimeout": (30, 3600), "readTimeout": (5, 600), "connectTimeout": (1, 60)}
MODEL_RUNTIME_LOCK_KEY = 734836213


def _capacity_event():
    loop = asyncio.get_running_loop()
    event = _capacity_events.get(loop)
    if event is None:
        event = asyncio.Event()
        _capacity_events[loop] = event
    return event


async def _broadcast_capacity():
    try:
        from .cluster_bus import bus
        if bus.enabled and bus.healthy:
            await bus.broadcast({"kind": "model-runtime-capacity"})
    except Exception as exc:  # notification is an optimization; DB polling remains authoritative
        log.debug("[model-runtime] capacity notification unavailable: %s", type(exc).__name__)


def wake_capacity_waiters(*, broadcast=True):
    """Wake local model waiters; cluster delivery is best effort and never state-bearing."""
    _capacity_event().set()
    loop = asyncio.get_running_loop()
    task = _capacity_broadcast.get(loop)
    bus_enabled = False
    if broadcast:
        try:
            from .cluster_bus import bus
            bus_enabled = bus.enabled
        except Exception:
            pass
    if broadcast and bus_enabled and (task is None or task.done()):
        task = asyncio.create_task(_broadcast_capacity(), name="model-capacity-notification")
        _capacity_broadcast[loop] = task


def clean_policy(raw):
    if not isinstance(raw, dict):
        raise ValueError("并发策略必须是一个对象")
    out = dict(DEFAULTS)
    for key, (low, high) in BOUNDS.items():
        value = raw.get(key, DEFAULTS[key])
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise ValueError(f"{key} 必须是 {low}–{high} 的整数")
        out[key] = value
    for key in ("providers", "models"):
        entries = raw.get(key, {})
        if not isinstance(entries, dict) or len(entries) > 200:
            raise ValueError("服务/模型并发覆盖项最多 200 条")
        out[key] = {}
        for name, value in entries.items():
            if not isinstance(name, str) or not name or len(name) > 240:
                raise ValueError("并发覆盖项标识无效")
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_POLICY_CONCURRENCY:
                raise ValueError(f"服务/模型并发数必须是 1–{MAX_POLICY_CONCURRENCY} 的整数")
            out[key][name] = value
    return out


def fingerprint(value):
    return hmac.new(get_settings().auth_secret.encode(),
                    json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode(),
                    hashlib.sha256).hexdigest()


async def lock_setting(session, key, initial="{}"):
    # INSERT ... ON CONFLICT and UPDATE provide a real cross-process lock on
    # both supported databases; SELECT FOR UPDATE alone is ignored by SQLite.
    if session.bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    await session.execute(insert(AppSetting).values(key=key, value=initial)
                          .on_conflict_do_nothing(index_elements=["key"]))
    await session.execute(update(AppSetting).where(AppSetting.key == key)
                          .values(value=AppSetting.value))
    return await session.get(AppSetting, key, populate_existing=True)


async def _lock_runtime_state(session):
    """Serialize admission without writing a hot AppSetting row on PostgreSQL."""
    if session.bind.dialect.name == "postgresql":
        await session.execute(text(f"SELECT pg_advisory_xact_lock({MODEL_RUNTIME_LOCK_KEY})"))
        row = await session.get(AppSetting, STATE_KEY, populate_existing=True)
        if row is None:
            row = AppSetting(key=STATE_KEY, value="")
            session.add(row)
            await session.flush()
        return row
    return await lock_setting(session, STATE_KEY, "")


async def _now(session):
    # Database clock avoids node clock skew and retains sub-second queue metrics.
    expression = (func.extract("epoch", func.clock_timestamp())
                  if session.bind.dialect.name == "postgresql"
                  else (func.julianday("now") - 2440587.5) * 86400.0)
    return float(await session.scalar(select(expression)))


async def policy(session):
    row = await session.get(AppSetting, POLICY_KEY)
    if not row:
        return dict(DEFAULTS)
    raw = json.loads(row.value)
    if raw == LEGACY_DEFAULTS:
        return dict(DEFAULTS)
    return clean_policy(raw)


def _metric(state, now, name, amount=1):
    # A rolling hour, bounded to 60 minute buckets and fixed metric names.
    minute = int(now // 60)
    buckets = state.setdefault("metrics", {})
    for stale in list(buckets):
        if int(stale) < minute - 59:
            del buckets[stale]
    bucket = buckets.setdefault(str(minute), {})
    bucket[name] = bucket.get(name, 0) + amount


def _lease_payload(row):
    return dict(
        id=row.id,
        created=float(row.created_at),
        expires=float(row.expires_at),
        state=row.state,
        provider=row.provider,
        model=row.model,
        scopes={
            "global_": row.global_scope,
            "provider": row.provider_scope,
            "key": row.key_scope,
            "model": row.model_scope,
            "user": row.user_scope,
        },
        limits={
            "global_": row.global_limit,
            "provider": row.provider_limit,
            "key": row.key_limit,
            "model": row.model_limit,
            "user": row.user_limit,
        },
    )


def _legacy_state(raw):
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) and ("leases" in value or "metrics" in value) else None


async def _load_state(session, lock_row):
    lease_rows = list((await session.scalars(
        select(ModelRuntimeLease).order_by(ModelRuntimeLease.created_at, ModelRuntimeLease.id)
    )).all())
    metric_rows = list((await session.scalars(select(ModelRuntimeMetric))).all())
    state = {"leases": [_lease_payload(row) for row in lease_rows], "metrics": {}}
    for row in metric_rows:
        state["metrics"].setdefault(str(row.bucket), {})[row.name] = row.value

    legacy = _legacy_state(lock_row.value)
    if not lease_rows and legacy:
        # The legacy row is the complete pre-0074 snapshot. If a crash left
        # only part of the new tables behind, prefer that snapshot for the
        # missing lease set instead of clearing it and losing admission state.
        state["leases"] = list(legacy.get("leases") or [])
        state["metrics"] = dict(legacy.get("metrics") or {})
        return state, lease_rows, metric_rows, True
    return state, lease_rows, metric_rows, False


def _set_if_changed(row, name, value):
    if getattr(row, name) == value:
        return False
    setattr(row, name, value)
    return True


async def _persist_state(session, lock_row, state, lease_rows, metric_rows, legacy_adopted):
    changed = legacy_adopted
    existing = {row.id: row for row in lease_rows}
    desired = {str(item.get("id")): item for item in state.get("leases", [])
               if isinstance(item, dict) and item.get("id")}
    for identifier, row in existing.items():
        if identifier not in desired:
            await session.delete(row)
            changed = True

    for identifier, item in desired.items():
        scopes, limits = item.get("scopes") or {}, item.get("limits") or {}
        row = existing.get(identifier)
        if row is None:
            session.add(ModelRuntimeLease(
                id=identifier,
                state=str(item.get("state") or "queued"),
                created_at=float(item.get("created") or 0),
                expires_at=float(item.get("expires") or 0),
                provider=str(item.get("provider") or "")[:80],
                model=str(item.get("model") or "")[:160],
                global_scope=str(scopes.get("global_") or "all")[:96],
                provider_scope=str(scopes.get("provider") or "")[:96],
                key_scope=str(scopes.get("key") or "")[:96],
                model_scope=str(scopes.get("model") or "")[:96],
                user_scope=str(scopes.get("user") or "")[:96],
                global_limit=int(limits.get("global_", 1)),
                provider_limit=int(limits.get("provider", 1)),
                key_limit=int(limits.get("key", 1)),
                model_limit=int(limits.get("model", 1)),
                user_limit=int(limits.get("user", 1)),
            ))
            changed = True
            continue
        changed |= _set_if_changed(row, "state", str(item.get("state") or "queued"))
        changed |= _set_if_changed(row, "created_at", float(item.get("created") or 0))
        changed |= _set_if_changed(row, "expires_at", float(item.get("expires") or 0))
        changed |= _set_if_changed(row, "provider", str(item.get("provider") or "")[:80])
        changed |= _set_if_changed(row, "model", str(item.get("model") or "")[:160])
        changed |= _set_if_changed(row, "global_scope", str(scopes.get("global_") or "all")[:96])
        changed |= _set_if_changed(row, "provider_scope", str(scopes.get("provider") or "")[:96])
        changed |= _set_if_changed(row, "key_scope", str(scopes.get("key") or "")[:96])
        changed |= _set_if_changed(row, "model_scope", str(scopes.get("model") or "")[:96])
        changed |= _set_if_changed(row, "user_scope", str(scopes.get("user") or "")[:96])
        changed |= _set_if_changed(row, "global_limit", int(limits.get("global_", 1)))
        changed |= _set_if_changed(row, "provider_limit", int(limits.get("provider", 1)))
        changed |= _set_if_changed(row, "key_limit", int(limits.get("key", 1)))
        changed |= _set_if_changed(row, "model_limit", int(limits.get("model", 1)))
        changed |= _set_if_changed(row, "user_limit", int(limits.get("user", 1)))

    desired_metrics = {}
    for bucket, values in (state.get("metrics") or {}).items():
        if not isinstance(values, dict):
            continue
        for name, value in values.items():
            if name != "sample":
                desired_metrics[(int(bucket), str(name)[:32])] = int(value)
    existing_metrics = {(row.bucket, row.name): row for row in metric_rows}
    for key, row in existing_metrics.items():
        if key not in desired_metrics:
            await session.delete(row)
            changed = True
    for key, value in desired_metrics.items():
        row = existing_metrics.get(key)
        if row is None:
            session.add(ModelRuntimeMetric(bucket=key[0], name=key[1], value=value))
            changed = True
        else:
            changed |= _set_if_changed(row, "value", value)

    if lock_row.value:
        lock_row.value = ""
        changed = True
    return changed


def _sweep(state, now):
    rows = state.setdefault("leases", [])
    active = [row for row in rows if row["expires"] > now]
    expired = len(rows) - len(active)
    if expired:
        state["leases"] = active
        _metric(state, now, "expired", expired)


def _schedule(state, now):
    rows = state["leases"]
    # A request is admitted when its count is below the smallest limit among
    # the request and already-running peers in each dimension. Keeping these
    # aggregates avoids rescanning every running row for every queued row.
    running_counts = {}
    running_min_limits = {}
    dimensions = tuple(rows[0]["scopes"]) if rows else ()
    for row in rows:
        if row["state"] != "running":
            continue
        for dimension in dimensions:
            scope = row["scopes"][dimension]
            counts = running_counts.setdefault(dimension, {})
            limits = running_min_limits.setdefault(dimension, {})
            counts[scope] = counts.get(scope, 0) + 1
            limits[scope] = min(limits.get(scope, row["limits"][dimension]), row["limits"][dimension])
    for row in rows:  # insertion order is FIFO among requests that can run
        if row["state"] != "queued":
            continue
        available = True
        for dimension, scope in row["scopes"].items():
            count = running_counts.get(dimension, {}).get(scope, 0)
            peer_limit = running_min_limits.get(dimension, {}).get(scope, row["limits"][dimension])
            if count >= min(row["limits"][dimension], peer_limit):
                available = False
                break
        if available:
            row.update(state="running", expires=now + LEASE_SECONDS)
            for dimension, scope in row["scopes"].items():
                counts = running_counts.setdefault(dimension, {})
                limits = running_min_limits.setdefault(dimension, {})
                counts[scope] = counts.get(scope, 0) + 1
                limits[scope] = min(limits.get(scope, row["limits"][dimension]), row["limits"][dimension])
            _metric(state, now, "started")
            _metric(state, now, "waitMs", max(0, int((now - row["created"]) * 1000)))


@asynccontextmanager
async def _state(cancel_lease="", cancel_outcome=lambda: "cancelled", cleanup_budget=None, *, read_policy=False):
    # Serialize this worker before checking out a DB connection: competing
    # requests should wait in the event loop, not fill the DB pool with lockers.
    # The SQL lock below remains the cross-worker source of truth.
    loop = asyncio.get_running_loop()
    lock = _transaction_locks.setdefault(loop, asyncio.Lock())
    session_factory = SessionLocal
    async def transaction(control):
        changed = False
        async with lock, session_factory() as session:
            if control.aborted:
                raise AbortTransaction()
            async with session.begin():
                lock_row = await _lock_runtime_state(session)
                state, lease_rows, metric_rows, legacy_adopted = await _load_state(session, lock_row)
                capacity_before = {(row['id'], row['state']) for row in state['leases']}
                now = await _now(session)
                _sweep(state, now)
                config = await policy(session) if read_policy else None
                await control.deliver((state, now, config))
                changed = await _persist_state(session, lock_row, state, lease_rows, metric_rows,
                                               legacy_adopted)
                capacity_changed = capacity_before != {(row['id'], row['state']) for row in state['leases']}
        # Lease renewal and metric writes cannot make queued capacity available.
        if changed and capacity_changed:
            wake_capacity_waiters()

    async def compensate(cause):
        # A cancellation can race with commit. Remove only this request's ID
        # from fresh locked state; never restore an old cross-worker snapshot.
        changed = False
        async with lock, session_factory() as session:
            async with session.begin():
                lock_row = await _lock_runtime_state(session)
                state, lease_rows, metric_rows, legacy_adopted = await _load_state(session, lock_row)
                now = await _now(session)
                _sweep(state, now)
                hit = next((item for item in state["leases"] if item["id"] == cancel_lease), None)
                if hit:
                    state["leases"].remove(hit)
                    outcome = cancel_outcome() if isinstance(cause, asyncio.CancelledError) else "failed"
                    _metric(state, now, outcome)
                _schedule(state, now)
                changed = await _persist_state(session, lock_row, state, lease_rows, metric_rows,
                                               legacy_adopted)
        if changed:
            wake_capacity_waiters()

    async with transaction_boundary(transaction, compensate if cancel_lease else None, cleanup_budget) as value:
        yield value


class CapacityError(UpstreamError):
    def __init__(self, message="模型服务当前繁忙，请稍后重试", status=429):
        super().__init__(status, "", message)
        self.retry_after = 3


async def _remove(identifier, outcome):
    async with _state(identifier, lambda: outcome) as (state, now, _):
        rows = state["leases"]
        hit = next((r for r in rows if r["id"] == identifier), None)
        if hit:
            rows.remove(hit)
            _metric(state, now, outcome)
        _schedule(state, now)


class Lease:
    def __init__(self, identifier, config, valid_until):
        self.id, self.policy = identifier, config
        self.deadline = time.monotonic() + config["requestTimeout"]
        # This lower bound starts before the admitting DB transaction, not at
        # construction: pool/lock/commit time must not extend the real lease.
        self.valid_until = valid_until
        self.lost = asyncio.Event()
        self.closed = False
        self.renewal = asyncio.create_task(self._renew())
        self.expiry = asyncio.create_task(self._watch_expiry())

    async def _watch_expiry(self):
        # Transaction cancellation/rollback may itself wait on a failed DB.
        # Expire independently so cleanup cannot prolong unaccounted capacity.
        while not self.closed and not self.lost.is_set():
            remaining = self.valid_until - time.monotonic()
            if remaining <= 0:
                self.lost.set()
                return
            await asyncio.sleep(remaining)

    async def _renew(self):
        delay, failures = RENEW_SECONDS, 0
        while not self.closed and not self.lost.is_set():
            await asyncio.sleep(min(delay, max(0, self.valid_until - time.monotonic())))
            started = time.monotonic()
            remaining = self.valid_until - started
            if remaining <= 0 or self.lost.is_set():
                self.lost.set()
                return
            try:
                async with asyncio.timeout(min(RENEW_TIMEOUT_SECONDS, remaining)):
                    async with _state() as (state, now, _):
                        hit = next((r for r in state["leases"] if r["id"] == self.id), None)
                        if hit is None or hit["state"] != "running":
                            self.lost.set()
                            return
                        hit["expires"] = now + LEASE_SECONDS
                # Only a confirmed commit extends the bound. A late commit
                # cannot revive a lease already expired by the independent guard.
                renewed_until = started + LEASE_SECONDS
                # Timers may not have run yet after an event-loop stall. Check
                # both bounds synchronously before publishing any extension.
                if self.lost.is_set() or time.monotonic() >= min(self.valid_until, renewed_until):
                    self.lost.set()
                    return
                self.valid_until = renewed_until
                delay, failures = RENEW_SECONDS, 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # A brief DB/pool/lock interruption does not invalidate the
                # previously committed lease or justify replaying a model call.
                if not failures:
                    log.warning("[model-runtime] lease renewal interrupted: %s; retrying within lease",
                                type(exc).__name__)
                failures += 1
                delay = RENEW_RETRY_SECONDS

    async def run(self, awaitable):
        operation = asyncio.ensure_future(awaitable)
        lost = asyncio.create_task(self.lost.wait())
        delivered = False
        try:
            async with asyncio.timeout(max(0, self.deadline - time.monotonic())):
                done, _ = await asyncio.wait((operation, lost), return_when=asyncio.FIRST_COMPLETED)
                if lost in done:
                    raise CapacityError("模型并发调度连接中断，请稍后重试", 503)
                result = await operation
                delivered = True
                return result
        finally:
            operation.cancel()
            lost.cancel()
            with anyio.CancelScope(shield=True):
                await asyncio.gather(operation, lost, return_exceptions=True)
                # A socket may finish opening in the same tick as cancellation.
                if not delivered and not operation.cancelled() and not operation.exception():
                    result = operation.result()
                    if hasattr(result, "aclose"):
                        with anyio.move_on_after(5):
                            await result.aclose()

    async def close(self, outcome="completed"):
        if self.closed:
            return
        self.closed = True
        self.renewal.cancel()
        self.expiry.cancel()

        async def release():
            # Raw Task.cancel() can interrupt joining the renewal worker. Own
            # the whole close sequence so it cannot skip lease removal.
            await asyncio.gather(self.renewal, self.expiry, return_exceptions=True)
            try:
                await _remove(self.id, outcome)
            except Exception:
                pass  # the finite lease is the fallback after database loss

        if await finish_cleanup(release()):
            raise asyncio.CancelledError


async def acquire(conf):
    identifier = uuid.uuid4().hex
    registered = False
    admitted = False
    reason = "cancelled"
    deadline = None
    timer = None
    queue_budget = False
    cleanup_budget = CleanupBudget()

    def cancelled_outcome():
        if timer is not None and timer.expired():
            return "queueTimeout" if queue_budget else "failed"
        return "cancelled"

    try:
        timer = asyncio.timeout(5)
        checked_at = time.monotonic()
        async with timer:
            async with _state(identifier, cancelled_outcome, cleanup_budget, read_policy=True) as (state, now, config):
                base = str(conf["base"]).rstrip("/")
                provider = str(conf.get("provider") or "")
                model = str(conf.get("model") or "")
                row = dict(id=identifier, created=now, expires=now + config["queueTimeout"] + 5,
                           state="queued", provider=provider[:80], model=model[:160],
                           scopes=dict(global_= "all", provider=fingerprint(base),
                                       key=fingerprint([base, conf["key"]]),
                                       model=fingerprint([base, model]),
                                       user=fingerprint(conf.get("user") or "internal")),
                           limits=dict(global_=config["globalConcurrent"],
                                       provider=config["providers"].get(provider, config["providerConcurrent"]),
                                       key=config["keyConcurrent"],
                                       model=config["models"].get(provider + ":" + model, config["modelConcurrent"]),
                                       user=config["userConcurrent"]))
                state["leases"].append(row)
                _schedule(state, now)
                queued_count = 0
                own_queued_count = 0
                for candidate in state["leases"]:
                    if candidate["state"] == "queued":
                        queued_count += 1
                        own_queued_count += candidate["scopes"]["user"] == row["scopes"]["user"]
                rejected = row["state"] == "queued" and (
                    queued_count > config["queueSize"] or own_queued_count > config["userQueueSize"])
                if rejected:
                    state["leases"].remove(row)
                    _metric(state, now, "rejected")
                else:
                    registered = True
                    admitted = row["state"] == "running"
                    valid_until = checked_at + max(0, row["expires"] - now)
        if rejected:
            raise CapacityError("模型等待队列已满，请稍后重试")
        deadline = time.monotonic() + config["queueTimeout"]
        while not admitted:
            if time.monotonic() >= deadline:
                reason = "queueTimeout"
                raise CapacityError("等待模型服务超时，请稍后重试")
            event = _capacity_event()
            try:
                await asyncio.wait_for(event.wait(), min(.25, max(0, deadline - time.monotonic())))
            except asyncio.TimeoutError:
                pass
            event.clear()
            if time.monotonic() >= deadline:
                reason = "queueTimeout"
                raise CapacityError("等待模型服务超时，请稍后重试")
            remaining = deadline - time.monotonic()
            queue_budget = remaining <= 5
            timer = asyncio.timeout(min(5, max(.01, remaining)))
            checked_at = time.monotonic()
            async with timer:
                async with _state(identifier, cancelled_outcome, cleanup_budget) as (state, now, _):
                    _schedule(state, now)
                    row = next((r for r in state["leases"] if r["id"] == identifier), None)
                    if row is None:
                        reason = "queueTimeout"
                        raise CapacityError("等待模型服务超时，请稍后重试")
                    admitted = row["state"] == "running"
                    valid_until = checked_at + max(0, row["expires"] - now)
        if valid_until <= time.monotonic():
            reason = "failed"
            raise CapacityError("模型并发调度暂时不可用，请稍后重试", 503)
        return Lease(identifier, config, valid_until)
    except asyncio.CancelledError:
        admitted = False
        raise
    except UpstreamError:
        admitted = False
        raise
    except TimeoutError as exc:
        admitted = False
        # Event-loop timers may fire up to one clock tick early on Windows.
        # Classify the timer that expired, not a second wall-clock observation;
        # a TimeoutError raised by the DB itself remains a scheduling failure.
        if timer is not None and timer.expired() and queue_budget:
            reason = "queueTimeout"
            raise CapacityError("等待模型服务超时，请稍后重试") from exc
        reason = "failed"
        raise CapacityError("模型并发调度暂时不可用，请稍后重试", 503) from exc
    except Exception as exc:
        admitted = False
        reason = "failed"
        raise CapacityError("模型并发调度暂时不可用，请稍后重试", 503) from exc
    finally:
        if registered and not admitted:
            # Raw asyncio cancellation is not shielded by an AnyIO CancelScope.
            # Preserve the original error even if a second cancellation arrives.
            await finish_cleanup(_remove(identifier, reason), cleanup_budget)


async def snapshot():
    # Telemetry is intentionally read-only. It filters expired leases in the
    # query and leaves cleanup/metric accounting to the next admission or
    # release transaction, so an admin dashboard cannot take the hot lock.
    # It still uses the cancellation boundary: a cancelled SQLite cursor must
    # finish and close its session before the caller's database can be removed.
    async def read(control):
        legacy_found = False
        async with SessionLocal() as session, session.begin():
            now = await _now(session)
            config = await policy(session)
            lease_rows = list((await session.scalars(
                select(ModelRuntimeLease)
                .where(ModelRuntimeLease.expires_at > now)
                .order_by(ModelRuntimeLease.created_at, ModelRuntimeLease.id)
            )).all())
            if not lease_rows:
                legacy_row = await session.get(AppSetting, STATE_KEY)
                legacy_found = bool(legacy_row and _legacy_state(legacy_row.value))
            minute = int(now // 60)
            metric_rows = list((await session.scalars(
                select(ModelRuntimeMetric).where(ModelRuntimeMetric.bucket >= minute - 59)
            )).all())
        await control.deliver((config, lease_rows, metric_rows, legacy_found))

    config, lease_rows, metric_rows, legacy_found = await _snapshot_value(read)
    if legacy_found:
        # A pre-0074 database may still have only the old JSON state. Perform
        # the one-time locked adoption, then repeat this read without the hot
        # row so the dashboard sees the preserved leases immediately.
        async with _state() as (_state_value, _state_now, _state_config):
            pass
        return await snapshot()
    totals = {}
    for row in metric_rows:
        totals[row.name] = totals.get(row.name, 0) + row.value
    groups = {}
    for row in lease_rows:
        key = (row.provider, row.model)
        group = groups.setdefault(key, dict(provider=key[0], model=key[1], running=0, queued=0))
        group[row.state] += 1
    return dict(policy=config, revision=fingerprint(config),
                running=sum(row.state == "running" for row in lease_rows),
                queued=sum(row.state == "queued" for row in lease_rows),
                groups=list(groups.values()), lastHour=totals)


async def _snapshot_value(operation):
    async with transaction_boundary(operation) as value:
        return value
