"""Server-managed schedules retain independent run records and deduplicate with leases and unique
runs. Current ordinary automation opens a new conversation; enterprise workflows and older
executors retain task and approval contracts. Offline conversation requests wait for delivery,
and the independent schedule loop checks due work at its configured interval.
"""
from __future__ import annotations

import logging
import hashlib
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from . import resource_leases
from . import schedule_timing
from .schedule_execution import (
    CAPABILITY_SKILLS, _capability_remediation, capability_save_blocker,
    preflight_execution, required_skill_names, validate_direct_execution,
    validate_execution,
)
from .schedule_repo_scope import resolve_repo
from .schedule_run_contracts import (
    DIRECT_CAPABILITIES, PERSONAL_PLUGIN_VERSION_POLICIES,
    RUN_ACTIVE, RUN_TERMINAL, RUN_TRIGGERS,
    _run_iso, _run_time, apply_attempt_outcome, apply_outcome, begin_run, claim_run,
    clean_personal_plugin_checksum, clean_personal_plugin_key,
    clean_personal_plugin_version, clean_personal_plugin_version_policy,
    clean_plugin_inputs, clean_required_capabilities, derive_run_state,
    error_text, normalize_personal_plugin_snapshot, personal_plugin_spec,
)

log = logging.getLogger("uvicorn.error")
_SCHEDULE_OWNER = resource_leases.default_owner("schedule")
_SCHEDULE_LEASE_SECONDS = 10 * 60


EVERY = schedule_timing.EVERY


DEFAULT_TIME_ZONE = "Asia/Shanghai"


def clean_time_zone(value: str | None) -> str:
    """Return a validated IANA timezone name.

    The client sends its browser timezone with the schedule. Asia/Shanghai is
    the migration default for schedules created before this field existed.
    """
    name = str(value or DEFAULT_TIME_ZONE).strip()[:64] or DEFAULT_TIME_ZONE
    try:
        ZoneInfo(name)
    except ZoneInfoNotFoundError:
        if name not in (DEFAULT_TIME_ZONE, "UTC", "Etc/UTC"):
            return DEFAULT_TIME_ZONE
    return name


def schedule_zone(s):
    name = clean_time_zone(getattr(s, "time_zone", DEFAULT_TIME_ZONE))
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        # Keep development usable before requirements are refreshed on Windows.
        # Production installs tzdata and therefore supports the full IANA set.
        return timezone(timedelta(hours=8), DEFAULT_TIME_ZONE)


