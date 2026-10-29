"""Explicit lifecycle controls for persistent plugin workflow runs."""
from __future__ import annotations

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from .task_access import publish_owner
from . import ai_exec, task_events
from .workflow_runs import _event, _ms, _now


LOCK = asyncio.Lock()
_ACTIVE = {"queued", "dispatching", "running", "waiting_human", "waiting_external"}


def _owned_refs(nodes: list[am.NodeRun]) -> tuple[set[str], set[tuple[str, str]], set[str]]:
    """Collect only external resources explicitly linked from these node outputs."""
    request_ids: set[str] = set()
    acceptance_refs: set[tuple[str, str]] = set()
    deployment_ids: set[str] = set()
    for node in nodes:
        output = dict(node.output or {})
        request_id = str(output.get("requestId") or "")
        if request_id:
            request_ids.add(request_id)
        for item in list(output.get("runs") or []):
            if isinstance(item, dict) and item.get("id"):
                deployment_ids.add(str(item["id"]))
        if node.node_type != "deploy_chain":
            continue
        artifact_id = str(output.get("artifactVersionId") or "")
        for item in list(output.get("environments") or []):
            if artifact_id and isinstance(item, dict) and item.get("id") \
                    and item.get("acceptance") in {"pending", "not_started"}:
                acceptance_refs.add((artifact_id, str(item["id"])))
    return request_ids, acceptance_refs, deployment_ids


async def _mark_cancelled(session: AsyncSession, run: am.WorkflowRun, actor: str,
                          reason: str) -> tuple[dict, list[dict], models.Task | None]:
    active_nodes = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == run.id, am.NodeRun.state.in_(tuple(_ACTIVE))
    ))).scalars().all())
    request_ids, acceptance_refs, deployment_ids = _owned_refs(active_nodes)
    executor_refs = []
    for node in active_nodes:
        executor = dict(node.executor or {})
        ref = str(executor.get("ref") or "")
        if node.node_type == "ai" and ref:
            executor_refs.append({"ref": ref,
                                  "runnerId": str(executor.get("runnerId") or ""),
                                  "provider": str(executor.get("provider") or "")})
        node.state, node.error, node.finished_at = "cancelled", reason, _now()
        node.lease_owner, node.lease_until = "", None

    outboxes = list((await session.execute(select(am.WorkflowOutbox).where(
        am.WorkflowOutbox.run_id == run.id,
        am.WorkflowOutbox.status.in_(("pending", "processing"))
    ))).scalars().all())
    for row in outboxes:
        row.status, row.error, row.lease_owner, row.lease_until = (
            "done", "流程已结束", "", None)

    pending = list((await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.task_id == run.task_id,
        am.ApprovalRequest.status == "pending"
    ))).scalars().all())
    cancelled_approvals = 0
    for request in pending:
        linked = request.id in request_ids or (
            (request.artifact_version_id, request.environment_id) in acceptance_refs
            and request.action in {"uat", "deploy"})
        if linked:
            request.status, request.resolved_at = "cancelled", _now()
            cancelled_approvals += 1

    cancelled_deployments = running_deployments = 0
    if deployment_ids:
        rows = list((await session.execute(select(am.DeploymentRun).where(
            am.DeploymentRun.id.in_(deployment_ids)
        ))).scalars().all())
        for deployment in rows:
            if deployment.state == "queued":
                deployment.state, deployment.error = "cancelled", "所属流程已结束"
                deployment.finished_at = _now()
                cancelled_deployments += 1
            elif deployment.state == "running":
                # A deployment may already have changed an environment.  Without a remote
                # cancel/rollback contract it is safer to retain its independent state machine.
                running_deployments += 1

    task = await session.get(models.Task, run.task_id)
    another_run = (await session.execute(select(am.WorkflowRun.id).where(
        am.WorkflowRun.task_id == run.task_id,
        am.WorkflowRun.id != run.id,
        am.WorkflowRun.state.in_(tuple(_ACTIVE)),
    ).limit(1))).scalar_one_or_none()
    task_reopened = bool(task and task.status == "doing" and another_run is None)
    if task_reopened:
        from . import task_status
        await task_status.mark(session, task, "todo", engine=True, why="run.cancelled")

    cancellation = {
        "actor": actor, "reason": reason, "at": _ms(_now()),
        "cancelledApprovals": cancelled_approvals,
        "cancelledDeployments": cancelled_deployments,
        "runningDeployments": running_deployments,
        "taskReopened": task_reopened,
    }
    run.state, run.current_nodes, run.error, run.finished_at = (
        "cancelled", [], reason, _now())
    run.output = {**dict(run.output or {}), "cancellation": cancellation}
    _event(session, run.id, "run.cancelled", actor=actor, detail=cancellation)
    task_events.record(session, run.task_id, "plugin.cancelled", {
        "runId": run.id, **cancellation,
    }, actor=actor)
    await session.commit()
    return cancellation, executor_refs, task


