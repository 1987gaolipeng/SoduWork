"""Shared task cards, detailed traces, and manual handoff APIs for clients and administrators. Keep
list cards lightweight; fetch full workflow, evidence, approval, session, deployment, and
timeline details on demand.
"""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client, has_perm, require_perm
from ..models import Client, Task, User
from ..services import audit, handoff, task_access, task_trace
from .scope import task_or_404

router = APIRouter(prefix="/api/v1", tags=["task-trace"])
admin_router = APIRouter(prefix="/api/v1/admin", tags=["task-trace"])


async def _my_task(session: AsyncSession, client: Client, tid: str) -> Task:
    task = await session.get(Task, tid, with_for_update=True, populate_existing=True)
    if task is None or not task_access.is_owner(task, client):
        raise HTTPException(status_code=404, detail="需求不存在")
    return task


async def _guard_prestart_handoff(session: AsyncSession, task: Task, *,
                                 user_id: str = "", client_id: str = "") -> None:
    from ..services import task_requirement_projection, task_requirements

    if task_requirements.stage(task) not in {"intake", "clarifying", "ready"}:
        return
    # todo can also mean a delivery awaiting review or a stale label over live
    # execution. Keep stopping available there. Without execution, every target
    # needs the creator: default done followed by cancel must not bypass this.
    projected = {}
    await task_requirement_projection.decorate_many(session, [task], [projected])
    if (projected.get("requirementStage") not in {"intake", "clarifying", "ready"}
            or projected.get("maintenanceBlocked")):
        return
    if not await task_requirements.is_maintenance_creator(
        session, task, user_id=user_id, client_id=client_id,
    ):
        raise HTTPException(status_code=403, detail="只有创建人可以结束尚未开始的需求")


@router.get("/tasks/{tid}/card")
async def my_task_card(tid: str, client: Client = Depends(current_client),
                       session: AsyncSession = Depends(get_session)):
    return await task_trace.card(session, await task_access.view_task(session, client, tid))


@router.get("/tasks/{tid}/trace")
async def my_task_trace(tid: str, client: Client = Depends(current_client),
                        session: AsyncSession = Depends(get_session)):
    task = await task_access.view_task(session, client, tid)
    from ..services import live_view_cache

    async def _build():
        return await task_trace.trace(session, task, {
            "actorId": client.user_ref or "client:" + client.id,
            "canEvaluate": True, "canReview": True, "canApply": False,
        })

    return await live_view_cache.get_or_build("task-trace", client.id, tid, _build, ttl=3.0, actor=client)


@router.post("/tasks/{tid}/manual-handoff")
async def my_task_handoff(tid: str, body: dict = Body(default_factory=dict),
                          client: Client = Depends(current_client),
                          session: AsyncSession = Depends(get_session)):
    """Stop active workflow and AI execution, retain evidence, and hand the task to manual
    processing.
    """
    task = await _my_task(session, client, tid)
    status = str(body.get("status") or "done")
    await _guard_prestart_handoff(session, task,
                                  user_id=str(client.user_ref or ""), client_id=client.id)
    try:
        return await handoff.to_human(
            session, task, status=status,
            note=str(body.get("note") or ""), actor=str(client.user_ref or client.id))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


@admin_router.post("/tasks/{tid}/handoff")
async def admin_task_handoff(tid: str, body: dict = Body(default_factory=dict),
                             user: User = Depends(require_perm("task.dispatch")),
                             session: AsyncSession = Depends(get_session)):
    await session.get(Task, tid, with_for_update=True, populate_existing=True)
    task = await task_or_404(session, user, tid)
    status = str(body.get("status") or "done")
    await _guard_prestart_handoff(session, task, user_id=user.id)
    try:
        result = await handoff.to_human(
            session, task, status=status,
            note=str(body.get("note") or ""),
            actor=user.display_name or user.username)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    await audit.log(session, user, "task.handoff", "task", tid, task.title,
                    {"status": result.get("status"), "note": str(body.get("note") or "")[:200]})
    return result


@admin_router.get("/delivery/board")
async def admin_delivery_board(user: User = Depends(require_perm("task.view")),
                               session: AsyncSession = Depends(get_session)):
    """List attention-needed, active, and recently completed delivery work within task visibility
    scope.
    """
    from ..services import delivery_board
    from .scope import visible_clients

    visible = await visible_clients(session, user)
    task_ids = None
    if visible is not None:
        task_ids = set((await session.execute(select(Task.id).where(
            Task.owner_client_id.in_(visible or {"__none__"})))).scalars().all())
    return await delivery_board.board(session, task_ids=task_ids)


@admin_router.get("/tasks/{tid}/rollback")
async def admin_rollback_plan(tid: str, user: User = Depends(require_perm("task.view")),
                              session: AsyncSession = Depends(get_session)):
    """Read the environment's deployed version and available rollback target without changing
    deployment state.
    """
    from ..services import rollback

    task = await task_or_404(session, user, tid)
    published = await rollback.latest_published(session, task.id)
    if not published:
        return {"ok": False, "why": "这条需求没有发布记录"}
    return await rollback.plan(session, task, published)


@admin_router.post("/tasks/{tid}/rollback")
async def admin_rollback(tid: str, body: dict = Body(default_factory=dict),
                         user: User = Depends(require_perm("release.approve")),
                         session: AsyncSession = Depends(get_session)):
    """Explicitly roll back deployment to the caller-confirmed toVersion. Reject stale targets if
    another release changed the plan; never silently choose a different rollback version.
    """
    from ..services import rollback

    task = await task_or_404(session, user, tid)
    published = await rollback.latest_published(session, task.id)
    plan = await rollback.plan(session, task, published) if published else {"ok": False,
                                                                            "why": "这条需求没有发布记录"}
    if not plan.get("ok"):
        raise HTTPException(status_code=409, detail=plan.get("why") or "没有可回滚的版本")
    want = str(body.get("toVersion") or "").strip()
    got = str((plan.get("previous") or {}).get("version") or "")
    if want and want != got:
        raise HTTPException(status_code=409,
                            detail="要退回的版本变了（你看到的是 %s，现在是 %s），请重看一眼再点" % (want, got))
    try:
        result = await rollback.execute(session, task, plan,
                                        actor=user.display_name or user.username)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001  Preserve the CI/CD provider's error details.
        raise HTTPException(status_code=502, detail="回滚没成：" + str(e)[:300]) from e
    await audit.log(session, user, "release.rollback", "task", tid, task.title,
                    {"to": got, "customer": plan.get("customer"),
                     "environment": plan.get("environment")})
    return result


@admin_router.get("/tasks/{tid}/card")
async def admin_task_card(tid: str, user: User = Depends(require_perm("task.view")),
                          session: AsyncSession = Depends(get_session)):
    return await task_trace.card(session, await task_or_404(session, user, tid))


@admin_router.get("/tasks/{tid}/trace")
async def admin_task_trace(tid: str, user: User = Depends(require_perm("task.view")),
                           session: AsyncSession = Depends(get_session)):
    task = await task_or_404(session, user, tid)
    can_manage = has_perm(user, "plugin.manage")
    return await task_trace.trace(session, task, {
        "actorId": user.id, "canEvaluate": True,
        "canReview": can_manage, "canApply": can_manage,
    })
