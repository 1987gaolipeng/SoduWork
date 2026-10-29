"""Scoped summary memory endpoints.

The client router serves owned records and one read-only context for the
bound user's current organization. Organization edits require management auth.
"""
from fastapi import APIRouter, Body, Depends, Query, Response

from .. import models
from ..db import get_session
from ..deps import current_client, require_perm
from ..services import audit, memory_records as svc

router = APIRouter(prefix="/api/v1/memories", tags=["memory-records"])
admin_router = APIRouter(prefix="/api/v1/admin/org-memory", tags=["admin-org-memory"])


@router.get("")
async def listing(
    scope: str = Query("", max_length=16),
    workspace_key: str = Query("", alias="workspaceKey", max_length=240),
    project_key: str = Query("", alias="projectKey", max_length=240),
    archived: bool = Query(False), offset: int = Query(0, ge=0),
    search: str = Query("", max_length=120),
    client=Depends(current_client), session=Depends(get_session),
):
    return await svc.listing(session, client, scope, workspace_key, project_key, archived, offset, search)


@router.post("")
async def create(body: svc.MemoryWrite, client=Depends(current_client), session=Depends(get_session)):
    return await svc.create(session, client, body)


@router.get("/organization-context")
async def organization_context(response: Response, client=Depends(current_client), session=Depends(get_session)):
    from ..services import org_memory
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Vary"] = "Authorization"
    value = await org_memory.for_client(session, client)
    await session.commit()
    return value


@router.get("/{rid}")
async def detail(rid: str, client=Depends(current_client), session=Depends(get_session)):
    return {"ok": True, "item": svc.view(await svc.get(session, client, rid), True)}


@router.put("/{rid}")
async def edit(rid: str, body: svc.MemoryPatch, client=Depends(current_client), session=Depends(get_session)):
    return await svc.edit(session, client, rid, body)


@router.delete("/{rid}")
async def delete(rid: str, client=Depends(current_client), session=Depends(get_session)):
    return await svc.delete(session, client, rid)


@router.post("/{rid}/archive")
async def archive(rid: str, client=Depends(current_client), session=Depends(get_session)):
    return await svc.archive(session, client, rid, True)


@router.post("/{rid}/restore")
async def restore(rid: str, client=Depends(current_client), session=Depends(get_session)):
    return await svc.archive(session, client, rid, False)


@router.post("/context")
async def context(body: dict = Body(default_factory=dict), client=Depends(current_client), session=Depends(get_session)):
    return await svc.context(session, client, body.get("scopes") or [], body.get("ids") or [])


@admin_router.get("")
async def org_listing(
    org_id: str = Query("", alias="orgId", max_length=36),
    archived: bool = Query(False), offset: int = Query(0, ge=0),
    user: models.User = Depends(require_perm("org.manage")), session=Depends(get_session),
):
    return await svc.org_listing(session, user, org_id, archived, offset)


@admin_router.get("/{rid}")
async def org_detail(rid: str, user: models.User = Depends(require_perm("org.manage")), session=Depends(get_session)):
    return {"ok": True, "item": svc._admin_view(await svc.org_get(session, user, rid))}


@admin_router.post("")
async def org_create(body: dict = Body(default_factory=dict), user: models.User = Depends(require_perm("org.manage")), session=Depends(get_session)):
    result = await svc.org_create(session, user, body)
    item = result["item"]
    await audit.log(session, user, "org_memory.create", "org_memory", item["id"],
                    detail={"orgId": item["orgId"], "revision": item["revision"]})
    return result


@admin_router.put("/{rid}")
async def org_edit(rid: str, body: dict = Body(default_factory=dict), user: models.User = Depends(require_perm("org.manage")), session=Depends(get_session)):
    result = await svc.org_edit(session, user, rid, body)
    item = result["item"]
    await audit.log(session, user, "org_memory.update", "org_memory", rid,
                    detail={"orgId": item["orgId"], "revision": item["revision"]})
    return result


@admin_router.delete("/{rid}")
async def org_delete(rid: str, user: models.User = Depends(require_perm("org.manage")), session=Depends(get_session)):
    result = await svc.org_delete(session, user, rid)
    await audit.log(session, user, "org_memory.delete", "org_memory", rid)
    return result
