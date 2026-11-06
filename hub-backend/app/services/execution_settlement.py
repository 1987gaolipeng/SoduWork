"""Settle terminal Runner sessions outside the WebSocket receive coroutine. Session state, task
state, and delivery are distinct: stop displaying execution first, then collect artifacts or
code candidates through idempotent services.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from sqlalchemy import func, literal, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models

_SUCCESS_MARKS = {"done", "done_no_output", "delegated", "superseded", "failed"}


async def _save_mark(session, row, mark, *, expected_state, error=None):
    """Patch settlement only while the captured execution turn remains current."""
    value = json.dumps(mark, ensure_ascii=False)
    if session.get_bind().dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import JSONB, array
        replacement = func.jsonb_set(am.ExecutionSession.metadata_.cast(JSONB),
                                    array(["terminalSettlement"]), literal(value).cast(JSONB))
        if error is not None:
            replacement = func.jsonb_set(replacement, array(["error"]),
                                         literal(json.dumps(error)).cast(JSONB))
    else:
        replacement = func.json_set(am.ExecutionSession.metadata_, "$.terminalSettlement", func.json(value))
        if error is not None:
            replacement = func.json_set(replacement, "$.error", error)
    changed = await session.execute(update(am.ExecutionSession).where(
        am.ExecutionSession.id == row.id, am.ExecutionSession.state == expected_state,
        func.coalesce(am.ExecutionSession.metadata_["round"].as_integer(), 1) == mark["round"],
        or_(func.coalesce(am.ExecutionSession.metadata_["terminalSettlement"]["round"].as_integer(), 0) != mark["round"],
            func.coalesce(am.ExecutionSession.metadata_["terminalSettlement"]["executionState"].as_string(), "") != mark["executionState"],
            func.coalesce(am.ExecutionSession.metadata_["terminalSettlement"]["state"].as_string(), "").not_in(tuple(_SUCCESS_MARKS))),
    ).values(metadata_=replacement).execution_options(synchronize_session=False))
    await session.refresh(row)
    return bool(changed.rowcount)


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
    """Preserve caller transactions; artifact identities and settlement CAS fence races."""
    try:
        return await _settle_terminal(session, task_id, ref, include_task=include_task)
    except BaseException:
        await session.rollback()
        raise


async def _settle_terminal(session: AsyncSession, task_id: str, ref: str,
                           *, include_task: bool = True) -> dict:
    """Settle only the task's latest dispatch so delayed older executions cannot overwrite rework.
    Plugin workflows import files without bypassing review or release nodes; direct tasks use
    existing candidate rules.
    """
    from . import (ai_exec, code_delivery, execution_sessions, project_context,
                   task_events, task_status)

    task = await session.get(models.Task, task_id, populate_existing=True)
    row = (await session.execute(select(am.ExecutionSession).where(
        am.ExecutionSession.ref == ref,
        am.ExecutionSession.task_id == task_id,
    ).limit(1).execution_options(populate_existing=True))).scalar_one_or_none()
    if task is None or row is None:
        return {"ok": False, "retry": False, "reason": "missing"}

    state = execution_sessions.canonical_state(row.state)
    if not execution_sessions.is_terminal(state):
        return {"ok": False, "retry": False, "reason": "not-terminal"}

    workflow_target = _workflow_target(row)
    workflow_managed = bool(row.workflow_run_id or row.node_run_id)
    meta = dict(row.metadata_ or {})
    expected_state, round_no = row.state, int(meta.get("round") or 1)
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
        if not await _save_mark(session, row, mark, expected_state=expected_state):
            return {"ok": False, "retry": False, "reason": "execution-advanced"}
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
        if not await _save_mark(session, row, mark, expected_state=expected_state, error=error):
            return {"ok": False, "retry": False, "reason": "execution-advanced"}
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
    await session.refresh(row)
    if row.state != expected_state or int((row.metadata_ or {}).get("round") or 1) != round_no:
        return {"ok": False, "retry": False, "reason": "execution-advanced"}
    persisted_output = False
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
            func.coalesce(models.Attachment.evidence_meta["round"].as_integer(), 1) == round_no,
        ).limit(1))
        persisted_output = bool(persisted)
        if persisted or getattr(task, "artifact_url", ""):
            status = {"ok": True, "done": True, "attachments": [], "round": round_no,
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
    has_output = bool(status.get("attachments") or status.get("artifactUrl") or persisted_output)
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

    delivery_error = str(receipt.get("submissionError") or "")
    incomplete = bool(receipt.get("missing")) or bool(status.get("artifactsDropped")) or bool(delivery_error)
    # Mobile review uses this durable terminal path, even after the phone closes.
    # A failed report must never become a successful review of the source task.
    acceptance_error = None
    if not incomplete:
        from fastapi import HTTPException
        from . import cloud_acceptance
        try:
            await cloud_acceptance.settle(session, task, row)
        except HTTPException as exc:
            if exc.status_code >= 500:
                raise
            acceptance_error = str(exc.detail)
            await cloud_acceptance.failed(session, task.id, acceptance_error)
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
        **({"error": acceptance_error or delivery_error} if acceptance_error or delivery_error else {}),
    }
    if not await _save_mark(session, row, mark, expected_state=expected_state,
                            error=acceptance_error or delivery_error or ("" if previous.get("state") == "incomplete" else None)):
        return {"ok": False, "retry": False, "reason": "execution-advanced"}
    await project_context.record_completion(session, task, row, status, receipt)
    await session.commit()
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
