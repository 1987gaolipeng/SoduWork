"""Desktop user's private imported session memories."""
from fastapi import APIRouter, Body, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import defer

from ..db import get_session
from ..deps import current_client
from ..session_memory_models import SessionMemory
from ..services import session_memory as svc

router = APIRouter(prefix="/api/v1/session-memories", tags=["session-memory"])


@router.get("/options")
async def options(search: str = Query("", max_length=120),
                  client=Depends(current_client), session=Depends(get_session)):
    return await svc.options(session, client, search)


@router.get("")
async def listing(search: str = Query("", max_length=120), scope: str = Query("", max_length=16), archived: bool = Query(False), offset: int = Query(0, ge=0),
                  client=Depends(current_client), session=Depends(get_session)):
    user = await svc.owner(session, client)
    query = select(SessionMemory).options(defer(SessionMemory.events)).where(SessionMemory.owner_user_id == user.id)
    if search:
        query = query.where(SessionMemory.title.contains(search, autoescape=True))
    if scope:
        query = query.where(SessionMemory.scope == scope)
    if not archived:
        query = query.where(SessionMemory.archived.is_(False))
    rows = list((await session.execute(query.order_by(SessionMemory.updated_at.desc(), SessionMemory.id)
                                      .offset(offset).limit(51))).scalars())
    return {"ok": True, "items": [svc.view(r) for r in rows[:50]], "hasMore": len(rows) > 50}


@router.post("")
async def create(body: svc.MemoryImport, client=Depends(current_client), session=Depends(get_session)):
    return await svc.create(session, client, body)


@router.post("/context")
async def context(ids: list[str] = Body(embed=True),
                  client=Depends(current_client), session=Depends(get_session)):
    return await svc.context(session, client, ids)


@router.get("/{mid}")
async def detail(mid: str, client=Depends(current_client), session=Depends(get_session)):
    return {"ok": True, "item": svc.view(await svc.get(session, client, mid), True)}


@router.put("/{mid}")
async def edit(mid: str, body: svc.MemoryEdit, client=Depends(current_client), session=Depends(get_session)):
    return await svc.edit(session, client, mid, body)


@router.post("/{mid}/archive")
async def archive(mid: str, client=Depends(current_client), session=Depends(get_session)):
    return await svc.archive(session, client, mid, True)


@router.post("/{mid}/restore")
async def restore(mid: str, client=Depends(current_client), session=Depends(get_session)):
    return await svc.archive(session, client, mid, False)


@router.delete("/{mid}")
async def delete(mid: str, client=Depends(current_client), session=Depends(get_session)):
    row = await svc.get(session, client, mid)
    await session.delete(row)
    await session.commit()
    return {"ok": True}
