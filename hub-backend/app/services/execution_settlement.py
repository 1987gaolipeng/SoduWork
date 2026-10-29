"""Settle terminal Runner sessions outside the WebSocket receive coroutine. Session state, task
state, and delivery are distinct: stop displaying execution first, then collect artifacts or
code candidates through idempotent services.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models

_SUCCESS_MARKS = {"done", "done_no_output", "delegated", "superseded", "failed"}


async def _task_view(session: AsyncSession, task: models.Task) -> dict:
    from .tasks import task_to_api_live

    await session.flush()
    return await task_to_api_live(session, task)


def _workflow_target(row: am.ExecutionSession) -> dict:
    """Return the durable workflow identity carried by a dispatched session."""
    run_id = str(row.workflow_run_id or "")
    node_id = str(row.node_run_id or "")
    if not run_id or not node_id:
        return {}
    return {"workflowRunId": run_id, "nodeRunId": node_id,
            "ref": str(row.ref or "")}


async def settle_terminal(session: AsyncSession, task_id: str, ref: str,
                          *, include_task: bool = True) -> dict:
    """Settle only the task's latest dispatch so delayed older executions cannot overwrite rework.
    Plugin workflows import files without bypassing review or release nodes; direct tasks use
    existing candidate rules.
    """
    from . import (ai_exec, code_delivery, execution_sessions, project_context,
                   task_events, task_status)

    task = await session.get(models.Task, task_id)
    row = (await session.execute(select(am.ExecutionSession).where(
        am.ExecutionSession.ref == ref,
        am.ExecutionSession.task_id == task_id,
    ).limit(1))).scalar_one_or_none()
    if task is None or row is None:
        return {"ok": False, "retry": False, "reason": "missing"}

    state = execution_sessions.canonical_state(row.state)
    if not execution_sessions.is_terminal(state):
        return {"ok": False, "retry": False, "reason": "not-terminal"}

    workflow_target = _workflow_target(row)
    workflow_managed = bool(row.workflow_run_id or row.node_run_id)
    meta = dict(row.metadata_ or {})
    previous = dict(meta.get("terminalSettlement") or {})
    if (previous.get("state") in _SUCCESS_MARKS and
            execution_sessions.settlement_is_current(row, previous)):
        result = {
            "ok": True,
            "idempotent": True,
            "clientId": task.owner_client_id or "",
            "task": await _task_view(session, task) if include_task else None,
            "settlement": previous,
        }
        if workflow_target:
            result["workflowTarget"] = workflow_target
        return result

    dispatch = await ai_exec.last_dispatch_event(session, task_id)
    route = dict(dispatch.detail or {}) if dispatch is not None else {}
    latest_ref = str(route.get("ref") or route.get("issueId") or "")
    if latest_ref and latest_ref != ref:
        mark = {
            "state": "superseded",
            "round": int(meta.get("round") or 1), "executionState": state,
            "at": datetime.now(timezone.utc).isoformat(),
            "latestRef": latest_ref,
        }
        meta["terminalSettlement"] = mark
        row.metadata_ = meta
        await session.commit()
        result = {
            "ok": True,
            "clientId": task.owner_client_id or "",
            "task": await _task_view(session, task) if include_task else None,
            "settlement": mark,
        }
        if workflow_target:
            result["workflowTarget"] = workflow_target
        return result

    if state != "done":
        error = str(meta.get("error") or "AI 执行进程异常退出")[:300]
        mark = {
            "state": "failed",
            "round": int(meta.get("round") or 1),
            "executionState": state,
            "at": datetime.now(timezone.utc).isoformat(),
            "error": error,
        }
        # Store settlement failures in metadata.error for session-detail reads.
        # Even a terminal session with no events needs an auditable failure explanation.
        meta["error"] = error
        meta["terminalSettlement"] = mark
        row.metadata_ = meta
        if not workflow_managed:
            failure = {
                "attemptId": str(route.get("attemptId") or "")[:64],
                "phase": "execution",
                "phaseName": "AI 执行",
                "error": error,
                "summary": "AI 执行失败：" + error,
                "retryable": True,
                "ref": ref,
                "runnerId": str(route.get("runnerId") or "")[:64],
                "assigneeId": str(route.get("assigneeId") or "")[:160],
                "assigneeName": str(route.get("assigneeName") or "")[:120],
            }
            task_events.record(
                session, task.id, ai_exec.EV_DISPATCH_FAILED, failure, actor="SoduWork")
            await task_status.mark(session, task, "todo", why="AI 执行失败")
        await project_context.record_completion(
            session, task, row, {"done": False, "error": error}, {})
        await session.commit()
        result = {
            "ok": True,
            "clientId": task.owner_client_id or "",
            "task": await _task_view(session, task) if include_task else None,
            "settlement": mark,
        }
        if workflow_target:
            result["workflowTarget"] = workflow_target
        return result


    ctx = await ai_exec.load(session)
    # The Runner route is durable in the dispatch event, while the in-memory
    # ref→Runner cache is deliberately rebuilt after a Hub restart.  Rehydrate
    # it before asking for the terminal status so a completed cloud turn does
    # not get stranded just because the Hub restarted after the Runner closed
    # the stream.
    if route.get("runnerId"):
        try:
            from . import ai_remote
            ai_remote.remember(ref, str(route.get("runnerId") or ""))
        except Exception:  # noqa: BLE001 - the persisted-output fallback below is authoritative
            pass
    status = await asyncio.to_thread(ai_exec.status_sync, ctx, ref)
    if not status.get("ok"):
        # A terminal cloud stream can already have uploaded and verified its
        # attachments before the status RPC becomes unavailable (for example
        # after a Hub restart).  Those attachments are the durable execution
        # evidence; waiting for an ephemeral RPC here leaves the UI forever at
        # Allow the ordinary idempotent artifact and release path to synchronize remote outputs.
        # finalize from the stored files instead of discarding the completion.
        persisted = await session.scalar(select(models.Attachment.id).where(
            models.Attachment.task_id == task_id,
            models.Attachment.source_ref == ref,
            models.Attachment.uploaded_by.like("agent:%"),
        ).limit(1))
        if persisted or getattr(task, "artifact_url", ""):
            status = {"ok": True, "done": True, "attachments": [],
                      "artifactUrl": getattr(task, "artifact_url", "") or ""}
        else:
            return {
                "ok": False,
                "retry": True,
                "reason": str(status.get("error") or "暂时取不到执行结果")[:300],
            }
    if not status.get("done"):
        return {"ok": False, "retry": True, "reason": "terminal-not-visible-yet"}

    receipt: dict = {}
    has_output = bool(status.get("attachments") or status.get("artifactUrl"))
    if has_output:
        receipt = await ai_exec.pull_artifacts(
            session, task_id, ctx, status, ref, settle=not workflow_managed)
    elif not workflow_managed:
        repo = await code_delivery.repo_for(session, task)
        if repo is not None:
            scm_hint = ({
                "provider": "runner",
                "runnerId": str(route.get("runnerId") or ""),
                "ref": ref,
            } if route.get("runnerId") else {})
            receipt["code"] = await code_delivery.check(
                session,
                task,
                who="SoduWork",
                force=True,
                branch_hint=str(status.get("gitRemoteBranch") or status.get("gitBranch") or ""),
                head_hint=str(status.get("gitHead") or ""),
                scm_hint=scm_hint,
            )

    incomplete = bool(receipt.get("missing")) or bool(status.get("artifactsDropped"))
    if workflow_managed:
        mark_state = "delegated"
    elif has_output or receipt.get("code"):
        mark_state = "done"
    else:
        mark_state = "done_no_output"
    mark = {
        "state": "incomplete" if incomplete else mark_state,
        "round": int(meta.get("round") or 1), "executionState": state,
        "at": datetime.now(timezone.utc).isoformat(),
        "files": int(receipt.get("files") or 0),
        "missing": list(receipt.get("missing") or [])[:50],
    }
    meta = dict(row.metadata_ or {})
    meta["terminalSettlement"] = mark
    row.metadata_ = meta
    await project_context.record_completion(session, task, row, status, receipt)
    await session.commit()
    from . import cloud_deliveries
    await cloud_deliveries.archive_if_cloud(session, task_id)
    result = {
        "ok": not incomplete,
        "retry": False,
        "clientId": task.owner_client_id or "",
        "task": await _task_view(session, task) if include_task else None,
        "settlement": mark,
    }
    if workflow_target:
        result["workflowTarget"] = workflow_target
    return result
