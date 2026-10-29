"""Professional profiles and work scenarios support recommendations and enterprise configuration.
Profiles do not grant permissions; scenarios do not select executors.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..db import get_session
from ..deps import current_client, require_perm
from ..services import audit, plugin_service, rbac, work_catalog

router = APIRouter(prefix="/api/v1/work-catalog", tags=["work-catalog"])
admin_router = APIRouter(
    prefix="/api/v1/admin/work-catalog", tags=["admin-work-catalog"])


async def _employee(
    session: AsyncSession, client: models.Client
) -> models.User:
    user = await session.get(
        models.User, client.user_ref) if client.user_ref else None
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=400,
            detail="本 SoduWork 尚未绑定有效员工，请让管理员分配归属")
    return user


async def _target_org(
    session: AsyncSession, user: models.User, offered: str | None
) -> str:
    target = str(offered or user.org_id or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="请先选择要配置的组织")
    if user.is_super:
        if await session.get(models.OrgUnit, target) is None:
            raise HTTPException(status_code=404, detail="组织不存在")
        return target
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None and target not in scope:
        raise HTTPException(status_code=403, detail="只能配置自己管辖的组织")
    return target


def _value_error(error: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(error))


@router.get("")
async def my_catalog(
    client: models.Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    user = await _employee(session, client)
    return await work_catalog.catalog_for_user(
        session, user.org_id, user.positions or [])


@router.post("/recommend")
async def recommend(
    body: dict = Body(default_factory=dict),
    client: models.Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    user = await _employee(session, client)
    return await work_catalog.recommend(
        session,
        str(body.get("text") or "")[:6000],
        user.org_id,
        user.positions or [],
        explicit_key=str(body.get("scenarioKey") or ""),
        project_id=str(body.get("projectId") or ""),
    )


@admin_router.get("")
async def admin_catalog(
    org_id: str = Query(default="", alias="orgId"),
    user: models.User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    target = await _target_org(session, user, org_id)
    catalog = await work_catalog.catalog_for_user(
        session, target, [], include_disabled=True)
    chain = await work_catalog._org_chain(session, target)
    plugins = await plugin_service.list_plugins(session, set(chain))
    plugins = work_catalog.effective_plugin_options(plugins, chain)
    catalog.update({
        "targetOrgId": target,
        "workflows": [{
            "key": row.get("key") or "",
            "name": row.get("name") or row.get("key") or "",
            "description": row.get("description") or "",
            "enabled": bool(row.get("enabled")),
        } for row in plugins if row.get("key")],
    })
    return catalog


@admin_router.post("/professions")
async def create_profession(
    body: dict = Body(default_factory=dict),
    user: models.User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    target = await _target_org(session, user, body.get("orgId"))
    try:
        row = await work_catalog.save_profession(session, body, target)
    except ValueError as error:
        raise _value_error(error) from error
    result = work_catalog.profession_api(row)
    await audit.log(session, user, "profession.create", "position",
                    row.id, row.name, {"orgId": target})
    return result


@admin_router.patch("/professions/{profession_id}")
async def update_profession(
    profession_id: str,
    body: dict = Body(default_factory=dict),
    user: models.User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(models.Position, profession_id)
    if row is None:
        raise HTTPException(status_code=404, detail="职业画像不存在")
    if row.is_system or row.org_id is None:
        raise HTTPException(status_code=400, detail="平台职业是只读基线，请新建企业职业")
    await _target_org(session, user, row.org_id)
    try:
        row = await work_catalog.save_profession(
            session, body, row.org_id, row)
    except ValueError as error:
        raise _value_error(error) from error
    result = work_catalog.profession_api(row)
    await audit.log(session, user, "profession.update", "position",
                    row.id, row.name, {"fields": sorted(body)})
    return result


@admin_router.delete("/professions/{profession_id}")
async def delete_profession(
    profession_id: str,
    user: models.User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(models.Position, profession_id)
    if row is None:
        raise HTTPException(status_code=404, detail="职业画像不存在")
    if row.org_id:
        await _target_org(session, user, row.org_id)
    reason = await work_catalog.delete_profession(session, row)
    if reason:
        raise HTTPException(status_code=400, detail=reason)
    await audit.log(session, user, "profession.delete", "position",
                    profession_id, row.name, {})
    return {"ok": True}


@admin_router.post("/scenarios")
async def create_scenario(
    body: dict = Body(default_factory=dict),
    user: models.User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    target = await _target_org(session, user, body.get("orgId"))
    try:
        row = await work_catalog.save_scenario(session, body, target)
    except ValueError as error:
        raise _value_error(error) from error
    result = work_catalog.scenario_api(row)
    await audit.log(session, user, "work_scenario.create", "work_scenario",
                    row.id, row.name, {"orgId": target, "key": row.key})
    return result


@admin_router.patch("/scenarios/{scenario_id}")
async def update_scenario(
    scenario_id: str,
    body: dict = Body(default_factory=dict),
    user: models.User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(models.WorkScenario, scenario_id)
    if row is None:
        raise HTTPException(status_code=404, detail="工作场景不存在")
    if row.is_system or row.org_id is None:
        raise HTTPException(status_code=400, detail="平台场景是只读基线，请创建企业覆盖版本")
    await _target_org(session, user, row.org_id)
    try:
        row = await work_catalog.save_scenario(
            session, body, row.org_id, row)
    except ValueError as error:
        raise _value_error(error) from error
    result = work_catalog.scenario_api(row)
    await audit.log(session, user, "work_scenario.update", "work_scenario",
                    row.id, row.name, {"fields": sorted(body)})
    return result


@admin_router.delete("/scenarios/{scenario_id}")
async def delete_scenario(
    scenario_id: str,
    user: models.User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(models.WorkScenario, scenario_id)
    if row is None:
        raise HTTPException(status_code=404, detail="工作场景不存在")
    if row.is_system or row.org_id is None:
        raise HTTPException(status_code=400, detail="平台场景不能删除")
    await _target_org(session, user, row.org_id)
    name = row.name
    await session.delete(row)
    await session.commit()
    await audit.log(session, user, "work_scenario.delete", "work_scenario",
                    scenario_id, name, {})
    return {"ok": True}
