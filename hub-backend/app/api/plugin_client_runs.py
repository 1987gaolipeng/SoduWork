"""Employee task plugin run, recovery and retry APIs."""
from __future__ import annotations

import json

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..db import get_session
from ..deps import current_ai_client, current_client
from ..models import Client, Task
from ..services import plugin_service, task_access, workflow_control, workflow_engine

router = APIRouter(prefix="/api/v1", tags=["plugin-runs"])


def _conflict(error: ValueError) -> HTTPException:
    return HTTPException(status_code=409, detail=str(error))

async def _owned_task(session: AsyncSession, client: Client, task_id: str) -> Task:
    task = await session.get(Task, task_id)
    if task is None or not task_access.is_owner(task, client):
        raise HTTPException(status_code=404, detail="需求不存在")
    return task


@router.get("/tasks/{task_id}/plugins")
async def client_plugins(
    task_id: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Expose only approved methods runnable on this task, excluding credentials, package paths,
    and administrative configuration.
    """
    task = await _owned_task(session, client, task_id)
    return {"items": await plugin_service.available_bindings(session, task)}


@router.get("/plugins/applicable")
async def client_plugins_applicable(
    projectId: str = "",
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Technical contract for client plugins applicable."""
    from types import SimpleNamespace
    stand_in = SimpleNamespace(id="", project_id=(projectId or None),
                               owner_client_id=client.id, repo_id=None)
    return {"items": await plugin_service.available_bindings(session, stand_in)}


@router.get("/plugins/automation-options")
async def client_plugins_automation_options(
    projectId: str = "",
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Approved workflows that explicitly support unattended automation."""
    from types import SimpleNamespace
    stand_in = SimpleNamespace(id="", project_id=(projectId or None),
                               owner_client_id=client.id, repo_id=None)
    return {"items": await plugin_service.available_bindings(
        session, stand_in, entrypoint="automation")}


@router.get("/tasks/{task_id}/plugin-runs")
async def client_runs(
    task_id: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    await _owned_task(session, client, task_id)
    return {"items": await workflow_engine.list_runs(session, task_id)}


@router.get("/plugin-runs/{run_id}")
async def client_run_detail(
    run_id: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    run = await session.get(am.WorkflowRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="插件运行不存在")
    await _owned_task(session, client, run.task_id)
    return await workflow_engine.run_api(session, run)


@router.post("/plugin-runs/{run_id}/cancel")
async def client_cancel_run(
    run_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    run = await session.get(am.WorkflowRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="插件运行不存在")
    await _owned_task(session, client, run.task_id)
    reason = str(body.get("reason") or "由需求负责人结束本次流程").strip()[:500]
    try:
        result = await workflow_control.cancel_run(
            session, run, actor=str(client.user_ref or client.id), reason=reason)
    except ValueError as e:
        raise _conflict(e) from e
    return {**result, "run": await workflow_engine.run_api(session, run)}


@router.post("/tasks/{task_id}/plugin-runs")
async def client_start_run(
    task_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_ai_client),
    session: AsyncSession = Depends(get_session),
):
    """Allow task owners to start project-approved plugins without granting import, trust, or
    binding-management permissions.
    """
    from ..services import task_access
    await task_access.reserve_task_write(session, task_id, client.id)
    task = await session.get(Task, task_id, with_for_update=True, populate_existing=True)
    if task is None or task.owner_client_id != client.id:
        raise HTTPException(status_code=404, detail="需求不存在")
    submission_mode = str(body.get("submissionMode") or body.get("executionSubmissionMode") or "").strip().lower()
    if submission_mode or "executionSubmissionMode" not in (task.work_routing or {}):
        from ..services.conversation_turns import default_submission_mode, normalize_submission_mode
        routing = dict(task.work_routing or {})
        routing["executionSubmissionMode"] = normalize_submission_mode(
            submission_mode, fallback=default_submission_mode(task))
        task.work_routing = routing
    inputs = body.get("inputs") or {}
    if not isinstance(inputs, dict) or len(json.dumps(inputs, ensure_ascii=False)) > 100_000:
        raise HTTPException(status_code=400, detail="插件输入必须是小于 100KB 的对象")
    try:
        binding = await plugin_service.resolve_binding(
            session, task, binding_id=str(body.get("bindingId") or ""),
            plugin_id=str(body.get("pluginId") or ""))
        source_id = str(body.get("resumeFromRunId") or "")
        source = await session.get(am.WorkflowRun, source_id) if source_id else None
        if source_id and source is None:
            raise ValueError("要续接的历史流程不存在")
        starter = workflow_engine.start_from_evidence if source else workflow_engine.start
        extra = ({"source_run": source, "target_key": str(body.get("startAtNode") or "")}
                 if source else {"conversation_turn": body.get("conversationTurn")})
        run = await starter(
            session, task, binding, inputs, actor_id=str(client.user_ref or client.id),
            execution=body.get("execution"), instruction=str(body.get("instruction") or ""),
            repo_id=str(body.get("repoId") or ""), **extra)
    except ValueError as e:
        raise _conflict(e) from e
    return await workflow_engine.run_api(session, run)


@router.post("/plugin-runs/{run_id}/recover-artifacts")
async def client_recover_artifacts(
    run_id: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Recover outputs from a failed or interrupted AI node without rerunning a completed session.

    """
    import asyncio

    from ..services import ai_exec
    run = await session.get(am.WorkflowRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="插件运行不存在")
    task = await _owned_task(session, client, run.task_id)
    nodes = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == run.id, am.NodeRun.node_type == "ai"
    ).order_by(am.NodeRun.created_at.desc()))).scalars().all())
    ctx = await ai_exec.load(session)
    attempts = []
    for node in nodes:
        executor = dict(node.executor or {})
        ref, runner_id = workflow_engine._restore_ai_route(executor)
        if not ref:
            continue
        status = await asyncio.to_thread(ai_exec.status_sync, ctx, ref)
        item = {"nodeId": node.id, "node": node.node_key, "attempt": node.attempt,
                "ref": ref, "runnerId": runner_id, "statusOk": bool(status.get("ok")),
                "done": bool(status.get("done")), "error": str(status.get("error") or "")[:240]}
        if status.get("ok") and status.get("done") and _has_recoverable_output(status):
            pulled = await ai_exec.pull_artifacts(
                session, task.id, ctx, status, ref, settle=False)
            item["pulled"] = pulled
            attempts.append(item)
            if not pulled.get("missing"):
                recovered = await workflow_engine.recover_ai_output(
                    session, run, task, node, status, pulled,
                    actor=str(client.user_ref or client.id))
                return {"ok": True, "recoveredFrom": item, "attempts": attempts,
                        "resumed": True, "recoveredNode": workflow_engine.node_api(recovered),
                        "run": await workflow_engine.run_api(session, run)}
        else:
            attempts.append(item)
    raise HTTPException(status_code=409, detail={
        "message": "历史 AI 会话里没有可完整取回的产出",
        "attempts": attempts,
    })


