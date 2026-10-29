"""Public module behavior and service contracts."""
from __future__ import annotations

import ast
import json
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models


def _now() -> datetime:
    return datetime.now(timezone.utc)


# Operations charts are a product-facing daily view. Keep their day boundary
# aligned with the rest of the usage screens (China Standard Time), while all
# database facts remain stored and queried as UTC.
_PRODUCT_ZONE = timezone(timedelta(hours=8))


def _as_utc(value) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _product_day(value):
    stamp = _as_utc(value)
    return stamp.astimezone(_PRODUCT_ZONE).date() if stamp else None


_MSG_RE = re.compile(r"['\"]message['\"]\s*:\s*['\"]([^'\"]+)")
_CODE_RE = re.compile(r"['\"]code['\"]\s*:\s*['\"]([^'\"]+)")
_VERSION_RE = re.compile(r"^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+]([^+]+))?$")


def _version_key(value) -> tuple:
    """Compare release versions numerically instead of lexicographically.

    ``max('1.9.0', '1.10.0')`` is wrong and used to make the operations page
    show an older plugin version after a perfectly valid upgrade.
    """
    text = str(value or "").strip()
    match = _VERSION_RE.fullmatch(text)
    if not match:
        return (0, text)
    major, minor, patch, suffix = match.groups()
    # Stable releases sort above prereleases; otherwise compare the suffix
    # deterministically without trying to implement the full semver grammar.
    return (1, int(major), int(minor or 0), int(patch or 0), 1 if not suffix else 0,
            suffix or "")


def _humanize_error(raw) -> dict:
    """Normalize historical errors stored as text or Python dictionary representations, including
    truncated values. Expose a readable message and separate code while removing
    attempt-specific noise before grouping.
    """
    text = str(raw or "").strip()
    code = ""
    if text.startswith("{"):
        parsed = None
        for loader in (ast.literal_eval, json.loads):
            try:
                parsed = loader(text)
                break
            except Exception:
                continue
        if isinstance(parsed, dict):
            code = str(parsed.get("code") or "").strip()
            text = str(parsed.get("message") or "").strip() or code or "执行失败"
        else:  # Extract message and code conservatively when a truncated representation cannot be parsed.
            msg = _MSG_RE.search(text)
            found = _CODE_RE.search(text)
            code = found.group(1).strip() if found else ""
            text = (msg.group(1).strip() if msg else "") or code or "执行失败"
    return {"text": text[:200], "code": code}


def _iso(value) -> str:
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat(timespec="seconds")


async def _adoption(session: AsyncSession) -> dict:
    now = _now()
    d7, d30 = now - timedelta(days=7), now - timedelta(days=30)
    active7 = (await session.execute(
        select(func.count(func.distinct(am.ExecutionSession.runner_client_id))).where(
            am.ExecutionSession.created_at >= d7,
            am.ExecutionSession.runner_client_id != ""))).scalar() or 0
    # Compare against the preceding seven-day period.
    active_prev7 = (await session.execute(
        select(func.count(func.distinct(am.ExecutionSession.runner_client_id))).where(
            am.ExecutionSession.created_at >= now - timedelta(days=14),
            am.ExecutionSession.created_at < d7,
            am.ExecutionSession.runner_client_id != ""))).scalar() or 0
    active30 = (await session.execute(
        select(func.count(func.distinct(am.ExecutionSession.runner_client_id))).where(
            am.ExecutionSession.created_at >= d30,
            am.ExecutionSession.runner_client_id != ""))).scalar() or 0
    clients_total = (await session.execute(
        select(func.count()).select_from(models.Client))).scalar() or 0
    runners = list((await session.execute(select(am.RunnerNode))).scalars().all())
    online = sum(1 for r in runners if r.last_seen_at is not None
                 and (now - (r.last_seen_at if r.last_seen_at.tzinfo
                             else r.last_seen_at.replace(tzinfo=timezone.utc))
                      ).total_seconds() < 300)
    # Count runtime installation and authentication state once per machine.
    # Runner heartbeats distinguish installed CLIs from authenticated ready CLIs.
    agents: dict[str, dict] = {}
    for r in runners:
        for a in (r.agents or []):
            key = str(a.get("key") or "")
            if not key:
                continue
            slot = agents.setdefault(key, {"installed": 0, "authed": 0, "unauthed": 0})
            slot["installed"] += 1
            if a.get("auth") == "authed":
                slot["authed"] += 1
            elif a.get("auth") == "unauthed":
                slot["unauthed"] += 1
    return {
        "activeClients7d": int(active7), "activeClientsPrev7d": int(active_prev7),
        "activeClients30d": int(active30),
        "clientsTotal": int(clients_total),
        "runnersOnline": online, "runnersTotal": len(runners),
        "agents": agents,
    }


