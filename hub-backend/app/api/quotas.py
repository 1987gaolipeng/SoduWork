"""Dedicated allowance management, with scoped members and audited mutations."""
import json
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import require_perm
from ..models import AppSetting, AuditLog, ModelDef, ModelProvider, User
from ..services import client_access, client_domain_events, quota_plans as qp, quota_usage, rbac
from ..services.model_runtime import lock_setting

router = APIRouter(prefix="/api/v1/admin/quotas", tags=["quotas"])


class CatalogUpdate(qp.Catalog):
    defaultLimit: StrictInt | None = Field(default=None, ge=0, le=qp.MAX_TOKENS)


class PlanPreview(BaseModel):
    revision: StrictInt = Field(ge=0)
    plan: qp.Plan


class Assignment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: StrictInt = Field(ge=0)
    catalogRevision: StrictInt | None = Field(default=None, ge=0)
    mode: Literal["inherit", "plan", "custom"]
    planId: str = Field(default="", max_length=48)
    custom: qp.Allowance | None = None


def conflict():
    return HTTPException(409, "额度配置已被其他管理员修改，请刷新后重试")


def record(session, actor, action, target, before, after):
    session.add(AuditLog(actor_id=actor.id, actor_name=actor.display_name or actor.username,
                        actor_org_id=actor.org_id, action=action, target_type="quota",
                        target_id=target, target_label="额度管理",
                        detail={"before": before, "after": after}))


async def settings_rows(session, ids=()):
    keys = [qp.CATALOG_KEY, client_access.POLICY_KEY]
    for uid in ids:
        keys.extend([qp.GRANT_PREFIX + uid, client_access.USER_QUOTA_PREFIX + uid])
    return dict((await session.execute(select(AppSetting.key, AppSetting.value).where(
        AppSetting.key.in_(keys)))).all())


async def validate_model_definitions(session, allowances):
    requested = {(m.provider, m.model) for allowance in allowances for m in allowance.models}
    if requested:
        definitions = set((await session.execute(select(ModelDef.provider_id, ModelDef.name))).all())
        if not requested.issubset(definitions):
            raise HTTPException(422, "请选择模型目录中已有的模型")


@router.get("")
async def configuration(user: User = Depends(require_perm("quota.manage")),
                        session: AsyncSession = Depends(get_session)):
    rows = await settings_rows(session)
    policy = {**client_access.DEFAULT_POLICY, **qp.parse(rows.get(client_access.POLICY_KEY))}
    models = (await session.execute(select(ModelDef, ModelProvider.name).join(
        ModelProvider, ModelDef.provider_id == ModelProvider.id).order_by(
            ModelProvider.name, ModelDef.label))).all()
    return {**qp.catalog_from(rows.get(qp.CATALOG_KEY)),
            "defaultLimit": policy["monthlyTokenLimit"] if policy["tokenLimitEnabled"] else None,
            "models": [{"provider": row.provider_id, "model": row.name,
                        "label": row.label or row.name, "providerName": name} for row, name in models]}


@router.put("")
async def save_configuration(body: CatalogUpdate,
                             user: User = Depends(require_perm("quota.manage")),
                             session: AsyncSession = Depends(get_session)):
    # The plan/model catalog is a platform-level directory: a scoped quota.manage in a
    # sub-department must not be able to rewrite it for the whole instance (#1027).
    if not user.is_super:
        raise HTTPException(status_code=403,
                            detail="平台级套餐与额度目录仅超级管理员可修改")
    row = await lock_setting(session, qp.CATALOG_KEY)
    old = qp.catalog_from(row.value)
    if old["revision"] != body.revision:
        raise conflict()
    plans = body.model_dump(exclude={"defaultLimit"})
    if {p["id"] for p in old["plans"]} - {p["id"] for p in plans["plans"]}:
        raise HTTPException(422, "已建立的套餐需要保留，避免影响已分配的成员")
    await validate_model_definitions(session, body.plans)
    plans["revision"] += 1
    row.value = json.dumps(plans, ensure_ascii=False)
    default = await lock_setting(session, client_access.POLICY_KEY)
    old_policy = {**client_access.DEFAULT_POLICY, **qp.parse(default.value)}
    default_limit = body.defaultLimit if "defaultLimit" in body.model_fields_set else (
        old_policy["monthlyTokenLimit"] if old_policy["tokenLimitEnabled"] else None)
    policy = {**old_policy, "tokenLimitEnabled": default_limit is not None,
              "monthlyTokenLimit": default_limit or 0}
    default.value = json.dumps(policy, ensure_ascii=False)
    record(session, user, "quota.catalog.update", qp.CATALOG_KEY,
           {**old, "defaultLimit": old_policy["monthlyTokenLimit"] if old_policy["tokenLimitEnabled"] else None},
           {**plans, "defaultLimit": default_limit})
    await session.commit()
    client_access._policy_cache = None
    previous = {plan["id"]: plan for plan in old["plans"]}
    changed = {plan["id"] for plan in plans["plans"]
               if plan["id"] != "trial" and plan != previous.get(plan["id"])}
    await client_domain_events.quota_changed(session, plan_ids=changed, default_changed=(
        policy["tokenLimitEnabled"] != old_policy["tokenLimitEnabled"] or
        policy["monthlyTokenLimit"] != old_policy["monthlyTokenLimit"]))
    return {**plans, "defaultLimit": default_limit}