async def _stop_executors(session: AsyncSession, run: am.WorkflowRun,
                          executor_refs: list[dict]) -> list[dict]:
    stopped = []
    if not executor_refs:
        return stopped
    ctx = await ai_exec.load(session)
    for item in executor_refs:
        if item["runnerId"] and item["provider"] == "runner":
            from . import ai_remote
            ai_remote.remember(item["ref"], item["runnerId"])
        try:
            result = await asyncio.to_thread(ai_exec.stop_sync, ctx, item["ref"])
            stopped.append({**item, "ok": bool(result.get("ok")),
                            "error": str(result.get("error") or "")[:240]})
        except Exception as exc:  # noqa: BLE001
            stopped.append({**item, "ok": False, "error": type(exc).__name__})
    await session.refresh(run)
    current = dict(run.output or {})
    current["cancellation"] = {**dict(current.get("cancellation") or {}),
                               "stoppedExecutors": stopped}
    run.output = current
    await session.commit()
    return stopped


async def cancel_run(session: AsyncSession, run: am.WorkflowRun, *, actor: str,
                     reason: str = "") -> dict:
    """End an active workflow without erasing completed evidence or deployments."""
    reason = (str(reason or "").strip() or "由需求负责人结束本次流程")[:500]
    actor = (str(actor or "").strip() or "system")[:100]
    async with LOCK:
        # The asyncio lock covers the normal one-process deployment.  FOR UPDATE also makes
        # cancellation atomic when an enterprise later runs multiple API workers.
        locked = (await session.execute(select(am.WorkflowRun).where(
            am.WorkflowRun.id == run.id).with_for_update())).scalar_one_or_none()
        if locked is None:
            raise ValueError("插件运行不存在")
        run = locked
        if run.state == "cancelled":
            return {"ok": True, "alreadyCancelled": True,
                    "cancelledApprovals": 0, "cancelledDeployments": 0,
                    "runningDeployments": 0, "stoppedExecutors": []}
        if run.state not in _ACTIVE:
            raise ValueError("只有进行中的流程可以结束")
        cancellation, executor_refs, task = await _mark_cancelled(
            session, run, actor, reason)
    stopped = await _stop_executors(session, run, executor_refs)
    if task is not None and task.owner_client_id:
        from ..realtime import hub
        from .tasks import task_to_api_live
        # Stopping a remote executor can take a few seconds.  Another workflow may have started
        # meanwhile, so publish the current database state rather than the stale reopened object.
        await session.refresh(task)
        await publish_owner(session, task, {
            "type": "task.updated", "task": await task_to_api_live(session, task),
        })
    return {"ok": True, "alreadyCancelled": False, **{
        key: cancellation[key] for key in (
            "cancelledApprovals", "cancelledDeployments", "runningDeployments",
            "taskReopened")
    }, "stoppedExecutors": stopped}