def _utc(value: datetime) -> datetime:
    """Normalize database instants.

    SQLite drops tzinfo even for DateTime(timezone=True). Those values were
    written as UTC, so treating a naive value as server-local time makes a
    daily schedule remain due for every two-minute sweep after its wall time.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _now_local(s=None) -> datetime:
    return datetime.now(timezone.utc).astimezone(schedule_zone(s))


def _wall_candidate(day: date, hh: int, mm: int, zone) -> datetime:
    candidate = datetime(day.year, day.month, day.day, hh, mm, tzinfo=zone)
    # A nonexistent DST wall time (for example 02:30 during spring-forward)
    # is normalized to the first real local instant after the jump.
    return candidate.astimezone(timezone.utc).astimezone(zone)


def next_run_instant(s, after: datetime | None = None) -> datetime | None:
    """Return the next occurrence as an aware UTC instant."""
    if getattr(s, "every", "") == "once":
        return schedule_timing.next_once(s)
    base_utc = _utc(after) if after is not None else datetime.now(timezone.utc)
    zone = schedule_zone(s)
    local = base_utc.astimezone(zone)
    mm = max(0, min(59, int(s.at_minute or 0)))
    every = s.every if getattr(s, "every", "") in EVERY else "daily"

    if every == "hourly":
        probe = base_utc.replace(second=0, microsecond=0)
        if probe <= base_utc:
            probe += timedelta(minutes=1)
        # Three real hours cover normal time and both sides of a DST fold.
        for _ in range(181):
            if probe.astimezone(zone).minute == mm:
                return probe
            probe += timedelta(minutes=1)
        raise RuntimeError("无法计算下一次小时计划")

    hh = max(0, min(23, int(s.at_hour or 0)))
    weekday = max(1, min(7, int(s.weekday or 1)))
    limit = 15 if every == "weekly" else 3
    for offset in range(limit):
        day = local.date() + timedelta(days=offset)
        if every == "weekly" and day.isoweekday() != weekday:
            continue
        candidate = _wall_candidate(day, hh, mm, zone).astimezone(timezone.utc)
        if candidate > base_utc:
            return candidate
    raise RuntimeError("无法计算下一次计划")


def next_run_after(s, after: datetime | None = None) -> datetime | None:
    """Compatibility contract: naive datetimes represent schedule-local wall time; aware inputs
    remain aware.
    """
    naive = after is not None and after.tzinfo is None
    if naive:
        after_utc = after.replace(tzinfo=schedule_zone(s)).astimezone(timezone.utc)
    else:
        after_utc = after
    instant = next_run_instant(s, after_utc)
    if instant is None:
        return None
    result = instant.astimezone(schedule_zone(s))
    return result.replace(tzinfo=None) if naive else result


def due(s, now: datetime | None = None) -> bool:
    """Whether the next scheduled instant or bounded retry is due now."""
    current = _utc(now) if now is not None else datetime.now(timezone.utc)
    if getattr(s, "every", "") == "once":
        target = schedule_timing.next_once(s)
        return target is not None and target <= current
    retry_at = getattr(s, "next_retry_at", None)
    if retry_at is not None:
        return _utc(retry_at) <= current

    base = s.last_run_at or s.created_at
    if base is None:
        return False
    return next_run_instant(s, _utc(base)) <= current


def trigger_identity(s, trigger: str = "timer") -> str:
    """Stable identity for one automatic occurrence, independent of the Hub process."""
    trigger = "retry" if trigger == "retry" else "timer"
    if trigger == "retry" and getattr(s, "next_retry_at", None) is not None:
        instant = _utc(s.next_retry_at)
    elif getattr(s, "every", "") == "once":
        instant = getattr(s, "run_at", None)
        if not isinstance(instant, datetime):
            raise ValueError("一次性执行缺少固定日期时间")
        instant = _utc(instant)
    else:
        base = getattr(s, "last_run_at", None) or getattr(s, "created_at", None)
        if base is None:
            raise ValueError("plan has no scheduling origin")
        instant = next_run_instant(s, _utc(base))
    stamp = instant.astimezone(timezone.utc).isoformat(
        timespec="microseconds" if getattr(s, "every", "") == "once" else "seconds")
    owner = (hashlib.sha256(str(getattr(s, "owner_client_id", "") or "").encode()).hexdigest() + ":"
             if getattr(s, "every", "") == "once" else "")
    return f"{trigger}:{str(getattr(s, 'id', '') or '')}:{owner}{stamp}"[:180]

def task_actor(s, client, fallback_name: str = "") -> tuple[str, str]:
    """Return the stable person who created this automation and its tasks."""
    user_id = str(getattr(s, "created_by", "") or getattr(client, "user_ref", "") or "")
    name = str(getattr(s, "created_by_name", "") or fallback_name or "")
    return user_id, name


async def _persisted_workflow(session: AsyncSession, task_id: str, binding_id: str):
    """Find a run committed before immediate scheduling failed.

    Workflow startup commits the run before dispatching its first node, so the global workflow
    ticker can resume it safely. Reporting that state as failure invites duplicate retries.
    """
    from .. import automation_models as am

    return await session.scalar(select(am.WorkflowRun).where(
        am.WorkflowRun.task_id == task_id,
        am.WorkflowRun.binding_id == binding_id,
    ).order_by(am.WorkflowRun.created_at.desc()).limit(1))


async def _persisted_dispatch(session: AsyncSession, task_id: str) -> dict | None:
    """Recover a hand-off committed before its schedule receipt was finalized."""
    from .. import automation_models as am
    from . import ai_exec

    row = await session.scalar(select(am.ExecutionSession).where(
        am.ExecutionSession.task_id == task_id
    ).order_by(am.ExecutionSession.started_at.desc().nullslast(),
               am.ExecutionSession.created_at.desc()).limit(1))
    if row is not None and row.ref:
        identity = dict(dict(row.metadata_ or {}).get("executionIdentity") or {})
        runner_id = str(row.runner_id or "")
        provider = "local" if runner_id == "backend-local" else "runner"
        return {
            "ok": True, "recovered": True, "taskId": task_id,
            "identifier": row.ref, "provider": provider,
            "runnerId": "" if runner_id == "backend-local" else runner_id,
            "host": row.host or "", "agentCli": row.engine or "",
            "assigneeCli": row.engine or "", "model": row.model or "",
            "assigneeId": str(identity.get("assigneeId") or ""),
            "assigneeName": str(identity.get("agentName") or row.engine or ""),
        }
    event = await ai_exec.last_dispatch_event(session, task_id)
    if event is None:
        return None
    detail = dict(event.detail or {})
    ref = str(detail.get("ref") or detail.get("issueId") or "")
    if not ref:
        return None
    return {
        "ok": True, "recovered": True, "taskId": task_id, "identifier": ref,
        **{key: detail.get(key) for key in (
            "provider", "runnerId", "host", "agentCli", "assigneeCli",
            "model", "assigneeId", "assigneeName") if detail.get(key) not in (None, "")},
    }




# Notify at most once per half-day for the same schedule and error type, including hourly schedules.
_FAIL_NOTIFIED: dict[str, tuple[int, float]] = {}
_FAIL_REPEAT_S = 12 * 3600


def _failure_hint(error: str) -> str:
    """Add actionable remediation for known failure categories."""
    if "尚未获得本机授权" in error:
        return ("到 Agent 管理 → Runner → 管理本机能力里授权后，"
                "在自动化里点「立即执行」即可补跑。")
    if "版本过旧" in error:
        return "升级这台电脑的 SoduWork 客户端后，重新启用这条自动化。"
    if "免费办公文档引擎" in error or "缺少" in error:
        return "到 Agent 管理 → Runner 查看能力探测详情，补齐环境后点「立即执行」。"
    return ""


async def _account_can_run(session: AsyncSession, s, client) -> bool:
    from .schedule_access import is_owner
    # Administrator delegation is frozen to the target account at creation.
    # The creator's role cannot grant a later login access to private work.
    return is_owner(s, client)


async def _notify_failure(session: AsyncSession, s, out: dict) -> None:
    import time as _time
    error = error_text(out.get("error")) or str(s.last_error or "").strip()
    if not error or not getattr(s, "owner_client_id", ""):
        return
    client = await session.get(models.Client, s.owner_client_id, populate_existing=True)
    if client is None or not await _account_can_run(session, s, client):
        return
    key = str(s.id)
    mark = _FAIL_NOTIFIED.get(key)
    now = _time.time()
    if mark and mark[0] == hash(error) and now - mark[1] < _FAIL_REPEAT_S:
        return
    _FAIL_NOTIFIED[key] = (hash(error), now)
    text = "⏰自动化「%s」没能启动：%s" % (
        (s.title or "定时任务")[:60], error[:200])
    hint = _failure_hint(error)
    if hint:
        text += " " + hint
    try:
        from ..realtime import hub
        message = {"type": "notice", "text": text, "kind": "flow_failed"}
        if out.get("taskId"):
            message["taskId"] = str(out.get("taskId"))
        await hub.publish(s.owner_client_id, message, user_id=client.user_ref or "")
    except Exception as exc:  # noqa: BLE001 - Notification failure must not affect settlement.
        log.warning("推送自动化失败通知失败：%s", type(exc).__name__)


async def execute_one(session: AsyncSession, s, trigger: str = "timer",
                      who: str = "SoduWork（自动化）",
                      idempotency_key: str = "") -> dict:
    """Create an immutable attempt before handing work to a substrate."""
    if getattr(s, "every", "") == "once" and trigger != "manual" and not s.enabled:
        return {"ok": True, "deduplicated": True, "scheduleRunState": "paused"}
    if idempotency_key:
        run, claimed = await claim_run(session, s, trigger, idempotency_key)
        # The claim is committed before external work. Reload both rows so crash recovery
        # observes the winner's durable receipt without async lazy-loading surprises.
        await session.refresh(s)
        await session.refresh(run)
        if not claimed and (
                run.state != "starting" or run.task_id or run.workflow_run_id):
            recovered = {}
            handed_off = bool(run.task_id or run.workflow_run_id or dict(run.receipt or {}).get("executionMode") or
                              run.state in ("running", "waiting", "succeeded"))
            if (getattr(s, "every", "") == "once" or
                    dict(run.receipt or {}).get("timing", {}).get("every") == "once"):
                # Recovery writes the same consumption marker as normal settlement.
                # Refresh under its row lock before checking a possibly replaced plan.
                s = await schedule_timing.locked_schedule(session, s.id)
            if (s is not None and getattr(s, "every", "") == "once" and not s.once_fired and run.trigger == "timer" and
                    schedule_timing.matches(s, run) and (run.state != "cancelled" or handed_off)):
                recovered = schedule_timing.settle(s, run, {"ok": handed_off, "error": run.error},
                                                   outcome_of=apply_outcome)
                await session.flush()
            return {
                "ok": run.state != "failed", "deduplicated": True,
                "error": run.error or "", "taskId": run.task_id or "",
                "workflowRunId": run.workflow_run_id or "",
                "scheduleRunId": run.id, "scheduleRunState": run.state, **recovered,
            }
    else:
        run = await begin_run(session, s, trigger)
    if not schedule_timing.matches(s, run):
        run.state, run.error = "cancelled", "预约日期或归属已变更，本次原预约未继续派发"
        run.finished_at = datetime.now(timezone.utc)
        await session.flush()
        return {"ok": True, "deduplicated": True, "scheduleRunId": run.id,
                "scheduleRunState": run.state, "staleTiming": True}
    if getattr(s, "every", "") == "once" and trigger != "manual" and not s.enabled:
        run.receipt = {**dict(run.receipt or {}), "phase": "paused_before_dispatch"}
        await session.flush()
        return {"ok": True, "deduplicated": True, "scheduleRunId": run.id,
                "scheduleRunState": run.state}
    if dict(run.receipt or {}).get("phase") == "paused_before_dispatch":
        receipt = dict(run.receipt)
        receipt.pop("phase", None)
        run.receipt = receipt
    once_attempt = (getattr(s, "every", "") == "once" or
                    dict(run.receipt or {}).get("timing", {}).get("every") == "once")
    schedule_id, plan_exists = s.id, True
    try:
        out = await run_one(session, s, who=who, schedule_run_id=run.id)
    except Exception as exc:  # noqa: BLE001 - the receipt must survive adapter failures
        log.exception("自动化启动异常：schedule=%s run=%s", s.id, run.id)
        out = {"ok": False, "error": str(exc)[:300]}
    # run_one calls task_dispatch.dispatch, which commits and expires all session ORM objects.
    # apply_outcome only assigns values on success, but its failure path reads schedule attributes
    # such as plugin_binding_id and retry_limit. Reading expired attributes triggers synchronous
    # lazy loading and a greenlet_spawn error under asyncpg, preventing the tick from committing
    # its changes, including last_run_at. due() would then remain true on each subsequent tick
    # and repeatedly run the same failing schedule.
    # Refresh both objects first so later attribute access uses values already in memory.
    try:
        if once_attempt:
            fresh = await schedule_timing.locked_schedule(session, schedule_id)
            if fresh is not None:
                s = fresh
            else:
                plan_exists = False
        else:
            await session.refresh(s)
    except Exception:  # noqa: BLE001 - The schedule may have been deleted; settle best-effort.
        if once_attempt:
            plan_exists = False
    try:
        await session.refresh(run)
    except Exception:  # noqa: BLE001
        # An inner rollback may remove the uncommitted run receipt created by begin_run.
        # Reinsert it using the retained ID and start time.
        # Failed executions must remain in the run history.
        session.add(run)
    retry = schedule_timing.settle(s, run, out, outcome_of=apply_outcome) if plan_exists else {"retrying": False}
    apply_attempt_outcome(run, out)
    await session.flush()
    return {**out, **retry, "scheduleRunId": run.id,
            "scheduleRunState": run.state}


async def reconcile_runs(session: AsyncSession, *, schedule_id: str = "",
                         owner_client_id: str = "", owner_user_id: str | None = None,
                         limit: int = 200) -> list:
    """Reconcile active receipts from task/workflow truth without substrate coupling."""
    state_filter = models.AiScheduleRun.state.in_(RUN_ACTIVE)
    if schedule_id:
        # Task and workflow retries can recover the same receipt. Revisit terminal
        # failures only inside one schedule so old failures never starve active work.
        state_filter = or_(state_filter, and_(
            models.AiScheduleRun.state == "failed",
            or_(models.AiScheduleRun.workflow_run_id != "",
                models.AiScheduleRun.task_id != ""),
        ))
    q = select(models.AiScheduleRun).where(state_filter)
    if schedule_id:
        q = q.where(models.AiScheduleRun.schedule_id == schedule_id)
    if owner_client_id:
        q = q.where(models.AiScheduleRun.owner_client_id == owner_client_id)
    if owner_user_id is not None:
        q = q.where(models.AiScheduleRun.owner_user_id == owner_user_id if owner_user_id
                    else models.AiScheduleRun.owner_user_id.is_(None))
    active = list((await session.execute(
        q.order_by(models.AiScheduleRun.started_at.desc()).limit(
            max(1, min(500, int(limit or 200)))))).scalars().all())
    if not active:
        return active

    task_ids = {item.task_id for item in active if item.task_id}
    tasks = {}
    if task_ids:
        tasks = {item.id: item for item in (await session.execute(
            select(models.Task).where(models.Task.id.in_(task_ids))
        )).scalars().all()}

    from .. import automation_models as am
    workflow_ids = {item.workflow_run_id for item in active if item.workflow_run_id}
    workflows = {}
    waiting_human = set()
    if workflow_ids:
        workflows = {item.id: item for item in (await session.execute(
            select(am.WorkflowRun).where(am.WorkflowRun.id.in_(workflow_ids))
        )).scalars().all()}
        waiting_human = set((await session.execute(
            select(am.NodeRun.run_id).where(
                am.NodeRun.run_id.in_(workflow_ids),
                am.NodeRun.state == "waiting_human")
        )).scalars().all())

    from . import tasks as task_service
    ai = await task_service.ai_states(session, list(task_ids)) if task_ids else {}
    now = datetime.now(timezone.utc)
    for item in active:
        if await schedule_timing.reconcile_pending(session, item, now):
            continue
        if dict(item.receipt or {}).get('executionMode') == 'soduwork.automation-conversation/v1':
            continue  # The ordinary conversation reports its own state; no task/acceptance is implied.
        task = tasks.get(item.task_id)
        workflow = workflows.get(item.workflow_run_id)
        ai_info = ai.get(item.task_id, {})
        state = derive_run_state(
            getattr(task, "status", ""), getattr(workflow, "state", ""),
            ai_info.get("state", ""), item.workflow_run_id in waiting_human,
            task is not None)
        # A task row is created before plugin validation and dispatch. Its todo/
        # doing status alone cannot undo a recorded failure; retries need real
        # execution evidence or an explicit terminal task decision.
        no_execution = workflow is None and not ai_info
        if (no_execution and state not in RUN_TERMINAL and
                (item.state == "failed" or state == "starting" and item.error)):
            state = "failed"
        started = _run_time(item.started_at)
        startup_error = ""
        if state == "starting" and no_execution and started and (now - started).total_seconds() > 600:
            state = "failed"
            startup_error = ("调度启动中断，未形成可执行任务" if task is None else
                             "调度启动中断，任务尚未交付执行，请检查执行条件后重试")
        receipt = dict(item.receipt or {})
        receipt.update({
            "taskStatus": str(getattr(task, "status", "") or ""),
            "workflowState": str(getattr(workflow, "state", "") or ""),
        })
        if state == "waiting":
            receipt["phase"] = "human_gate" if item.workflow_run_id in waiting_human else "acceptance"
        else:
            receipt.pop("phase", None)
        item.receipt = receipt
        if state == "failed":
            item.error = str(getattr(workflow, "error", "") or
                             ai_info.get("error") or item.error or startup_error or "执行失败")[:1200]
        elif state != "failed":
            item.error = ""
        if state in RUN_TERMINAL:
            item.finished_at = (getattr(workflow, "finished_at", None) or
                                getattr(task, "actual_end_at", None) or
                                (item.finished_at if item.state == state else None) or now)
        else:
            item.finished_at = None
        item.state = state
    return active


def run_to_api(run, task=None) -> dict:
    started = _run_time(run.started_at)
    finished = _run_time(run.finished_at)
    duration = max(0, int((finished - started).total_seconds())) if started and finished else None
    return {
        "id": run.id, "scheduleId": run.schedule_id, "trigger": run.trigger,
        "state": run.state, "attempt": int(run.attempt or 1),
        "taskId": run.task_id, "taskTitle": str(getattr(task, "title", "") or ""),
        "taskStatus": str(getattr(task, "status", "") or ""),
        "workflowRunId": run.workflow_run_id, "startedAt": _run_iso(run.started_at),
        "finishedAt": _run_iso(run.finished_at), "durationSeconds": duration,
        "error": run.error, "receipt": dict(run.receipt or {}),
        "conversationId": dict(run.receipt or {}).get('conversationId', ''),
        "conversationTitle": dict(run.receipt or {}).get('conversationTitle', ''),
    }


async def list_runs(session: AsyncSession, schedule_id: str, *,
                    owner_client_id: str = "", owner_user_id: str | None = None,
                    limit: int = 20) -> list[dict]:
    await reconcile_runs(session, schedule_id=schedule_id,
                         owner_client_id=owner_client_id, owner_user_id=owner_user_id)
    q = select(models.AiScheduleRun).where(
        models.AiScheduleRun.schedule_id == schedule_id)
    if owner_client_id:
        q = q.where(models.AiScheduleRun.owner_client_id == owner_client_id)
    if owner_user_id is not None:
        q = q.where(models.AiScheduleRun.owner_user_id == owner_user_id if owner_user_id
                    else models.AiScheduleRun.owner_user_id.is_(None))
    rows = list((await session.execute(
        q.order_by(models.AiScheduleRun.started_at.desc()).limit(
            max(1, min(100, int(limit or 20)))))).scalars().all())
    task_ids = {item.task_id for item in rows if item.task_id}
    tasks = {}
    if task_ids:
        tasks = {item.id: item for item in (await session.execute(
            select(models.Task).where(models.Task.id.in_(task_ids))
        )).scalars().all()}
    return [run_to_api(item, tasks.get(item.task_id)) for item in rows]


async def run_one(session: AsyncSession, s, who: str = "SoduWork（定时）",
                  schedule_run_id: str = "") -> dict:
    """Send ordinary local automation into conversations while retaining legacy and explicit
    workflow contracts. Enterprise execution continues through engine routing, evidence, and
    approval gates.
    """
    from . import task_dispatch
    from . import ai_exec

    if not s.owner_client_id:
        return {"ok": False, "error": "没配任务落在哪台 SoduWork 上"}
    client = await session.get(models.Client, s.owner_client_id, populate_existing=True)
    if client is None:
        return {"ok": False, "error": "配的那台 SoduWork 不在了"}
    if not await _account_can_run(session, s, client):
        return {"ok": False, "code": "SCHEDULE_OWNER_CHANGED", "error": "执行设备的登录账号已变更，请原账号登录后再执行"}
    try:
        repo = await resolve_repo(session, s, client=client)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)[:300]}

    actor_id, actor_name = task_actor(s, client, who)
    stamp = _now_local(s).strftime("%m-%d %H:%M")
    plugin_mode = bool(str(getattr(s, "plugin_binding_id", "") or ""))
    personal = {}
    if not plugin_mode:
        try:
            await validate_execution(session, s)
            personal = personal_plugin_spec(s)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)[:300]}

    from . import schedule_conversations
    adapter = schedule_conversations.adapter_for(s, client)
    if adapter and schedule_run_id:
        return await schedule_conversations.prepare(session, s, client, repo, schedule_run_id, adapter, personal)

    # A transient offline Runner must not create a trail of duplicate tasks.
    # Retries keep the original task, its timeline and its evidence identity.
    retrying = bool(getattr(s, "next_retry_at", None) and
                    str(getattr(s, "last_task_id", "") or ""))
    stable_task_id = str(schedule_run_id or "")[:36]
    if retrying:
        t = await session.get(models.Task, s.last_task_id)
    else:
        t = await session.get(models.Task, stable_task_id) if stable_task_id else None
    new_task = t is None
    if new_task:
        task_values = {
            "title": ("%s · %s" % (s.title or "定时任务", stamp))[:200],
            "note": s.note or "", "status": "todo",
            "owner_client_id": s.owner_client_id,
            # This Task is an execution identity for the automation run, not a
            # user requirement.  Keep it addressable for artifacts and traces,
            # while the normal task projection excludes its origin.
            "origin": "automation",
            "automation_schedule_id": str(getattr(s, "id", "") or "")[:36] or None,
            "source": "定时派活", "created_by": actor_id or None,
            "created_by_name": actor_name,
            "requester_user_id": actor_id or None, "requester_name": actor_name,
        }
        if stable_task_id:
            task_values["id"] = stable_task_id
        t = models.Task(**task_values)
        if repo is not None:
            t.project_id = repo.project_id
            t.repo_id = repo.id
        session.add(t)

    # Retries can find a Task created before the origin marker was added.  The
    # schedule owns that stable identity, so normalize it before any receipt or
    # execution update is emitted.
    t.origin = "automation"
    t.automation_schedule_id = str(getattr(s, "id", "") or "")[:36] or None

    if not plugin_mode:
        routing = dict(getattr(t, "work_routing", None) or {})
        capabilities = clean_required_capabilities(
            getattr(s, "required_capabilities", None))
        routing.update({
            "automationScheduleId": str(getattr(s, "id", "") or ""),
            "automationScheduleRunId": str(schedule_run_id or ""),
            "requiredAgentCapabilities": capabilities,
            "requiredSkills": required_skill_names(capabilities),
        })
        if personal:
            routing["personalPlugin"] = dict(personal)
        t.work_routing = routing
    await session.flush()

    if new_task:
        await _push_new(session, t)
    if plugin_mode:
        if stable_task_id:
            persisted = await _persisted_workflow(
                session, t.id, str(getattr(s, "plugin_binding_id", "") or ""))
            if persisted is not None:
                return {
                    "ok": True, "recovered": True, "taskId": t.id,
                    "workflowRunId": persisted.id, "identifier": persisted.id,
                }
        binding = None
        plugin_snapshot = {}
        try:
            binding = await validate_execution(session, s)
            from .. import automation_models as am
            version = await session.get(am.PluginVersion, binding.version_id)
            plugin = await session.get(am.Plugin, binding.plugin_id)
            plugin_snapshot = {
                "scope": "enterprise", "bindingId": binding.id,
                "pluginId": binding.plugin_id, "versionId": binding.version_id,
                "key": str(getattr(plugin, "key", "") or ""),
                "name": str(getattr(plugin, "name", "") or ""),
                "version": str(getattr(version, "version", "") or ""),
                "checksum": str(getattr(version, "checksum", "") or ""),
            }
            from . import workflow_engine
            run = await workflow_engine.start(
                session, t, binding, dict(s.plugin_inputs or {}),
                actor_id=actor_id, instruction=s.note or "",
                repo_id=(repo.id if repo else ""), entrypoint="automation")
        except Exception as e:  # noqa: BLE001 - Retain the task and readable failure for later configuration repair.
            # start first commits the run, then schedules its first node. The persisted run is
            # recoverable by workflow_engine.tick and must not look like "nothing started".
            persisted = None
            if binding is not None:
                try:
                    persisted = await _persisted_workflow(session, t.id, binding.id)
                except Exception:  # a broken transaction remains a real startup failure
                    persisted = None
            if persisted is not None:
                warning = "流程已创建，首次调度暂未完成，后台会自动恢复"
                log.warning("定时插件首次调度延后恢复：task=%s run=%s", t.id, persisted.id)
                return {"ok": True, "taskId": t.id, "workflowRunId": persisted.id,
                        "identifier": persisted.id, "deferredSchedule": True,
                        "warning": warning, "pluginSnapshot": plugin_snapshot}
            return {"ok": False, "error": str(getattr(e, "detail", e))[:300],
                    "taskId": t.id}
        return {"ok": True, "taskId": t.id, "workflowRunId": run.id,
                "identifier": run.id, "pluginSnapshot": plugin_snapshot}

    if stable_task_id:
        persisted_dispatch = await _persisted_dispatch(session, t.id)
        if persisted_dispatch is not None:
            return persisted_dispatch
    ctx = await ai_exec.load(session, force=True)
    if not ai_exec.configured(ctx):
        return {"ok": False, "error": "AI 执行还没配好", "taskId": t.id}
    body = {"assigneeId": s.assignee_id, "assigneeType": s.assignee_type or "agent", "brief": ""}
    if personal:
        # Send only personal-plugin identity, verifiable version metadata, and public parameters.
        # Resolve content on the owner's device, where the personal plugin library exists.
        body["personalPlugin"] = {**personal, "inputs": dict(s.plugin_inputs or {})}
    if repo is not None:
        # Unattended schedules resolve paths from the client's persisted work root,
        # falling back to the repository ai_work_dir only when needed; see workdirs.auto_dir.
        from . import workdirs
        wd, _why = workdirs.auto_dir(client, repo)
        if not wd:
            return {"ok": False,
                    "error": "没有可用的干活目录（这台 SoduWork 没设工作目录，工程也没配 AI 干活目录）"}
        body["repo"] = {"id": repo.id, "path": wd, "name": repo.name, "kind": repo.kind,
                        "gitUrl": repo.git_url, "branch": repo.default_branch,
                        "note": repo.note, "flow": bool(s.flow)}
    # Push server-created tasks to their owning client immediately.
    # Otherwise clients remain unaware until their next full refresh.
    # The server owns task truth; client absence from a local snapshot is not a deletion command.
    try:
        r = await task_dispatch.dispatch(tid=t.id, body=body, client=client, session=session)
    except Exception as e:                       # noqa: BLE001 - Record dispatch failure without disabling the schedule loop.
        return {"ok": False, "error": str(getattr(e, "detail", e))[:300], "taskId": t.id}
    result = {"ok": True, "taskId": t.id,
              "identifier": (r or {}).get("identifier", "")}
    for key in (
            "provider", "assigneeId", "assigneeName", "assigneeCli", "agentCli",
            "model", "runnerId", "host", "pluginSnapshot"):
        value = (r or {}).get(key)
        if value not in (None, ""):
            result[key] = value
    return result


async def _push_new(session: AsyncSession, t: models.Task) -> None:
    """Push a newly created task to its owner without allowing notification failure to affect
    dispatch.
    """
    # Automation execution identities are intentionally absent from the
    # requirement pool.  Their run ledger is the user-facing status surface.
    if not t.owner_client_id or getattr(t, "origin", "") == "automation":
        return
    try:
        from . import task_access
        await task_access.publish_task(session, t, "task.created")
    except Exception as e:  # noqa: BLE001
        log.warning("定时派活推送新任务失败：%s", type(e).__name__)


async def tick(session: AsyncSession) -> dict:
    """Reconcile receipts and claim each due occurrence on exactly one Hub instance."""
    try:
        await reconcile_runs(session)
        await session.commit()
    except Exception:  # Receipt projection failure must not suppress unrelated due work.
        log.exception("自动化执行记录对账失败，继续检查到期计划")
        await session.rollback()
    schedule_ids = list((await session.execute(
        select(models.AiSchedule.id).where(
            models.AiSchedule.enabled.is_(True)))).scalars().all())
    fired = contended = deduplicated = 0
    for schedule_id in schedule_ids:
        lease = None
        identity = ""
        entered_execute = False
        # Include timing and lease acquisition in the per-plan boundary: an old
        # malformed row or transient lease error must not starve later owners.
        try:
            s = await session.get(models.AiSchedule, schedule_id)
            if s is None or not s.enabled or not due(s):
                continue
            trigger = schedule_timing.trigger_for(s)
            identity = trigger_identity(s, trigger)
            lease = await resource_leases.acquire(
                session, "schedule-trigger", identity, owner=_SCHEDULE_OWNER,
                ttl_seconds=_SCHEDULE_LEASE_SECONDS,
                detail={"scheduleId": schedule_id, "trigger": trigger})
            await session.refresh(s)
            if not s.enabled or not due(s):
                continue
            fresh_trigger = schedule_timing.trigger_for(s)
            fresh_identity = trigger_identity(s, fresh_trigger)
            if fresh_identity != identity:
                # Another owner completed the stale occurrence before this lease was acquired.
                continue
            entered_execute = True
            out = await execute_one(
                session, s, trigger=fresh_trigger, idempotency_key=fresh_identity)
            await session.commit()
        except resource_leases.LeaseBusy:
            contended += 1
            continue
        except Exception as exc:  # noqa: BLE001
            log.exception("定时派活单条异常：schedule=%s", schedule_id)
            await session.rollback()
            # Pre-claim infrastructure errors have not consumed an occurrence.
            # Keep its clock and retry budget intact so the same identity resumes.
            try:
                s = await session.get(models.AiSchedule, schedule_id)
                if s is None:
                    continue
                await session.refresh(s)
                claimed = None
                if entered_execute and identity:
                    claimed = await session.scalar(select(models.AiScheduleRun.id).where(
                        models.AiScheduleRun.idempotency_key == identity).limit(1))
                if getattr(s, "every", "") == "once" or claimed is None:
                    # Unclaimed work remains due. Once plans also preserve their
                    # durable claim until recovery verifies any external effects.
                    s.last_error = str(exc)[:300]
                else:
                    apply_outcome(s, {"ok": False, "error": str(exc)[:300]})
                await session.commit()
                await _notify_failure(session, s, {"error": str(exc)[:300]})
            except Exception:  # noqa: BLE001
                await session.rollback()
            continue
        finally:
            if lease is not None:
                try:
                    await resource_leases.release(session, lease)
                except Exception as exc:  # noqa: BLE001
                    await session.rollback()
                    log.warning("释放定时触发租约失败：%s", type(exc).__name__)
        if out.get("deduplicated"):
            deduplicated += 1
        elif out.get("ok"):
            fired += 1
            log.info("自动化「%s」已交付执行（任务 %s，记录 %s）",
                     s.title, out.get("taskId"), out.get("scheduleRunId"))
        else:
            log.warning("自动化启动失败「%s」：%s", s.title, s.last_error)
            await _notify_failure(session, s, out)
    return {"checked": len(schedule_ids), "fired": fired,
            "contended": contended, "deduplicated": deduplicated}
