"""Safety barrier between client updates and execution workloads."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import runner_hub, runner_registry


DETAIL_KEY = "updateMaintenance"
LEASE_SECONDS = 90
QUIESCE_SECONDS = 2
ACTIVE_SESSION_STATES = {"queued", "dispatching", "running", "waiting_external"}
MAX_VISIBLE_BLOCKERS = 12
# Reconcile terminal-task sessions and long-idle sessions on idle executors before update draining.
# Stale execution records must not block the client upgrade gate indefinitely.
TERMINAL_TASK_STATUS = {"done", "cancel"}
STALE_SESSION_AFTER = timedelta(hours=24)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _datetime(value: object) -> datetime | None:
    """Parse persisted timestamps into aware UTC values.

    SQLite drops ``timezone=True`` on read while PostgreSQL preserves it.  All
    update-safety comparisons must use one representation, otherwise a normal
    SQLite session can fail before the drain response is produced.
    """
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None \
            else value.astimezone(timezone.utc)
    text = str(value or "").strip().replace("Z", "+00:00")
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text)
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None \
            else parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _visible_blocker(item: dict) -> dict:
    """Keep the admin-facing snapshot useful, bounded and credential-free."""
    result = {
        "kind": str(item.get("kind") or "")[:40],
        "id": str(item.get("id") or "")[:80],
        "runnerId": str(item.get("runnerId") or "")[:80],
        "taskId": str(item.get("taskId") or "")[:80],
        "title": str(item.get("title") or "正在执行的工作")[:160],
        "engine": str(item.get("engine") or "")[:40],
        "state": str(item.get("state") or "")[:40],
        "source": str(item.get("source") or "")[:20],
        "resumable": bool(item.get("resumable")),
    }
    if item.get("count") is not None:
        result["count"] = max(0, int(item.get("count") or 0))
    return {key: value for key, value in result.items()
            if value not in ("", None)}


async def _embedded_runners(session: AsyncSession, client_id: str) -> dict[str, am.RunnerNode]:
    rows = list((await session.execute(select(am.RunnerNode).where(
        am.RunnerNode.client_id == client_id,
    ))).scalars().all())
    result = {
        row.id: row for row in rows
        if runner_hub.CLIENT_TAG in set(row.tags or [])
    }
    for live in runner_hub.online():
        if (str(getattr(live, "client_id", "") or "") != client_id or
                not runner_hub.is_client_runtime(live)):
            continue
        row = await runner_registry.record(session, live, force=True)
        result[row.id] = row
    return result


def _runner_idle(runner_id: str, runner_rows: dict) -> bool:
    """Determine executor idleness from live busy state when online, otherwise its persisted
    snapshot.
    """
    live = runner_hub.get(runner_id)
    if live is not None:
        return max(0, int(getattr(live, "busy", 0) or 0)) == 0
    row = runner_rows.get(runner_id)
    return row is None or max(0, int(row.busy or 0)) == 0


def _execution_stop_confirmed(item: am.ExecutionSession) -> bool:
    """Return only an explicit execution-end acknowledgement.

    Task status is business state and runner load is machine-wide telemetry;
    neither proves that this particular execution stopped.  The runner may
    still flush a final event after a task is cancelled.  Snapshot producers
    can set one of these durable markers when they have observed the terminal
    runtime state.  Keeping the check explicit makes old rows fail closed.
    """
    meta = dict(item.metadata_ or {})
    return any(bool(meta.get(key)) for key in (
        "executionStopped", "runnerStopped", "stopConfirmed", "endedByRunner",
    ))


async def _sweep_stale_sessions(
    session: AsyncSession,
    sessions: list[am.ExecutionSession],
    runner_rows: dict,
    now: datetime,
) -> None:
    """Sweep only sessions whose execution endpoint explicitly confirmed stop.

    An expired task does not cancel its runner process.  Leaving an unconfirmed
    session active is intentional: the update barrier must wait instead of
    rewriting a live transcript.  Audit information is stored as a TaskEvent,
    which has its own UUID timeline and cannot consume the Runner event seq.
    """
    now = _datetime(now) or _now()
    task_ids = {item.task_id for item in sessions if item.task_id}
    statuses: dict[str, str] = {}
    if task_ids:
        rows = (await session.execute(
            select(models.Task.id, models.Task.status).where(models.Task.id.in_(task_ids))
        )).all()
        statuses = {row.id: row.status for row in rows}
    for item in sessions:
        status = statuses.get(item.task_id)
        last = _datetime(item.last_event_at or item.updated_at or item.started_at)
        if last is None:
            continue
        stale = last is not None and (now - last) > STALE_SESSION_AFTER
        terminal = status in TERMINAL_TASK_STATUS
        if not _execution_stop_confirmed(item) or not _runner_idle(item.runner_id, runner_rows):
            continue
        if not terminal and not stale:
            continue
        item.state = "failed"
        item.finished_at = now
        item.updated_at = now
        if item.task_id:
            session.add(models.TaskEvent(
                task_id=item.task_id,
                kind="execution.session_swept",
                actor="SoduWork",
                detail={"sessionId": item.id, "ref": item.ref,
                        "swept": True, "by": "update-safety",
                        "taskStatus": status or "", "runnerId": item.runner_id},
                at=now,
            ))


async def release(session: AsyncSession, attempt: models.ClientUpdateAttempt) -> None:
    """Release only modes owned by this update; explicit operator changes win."""
    detail = dict(attempt.detail or {})
    maintenance = detail.get(DETAIL_KEY) if isinstance(detail.get(DETAIL_KEY), dict) else {}
    previous = maintenance.get("previousModes")
    previous = previous if isinstance(previous, dict) else {}
    for runner_id in maintenance.get("runnerIds") or []:
        row = await session.get(am.RunnerNode, str(runner_id))
        if row is None or row.dispatch_mode != "draining":
            continue
        wanted = str(previous.get(str(runner_id)) or "accepting")
        if wanted not in runner_registry.MODES:
            wanted = "accepting"
        await runner_registry.set_mode(session, row.id, wanted)
    detail.pop(DETAIL_KEY, None)
    attempt.detail = detail


async def expire_for_client(session: AsyncSession, client_id: str) -> int:
    """Recover a drain lease after a client crash or abandoned update."""
    rows = list((await session.execute(select(models.ClientUpdateAttempt).where(
        models.ClientUpdateAttempt.client_id == client_id,
        models.ClientUpdateAttempt.state == "waiting",
    ))).scalars().all())
    now = _now()
    released = 0
    for attempt in rows:
        maintenance = (attempt.detail or {}).get(DETAIL_KEY)
        lease_until = _datetime(maintenance.get("leaseUntil")) \
            if isinstance(maintenance, dict) else None
        if lease_until is not None and lease_until > now:
            continue
        await release(session, attempt)
        attempt.state = "downloaded" if int(attempt.progress or 0) >= 100 else "available"
        released += 1
    return released


async def prepare(
    session: AsyncSession,
    attempt: models.ClientUpdateAttempt,
    client: models.Client,
    client_blockers: list[dict] | None = None,
) -> dict:
    """Drain embedded Runners and return the currently blocking workload facts."""
    now = _now()
    detail = dict(attempt.detail or {})
    maintenance = detail.get(DETAIL_KEY)
    maintenance = dict(maintenance) if isinstance(maintenance, dict) else {}
    lease_until = _datetime(maintenance.get("leaseUntil"))
    if lease_until is not None and lease_until <= now:
        await release(session, attempt)
        detail = dict(attempt.detail or {})
        maintenance = {}

    runner_rows = await _embedded_runners(session, client.id)
    known_ids = {str(item) for item in maintenance.get("runnerIds") or []}
    all_ids = known_ids | set(runner_rows)
    previous = maintenance.get("previousModes")
    previous = dict(previous) if isinstance(previous, dict) else {}
    for runner_id, row in runner_rows.items():
        previous.setdefault(runner_id, str(row.dispatch_mode or "accepting"))
        await runner_registry.set_mode(session, runner_id, "draining")

    started_at = _datetime(maintenance.get("startedAt")) or now
    lease_until = now + timedelta(seconds=LEASE_SECONDS)
    maintenance = {
        "runnerIds": sorted(all_ids),
        "previousModes": previous,
        "startedAt": _iso(started_at),
        "leaseUntil": _iso(lease_until),
    }
    attempt.state = "waiting"
    attempt.progress = max(100, int(attempt.progress or 0))

    sessions = []
    if all_ids:
        sessions = list((await session.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.runner_id.in_(all_ids),
            am.ExecutionSession.state.in_(ACTIVE_SESSION_STATES),
        ).order_by(am.ExecutionSession.updated_at.desc()))).scalars().all())
    if sessions:
        await _sweep_stale_sessions(session, sessions, runner_rows, now)
        sessions = [item for item in sessions if item.state in ACTIVE_SESSION_STATES]
    task_ids = {item.task_id for item in sessions if item.task_id}
    titles = {
        task.id: task.title for task in list((await session.execute(
            select(models.Task).where(models.Task.id.in_(task_ids or {"__none__"}))
        )).scalars().all())
    }
    blockers = [{
        "kind": "runner-session",
        "id": item.id,
        "runnerId": item.runner_id,
        "taskId": item.task_id,
        "title": titles.get(item.task_id, "") or "正在执行的任务",
        "engine": item.engine or "",
        "state": item.state or "running",
        "startedAt": _iso(item.started_at) if item.started_at else "",
        "resumable": False,
    } for item in sessions]

    persisted_by_runner: dict[str, int] = {}
    for item in sessions:
        persisted_by_runner[item.runner_id] = persisted_by_runner.get(item.runner_id, 0) + 1
    for runner_id in all_ids:
        live = runner_hub.get(runner_id)
        busy = max(0, int(getattr(live, "busy", 0) or 0)) if live is not None else 0
        extra = max(0, busy - persisted_by_runner.get(runner_id, 0))
        if extra:
            blockers.append({
                "kind": "runner-busy",
                "runnerId": runner_id,
                "title": f"执行机仍有 {extra} 个会话正在收尾",
                "state": "running",
                "count": extra,
                "resumable": False,
            })

    quiet_for = max(0.0, (now - started_at).total_seconds())
    if not blockers and quiet_for < QUIESCE_SECONDS:
        blockers.append({
            "kind": "drain-barrier",
            "title": "正在确认没有新的任务进入",
            "state": "draining",
            "resumable": True,
        })
    visible = [_visible_blocker({**item, "source": "runner"})
               for item in blockers[:MAX_VISIBLE_BLOCKERS]]
    client_items = [item for item in (client_blockers or [])[:MAX_VISIBLE_BLOCKERS]
                    if isinstance(item, dict)]
    room = max(0, MAX_VISIBLE_BLOCKERS - len(visible))
    client_visible = [_visible_blocker({**item, "source": "client"})
                      for item in client_items[:room]]
    all_visible = visible + client_visible
    overall_safe = not blockers and not client_items
    maintenance.update({
        "safe": overall_safe,
        "blockerCount": len(blockers) + len(client_items),
        "blockers": all_visible,
        "checkedAt": _iso(now),
    })
    # SQLAlchemy compares JSON values as a whole. Assign a fresh nested
    # snapshot after every field is final; mutating the earlier dict in place
    # can otherwise leave persisted detail one polling cycle behind.
    attempt.detail = {**detail, DETAIL_KEY: dict(maintenance)}
    return {
        "safe": overall_safe,
        "state": "safe" if overall_safe else "waiting",
        "blockers": blockers,
        "runnerIds": sorted(all_ids),
        "leaseUntil": maintenance["leaseUntil"],
        "retryAfterMs": 2000,
    }