def preview_totals(previous_limit, new_limit, *, scoped=False):
    return {"previousLimit": previous_limit, "newLimit": new_limit,
            "affectedMembers": 0, "used": 0, "remaining": None if new_limit is None else 0,
            "pausedMembers": 0, "scopeLimited": scoped}


def preview_details(status):
    return {key: status[key] for key in ("used", "remaining", "reason", "period", "models", "restrictModels")}


@router.post("/plans/preview")
async def preview_plan(body: PlanPreview, user: User = Depends(require_perm("quota.manage")),
                       session: AsyncSession = Depends(get_session)):
    catalog = await qp.catalog(session)
    if catalog["revision"] != body.revision:
        raise conflict()
    await validate_model_definitions(session, [body.plan])
    plan = body.plan.model_dump()
    old = next((p for p in catalog["plans"] if p["id"] == plan["id"]), None)
    scope = await rbac.scope_org_ids(session, user)
    result = preview_totals(old["totalLimit"] if old else None, plan["totalLimit"], scoped=scope is not None)
    if plan["id"] == "trial":
        # Existing trials keep their grant snapshot. Show a future registration's starting balance.
        return {**result, **preview_details(qp.status_from(plan, {}, {}))}
    result["modelLimitedMembers"] = 0
    if not old:
        return {**result, "remaining": 0}
    query = select(User.id, AppSetting.value).join(
        AppSetting, AppSetting.key == qp.GRANT_PREFIX + User.id).where(User.account_deleted_at.is_(None))
    if scope is not None:
        query = query.where(User.org_id.in_(scope))
    now = datetime.now(timezone.utc)
    # Grants are stored as text. Bound the ledger query and memory even on large installations.
    rows = await session.stream(query.execution_options(yield_per=400))
    async for batch in rows.partitions(400):
        ids = []
        for uid, value in batch:
            grant = qp.parse(value)
            if grant.get("mode") == "plan" and grant.get("planId") == plan["id"]:
                ids.append(uid)
        usage = await quota_usage.totals(session, ids, now=now)
        for uid in ids:
            status = qp.status_from(plan, {}, usage.get(uid, {}), now=now)
            result["affectedMembers"] += 1
            result["used"] += status["used"]
            if result["remaining"] is not None:
                result["remaining"] += status["remaining"]
            result["pausedMembers"] += int(status["exceeded"])
            if not status["exceeded"] and any(row["exceeded"] for row in status["models"]):
                result["modelLimitedMembers"] += 1
    if not result["affectedMembers"]:
        result["remaining"] = 0
    return result


@router.get("/members")
async def members(q: str = Query(default="", max_length=100),
                  offset: int = Query(default=0, ge=0), limit: int = Query(default=50, ge=1, le=100),
                  user: User = Depends(require_perm("quota.manage")),
                  session: AsyncSession = Depends(get_session)):
    scope = await rbac.scope_org_ids(session, user)
    filters = [User.account_deleted_at.is_(None)]
    if scope is not None:
        filters.append(User.org_id.in_(scope or {"__none__"}))
    if q.strip():
        # Escape wildcards so a user name search remains literal and bounded.
        match = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        filters.append(or_(User.username.ilike(match, escape="\\"), User.display_name.ilike(match, escape="\\")))
    total = await session.scalar(select(func.count()).select_from(User).where(*filters))
    users = list((await session.scalars(select(User).where(*filters).order_by(
        User.created_at, User.id).offset(offset).limit(limit))).all())
    return {"total": total, "items": await member_items(session, users), "offset": offset, "limit": limit}


async def member_items(session, users):
    rows = await settings_rows(session, [u.id for u in users])
    plans = qp.catalog_from(rows.get(qp.CATALOG_KEY))
    policies = {}
    grants = {}
    for member in users:
        grant = qp.parse(rows.get(qp.GRANT_PREFIX + member.id))
        grants[member.id] = grant
        policies[member.id] = qp.effective(grant, plans)
    monthly_ids = [u.id for u in users if not policies[u.id] or policies[u.id]["period"] != "once"]
    trial_ids = [u.id for u in users if policies[u.id] and policies[u.id]["period"] == "once"]
    usage = await quota_usage.totals(session, monthly_ids)
    usage.update(await quota_usage.totals(session, trial_ids, monthly=False))
    global_policy = {**client_access.DEFAULT_POLICY, **qp.parse(rows.get(client_access.POLICY_KEY))}
    items = []
    for member in users:
        grant, policy = grants[member.id], policies[member.id]
        override = client_access.user_quota(qp.parse(rows.get(client_access.USER_QUOTA_PREFIX + member.id)))
        if not policy:
            policy = legacy_policy(override, global_policy)
            status_grant = {"mode": override["mode"]}
        else:
            status_grant = grant
        status = qp.status_from(policy, status_grant, usage.get(member.id, {}))
        items.append({"id": member.id, "username": member.username, "displayName": member.display_name,
                      "isActive": member.is_active, "quota": status, "legacyOverride": override,
                      "assignment": {"revision": grant.get("revision", 0),
                                     "mode": grant.get("mode", "inherit"), "planId": grant.get("planId", ""),
                                     "custom": grant.get("custom"), "hasTrial": bool(grant.get("trial"))}})
    return items


