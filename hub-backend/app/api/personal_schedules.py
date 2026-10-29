"""Device-owned automation schedules and conversation handoff receipts."""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client
from ..models import Client
from ..services import schedule_access
from .schedule_contract import schedule_payload

router = APIRouter()


def _my_sch_api(s) -> dict:
    from .tasks import _iso_utc
    return schedule_payload(s, timestamp=_iso_utc)


async def _my_sch(session: AsyncSession, sid: str, client: Client, *, lock: bool = False):
    from ..models import AiSchedule
    if lock:
        from ..services.schedule_timing import locked_schedule
        s = await locked_schedule(session, sid)
    else:
        s = await session.get(AiSchedule, sid)
    if s is None or not schedule_access.is_owner(s, client):
        raise HTTPException(status_code=404, detail="这条定时任务不在了")
    return s


@router.get("/schedules")
async def my_schedules(client: Client = Depends(current_client),
                       session: AsyncSession = Depends(get_session)):
    from .tasks import _my_sch_api

    from sqlalchemy import select as _sel

    from ..models import AiSchedule
    rows = (await session.execute(
        _sel(AiSchedule).where(schedule_access.owner_clause(client))
        .order_by(AiSchedule.created_at))).scalars().all()
    return [_my_sch_api(s) for s in rows]


@router.get("/schedules/templates")
async def my_schedule_templates(client: Client = Depends(current_client),
                                session: AsyncSession = Depends(get_session)):
    """Return enabled organization templates for the client schedule picker."""
    from ..services import automation_templates
    return await automation_templates.enabled(session)


@router.post('/automation-conversations/inbox')
async def automation_conversation_inbox(client: Client = Depends(current_client),
                                         session: AsyncSession = Depends(get_session)):
    from ..services import schedule_conversations as conversations
    return {'items': await conversations.inbox(session, client)}


@router.post('/automation-conversations/{run_id}/claim')
async def claim_automation_conversation(run_id: str, body: dict = Body(default_factory=dict),
                                        client: Client = Depends(current_client),
                                        session: AsyncSession = Depends(get_session)):
    from ..services import schedule_conversations as conversations
    return await conversations.claim(session, client, run_id, str(body.get('instanceId') or ''))


@router.post('/automation-conversations/{run_id}/state')
async def acknowledge_automation_conversation(run_id: str, body: dict = Body(default_factory=dict),
                                              client: Client = Depends(current_client),
                                              session: AsyncSession = Depends(get_session)):
    from ..services import schedule_conversations as conversations
    return await conversations.acknowledge(session, client, run_id, body)


@router.post("/schedules/preflight")
async def preflight_my_schedule(body: dict = Body(default_factory=dict),
                                client: Client = Depends(current_client),
                                session: AsyncSession = Depends(get_session)):
    """Validate policy now and explain whether a capable Runner is online."""
    from .tasks import _my_sch

    from .schedule_contract import apply_schedule_update as _sch_apply
    from ..models import AiSchedule
    from ..services import schedules as sch

    candidate = AiSchedule()
    schedule_id = str(body.get("scheduleId") or body.get("id") or "")
    if schedule_id:
        saved = await _my_sch(session, schedule_id, client)
        candidate = AiSchedule(**{column.key: getattr(saved, column.key) for column in AiSchedule.__table__.columns})
    try:
        _sch_apply(candidate, dict(body or {}))
        candidate.owner_client_id = client.id
        return await sch.preflight_execution(session, candidate)
    except (ValueError, HTTPException) as exc:
        if isinstance(exc, HTTPException) and exc.status_code != 400:
            raise
        mode = ("plugin" if str(candidate.plugin_binding_id or "") else
                "personal" if str(candidate.personal_plugin_key or "") else "direct")
        message = str(exc.detail if isinstance(exc, HTTPException) else exc)[:240]
        return {
            "state": "blocked", "mode": mode, "message": message,
            "checks": [{"key": "configuration", "state": "blocked",
                        "label": message}],
        }


@router.post("/schedules")
async def create_my_schedule(body: dict = Body(default_factory=dict),
                             client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    from .tasks import _my_sch_api, _actor_user, _actor_label

    from .schedule_contract import apply_schedule_update as _sch_apply
    from ..models import AiSchedule
    me = await _actor_user(session, client)
    s = AiSchedule(created_by=(str(me.id) if me else None),
                   created_by_name=_actor_label(me, client),
                   org_id=(me.org_id if me else None))
    _sch_apply(s, body)
    s.owner_client_id = client.id          # Bind the schedule to the authenticated client, not a client supplied in the request.
    if not s.title:
        raise HTTPException(status_code=400, detail="请填任务标题")
    if not s.assignee_id and not s.plugin_binding_id:
        raise HTTPException(status_code=400, detail="请选把活交给谁")
    from ..services import schedules as sch
    try:
        await sch.validate_execution(session, s)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    blocker = sch.capability_save_blocker(s)
    if blocker:
        raise HTTPException(status_code=409, detail=blocker)
    session.add(s)
    await session.commit()
    await session.refresh(s)
    return _my_sch_api(s)


@router.put("/schedules/{sid}")
async def update_my_schedule(sid: str, body: dict = Body(default_factory=dict),
                             client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    from .tasks import _my_sch, _my_sch_api

    from .schedule_contract import apply_schedule_update as _sch_apply
    s = await _my_sch(session, sid, client, lock=True)
    body.pop("ownerClientId", None)        # Do not move personal schedules to another user's machine.
    _sch_apply(s, body)
    from ..services import schedules as sch
    try:
        await sch.validate_execution(session, s)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    blocker = sch.capability_save_blocker(s)
    if blocker:
        raise HTTPException(status_code=409, detail=blocker)
    await session.commit()
    await session.refresh(s)
    return _my_sch_api(s)


@router.delete("/schedules/{sid}")
async def delete_my_schedule(sid: str, client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    from .tasks import _my_sch

    s = await _my_sch(session, sid, client)
    await session.delete(s)
    await session.commit()
    return {"ok": True}


@router.get("/schedules/{sid}/runs")
async def my_schedule_runs(sid: str, limit: int = 20,
                           client: Client = Depends(current_client),
                           session: AsyncSession = Depends(get_session)):
    """List recent executions with status reconciled against authoritative task and workflow state.

    """
    from .tasks import _my_sch

    from ..services import schedules as sch
    await _my_sch(session, sid, client)
    items = await sch.list_runs(session, sid, owner_client_id=client.id,
                               owner_user_id=str(client.user_ref or ""), limit=limit)
    await session.commit()
    return {"items": items}


@router.post("/schedules/{sid}/run")
async def run_my_schedule(sid: str, client: Client = Depends(current_client),
                          session: AsyncSession = Depends(get_session)):
    """Start an immediate run and return its durable tracking record."""
    from .tasks import _my_sch

    from ..services import schedules as sch
    s = await _my_sch(session, sid, client)
    out = await sch.execute_one(session, s, trigger="manual")
    await session.commit()
    if not out.get("ok"):
        raise HTTPException(status_code=502, detail="没派出去：" + str(out.get("error"))[:200])
    return {"ok": True, **out}
