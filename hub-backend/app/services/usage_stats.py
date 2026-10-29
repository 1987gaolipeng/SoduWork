"""Read-only Runner and task usage aggregation from persisted execution usage. Sum cumulative
consumption, never context occupancy. Count running sessions for load and consult live Runner
state for connectivity. Include backend-local execution explicitly so its usage is not lost.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models

_NUM_KEYS = ("input", "output", "total", "turns", "steps")


def merge_usage(acc: dict, usage: dict | None) -> dict:
    """Accumulate one session's usage into totals, handling cost separately from integer counters.

    """
    u = dict(usage or {})
    for key in _NUM_KEYS:
        try:
            v = int(u.get(key) or 0)
        except (TypeError, ValueError):
            v = 0
        if v:
            acc[key] = int(acc.get(key) or 0) + v
    try:
        cost = float(u.get("cost") or 0)
    except (TypeError, ValueError):
        cost = 0.0
    if cost:
        acc["cost"] = round(float(acc.get("cost") or 0.0) + cost, 6)
    return acc


def _duration_ms(row: am.ExecutionSession) -> int:
    """Measure elapsed execution from firstStarted because follow-ups and compaction reset started.
    Use finished_at for terminal sessions and current time for running sessions.
    """
    meta = dict(row.metadata_ or {})
    start = None
    fs = meta.get("firstStarted")
    if fs:
        try:
            start = datetime.fromtimestamp(float(fs), tz=timezone.utc)
        except (TypeError, ValueError, OverflowError):
            start = None
    start = start or row.started_at
    if start is None:
        return 0
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    end = row.finished_at or datetime.now(timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    return max(0, int((end - start).total_seconds() * 1000))


def _session_brief(row: am.ExecutionSession) -> dict:
    meta = dict(row.metadata_ or {})
    return {
        "ref": row.ref, "runnerId": row.runner_id or "", "host": row.host or "",
        "cli": row.engine or "", "model": row.model or "", "state": row.state or "",
        "startedAt": row.started_at.isoformat() if row.started_at else "",
        "finishedAt": row.finished_at.isoformat() if row.finished_at else "",
        "durationMs": _duration_ms(row), "usage": dict(meta.get("usage") or {}),
    }


async def task_usage(session: AsyncSession, task_id: str) -> dict:
    """Return task usage and elapsed-time totals with per-session details across dispatches and
    reassignment.
    """
    rows = list((await session.execute(
        select(am.ExecutionSession).where(am.ExecutionSession.task_id == task_id)
        .order_by(am.ExecutionSession.started_at))).scalars().all())
    total: dict = {}
    duration = 0
    sessions = []
    for row in rows:
        brief = _session_brief(row)
        sessions.append(brief)
        merge_usage(total, brief["usage"])
        duration += brief["durationMs"]
    return {"taskId": task_id, "sessions": sessions, "sessionCount": len(rows),
            "usage": total, "durationMs": duration}


async def runner_usage(session: AsyncSession, days: int = 30, *,
                       task_client_ids: set[str] | None = None,
                       runner_client_ids: set[str] | None = None,
                       runner_org_ids: set[str] | None = None) -> list[dict]:
    """Return one row per Runner with identity, connectivity, running load, and windowed session,
    usage, and elapsed-time totals. Select the reporting window by started_at.
    """
    from . import runner_hub

    since = datetime.now(timezone.utc) - timedelta(days=max(1, int(days or 30)))
    node_query = select(am.RunnerNode)
    if runner_client_ids is not None or runner_org_ids is not None:
        # Reuse Runner-directory organization boundaries; online state does not grant access.
        node_query = node_query.where(
            am.RunnerNode.management_state != "retired",
            or_(am.RunnerNode.client_id.in_(runner_client_ids or set()),
                ((am.RunnerNode.client_id == "") | am.RunnerNode.client_id.is_(None)) &
                am.RunnerNode.org_id.in_(runner_org_ids or set())))
    nodes = {x.id: x for x in (await session.execute(node_query)).scalars().all()}
    query = select(am.ExecutionSession).where(am.ExecutionSession.started_at >= since)
    if task_client_ids is not None:
        # Filter task scope before aggregating shared or backend-local executors.
        query = query.where(am.ExecutionSession.task_id.in_(select(models.Task.id).where(
            models.Task.owner_client_id.in_(task_client_ids))))
    if runner_client_ids is not None or runner_org_ids is not None:
        query = query.where(or_(am.ExecutionSession.runner_id.in_(set(nodes) | {"backend-local", ""}),
                                am.ExecutionSession.runner_id.is_(None)))
    rows = list((await session.execute(query)).scalars().all())
    client_ids = {x.client_id for x in nodes.values() if x.client_id} | {
        r.runner_client_id for r in rows if r.runner_client_id}
    clients = {}
    if client_ids:
        clients = {c.id: c for c in (await session.execute(
            select(models.Client).where(models.Client.id.in_(client_ids)))).scalars().all()}
    online = {str(x.get("id") or ""): x for x in runner_hub.api_list() if x.get("online")}

    by_runner: dict[str, dict] = {}
    for row in rows:
        rid = row.runner_id or "backend-local"
        item = by_runner.setdefault(rid, {
            "runnerId": rid, "host": row.host or "", "clientId": row.runner_client_id or "",
            "sessions": 0, "running": 0, "usage": {}, "durationMs": 0, "byCli": {}})
        item["sessions"] += 1
        if row.state == "running":
            item["running"] += 1
        if row.host and not item["host"]:
            item["host"] = row.host
        meta = dict(row.metadata_ or {})
        merge_usage(item["usage"], meta.get("usage"))
        item["durationMs"] += _duration_ms(row)
        cli = (row.engine or "其他").strip() or "其他"
        per = item["byCli"].setdefault(cli, {"sessions": 0, "usage": {}})
        per["sessions"] += 1
        merge_usage(per["usage"], meta.get("usage"))

    # Include registered Runners even without sessions in the reporting window.
    # Show zero usage rather than omitting idle machines.
    for rid, node in nodes.items():
        by_runner.setdefault(rid, {
            "runnerId": rid, "host": node.host or "", "clientId": node.client_id or "",
            "sessions": 0, "running": 0, "usage": {}, "durationMs": 0, "byCli": {}})

    out = []
    for rid, item in by_runner.items():
        node = nodes.get(rid)
        client = clients.get((node.client_id if node else "") or item["clientId"])
        owner = ""
        if client is not None:
            owner = client.name or ""
        name = owner or item["host"] or (node.host if node else "") or (
            "后端执行机" if rid == "backend-local" else rid[:8])
        item.update({
            "name": name, "owner": owner,
            "host": item["host"] or (node.host if node else ""),
            "online": rid in online or rid == "backend-local",
            "dispatchMode": node.dispatch_mode if node else "",
            "lastSeenAt": node.last_seen_at.isoformat() if node and node.last_seen_at else "",
        })
        out.append(item)
    out.sort(key=lambda x: (not x["online"], -(x["usage"].get("total") or
                                               x["usage"].get("input") or 0)))
    return out