def _has_recoverable_output(status: dict) -> bool:
    """Files and repository commits are both first-class recoverable deliveries."""
    return bool(status.get("attachments") or status.get("artifactUrl")
                or status.get("gitHead"))


@router.post("/plugin-runs/{run_id}/retry-quality")
async def client_retry_quality(
    run_id: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Retry an exhausted quality gate without rerunning completed AI or approvals."""
    run = await session.get(am.WorkflowRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="插件运行不存在")
    await _owned_task(session, client, run.task_id)
    try:
        node = await workflow_engine.retry_failed_quality(
            session, run, actor=str(client.user_ref or client.id))
    except ValueError as e:
        raise _conflict(e) from e
    return {"ok": True, "node": workflow_engine.node_api(node),
            "run": await workflow_engine.run_api(session, run)}


@router.post("/plugin-runs/{run_id}/retry-gate")
async def client_retry_gate(
    run_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Retry a technical gate failure, without bypassing a real human decision."""
    run = await session.get(am.WorkflowRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="插件运行不存在")
    await _owned_task(session, client, run.task_id)
    try:
        node = await workflow_engine.retry_failed_gate(
            session, run, actor=str(client.user_ref or client.id),
            node_key=str(body.get("nodeKey") or ""),
            execution=dict(body.get("execution") or {}) or None,
            resume_rework=bool(body.get("resumeRework")))
    except ValueError as e:
        raise _conflict(e) from e
    return {"ok": True, "node": workflow_engine.node_api(node),
            "run": await workflow_engine.run_api(session, run)}


@router.post("/plugin-runs/{run_id}/redispatch")
async def client_redispatch_gate(
    run_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_ai_client),
    session: AsyncSession = Depends(get_session),
):
    """Technical contract for client redispatch gate."""
    run = await session.get(am.WorkflowRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="插件运行不存在")
    await _owned_task(session, client, run.task_id)
    try:
        node = await workflow_engine.redispatch_running_gate(
            session, run, actor=str(client.user_ref or client.id),
            node_key=str(body.get("nodeKey") or ""),
            execution=dict(body.get("execution") or {}) or None)
    except ValueError as e:
        raise _conflict(e) from e
    return {"ok": True, "node": workflow_engine.node_api(node),
            "run": await workflow_engine.run_api(session, run)}