async def _plugins(session: AsyncSession) -> list[dict]:
    d30 = _now() - timedelta(days=30)
    plugins = list((await session.execute(select(am.Plugin))).scalars().all())
    if not plugins:
        return []
    installs = dict((await session.execute(
        select(am.PluginInstallation.plugin_id, func.count()).where(
            am.PluginInstallation.enabled.is_(True)
        ).group_by(am.PluginInstallation.plugin_id))).all())
    run_rows = (await session.execute(
        select(am.WorkflowRun.plugin_id, am.WorkflowRun.state, func.count()).where(
            am.WorkflowRun.created_at >= d30
        ).group_by(am.WorkflowRun.plugin_id, am.WorkflowRun.state))).all()
    runs: dict[str, dict] = {}
    for pid, state, count in run_rows:
        slot = runs.setdefault(pid, {"total": 0, "succeeded": 0, "failed": 0})
        slot["total"] += count
        if state == "succeeded":
            slot["succeeded"] += count
        elif state in ("failed", "cancelled"):
            slot["failed"] += count
    last_used = dict((await session.execute(
        select(am.WorkflowRun.plugin_id, func.max(am.WorkflowRun.created_at))
        .group_by(am.WorkflowRun.plugin_id))).all())
    # Count conversation-plugin grants from audit records grouped by plugin target ID.
    chat_rows = (await session.execute(
        select(models.AuditLog.target_id, func.count()).where(
            models.AuditLog.action == "plugin.conversation_grant",
            models.AuditLog.at >= d30
        ).group_by(models.AuditLog.target_id))).all()
    chat_uses = {str(pid): count for pid, count in chat_rows}
    versions = {}
    for row in (await session.execute(select(am.PluginVersion).where(
            am.PluginVersion.enabled.is_(True)))).scalars().all():
        current = versions.get(row.plugin_id)
        if current is None or _version_key(row.version) > _version_key(current["version"]):
            versions[row.plugin_id] = {"version": str(row.version or ""),
                                       "manifest": dict(row.manifest or {})}
    out = []
    for plugin in plugins:
        stats = runs.get(plugin.id) or {"total": 0, "succeeded": 0, "failed": 0}
        finished = stats["succeeded"] + stats["failed"]
        out.append({
            "pluginId": plugin.id, "key": plugin.key, "name": plugin.name,
            "enabled": bool(plugin.enabled),
            "category": str((versions.get(plugin.id, {}).get("manifest") or {}).get("category") or ""),
            "version": str(versions.get(plugin.id, {}).get("version") or ""),
            "installs": int(installs.get(plugin.id) or 0),
            "runs30d": stats["total"],
            "succeeded30d": stats["succeeded"],
            "failed30d": stats["failed"],
            "successRate": (round(stats["succeeded"] * 100 / finished)
                            if finished else None),
            "conversationUses30d": int(chat_uses.get(plugin.id) or 0),
            "lastUsedAt": _iso(last_used.get(plugin.id)),
        })
    out.sort(key=lambda item: (-(item["runs30d"] + item["conversationUses30d"]),
                               -item["installs"], item["name"]))
    return out


