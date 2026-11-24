"""Classify and archive catalog records in an authorized, all-or-nothing batch."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import require_perm
from ..models import OrgUnit, Position, Project, Repo, User
from ..services import audit, rbac
from ..services.business_records import record_fields

router = APIRouter(prefix="/api/v1/admin/business-records", tags=["admin"])


class Batch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: list[str] = Field(min_length=1, max_length=200)
    action: Literal["test", "business", "archive", "restore"]
    scopeId: str = ""


async def _check_org_changes(session, ids, rows, actor, action):
    if action == "archive":
        users = select(User.id).where(User.org_id.in_(ids)).limit(1)
        children = select(OrgUnit.id).where(OrgUnit.parent_id.in_(ids),
            OrgUnit.id.not_in(ids), OrgUnit.is_archived.is_(False)).limit(1)
        if actor.org_id in ids or await session.scalar(users) or await session.scalar(children):
            raise HTTPException(409, "请先迁移部门成员或一并归档下属部门", headers={"X-Error-Code": "catalog.department.in_use"})
    elif action == "restore":
        parents = select(OrgUnit.parent_id).where(OrgUnit.id.in_(ids))
        archived_parent = select(OrgUnit.id).where(OrgUnit.id.in_(parents),
            OrgUnit.id.not_in(ids), OrgUnit.is_archived.is_(True)).limit(1)
        if await session.scalar(archived_parent):
            raise HTTPException(409, "请先恢复上级部门", headers={"X-Error-Code": "catalog.department.restore_parent"})
    elif action == "test":
        changing = [row.id for row in rows if row.data_source != "test"]
        active_children = select(OrgUnit.id).where(
            OrgUnit.parent_id.in_(changing), OrgUnit.id.not_in(ids),
            OrgUnit.is_archived.is_(False), OrgUnit.data_source != "test").limit(1)
        if changing and await session.scalar(active_children):
            raise HTTPException(409, "请将未归档的非测试下属部门一并标记为测试", headers={"X-Error-Code": "catalog.department.classify_children"})


async def _batch(session, actor, model, body):
    ids = set(body.ids)
    # The same tree lock protects department moves and user-to-department assignments.
    await rbac.lock_org_tree(session, shared=model is not OrgUnit)
    scope = await rbac.scope_org_ids(session, actor)
    if body.action == "business" and actor.is_test_account:
        raise HTTPException(403, "测试账号不能将记录标记为正式数据", headers={"X-Error-Code": "catalog.source.test_actor"})
    if model is Repo:
        parent = await session.scalar(select(Project).where(Project.id == body.scopeId).with_for_update())
        if not parent:
            raise HTTPException(404, "项目不存在")
        if scope is not None and parent.org_id and parent.org_id not in scope:
            raise HTTPException(403, "只能在自己管辖的部门内操作")
        if parent.data_source == "test" and body.action == "business":
            raise HTTPException(409, "请先核对上级记录的数据来源", headers={"X-Error-Code": "catalog.source.parent"})
    rows = list(await session.scalars(select(model).where(model.id.in_(ids)).order_by(model.id)
        .with_for_update().execution_options(populate_existing=True)))
    if len(rows) != len(ids):
        raise HTTPException(404, "所选记录已不存在", headers={"X-Error-Code": "catalog.selection.missing"})
    for row in rows:
        org_id = row.id if model is OrgUnit else row.org_id
        if scope is not None and (org_id and org_id not in scope):
            raise HTTPException(403, "只能在自己管辖的部门内操作")
        if model is Repo and row.project_id != body.scopeId:
            raise HTTPException(403, "仓库不属于所选项目", headers={"X-Error-Code": "catalog.scope.repo"})
        if model is Position and (row.is_system or not row.org_id or row.org_id != body.scopeId):
            raise HTTPException(403, "只能管理本组织创建的职业画像", headers={"X-Error-Code": "catalog.scope.profile"})
    if model is OrgUnit:
        await _check_org_changes(session, ids, rows, actor, body.action)
    if body.action == "business" and model in (OrgUnit, Position, Project):
        if model is OrgUnit:
            parents = {row.parent_id for row in rows} - ids
        else:
            parents = {row.org_id for row in rows}
        if await session.scalar(select(OrgUnit.id).where(OrgUnit.id.in_(parents),
                OrgUnit.data_source == "test").limit(1)):
            raise HTTPException(409, "请先核对上级记录的数据来源", headers={"X-Error-Code": "catalog.source.parent"})
    changed = 0
    for row in rows:
        before = record_fields(row)
        if body.action in ("archive", "restore"):
            row.is_archived = body.action == "archive"
        else:
            row.data_source = body.action
        after = record_fields(row)
        if after != before:
            audit.add(session, actor, "catalog." + body.action, model.__tablename__, row.id, row.name,
                      {"before": before, "after": after})
            changed += 1
    await session.commit()
    return {"changed": changed}


@router.post("/projects")
async def projects(body: Batch, user: User = Depends(require_perm("task.dispatch")),
                   session: AsyncSession = Depends(get_session)):
    return await _batch(session, user, Project, body)


@router.post("/repositories")
async def repositories(body: Batch, user: User = Depends(require_perm("task.dispatch")),
                       session: AsyncSession = Depends(get_session)):
    return await _batch(session, user, Repo, body)


@router.post("/orgs")
async def orgs(body: Batch, user: User = Depends(require_perm("org.manage")),
               session: AsyncSession = Depends(get_session)):
    return await _batch(session, user, OrgUnit, body)


@router.post("/professions")
async def professions(body: Batch, user: User = Depends(require_perm("work.catalog.manage")),
                      session: AsyncSession = Depends(get_session)):
    return await _batch(session, user, Position, body)
