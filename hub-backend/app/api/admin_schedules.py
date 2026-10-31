"""Organization-scoped automation administration and template catalog."""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import require_perm
from ..models import User
from ..services import audit, rbac
from .schedule_contract import apply_schedule_update as _sch_apply, schedule_payload

router = APIRouter()
template_router = APIRouter()


def _sch_api(s) -> dict:
    from .admin import _iso_utc_dt
    return schedule_payload(s, timestamp=_iso_utc_dt, administrative=True)


@template_router.get("/automation-templates")
async def list_automation_templates(
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Return administrator-maintained automation templates without user devices or credentials."""
    from ..services import automation_templates
    return {"items": await automation_templates.load(session)}


@template_router.put("/automation-templates")
async def save_automation_templates(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    from ..services import automation_templates
    try:
        items = await automation_templates.save(session, body.get("items", []))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await session.commit()
    await audit.log(session, user, "automation.templates.update", "setting",
                    automation_templates.SETTING_KEY, "自动化模板", {"count": len(items)})
    return {"items": items}


async def _scoped_ai_schedule(session: AsyncSession, sid: str, user: User, *, lock: bool = False):
    from ..models import AiSchedule
    if lock:
        from ..services.schedule_timing import locked_schedule
        s = await locked_schedule(session, sid)
    else:
        s = await session.get(AiSchedule, sid)
    if s is None:
        raise HTTPException(status_code=404, detail="这条定时任务不在了")
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None and s.org_id not in scope:
        raise HTTPException(status_code=404, detail="这条定时任务不在了")
    return s


@router.get("/ai-schedules")
async def list_ai_schedules(user: User = Depends(require_perm("task.dispatch")),
                            session: AsyncSession = Depends(get_session)):
    from .admin import _sch_api, _sch_apply, _scoped_ai_schedule

    from ..models import AiSchedule
    query = select(AiSchedule).order_by(AiSchedule.created_at)
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None:
        allowed = scope or {"__none__"}
        query = query.where(AiSchedule.org_id.in_(allowed))
    rows = (await session.execute(query)).scalars().all()
    return [_sch_api(s) for s in rows]


@router.post("/ai-schedules")
async def create_ai_schedule(body: dict = Body(default_factory=dict),
                             user: User = Depends(require_perm("task.dispatch")),
                             session: AsyncSession = Depends(get_session)):
    from .admin import _sch_api, _sch_apply, _scoped_ai_schedule

    from ..models import AiSchedule
    s = AiSchedule(created_by=user.id,
                   created_by_name=(user.display_name or user.username or ""),
                   org_id=user.org_id)
    from ..services.schedule_source_app import clean as clean_source_app
    try:
        s.source_app = clean_source_app(body.get("sourceApp"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _sch_apply(s, body)
    if not s.title:
        raise HTTPException(status_code=400, detail="请填任务标题")
    if not s.assignee_id:
        raise HTTPException(status_code=400, detail="请先选择执行底座")
    if not s.owner_client_id:
        raise HTTPException(status_code=400, detail="请选任务落在哪台 SoduWork 上")
    try:
        from ..services import schedules as sch
        await sch.validate_execution(
            session, s, org_ids=await rbac.scope_org_ids(session, user))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    session.add(s)
    await session.commit()
    await session.refresh(s)
    await audit.log(session, user, "schedule.create", "schedule", s.id, s.title, {})
    return _sch_api(s)


@router.put("/ai-schedules/{sid}")
async def update_ai_schedule(sid: str, body: dict = Body(default_factory=dict),
                             user: User = Depends(require_perm("task.dispatch")),
                             session: AsyncSession = Depends(get_session)):
    from .admin import _sch_api, _sch_apply, _scoped_ai_schedule

    from ..models import AiSchedule
    s = await _scoped_ai_schedule(session, sid, user, lock=True)
    from ..services.schedule_timing import owner_change_blocker
    blocker = await owner_change_blocker(session, s, body)
    if blocker:
        raise HTTPException(status_code=409, detail=blocker)
    _sch_apply(s, body)
    try:
        from ..services import schedules as sch
        await sch.validate_execution(
            session, s, org_ids=await rbac.scope_org_ids(session, user))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    await session.commit()
    await session.refresh(s)
    await audit.log(session, user, "schedule.update", "schedule", s.id, s.title, {})
    return _sch_api(s)


@router.delete("/ai-schedules/{sid}")
async def delete_ai_schedule(sid: str, user: User = Depends(require_perm("task.dispatch")),
                             session: AsyncSession = Depends(get_session)):
    from .admin import _sch_api, _sch_apply, _scoped_ai_schedule

    from ..models import AiSchedule
    s = await _scoped_ai_schedule(session, sid, user)
    await session.delete(s)
    await session.commit()
    await audit.log(session, user, "schedule.delete", "schedule", sid, s.title, {})
    return {"ok": True}


@router.get("/ai-schedules/{sid}/runs")
async def list_ai_schedule_runs(sid: str, limit: int = 20,
                                user: User = Depends(require_perm("task.dispatch")),
                                session: AsyncSession = Depends(get_session)):
    from .admin import _sch_api, _sch_apply, _scoped_ai_schedule

    from ..models import AiSchedule
    from ..services import schedules as sch
    s = await _scoped_ai_schedule(session, sid, user)
    items = await sch.list_runs(session, sid, limit=limit)
    await session.commit()
    return {"items": items}


@router.post("/ai-schedules/{sid}/run")
async def run_ai_schedule(sid: str, user: User = Depends(require_perm("task.dispatch")),
                          session: AsyncSession = Depends(get_session)):
    """Start an immediate run and return its durable tracking record."""
    from .admin import _sch_api, _sch_apply, _scoped_ai_schedule

    from ..models import AiSchedule
    from ..services import schedules as sch
    s = await _scoped_ai_schedule(session, sid, user)
    out = await sch.execute_one(
        session, s, trigger="manual",
        who=(user.display_name or user.username or "管理员"))
    await session.commit()
    if not out.get("ok"):
        raise HTTPException(status_code=502, detail="没派出去：" + str(out.get("error"))[:200])
    await audit.log(session, user, "schedule.run", "schedule", s.id, s.title,
                    {"scheduleRunId": str(out.get("scheduleRunId") or ""),
                     "conversationId": str(out.get("conversationId") or "")})
    return {"ok": True, **out, "schedule": _sch_api(s)}