async def _automation(session: AsyncSession) -> dict:
    d7 = _now() - timedelta(days=7)
    total = (await session.execute(
        select(func.count()).select_from(models.AiSchedule))).scalar() or 0
    enabled = (await session.execute(
        select(func.count()).select_from(models.AiSchedule).where(
            models.AiSchedule.enabled.is_(True)))).scalar() or 0
    run_rows = (await session.execute(
        select(models.AiScheduleRun.state, func.count()).where(
            models.AiScheduleRun.started_at >= d7
        ).group_by(models.AiScheduleRun.state))).all()
    states = {state: count for state, count in run_rows}
    failed = int(states.get("failed") or 0)
    fired = sum(states.values())
    succeeded = int(states.get("succeeded") or 0)
    cancelled = int(states.get("cancelled") or 0)
    completed = succeeded + failed + cancelled
    running = max(0, fired - completed)
    # Normalize failure messages before aggregation.
    # Per-attempt identifiers must not split one recurring failure into many single-occurrence groups.
    counter: dict[tuple, int] = {}
    for (raw,) in (await session.execute(
            select(models.AiScheduleRun.error).where(
                models.AiScheduleRun.started_at >= d7,
                models.AiScheduleRun.state == "failed",
                models.AiScheduleRun.error != ""))).all():
        item = _humanize_error(raw)
        key = (item["text"], item["code"])
        counter[key] = counter.get(key, 0) + 1
    top_errors = [{"error": text, "code": code, "n": count}
                  for (text, code), count in
                  sorted(counter.items(), key=lambda kv: -kv[1])[:3]]
    return {"schedules": int(total), "enabled": int(enabled),
            "runs7d": int(fired), "completed7d": int(completed),
            "succeeded7d": succeeded, "running7d": running,
            "failed7d": failed, "topErrors": top_errors}


async def _output(session: AsyncSession) -> dict:
    d30 = _now() - timedelta(days=30)
    created = (await session.execute(
        select(func.count()).select_from(models.Task).where(
            models.Task.created_at >= d30))).scalar() or 0
    done = (await session.execute(
        select(func.count()).select_from(models.Task).where(
            models.Task.created_at >= d30, models.Task.status == "done"))).scalar() or 0
    sessions = (await session.execute(
        select(func.count()).select_from(am.ExecutionSession).where(
            am.ExecutionSession.created_at >= d30))).scalar() or 0
    deployments = (await session.execute(
        select(func.count()).select_from(am.DeploymentRun).where(
            am.DeploymentRun.created_at >= d30))).scalar() or 0
    return {"tasksCreated30d": int(created), "tasksDone30d": int(done),
            "aiSessions30d": int(sessions), "deployments30d": int(deployments)}


async def _trend(session: AsyncSession) -> list[dict]:
    """Build daily task, session, and automation series for 30 days by bucketing retrieved
    timestamps, avoiding database-specific date grouping.
    """
    now = _now()
    local_now = now.astimezone(_PRODUCT_ZONE)
    local_start = (local_now - timedelta(days=29)).replace(
        hour=0, minute=0, second=0, microsecond=0)
    start = local_start.astimezone(timezone.utc)
    days = [(local_start + timedelta(days=i)).date() for i in range(30)]
    buckets = {d.isoformat(): {"date": d.isoformat(), "tasksCreated": 0, "tasksDone": 0,
                               "aiSessions": 0, "activeClients": 0,
                               "automationRuns": 0, "automationCompleted": 0,
                               "automationSucceeded": 0, "automationRunning": 0,
                               "automationFailed": 0}
               for d in days}
    day_clients: dict[str, set] = {d.isoformat(): set() for d in days}

    def _day_key(stamp) -> str:
        day = _product_day(stamp)
        return day.isoformat() if day else ""

    def _put(stamp, key):
        slot = buckets.get(_day_key(stamp))
        if slot is not None:
            slot[key] += 1

    for (created, status) in (await session.execute(
            select(models.Task.created_at, models.Task.status).where(
                models.Task.created_at >= start))).all():
        _put(created, "tasksCreated")
        if status == "done":
            _put(created, "tasksDone")
    for (created, cid) in (await session.execute(
            select(am.ExecutionSession.created_at,
                   am.ExecutionSession.runner_client_id).where(
                am.ExecutionSession.created_at >= start))).all():
        _put(created, "aiSessions")
        slot = day_clients.get(_day_key(created))
        if cid and slot is not None:
            slot.add(cid)
    for (started, state) in (await session.execute(
            select(models.AiScheduleRun.started_at, models.AiScheduleRun.state).where(
                models.AiScheduleRun.started_at >= start))).all():
        _put(started, "automationRuns")
        if state == "failed":
            _put(started, "automationFailed")
        if state in ("succeeded", "failed", "cancelled"):
            _put(started, "automationCompleted")
        if state == "succeeded":
            _put(started, "automationSucceeded")
        elif state not in ("succeeded", "failed", "cancelled"):
            _put(started, "automationRunning")
    for key, clients in day_clients.items():
        buckets[key]["activeClients"] = len(clients)
    return [buckets[d.isoformat()] for d in days]


