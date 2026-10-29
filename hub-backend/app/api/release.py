"""Administrative delivery review, merge approval, and explicit merge commands."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..db import get_session
from ..deps import current_user, require_perm
from ..models import Task, User
from ..services import audit, code_delivery, deployments, release_control, workflow_engine
from .scope import task_or_404, visible_clients

router = APIRouter(prefix="/api/v1/admin/releases", tags=["release"])


def _decision_error(out: dict) -> HTTPException:
    reason = out.get("reason")
    status = 403 if reason == "forbidden" else 409
    text = {
        "stale": "候选版本已经变化，请刷新后重新审批",
        "resolved": "这项审批已经处理过了",
        "duplicate": "你已经对这项审批做过决定",
        "decision": "决定只能是 approve 或 reject",
        "note": "退回时请写清楚需要修改的地方",
        "forbidden": out.get("detail") or "没有审批权限",
    }.get(reason, out.get("detail") or "审批没有生效")
    return HTTPException(status_code=status, detail=text)


@router.get("/pending")
async def pending(
    user: User = Depends(require_perm("release.approve")),
    session: AsyncSession = Depends(get_session),
):
    items = await release_control.list_pending(session, user)
    visible = await visible_clients(session, user)
    if visible is None:
        return {"items": items}
    task_ids = {x["task"]["id"] for x in items}
    rows = (await session.execute(select(Task.id, Task.owner_client_id).where(
        Task.id.in_(task_ids or {"__none__"})))).all()
    allowed = {tid for tid, cid in rows if cid in visible}
    return {"items": [x for x in items if x["task"]["id"] in allowed]}


@router.get("/tasks/{tid}")
async def task_release(
    tid: str,
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    await task_or_404(session, user, tid)
    runs = await workflow_engine.list_runs(session, task_id=tid, limit=10)
    current_workflow = None
    if runs:
        run = await session.get(am.WorkflowRun, runs[0]["id"])
        if run is not None:
            current_workflow = await workflow_engine.run_api(session, run)
    return {**await release_control.view(session, tid),
            "deployments": await deployments.list_runs(session, tid),
            "workflowRuns": runs, "workflow": current_workflow}


@router.post("/tasks/{tid}/decisions")
async def decide(
    tid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("release.approve")),
    session: AsyncSession = Depends(get_session),
):
    task = await task_or_404(session, user, tid)
    action = str(body.get("action") or "").strip().lower()
    if action not in ("merge", "deploy"):
        raise HTTPException(status_code=400, detail="管理端只能审批代码合并或环境发布")
    request_id = str(body.get("requestId") or "")
    if request_id:
        req = await session.get(am.ApprovalRequest, request_id)
        if req is None or req.task_id != tid or req.action != action:
            raise HTTPException(status_code=409, detail="审批项已变化，请刷新后再操作")
    out = await release_control.decide(
        session, task, user, action=action,
        decision=str(body.get("decision") or ""), note=str(body.get("note") or ""),
        artifact_version_id=str(body.get("artifactVersionId") or ""),
        environment_id=str(body.get("environmentId") or ""),
    )
    if not out.get("ok"):
        raise _decision_error(out)
    await audit.log(session, user, f"release.{action}_{body.get('decision')}",
                    "task", tid, task.title,
                    {"artifactVersionId": body.get("artifactVersionId") or "",
                     "environmentId": body.get("environmentId") or ""})
    return out


@router.post("/tasks/{tid}/merge")
async def merge(
    tid: str,
    user: User = Depends(require_perm("release.approve")),
    session: AsyncSession = Depends(get_session),
):
    task = await task_or_404(session, user, tid)
    who = user.display_name or user.username
    out = await code_delivery.merge_approved(session, task, who=who)
    if not out.get("ok"):
        raise HTTPException(status_code=409, detail=out.get("error") or "当前版本尚未获准合并")
    await audit.log(session, user, "release.merge_execute", "task", tid, task.title,
                    {"commit": out.get("commit") or "", "target": out.get("target") or ""})
    return {**out, "release": await release_control.view(session, tid)}


@router.get("/deployments")
async def deployment_runs(
    taskId: str = "",
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    if taskId:
        await task_or_404(session, user, taskId)
        return {"items": await deployments.list_runs(session, taskId)}
    visible = await visible_clients(session, user)
    if visible is None:
        return {"items": await deployments.list_runs(session)}
    task_ids = set((await session.execute(select(Task.id).where(
        Task.owner_client_id.in_(visible or {"__none__"})))).scalars().all())
    return {"items": await deployments.list_runs(session, task_ids=task_ids)}


@router.post("/tasks/{tid}/environments/{environment_id}/deploy")
async def deploy(
    tid: str,
    environment_id: str,
    user: User = Depends(require_perm("release.approve")),
    session: AsyncSession = Depends(get_session),
):
    task = await task_or_404(session, user, tid)
    out = await deployments.request_environment(
        session, task, environment_id, user.display_name or user.username)
    if not out.get("ok"):
        raise HTTPException(status_code=409, detail=out.get("error") or "没能进入这个环境")
    await audit.log(session, user, "release.deploy_request", "task", tid, task.title,
                    {"environmentId": environment_id,
                     "pendingApproval": bool(out.get("pendingApproval"))})
    return out
