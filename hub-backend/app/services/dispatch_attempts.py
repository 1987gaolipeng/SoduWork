"""Durable observability for direct AI dispatch attempts.

Dispatch is an external side effect: runner selection, workspace preparation and
the RPC itself can fail before an execution session exists. Those failures must
still remain on the task timeline after the HTTP request and container logs are
gone. This module keeps the persistence rule in one place and redacts raw
provider errors before they reach task history or the client.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from ..log_safety import redact_log_text
from . import ai_exec, dispatch_identity, execution_sessions, task_events
from .ai_exec_route import cli_of


_CLI_NAMES = {
    "pi": "Pi",
    "opencode": "OpenCode",
    "claude": "Claude Code",
    "codex": "Codex",
}

PHASE_NAMES = {
    "configuration": "检查配置",
    "routing": "选择执行机",
    "context": "整理需求资料",
    "workspace": "准备工作目录",
    "workflow": "加载工作方法",
    "dispatch": "启动 Agent",
    "confirmation": "确认执行机回执",
    "unknown": "启动需求",
}


def public_error(value, fallback: str = "安排执行失败") -> str:
    """Return a bounded, redacted error suitable for audit history and UI."""
    text = redact_log_text(str(value or "")).strip().replace("\x00", "")
    return (text or fallback)[:500]


def _agent_detail(requested_id: str, picked: dict | None = None) -> dict:
    selected = dict(picked or {})
    cli = str(selected.get("cli") or selected.get("cliName") or cli_of(requested_id)).strip()
    cli_key = cli.lower().replace(" ", "")
    name = str(selected.get("name") or "").strip()
    return {
        "requestedId": str(requested_id or "")[:180],
        "assigneeId": str(selected.get("id") or "")[:180],
        "assigneeName": name[:180] or _CLI_NAMES.get(cli_key, cli or "AI"),
        "assigneeCli": _CLI_NAMES.get(cli_key, cli)[:80],
        "runnerId": str(selected.get("runnerId") or "")[:80],
        "runnerBootId": str(selected.get("runnerBootId") or "")[:64],
        "host": str(selected.get("host") or "")[:180],
        "selection": dict(selected.get("selection") or {}),
    }


async def start(session: AsyncSession, task_id: str, actor: str,
                requested_id: str = "", requested_type: str = "",
                model: str = "", *, stable_id: str = "") -> str:
    """Persist the intent before touching a Runner and return its correlation id."""
    attempt_id = dispatch_identity.clean_dispatch_id(stable_id) or uuid.uuid4().hex
    detail = {
        "attemptId": attempt_id,
        "expectedRef": dispatch_identity.execution_ref(attempt_id),
        "phase": "routing",
        "phaseName": PHASE_NAMES["routing"],
        "requestedId": str(requested_id or "")[:180],
        "requestedType": str(requested_type or "agent")[:24],
        "assigneeCli": _CLI_NAMES.get(cli_of(requested_id), cli_of(requested_id) or "AI"),
        "model": str(model or "")[:180],
        "retryable": True,
    }
    task_events.record(session, task_id, ai_exec.EV_DISPATCH_STARTED, detail, actor=actor)
    await session.commit()
    return attempt_id

async def existing(session: AsyncSession, task_id: str,
                   task_status: str = "") -> dict | None:
    """Return an idempotent receipt while one direct dispatch is still active."""
    return (await existing_many(session, {task_id: task_status})).get(task_id)


async def existing_many(session: AsyncSession, task_statuses: dict[str, str], *,
                        execution_states: dict[tuple[str, str], str] | None = None) -> dict:
    """Latest dispatch facts in bounded queries, shared by dispatch and maintenance."""
    if not task_statuses:
        return {}
    ranked = select(
        models.TaskEvent.id,
        func.row_number().over(
            partition_by=models.TaskEvent.task_id,
            order_by=(models.TaskEvent.at.desc(), models.TaskEvent.id.desc()),
        ).label("position"),
    ).where(models.TaskEvent.task_id.in_(task_statuses),
            models.TaskEvent.kind.in_(ai_exec.KINDS_DISPATCH_STATE)).subquery()
    events = list(await session.scalars(select(models.TaskEvent).join(
        ranked, models.TaskEvent.id == ranked.c.id).where(ranked.c.position == 1)))
    if execution_states is None:
        refs = {_execution_ref(event) for event in events} - {""}
        execution_states = {}
        if refs:
            states = await session.execute(select(
                am.ExecutionSession.task_id, am.ExecutionSession.ref, am.ExecutionSession.state,
            ).where(am.ExecutionSession.task_id.in_(task_statuses), am.ExecutionSession.ref.in_(refs)))
            execution_states = {(tid, ref): state for tid, ref, state in states}
    now = datetime.now(timezone.utc)
    result = {}
    for event in events:
        receipt = _existing_receipt(event, task_statuses[event.task_id],
                                    execution_states.get((event.task_id, _execution_ref(event))), now)
        if receipt is not None:
            result[event.task_id] = receipt
    return result


def _execution_ref(event) -> str:
    detail = event.detail or {}
    return str(detail.get("ref") or detail.get("issueId") or detail.get("expectedRef") or "")


def _existing_receipt(event, task_status: str, execution_state, now: datetime) -> dict | None:
    if event is None or event.kind == ai_exec.EV_DISPATCH_FAILED:
        return None
    # Telemetry can finish before an uncertain ACK is reconciled. Its exact
    # execution ref is authoritative; unfamiliar/paused states are not terminal.
    if execution_sessions.is_terminal(execution_state) or event.kind in ai_exec.KINDS_ARTIFACTS:
        return None

    detail = dict(event.detail or {})
    at = event.at
    if isinstance(at, datetime) and at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    age = now - at if isinstance(at, datetime) else None
    if (event.kind == ai_exec.EV_DISPATCH_STARTED and age is not None
            and age > timedelta(minutes=10)):
        return None
    if (event.kind in ai_exec.KINDS_DISPATCHED and task_status == "todo"
            and age is not None and age > timedelta(minutes=10)):
        return None

    pending = event.kind in {
        ai_exec.EV_DISPATCH_STARTED, ai_exec.EV_DISPATCH_UNCERTAIN}
    requested_id = str(detail.get("requestedId") or "")
    provider = str(detail.get("provider") or "")
    if not provider:
        provider = ("runner" if requested_id.startswith(ai_exec.REMOTE_PREFIX)
                    else "local" if requested_id.startswith(ai_exec.LOCAL_PREFIX) else "")
    requested_runner = (requested_id[len(ai_exec.REMOTE_PREFIX):].split(":", 1)[0]
                        if requested_id.startswith(ai_exec.REMOTE_PREFIX) else "")
    expected_ref = str(detail.get("expectedRef") or "")
    ref = str(detail.get("ref") or detail.get("issueId") or expected_ref)
    return {
        "ok": True,
        "already": True,
        "pending": pending,
        "state": "confirming" if pending else "running",
        "confirmationPending": event.kind == ai_exec.EV_DISPATCH_UNCERTAIN,
        "attentionRaised": bool(detail.get("attentionRaised")),
        "nextAction": str(detail.get("nextAction") or ""),
        "runnerOnline": detail.get("runnerOnline"),
        "retryable": False,
        "eventKind": event.kind,
        "attemptId": str(detail.get("attemptId") or ""),
        "issueId": ref,
        "expectedRef": expected_ref or ref,
        "identifier": str(detail.get("identifier") or ""),
        "provider": provider,
        "runnerId": str(detail.get("runnerId") or requested_runner),
        "runnerBootId": str(detail.get("runnerBootId") or ""),
        "host": str(detail.get("host") or ""),
        "assigneeId": str(detail.get("assigneeId") or ""),
        "assigneeName": str(detail.get("assigneeName") or ""),
        "assigneeCli": str(detail.get("assigneeCli") or ""),
    }



def uncertain(session: AsyncSession, task_id: str, actor: str, attempt_id: str,
              error, requested_id: str = "", picked: dict | None = None) -> dict:
    """Record an indeterminate ACK without claiming that Agent startup failed.

    Once the RPC bytes may have reached a Runner, rolling the task back invites a
    second Agent to perform the same work. The Runner heartbeat is the authority
    that later confirms the stable execution ref.
    """
    detail = {
        "attemptId": str(attempt_id or "")[:64],
        "expectedRef": dispatch_identity.execution_ref(attempt_id),
        "phase": "confirmation",
        "phaseName": PHASE_NAMES["confirmation"],
        "error": public_error(error, "执行机回执暂未确认"),
        "summary": "执行机回执暂未确认，SoduWork 正在按执行实况自动核对",
        "retryable": False,
        "uncertain": True,
        **_agent_detail(requested_id, picked),
    }
    task_events.record(
        session, task_id, ai_exec.EV_DISPATCH_UNCERTAIN, detail, actor=actor)
    return detail


async def failed(session: AsyncSession, task_id: str, actor: str, attempt_id: str,
                 phase: str, error, requested_id: str = "",
                 picked: dict | None = None, retryable: bool = True) -> dict:
    """Rollback partial DB mutations, then durably record the failed attempt."""
    await session.rollback()
    key = phase if phase in PHASE_NAMES else "unknown"
    message = public_error(error)
    detail = {
        "attemptId": str(attempt_id or "")[:64],
        "phase": key,
        "phaseName": PHASE_NAMES[key],
        "error": message,
        "summary": PHASE_NAMES[key] + "失败：" + message,
        "retryable": bool(retryable),
        **_agent_detail(requested_id, picked),
    }
    task_events.record(session, task_id, ai_exec.EV_DISPATCH_FAILED, detail, actor=actor)
    await session.commit()
    return detail


def success_detail(attempt_id: str, requested_id: str,
                   picked: dict | None = None) -> dict:
    """Fields shared by a successful dispatch event and its failed counterpart."""
    return {"attemptId": str(attempt_id or "")[:64],
            "expectedRef": dispatch_identity.execution_ref(attempt_id),
            **_agent_detail(requested_id, picked)}