async def _departments(session: AsyncSession) -> list[dict]:
    """Aggregate department usage from user identity: seven-day active users and 30-day tasks.
    Resolve devices to people before organization grouping.
    """
    now = _now()
    d7, d30 = now - timedelta(days=7), now - timedelta(days=30)
    clients = {c.id: c.user_ref for c in (await session.execute(
        select(models.Client))).scalars().all() if c.user_ref}
    users = {u.id: u for u in (await session.execute(
        select(models.User))).scalars().all()}
    orgs = {o.id: o.name for o in (await session.execute(
        select(models.OrgUnit))).scalars().all()}

    def org_of(client_id):
        user = users.get(clients.get(client_id or ""))
        return orgs.get(user.org_id, "") if user is not None and user.org_id else ""

    stats: dict[str, dict] = {}
    for (cid,) in (await session.execute(
            select(func.distinct(am.ExecutionSession.runner_client_id)).where(
                am.ExecutionSession.created_at >= d7,
                am.ExecutionSession.runner_client_id != ""))).all():
        org = org_of(cid)
        if not org:
            continue
        slot = stats.setdefault(org, {"org": org, "activeUsers7d": set(),
                                      "tasks30d": 0, "done30d": 0})
        slot["activeUsers7d"].add(clients.get(cid))
    for (cid, status) in (await session.execute(
            select(models.Task.owner_client_id, models.Task.status).where(
                models.Task.created_at >= d30))).all():
        org = org_of(cid)
        if not org:
            continue
        slot = stats.setdefault(org, {"org": org, "activeUsers7d": set(),
                                      "tasks30d": 0, "done30d": 0})
        slot["tasks30d"] += 1
        if status == "done":
            slot["done30d"] += 1
    out = [{**slot, "activeUsers7d": len(slot["activeUsers7d"])}
           for slot in stats.values()]
    out.sort(key=lambda item: (-item["activeUsers7d"], -item["tasks30d"], item["org"]))
    return out[:8]


async def _failing_schedules(session: AsyncSession) -> list[dict]:
    d7 = _now() - timedelta(days=7)
    rows = (await session.execute(
        select(models.AiScheduleRun.schedule_id, func.count(),
               func.max(models.AiScheduleRun.started_at)).where(
            models.AiScheduleRun.started_at >= d7,
            models.AiScheduleRun.state == "failed"
        ).group_by(models.AiScheduleRun.schedule_id)
        .order_by(func.count().desc()).limit(5))).all()
    out = []
    for sid, count, last_at in rows:
        schedule = await session.get(models.AiSchedule, sid)
        if schedule is None:
            continue
        client = await session.get(models.Client, schedule.owner_client_id)             if schedule.owner_client_id else None
        # A schedule's last_error may clear after a later successful run.
        # For failures in the reporting window, fall back to the latest failed run's stored error.
        err_raw = str(schedule.last_error or "").strip()
        if not err_raw:
            err_raw = (await session.execute(
                select(models.AiScheduleRun.error).where(
                    models.AiScheduleRun.schedule_id == sid,
                    models.AiScheduleRun.state == "failed",
                    models.AiScheduleRun.error != "")
                .order_by(models.AiScheduleRun.started_at.desc())
                .limit(1))).scalar() or ""
        err = _humanize_error(err_raw)
        out.append({"title": schedule.title or "定时任务", "failed7d": int(count),
                    "enabled": bool(schedule.enabled),
                    "owner": (client.name if client else "")[:40],
                    "lastError": err["text"][:120], "lastErrorCode": err["code"],
                    "lastFailedAt": _iso(last_at)})
    return out


async def insights(session: AsyncSession) -> dict:
    automation = await _automation(session)
    automation["failing"] = await _failing_schedules(session)
    return {
        "generatedAt": _iso(_now()),
        "adoption": await _adoption(session),
        "plugins": await _plugins(session),
        "automation": automation,
        "output": await _output(session),
        "trend": await _trend(session),
        "departments": await _departments(session),
    }