def legacy_policy(override, global_policy):
    enabled = override["mode"] == "limited" or (override["mode"] == "inherit" and global_policy["tokenLimitEnabled"])
    cap = override["limit"] if override["mode"] == "limited" else global_policy["monthlyTokenLimit"]
    return {"id": "legacy", "name": "原有额度", "period": "monthly", "totalLimit": cap if enabled else None}


async def managed_member(session, user, uid, *, lock=False):
    member = await session.get(User, uid, with_for_update=lock, populate_existing=lock)
    if member is None or member.account_deleted_at:
        raise HTTPException(404, "用户不存在")
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None and member.org_id not in scope:
        raise HTTPException(403, "只能管理自己管辖部门的额度")
    return member


@router.get("/members/{uid}")
async def member_detail(uid: str, user: User = Depends(require_perm("quota.manage")),
                        session: AsyncSession = Depends(get_session)):
    member = await managed_member(session, user, uid)
    return (await member_items(session, [member]))[0]


async def proposed_grant(session, body, old, plans=None):
    if old.get("revision", 0) != body.revision:
        raise conflict()
    if body.catalogRevision is not None and plans["revision"] != body.catalogRevision:
        raise conflict()
    grant = {"mode": body.mode, "revision": body.revision + 1}
    if old.get("trial"):
        grant["trial"] = old["trial"]
    if body.mode == "plan":
        plans = plans if plans is not None else await qp.catalog(session)
        if not any(p["id"] == body.planId for p in plans["plans"]):
            raise HTTPException(422, "请选择有效套餐")
        if body.planId == "trial" and not grant.get("trial"):
            raise HTTPException(422, "一次性试用仅在新用户注册时发放")
        grant["planId"] = body.planId
    if body.mode == "custom":
        if body.custom is None:
            raise HTTPException(422, "请填写个人额度")
        await validate_model_definitions(session, [body.custom])
        grant["custom"] = body.custom.model_dump()
    return grant


@router.post("/members/{uid}/preview")
async def preview_member(uid: str, body: Assignment, user: User = Depends(require_perm("quota.manage")),
                         session: AsyncSession = Depends(get_session)):
    await managed_member(session, user, uid)
    rows = await settings_rows(session, [uid])
    old = qp.parse(rows.get(qp.GRANT_PREFIX + uid))
    plans = qp.catalog_from(rows.get(qp.CATALOG_KEY))
    grant = await proposed_grant(session, body, old, plans)
    fallback = legacy_policy(client_access.user_quota(qp.parse(rows.get(client_access.USER_QUOTA_PREFIX + uid))),
                             {**client_access.DEFAULT_POLICY, **qp.parse(rows.get(client_access.POLICY_KEY))})
    previous = qp.effective(old, plans) or fallback
    policy = qp.effective(grant, plans) or fallback
    now = datetime.now(timezone.utc)
    usage = await quota_usage.totals(session, [uid], monthly=policy["period"] != "once", now=now)
    status = qp.status_from(policy, grant, usage.get(uid, {}), now=now)
    return {**preview_totals(previous["totalLimit"], policy["totalLimit"]), **preview_details(status),
            "affectedMembers": 1, "pausedMembers": int(status["exceeded"])}


@router.put("/members/{uid}")
async def assign(uid: str, body: Assignment, user: User = Depends(require_perm("quota.manage")),
                 session: AsyncSession = Depends(get_session)):
    # Lock the account even when its first grant does not exist yet.
    await managed_member(session, user, uid, lock=True)
    row = await lock_setting(session, qp.GRANT_PREFIX + uid)
    old = qp.parse(row.value)
    plans = None
    if body.catalogRevision is not None:
        # Serialize the reviewed catalog revision with concurrent catalog saves, including first use.
        plans = qp.catalog_from((await lock_setting(session, qp.CATALOG_KEY)).value)
    grant = await proposed_grant(session, body, old, plans)
    row.value = json.dumps(grant, ensure_ascii=False)
    record(session, user, "quota.member.assign", uid, old, grant)
    await session.commit()
    await client_domain_events.quota_changed(session, uid)
    return {"ok": True, "revision": grant["revision"]}
