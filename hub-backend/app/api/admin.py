"""Administrative APIs for authentication, RBAC, organizational scope, tasks, integrations, and
device management. Superusers see all records; other users see their department subtree and
unassigned devices. Client.user_ref determines device ownership.
"""
import hashlib
import logging
import uuid
from datetime import date as calendar_date
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import (
    APIRouter,
    Body,
    Depends,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import StreamingResponse
from pydantic import AwareDatetime
from sqlalchemy import case, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import sign_token, verify_claims, verify_password
from ..config import get_settings
from ..csv_export import csv_chunks
from ..db import get_session
from ..deps import current_user, has_perm, require_any_perm, require_perm
from ..models import Attachment, Client, Role, Task, TaskEvent, User
from ..pagination import PageQuery
from ..permissions import ALL_KEYS, PERMISSIONS
from ..realtime import hub
from ..schemas import (
    AdminLogin,
    AssignBody,
    AssignUserBody,
    BindingCreate,
    ClientPairBody,
    DispatchCreate,
    IntegrationCreate,
    IntegrationUpdate,
    OrgCreate,
    OrgUpdate,
    RoleCreate,
    RoleUpdate,
    UserBatchUpdate,
    UserCreate,
    UserUpdate,
    attachment_role,
    attachment_to_api,
    client_to_api,
    task_to_api,
)
from ..services import aggregation as agg
from ..services import (
    audit,
    client_access,
    device_auth,
    device_connections,
    email_auth,
    poller,
    rbac,
    receipts,
    repository_catalog,
    storage,
    work_catalog,
)
from ..services import environment_service as environment_service
from ..services import inbox as inbox_svc
from ..services import tasks as svc
from ..services.catalog_names import DuplicateName
from ..services.task_access import publish_owner
from ..timestamps import iso_utc
from .first_chat import REPORT_KEY
from .input_validation import parse_integer
from .scope import integration_target_org, require_integration_org
from .scope import require_existing_org as _require_existing_org

log = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/api/v1/admin", tags=["admin"])
settings = get_settings()

# Device-owned model settings and first-chat reports stay out of generic
# administrative device reads and patches.
_CLIENT_PRIVATE_CONFIG_KEYS = frozenset(("modelProviders", REPORT_KEY))


def _admin_client_config(value) -> dict:
    """Return the administrative configuration view without client-local model data."""
    config = dict(value or {}) if isinstance(value, dict) else {}
    for key in _CLIENT_PRIVATE_CONFIG_KEYS:
        config.pop(key, None)
    return config


# Authentication and current user.

async def _me_payload(session: AsyncSession, user: User) -> dict:
    if user.is_super:
        perms = list(ALL_KEYS)
    elif user.role_id:
        r = await session.get(Role, user.role_id)
        perms = list(r.permissions or []) if r else []
    else:
        perms = []
    d = rbac.user_to_api(user)
    d["permissions"] = perms
    return d


@router.post("/login")
async def login(body: AdminLogin, request: Request, session: AsyncSession = Depends(get_session)):
    user = await client_access.find_login_user(session, body.user, legacy_lookup=rbac.get_user_by_username)
    # Verified email and legacy username can identify the same account.
    account = "id:" + user.id if user is not None else "name:" + body.user.strip().casefold()
    peer = request.client.host if request.client else "unknown"
    async with session.begin_nested() as reservation:
        try:
            await email_auth.reserve_admin_login(session, account, peer)
        except client_access.ClientAccessError as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc),
                                headers={"Retry-After": str(exc.meta["retryAfter"])}) from exc
        valid_password = bool(user and not user.account_deleted_at and verify_password(body.pw, user.password_hash))
        authenticated = valid_password and user.is_active
        if authenticated:
            # Only failed attempts consume the account and peer budgets.
            await reservation.rollback()
        else:
            audit.add(session, None, "admin.login.failed", "user", user.id if user else None)
    if not authenticated:
        await session.commit()
        if valid_password:
            raise HTTPException(status_code=403, detail="账号已停用")
        raise HTTPException(status_code=401, detail="账号或密码不正确")
    user.last_login_at = datetime.now(timezone.utc)
    await session.commit()
    return {"token": sign_token(user.id, user.auth_version),
            "user": await _me_payload(session, user)}


@router.get("/me")
async def me(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await _me_payload(session, user)


@router.get("/permissions", dependencies=[Depends(require_perm("role.manage"))])
async def permissions():
    return PERMISSIONS


# Visibility scope helpers.

async def _client_scope(session: AsyncSession, user: User):
    """Restrict devices to scoped owners plus unassigned devices in the query itself."""
    orgs = await rbac.scope_org_ids(session, user)
    if orgs is None:
        return ()
    owners = select(User.id).where(User.org_id.in_(orgs)).correlate(None)
    return (or_(Client.user_ref.is_(None), Client.user_ref.in_(owners)),)


async def _visible_client_ids(session: AsyncSession, user: User) -> set[str] | None:
    scope = await _client_scope(session, user)
    if not scope:
        return None
    return set(await session.scalars(select(Client.id).where(*scope)))


async def _assert_org_in_scope(session: AsyncSession, user: User, org_id: str | None):
    if user.is_super or not org_id:
        return
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None and org_id not in scope:
        raise HTTPException(status_code=403, detail="只能在自己管辖的部门内操作")


async def _assert_user_in_scope(session: AsyncSession, user: User, target: User):
    if user.is_super:
        return
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None and target.org_id not in scope:
        raise HTTPException(status_code=403, detail="无权管理该用户")


async def _assert_client_in_scope(session: AsyncSession, user: User, client: Client):
    if user.is_super:
        return
    vis = await _visible_client_ids(session, user)
    if vis is not None and client.id not in vis:
        raise HTTPException(status_code=403, detail="无权管理该 SoduWork")


def _org_mutation_error(exc: rbac.OrgMutationError) -> HTTPException:
    status, message = {
        "out_of_scope": (403, "只能在自己管辖的部门内操作"),
        "parent_not_found": (400, "上级部门不存在"),
        "archived_parent": (409, "上级部门已归档"),
        "archived_org": (409, "请先恢复已归档的部门"),
        "cycle": (400, "部门不能移动到自身或下级部门"),
        "invalid_name": (400, "部门名称须为 1 至 64 个字符"),
        "duplicate_name": (409, "同级部门已使用这个名称"),
    }.get(exc.reason, (400, "组织架构操作无效"))
    return HTTPException(status_code=status, detail=message)


# Organizational structure.

@router.get("/orgs")
async def list_orgs(user: User = Depends(current_user), session: AsyncSession = Depends(get_session),
                    window: PageQuery = None, includeManaged: bool = False):
    if includeManaged and not any(has_perm(user, key) for key in ("org.manage", "user.manage", "work.catalog.manage")):
        raise HTTPException(status_code=403, detail="无该操作权限")
    if not user.is_super and not getattr(user, "_perms", set()):
        scope = {user.org_id} if user.org_id else set()
    else:
        scope = await rbac.scope_org_ids(session, user)
    return await rbac.list_orgs(session, scope, page=window, include_managed=includeManaged)


@router.post("/orgs")
async def create_org(
    body: OrgCreate, user: User = Depends(require_perm("org.manage")),
    session: AsyncSession = Depends(get_session),
):
    try:
        created = await rbac.create_org(
            session, body.name, body.parentId, body.sort, actor=user, data_source=body.dataSource)
    except rbac.OrgMutationError as exc:
        raise _org_mutation_error(exc) from exc
    audit.add(session, user, "org.create", "org", created["id"],
              created["name"], {"parentId": created.get("parentId"), "dataSource": created["dataSource"]})
    await session.commit()
    return created


@router.patch("/orgs/{oid}")
async def update_org(
    oid: str, body: OrgUpdate,
    user: User = Depends(require_perm("org.manage")),
    session: AsyncSession = Depends(get_session),
):
    try:
        r = await rbac.update_org(
            session, oid, body.name, body.parentId, body.sort, actor=user)
    except rbac.OrgMutationError as exc:
        raise _org_mutation_error(exc) from exc
    if r is None:
        raise HTTPException(status_code=404, detail="部门不存在")
    await audit.log(session, user, "org.update", "org", oid, r["name"], {
        "parentId": r.get("parentId"), "sort": r.get("sort"),
    })
    return r


@router.delete("/orgs/{oid}")
async def delete_org(
    oid: str, user: User = Depends(require_perm("org.manage")),
    session: AsyncSession = Depends(get_session),
):
    try:
        r = await rbac.delete_org(session, oid, actor=user)
    except rbac.OrgMutationError as exc:
        raise _org_mutation_error(exc) from exc
    if not r["ok"]:
        # Actionable messages: the count plus where and what to do, so the user can
        # fix the blocking reference and retry without support.
        templates = {
            "has_children": "该部门下还有 {count} 个子部门，请先删除或移动子部门后再删除该部门",
            "has_users": "该部门下还有 {count} 个用户，请先在“用户管理”页把用户调整到其他部门后再删除",
            "has_positions": "该部门下还有 {count} 个岗位（职业画像），请先在“组织治理 → 工作目录”页转移或删除后再删除",
            "has_scenarios": "该部门下还有 {count} 个工作场景，请先在“组织治理 → 工作目录”页转移或删除后再删除",
            "has_projects": "该部门下还有 {count} 个项目，请先在“项目治理”页把项目转移到其他部门后再删除",
            "has_repos": "该部门下还有 {count} 个工程仓库（跟随所属项目），请先在“项目治理”页处理所属项目后再删除",
            "has_default_org": "有 {count} 个登录接入方式把该部门设为新用户默认部门，请先在“接入策略”页更换默认部门后再删除",
        }
        reason = r["reason"]
        template = templates.get(reason)
        detail = template.format(count=r["count"]) if template and r.get("count") is not None else {
            "has_children": "该部门下还有子部门", "has_users": "该部门下还有用户", "not_found": "部门不存在"}.get(reason, "无法删除")
        raise HTTPException(status_code=404 if reason == "not_found" else 400, detail=detail,
                            headers={"X-Error-Code": f"org.delete.{reason}"})
    # Physical delete: keep parent/sort in the audit entry so an accidental delete
    # can be reconstructed.
    await audit.log(session, user, "org.delete", "org", oid, r.get("name", ""),
                    {"parent_id": r.get("parent_id"), "sort": r.get("sort")})
    return r


# Roles.

async def _check_role_grant(session: AsyncSession, actor: User, *, permission: str,
                            role_id: str | None = None, proposed: list[str] | None = None) -> Role | None:
    # Acquire role locks in a stable order for concurrent grants and edits.
    role_ids = {key for key in (role_id, None if actor.is_super else actor.role_id) if key}
    roles = {key: await rbac.lock_role_reference(session, key) for key in sorted(role_ids)}
    target = roles.get(role_id)
    if not actor.is_super:
        own = roles.get(actor.role_id)
        allowed = set(own.permissions or []) if own else set()
        # The role service reports unknown requested keys as a validation error.
        required = {permission} | (set(proposed or ()) & set(ALL_KEYS))
        if target is not None:
            required.update(target.permissions or [])
        if not required.issubset(allowed):
            raise HTTPException(status_code=403, detail="不能管理超出自己权限范围的角色")
    return target


def _check_self_authority(actor: User, target: User, *, role_changed: bool = False,
                          org_id: str | None = None, active: bool | None = None) -> None:
    if actor.is_super or actor.id != target.id:
        return
    if role_changed or (org_id is not None and org_id != target.org_id) or (
        active is not None and active != target.is_active
    ):
        raise HTTPException(status_code=403, detail="不能更改自己的角色、部门或启用状态")


@router.get("/roles")
async def list_roles(user: User = Depends(require_perm("role.manage")), session: AsyncSession = Depends(get_session),
                    window: PageQuery = None):
    return await rbac.list_roles(session, page=window)


@router.get("/role-options")
async def role_options(
    user: User = Depends(require_any_perm("user.manage", "identity.manage", "client.assign")),
    session: AsyncSession = Depends(get_session),
):
    """Role names for account and identity settings."""
    rows = await session.execute(select(Role.id, Role.name).order_by(Role.created_at, Role.id))
    return [{"id": role_id, "name": name} for role_id, name in rows]


@router.post("/roles")
async def create_role(body: RoleCreate,
                      user: User = Depends(require_perm("role.manage")),
                      session: AsyncSession = Depends(get_session)):
    await _lock_user_targets(session, user, [])
    await _check_role_grant(session, user, permission="role.manage", proposed=body.permissions)
    try:
        result = await rbac.create_role(session, body.name, body.permissions)
    except DuplicateName as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await audit.log(session, user, "role.create", "role", result.get("id"),
                    result.get("name", ""), {"permissions": result.get("permissions", [])})
    return result


@router.patch("/roles/{rid}")
async def update_role(rid: str, body: RoleUpdate,
                      user: User = Depends(require_perm("role.manage")),
                      session: AsyncSession = Depends(get_session)):
    await _lock_user_targets(session, user, [])
    await _check_role_grant(session, user, permission="role.manage", role_id=rid, proposed=body.permissions)
    try:
        r = await rbac.update_role(session, rid, body.name, body.permissions)
    except DuplicateName as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if r is None:
        raise HTTPException(status_code=404, detail="角色不存在")
    await audit.log(session, user, "role.update", "role", rid, r.get("name", ""),
                    {"permissions": body.permissions} if body.permissions is not None else {})
    return r


@router.delete("/roles/{rid}")
async def delete_role(rid: str,
                      user: User = Depends(require_perm("role.manage")),
                      session: AsyncSession = Depends(get_session)):
    target = await session.get(Role, rid)
    label = target.name if target else ""
    r = await rbac.delete_role(session, rid)
    if not r["ok"]:
        msg = {"system_role": "系统内置角色不可删", "in_use": "仍有用户在用该角色", "not_found": "角色不存在"}
        reason = r["reason"]
        raise HTTPException(status_code=404 if reason == "not_found" else 400, detail=msg.get(reason, "无法删除"),
                            headers={"X-Error-Code": f"role.delete.{reason}"})
    await audit.log(session, user, "role.delete", "role", rid, label, {})
    return r


# Users within the current scope.

@router.get("/users", dependencies=[Depends(require_perm("user.manage"))])
async def list_users(user: User = Depends(current_user), session: AsyncSession = Depends(get_session),
                    window: PageQuery = None, isActive: bool | None = None):
    return await rbac.list_users(session, await rbac.scope_org_ids(session, user), page=window, is_active=isActive)


@router.post("/users")
async def create_user(
    body: UserCreate,
    user: User = Depends(require_perm("user.manage")),
    session: AsyncSession = Depends(get_session),
):
    if body.tokenQuota is not None and not has_perm(user, "quota.manage"):
        raise HTTPException(status_code=403, detail="请由额度管理员调整用户额度")
    if not body.orgId:
        raise HTTPException(status_code=400, detail="请为用户指定所属部门")
    await _lock_user_targets(session, user, [])
    await rbac.lock_org_tree(session, shared=True)
    await _assert_org_in_scope(session, user, body.orgId)
    if body.roleId and await _check_role_grant(
        session, user, permission="user.manage", role_id=body.roleId,
    ) is None:
        raise HTTPException(status_code=400, detail="角色不存在")
    if body.domains:
        domain_ids = {str(value) for value in body.domains}
        found = set((await session.scalars(select(models.Domain.id).where(
            models.Domain.id.in_(domain_ids)))).all())
        missing = sorted(domain_ids - found)
        if missing:
            raise HTTPException(status_code=400, detail="业务域不存在：" + ", ".join(missing))
    await _require_existing_org(session, body.orgId)
    if await rbac.get_user_by_username(session, body.username):
        raise HTTPException(status_code=400, detail="用户名已存在")
    try:
        position_ids = await work_catalog.validate_profession_ids(
            session, body.orgId, body.positions or [])
        await rbac.validate_user_domains(session, body.domains)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    try:
        created = await rbac.create_user(
            session, body.username, body.password, body.displayName,
            body.orgId, body.roleId, position_ids, body.domains,
            is_test_account=body.isTestAccount,
            token_quota=body.tokenQuota.model_dump() if body.tokenQuota is not None else None)
    except client_access.ClientAccessError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    await audit.log(session, user, "user.create", "user", created.get("id"), created.get("displayName") or body.username,
                    {"orgId": body.orgId, "roleId": body.roleId})
    return created


async def _lock_user_targets(session: AsyncSession, actor: User, ids: list[str]) -> list[User]:
    # A target can also be the actor of an overlapping batch. Lock both sets in ID order.
    authority = (actor.auth_version, actor.is_active, actor.is_super, actor.org_id, actor.role_id)
    selected = set(ids)
    if session.get_bind().dialect.name == "sqlite":
        await session.execute(update(User).where(False).values(display_name=User.display_name))
    rows = list(await session.scalars(select(User).where(User.id.in_(selected | {actor.id}))
        .order_by(User.id).with_for_update().execution_options(populate_existing=True)))
    current = next((row for row in rows if row.id == actor.id), None)
    if (current is None or current.account_deleted_at or not current.is_active or authority !=
            (current.auth_version, current.is_active, current.is_super, current.org_id, current.role_id)):
        raise HTTPException(status_code=409, detail="登录账号已变更，请刷新后重试")
    targets = [row for row in rows if row.id in selected]
    if len(targets) != len(selected):
        raise HTTPException(status_code=404, detail="用户不存在")
    return targets


def _check_deactivation(actor: User, target: User, active: bool | None) -> None:
    if active is False and target.is_super:
        raise HTTPException(status_code=400, detail="不能停用超级管理员")
    if active is False and target.id == actor.id:
        raise HTTPException(status_code=400, detail="不能停用自己的账号")


async def _revoke_user_devices(session: AsyncSession, disabled_ids: list[str]) -> list[str]:
    if not disabled_ids:
        return []
    # Keep historical ownership and explicit device bans; live channels close after commit.
    return list(await session.scalars(update(Client).where(
        Client.user_ref.in_(disabled_ids), Client.auth_state != "revoked",
    ).values(auth_state="pending", auth_version=Client.auth_version + 1,
             activated_at=None, revoked_at=None).returning(Client.id)
        .execution_options(synchronize_session=False)))


@router.post("/users/batch")
async def batch_update_users(
    body: UserBatchUpdate, user: User = Depends(require_perm("user.manage")),
    session: AsyncSession = Depends(get_session),
):
    if (body.isActive is None) == (body.orgId is None):
        raise HTTPException(status_code=422, detail="请选择一项批量操作")
    targets = await _lock_user_targets(session, user, body.ids)
    if not user.is_super or body.orgId is not None:
        await rbac.lock_org_tree(session, shared=True)
    scope = await rbac.scope_org_ids(session, user)
    visible_positions = set()
    if body.orgId is not None:
        if scope is not None and body.orgId not in scope:
            raise HTTPException(status_code=403, detail="只能在自己管辖的部门内操作")
        await _require_existing_org(session, body.orgId)
        visible_positions = {row.id for row in await work_catalog.profession_rows(session, body.orgId)}

    changes = []
    for target in targets:
        if scope is not None and (target.org_id not in scope or target.is_super):
            raise HTTPException(status_code=403, detail="无权管理该用户")
        if target.account_deleted_at:
            raise HTTPException(status_code=400, detail="不能修改已注销的账号")
        _check_deactivation(user, target, body.isActive)
        _check_self_authority(user, target, org_id=body.orgId, active=body.isActive)
        if body.isActive is not None and target.is_active != body.isActive:
            changes.append((target, {"isActive": body.isActive}))
        if body.orgId is not None and target.org_id != body.orgId:
            try:
                positions = work_catalog.check_profession_ids(target.positions, visible_positions)
            except ValueError as error:
                raise HTTPException(status_code=400, detail=str(error)) from error
            changes.append((target, {"orgId": body.orgId, "positions": positions}))

    disabled = [target.id for target, _ in changes] if body.isActive is False else []
    client_ids = await _revoke_user_devices(session, disabled)
    for target, patch in changes:
        audit.add(session, user, "user.update", "user", target.id, target.display_name or target.username,
                  {"fields": list(patch), "pwChanged": False})
    for target, patch in changes:
        rbac.apply_user_patch(target, patch)
    await session.commit()
    if client_ids:
        await device_connections.disconnect_many(client_ids)
    return {"updated": len(changes)}


@router.patch("/users/{uid}")
async def update_user(
    uid: str,
    body: UserUpdate,
    user: User = Depends(require_perm("user.manage")),
    session: AsyncSession = Depends(get_session),
):
    target, = await _lock_user_targets(session, user, [uid])
    if not user.is_super or body.orgId is not None:
        await rbac.lock_org_tree(session, shared=True)
    await _assert_user_in_scope(session, user, target)
    if body.orgId is not None:
        await _assert_org_in_scope(session, user, body.orgId)
        await _require_existing_org(session, body.orgId)
    _check_deactivation(user, target, body.isActive)
    _check_self_authority(user, target, org_id=body.orgId, active=body.isActive,
                          role_changed="roleId" in body.model_fields_set and (body.roleId or None) != target.role_id)
    # An empty roleId is the legacy form used by clients to clear a role.
    # Validate non-empty assignments while preserving that clearing behavior.
    if body.roleId and await _check_role_grant(
        session, user, permission="user.manage", role_id=body.roleId,
    ) is None:
        raise HTTPException(status_code=400, detail="角色不存在")
    if body.domains is not None:
        domain_ids = {str(value) for value in body.domains}
        found = set((await session.scalars(select(models.Domain.id).where(
            models.Domain.id.in_(domain_ids)))).all())
        missing = sorted(domain_ids - found)
        if missing:
            raise HTTPException(status_code=400, detail="业务域不存在：" + ", ".join(missing))
    was_active = bool(target.is_active)
    patch = body.model_dump(exclude_none=True)
    # Explicit null clears the role; omitting the field preserves it.
    if "roleId" in body.model_fields_set:
        patch["roleId"] = body.roleId
    if "isTestAccount" in body.model_fields_set:
        patch["isTestAccount"] = body.isTestAccount
    target_org_id = body.orgId if body.orgId is not None else target.org_id
    try:
        await rbac.validate_user_domains(session, body.domains)
        if body.positions is not None or target_org_id != target.org_id:
            patch["positions"] = await work_catalog.validate_profession_ids(
                session, target_org_id,
                body.positions if body.positions is not None else target.positions,
                retained=target.positions if target_org_id == target.org_id else ())
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    client_ids = await _revoke_user_devices(session, [uid] if was_active and body.isActive is False else [])
    try:
        updated = await rbac.update_user(session, uid, patch)
    except client_access.ClientAccessError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    if client_ids:
        await device_connections.disconnect_many(client_ids)
    await audit.log(session, user, "user.update", "user", uid, target.display_name or target.username,
                    {"fields": [k for k in patch if k != "password"], "pwChanged": "password" in patch})
    return updated


# Professional profiles are independent of permissions; built-in profiles are read-only and organizations may add their own.

@router.get("/positions")
async def list_positions(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    org_id: Annotated[str, Query(alias="orgId")] = "",
):
    if org_id:
        await _assert_org_in_scope(session, user, org_id)
        await _require_existing_org(session, org_id)
        return [work_catalog.profession_api(row, inherited=row.org_id != org_id)
                for row in await work_catalog.profession_rows(session, org_id)]
    return await rbac.list_positions(
        session, await rbac.scope_org_ids(session, user))


@router.post("/positions")
async def create_position(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    await rbac.lock_org_tree(session, shared=True)
    org_id = str(body.get("orgId") or user.org_id or "")
    if not org_id:
        raise HTTPException(status_code=400, detail="请先选择所属组织")
    await _assert_org_in_scope(session, user, org_id)
    await _require_existing_org(session, org_id)
    try:
        row = await work_catalog.save_profession(session, body, org_id, actor=user)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    result = work_catalog.profession_api(row)
    await audit.log(session, user, "profession.create", "position",
                    row.id, row.name, {"orgId": org_id})
    return result


@router.patch("/positions/{pid}")
async def update_position(
    pid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    await rbac.lock_org_tree(session, shared=True)
    row = await session.get(models.Position, pid)
    if row is None:
        raise HTTPException(status_code=404, detail="职业画像不存在")
    if row.is_system or row.org_id is None:
        raise HTTPException(status_code=400, detail="平台职业是只读基线，请新建企业职业")
    await _assert_org_in_scope(session, user, row.org_id)
    try:
        row = await work_catalog.save_profession(
            session, body, row.org_id, row, actor=user)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    result = work_catalog.profession_api(row)
    await audit.log(session, user, "profession.update", "position",
                    pid, row.name, {"fields": sorted(body)})
    return result


@router.delete("/positions/{pid}")
async def delete_position(
    pid: str,
    user: User = Depends(require_perm("work.catalog.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(models.Position, pid)
    if row is None:
        raise HTTPException(status_code=404, detail="职业画像不存在")
    if row.org_id:
        await _assert_org_in_scope(session, user, row.org_id)
    reason = await work_catalog.delete_profession(session, row)
    if reason:
        raise HTTPException(status_code=400, detail=reason)
    await audit.log(session, user, "profession.delete", "position",
                    pid, row.name, {})
    return {"ok": True}

# Responsibility domains support user management and dispatch.

@router.get("/domains")
async def list_domains(user: User = Depends(require_any_perm("user.manage", "task.dispatch")), session: AsyncSession = Depends(get_session),
                    window: PageQuery = None):
    return await rbac.list_domains(session, page=window)


@router.post("/domains")
async def create_domain(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("user.manage")),
    session: AsyncSession = Depends(get_session),
):
    sort = parse_integer(body.get("sort"), field="sort", default=0)
    try:
        r = await rbac.create_domain(session, body.get("name"), sort)
    except DuplicateName as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="领域名称必须为 1 到 64 个字符") from exc
    audit.add(session, user, "domain.create", "domain", r["id"], r["name"], {})
    await session.commit()
    return r


@router.patch("/domains/{did}")
async def update_domain(
    did: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("user.manage")),
    session: AsyncSession = Depends(get_session),
):
    # Omitted/null sort retains the previous rank; a supplied value must be
    # validated before the service can mutate either name or sort.
    sort = body.get("sort")
    if sort is not None:
        sort = parse_integer(sort, field="sort")
    if "name" in body and body["name"] is None:
        raise HTTPException(status_code=422, detail="领域名称必须为 1 到 64 个字符")
    try:
        change = await rbac.update_domain(session, did, body.get("name"), sort)
    except DuplicateName as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="领域名称必须为 1 到 64 个字符") from exc
    if change is None:
        raise HTTPException(status_code=404, detail="领域不存在")
    before, after = change
    audit.add(session, user, "domain.update", "domain", did, after["name"],
              {"before": before, "after": after})
    await session.commit()
    return after


@router.delete("/domains/{did}")
async def delete_domain(
    did: str,
    user: User = Depends(require_perm("user.manage")),
    session: AsyncSession = Depends(get_session),
):
    r = await rbac.delete_domain(session, did)
    if not r.get("ok"):
        msg = {"not_found": "领域不存在", "system": "内置领域不可删除",
               "users_remain": "仍有用户属于该领域，先移除用户关联",
               "in_use": "仍有用户使用该业务域，请先解除关联"}.get(r.get("reason"), "删除失败")
        raise HTTPException(status_code=404 if r.get("reason") == "not_found" else 400, detail=msg)
    await audit.log(session, user, "domain.delete", "domain", did, did, {})
    return r


# Scoped device fleet and SoduWork ownership.

class ClientListFilters:
    def __init__(self, q: str = Query(default="", max_length=120),
                 state: str = Query(default="all", pattern="^(all|online|offline|pending)$"),
                 form: str = Query(default="all", pattern="^(all|desktop|mobile)$"),
                 sort_by: str | None = Query(default=None, alias="sortBy",
                                             pattern="^(name|owner|online|auth|platform|lastSeen)$"),
                 sort_dir: str = Query(default="asc", alias="sortDir", pattern="^(asc|desc)$")):
        self.q = q
        self.state = state
        self.form = form
        self.sort_by = sort_by
        self.sort_dir = sort_dir


ClientFilters = Annotated[ClientListFilters, Depends()]
ClientPageNumber = Annotated[int | None, Query(ge=1, le=2**31-1)]
ClientPageSize = Annotated[int | None, Query(alias="pageSize", ge=1, le=100)]


@router.get("/clients")
async def list_clients(
    filters: ClientFilters, paged: bool = Query(default=False),
    page: ClientPageNumber = None, page_size: ClientPageSize = None, window: PageQuery = None,
    user: User = Depends(require_perm("client.view")),
    session: AsyncSession = Depends(get_session),
):
    """Legacy unpaged clients receive an array. Use /client-inventory for a stable envelope."""
    if paged or window:
        return await paged_clients(filters, page, page_size, window, user, session)
    vis = await _visible_client_ids(session, user)
    query = select(Client).order_by(Client.created_at.desc(), Client.id)
    if vis is not None:
        query = query.where(Client.id.in_(vis))
    return [client_to_api(c, settings.offline_after_seconds) for c in await session.scalars(query)]


async def _client_inventory_query(session, user, filters):
    state, form, q = filters.state, filters.form, filters.q

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=settings.offline_after_seconds)
    online = case((Client.last_seen_at >= cutoff, 1), else_=0)
    scope = await _client_scope(session, user)
    state_where = {
        "online": [Client.last_seen_at.is_not(None), Client.last_seen_at >= cutoff],
        "offline": [or_(Client.last_seen_at.is_(None), Client.last_seen_at < cutoff)],
        "pending": [Client.auth_state != "active"],
    }.get(state, [])
    # Manage mobile and desktop clients in the same device inventory.
    # Mobile approvals, assignments, and task views reuse these device identities.
    platform_lc = func.lower(func.coalesce(Client.platform, ""))
    is_mobile = or_(platform_lc.like("android%"), platform_lc.like("ios%"),
                    platform_lc.like("harmony%"), platform_lc == "mobile")
    form_where = {"mobile": [is_mobile], "desktop": [~is_mobile]}.get(form, [])
    keyword = q.strip().lower()
    search = []
    if keyword:
        search = [or_(
            func.lower(func.coalesce(Client.name, "")).contains(keyword, autoescape=True),
            func.lower(Client.id).contains(keyword, autoescape=True),
            func.lower(func.coalesce(User.display_name, "")).contains(keyword, autoescape=True),
            func.lower(func.coalesce(User.username, "")).contains(keyword, autoescape=True),
        )]

    owner = func.coalesce(func.nullif(User.display_name, ""), User.username, "")
    query = (select(Client, owner.label("owner_name"), online.label("online"))
             .outerjoin(User, User.id == Client.user_ref)
             .where(*scope, *state_where, *form_where, *search))
    if filters.sort_by is None:
        order = (online.desc(), Client.created_at.desc())
    else:
        # Match the normalized platform labels displayed in the terminal table.
        platform_name = case(
            (platform_lc.like("win%"), "windows"),
            (or_(platform_lc.like("darwin%"), platform_lc.like("mac%")), "macos"),
            (platform_lc.like("linux%"), "linux"), (platform_lc.like("ios%"), "ios"),
            (platform_lc.like("android%"), "android"), (platform_lc.like("harmony%"), "harmonyos"),
            else_=platform_lc,
        )
        columns = {
            "name": (func.lower(func.coalesce(Client.name, "")),),
            "owner": (func.lower(owner),),
            "online": (1 - online,),  # Ascending groups online devices first.
            "auth": (case((Client.auth_state.in_(("active", "revoked")), Client.auth_state),
                          else_="pending"),),
            "platform": (platform_name, func.lower(func.coalesce(Client.app_version, ""))),
            "lastSeen": (Client.last_seen_at,),
        }[filters.sort_by]
        order = tuple((col.desc() if filters.sort_dir == "desc" else col.asc()).nulls_last()
                      for col in columns)
    return query.order_by(*order, Client.id), scope, online, is_mobile


@router.get("/client-inventory")
async def paged_clients(
    filters: ClientFilters, page: ClientPageNumber = None, page_size: ClientPageSize = None,
    window: PageQuery = None, user: User = Depends(require_perm("client.view")),
    session: AsyncSession = Depends(get_session),
):
    """Return items, total and counts for every request, including an empty page."""
    if window:
        if page is not None or page_size is not None:
            raise HTTPException(status_code=422, detail="请选择一种分页方式：limit/offset 或 page/pageSize",
                                headers={"X-Error-Code": "hub.input.pages"})
        offset, page_size = window.offset, window.limit
        page = offset // page_size + 1
    else:
        page, page_size = page or 1, page_size or 25
        offset = (page - 1) * page_size
    query, scope, online, is_mobile = await _client_inventory_query(session, user, filters)
    total = await session.scalar(query.order_by(None).with_only_columns(func.count()))
    summary = (await session.execute(
        select(
            func.count(),
            func.sum(online),
            func.sum(case((Client.auth_state != "active", 1), else_=0)),
            func.sum(case((is_mobile, 1), else_=0)),
        ).select_from(Client).where(*scope)
    )).one()
    all_count = int(summary[0] or 0)
    online_count, pending_count = int(summary[1] or 0), int(summary[2] or 0)
    mobile_count = int(summary[3] or 0)

    rows = await session.execute(query.offset(offset).limit(page_size))
    items = []
    for client, owner, online_at_query in rows:
        item = client_to_api(client, settings.offline_after_seconds)
        item.update(ownerName=owner, online=bool(online_at_query))
        items.append(item)
    return {
        "items": items, "total": total, "page": page, "pageSize": page_size, "offset": offset,
        "counts": {
            "all": all_count, "online": online_count,
            "offline": all_count - online_count, "pending": pending_count,
            "mobile": mobile_count,
        },
    }


@router.get("/client-inventory/export.csv")
async def export_client_inventory(
    filters: ClientFilters, user: User = Depends(require_perm("client.view")),
    session: AsyncSession = Depends(get_session),
):
    """Export the complete filtered inventory with the same scope and ordering as the table."""
    query, _, _, _ = await _client_inventory_query(session, user, filters)
    query = query.with_only_columns(
        Client.id, Client.name, query.selected_columns.owner_name, query.selected_columns.online,
        Client.auth_state, Client.platform, Client.app_version, Client.last_seen_at,
    )
    rows = await session.stream(query.execution_options(yield_per=400))
    fields = ("id", "name", "ownerName", "connectionState", "authState", "platform", "version", "lastSeen")

    def values(row):
        device_id, name, owner, online, auth, platform, version, heartbeat = row
        return (device_id, name, owner, "online" if online else "offline",
                auth if auth in ("active", "revoked") else "pending", platform, version, iso_utc(heartbeat))

    return StreamingResponse(csv_chunks(rows, fields, values), media_type="text/csv", headers={
        "Content-Disposition": 'attachment; filename="soduwork-clients.csv"',
        "Cache-Control": "no-store",
    })


@router.get("/client-owner-options")
async def client_owner_options(user: User = Depends(require_perm("client.assign")),
                               session: AsyncSession = Depends(get_session)):
    query = select(User.id, User.username, User.display_name).where(
        User.is_active.is_(True), User.account_deleted_at.is_(None))
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None:
        query = query.where(User.org_id.in_(scope))
    if not user.is_super:
        query = query.where(User.is_super.is_(False))
    rows = await session.execute(query.order_by(User.username, User.id))
    return [{"id": uid, "username": name, "displayName": display} for uid, name, display in rows]


def _pairing_claims(token: str | None, cid: str | None = None) -> dict:
    claims = verify_claims(token or "", token_type="device-pairing")
    if not claims or (cid is not None and claims["cid"] != cid):
        raise HTTPException(403, "请向设备使用者索取这台设备的新配对凭据")
    return claims


async def _assign_client_owner(session, user, cid, target_id, token, *, action, create=False):
    from ..services import desktop_login_policy
    target = await session.get(User, target_id, with_for_update=True) if target_id else None
    if target is None or not target.is_active or target.account_deleted_at:
        raise HTTPException(400, "请选择一个可用的归属用户")
    await _assert_user_in_scope(session, user, target)
    c = await session.get(Client, cid)
    new = c is None
    if new:
        if not create:
            raise HTTPException(404, "SoduWork 不存在")
        claims = _pairing_claims(token, cid)
        if claims["ver"] is not None:
            raise HTTPException(409, "设备登记已变化，请重新配对")
        c = await device_auth.insert_new_device(session, cid, claims["digest"], platform=claims["platform"])
        if c is None:
            raise HTTPException(409, "设备登记已变化，请重新配对")

    await desktop_login_policy.lock_assignment(session, c, target)
    await _assert_client_in_scope(session, user, c)
    await _assert_user_in_scope(session, user, target)
    if not target.is_active or target.account_deleted_at:
        raise HTTPException(409, "账号授权已变化，请刷新后重试")
    if target.is_super and not user.is_super:
        raise HTTPException(403, "无权管理该用户")
    if c.auth_state == "revoked":
        raise HTTPException(409, "请先重新登记已停用的设备")
    changed = action != "client.assign" or c.user_ref != target.id or c.auth_state != "active"
    if changed:
        if not new:
            claims = _pairing_claims(token, cid)
            digest = claims["digest"]
            bound_digest = c.secret_hash or (device_auth.hash_secret(c.secret) if c.secret else None)
            if claims["ver"] != c.auth_version or (bound_digest and bound_digest != digest):
                raise HTTPException(409, "设备登记已变化，请重新配对")
            # On SQLite SELECT FOR UPDATE is a no-op. A conditional write also
            # fences a simultaneous approval or reset before consuming this proof.
            matched = await session.execute(update(Client).where(
                Client.id == cid, Client.auth_version == claims["ver"],
                Client.secret_hash == c.secret_hash, Client.secret == c.secret, Client.auth_state != "revoked",
            ).values(secret_hash=digest, secret=None))
            if matched.rowcount != 1:
                raise HTTPException(409, "设备登记已变化，请重新配对")
            if not bound_digest and claims["platform"]:
                c.platform = claims["platform"]
        device_auth.activate(c, target)
    replaced = await desktop_login_policy.replace_previous(session, c, target)
    audit.add(session, user, action, "client", cid, c.name or cid, {"ownerUserId": target.id})
    await session.commit()
    if changed:
        await device_connections.disconnect(cid)
    for previous_id in replaced:
        await device_connections.disconnect(previous_id, 4401)
    return {"ok": True, "ownerUserId": target.id, "authState": c.auth_state}


@router.post("/clients/pair")
async def pair_client(body: ClientPairBody, user: User = Depends(require_perm("client.assign")),
                      session: AsyncSession = Depends(get_session)):
    cid = _pairing_claims(body.pairingToken)["cid"]
    return await _assign_client_owner(session, user, cid, body.userId, body.pairingToken,
                                     action="client.pair", create=True)


@router.post("/clients/{cid}/assign")
async def assign_client(cid: str, body: AssignUserBody, user: User = Depends(require_perm("client.assign")),
                        session: AsyncSession = Depends(get_session)):
    if body.userId:
        return await _assign_client_owner(session, user, cid, body.userId, body.pairingToken,
                                         action="client.assign")
    c = await session.get(Client, cid, with_for_update=True)
    if c is None:
        raise HTTPException(404, "SoduWork 不存在")
    await _assert_client_in_scope(session, user, c)
    changed = bool(c.user_ref or c.auth_state == "active")
    if c.auth_state == "active":
        device_auth.revoke(c)
    c.user_ref = None
    await session.commit()
    if changed:
        await device_connections.disconnect(cid)
    await audit.log(session, user, "client.assign", "client", cid, c.name or cid, {"ownerUserId": None})
    return {"ok": True, "ownerUserId": None, "authState": c.auth_state}


@router.post("/clients/{cid}/activate")
async def activate_client(cid: str, body: AssignUserBody, user: User = Depends(require_perm("client.assign")),
                          session: AsyncSession = Depends(get_session)):
    return await _assign_client_owner(session, user, cid, body.userId, body.pairingToken,
                                     action="client.activate")


@router.post("/clients/{cid}/revoke")
async def revoke_client(
    cid: str,
    user: User = Depends(require_perm("client.control")),
    session: AsyncSession = Depends(get_session),
):
    c = await session.get(Client, cid)
    if c is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_in_scope(session, user, c)
    device_auth.revoke(c)
    await session.commit()
    await device_connections.disconnect(cid)
    await audit.log(session, user, "client.revoke", "client", cid, c.name or cid, {})
    return {"ok": True, "authState": c.auth_state}


@router.post("/clients/{cid}/reset-enrollment")
async def reset_client_enrollment(
    cid: str,
    user: User = Depends(require_perm("client.control")),
    session: AsyncSession = Depends(get_session),
):
    c = await session.get(Client, cid)
    if c is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_in_scope(session, user, c)
    device_auth.reset_enrollment(c)
    await session.commit()
    await device_connections.disconnect(cid)
    await audit.log(session, user, "client.reset_enrollment", "client", cid, c.name or cid, {})
    return {"ok": True, "authState": c.auth_state}


@router.post("/clients/{cid}/reset-secret")
async def reset_client_secret(
    cid: str,
    user: User = Depends(require_perm("client.control")),
    session: AsyncSession = Depends(get_session),
):
    """Compatibility alias for the secure enrollment reset operation."""
    c = await session.get(Client, cid)
    if c is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_in_scope(session, user, c)
    device_auth.reset_enrollment(c)
    await session.commit()
    await device_connections.disconnect(cid)
    await audit.log(session, user, "client.reset_secret", "client", cid, c.name or cid, {})
    return {"ok": True, "authState": c.auth_state}


# Scoped tasks and dispatch.

@router.get("/tasks")
async def list_all_tasks(
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
    origin: str | None = None,
    owner: str | None = None,
):
    q = select(Task).order_by(Task.created_at.desc())
    if origin:
        q = q.where(Task.origin == origin)
    if owner:
        q = q.where(Task.owner_client_id == owner)
    res = await session.execute(q)
    vis = await _visible_client_ids(session, user)
    rows = [t for t in res.scalars().all() if vis is None or t.owner_client_id in vis]
    states = await svc.ai_states(session, [t.id for t in rows])
    # This list uses the same administrative scope as task execution details.
    # Make access explicit for shared selectors; never infer it from visibility.
    out = [{**task_to_api(t), "canViewExecution": True,
             "canRunPlugin": user.is_super or "plugin.run" in getattr(user, "_perms", set()),
             **({"ai": states[t.id]} if t.id in states else {})} for t in rows]
    from ..services import task_requirement_projection
    return await task_requirement_projection.decorate_many(session, rows, out)


async def _assert_task_in_scope(session: AsyncSession, user: User, tid: str) -> Task:
    t = await session.get(Task, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    if not user.is_super:
        vis = await _visible_client_ids(session, user)
        if vis is not None and t.owner_client_id not in vis:
            raise HTTPException(status_code=403, detail="无权操作该需求")
    return t


# Legacy task workflow routes are retired: /workflow/tasks, /tasks/{tid}/workflow, advance, and reject.
# Multi-stage work uses plugin WorkflowRun instances, including human approval nodes.
# Direct assignments use /users/{uid}/tasks with ordinary tasks and completion receipts.


@router.get("/daily-reports")
async def list_daily_reports(
    date: str = "", user_id: str = "",
    org_id: str = Query(default="", alias="orgId"),
    user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)
):
    """Return the current team's overview, with drill-down into direct subteams and individual
    facts.
    """
    from ..services import daily_report as dr, team_daily_report as tdr
    day = (date or "").strip() or dr.today_str()
    try:
        parsed_date = calendar_date.fromisoformat(day)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="非法日期，请使用 YYYY-MM-DD 格式") from None
    if parsed_date > calendar_date.today():
        raise HTTPException(status_code=400, detail="日报只能查询今天或之前的日期")
    try:
        data = await tdr.overview(session, user, day, org_id)
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    if user_id:
        data["reports"] = [row for row in data.get("reports") or []
                           if row.get("userId") == user_id]
        data["members"] = [row for row in data.get("members") or []
                           if row.get("userId") == user_id]
    return data


@router.post("/daily-reports/generate")
async def generate_daily_reports(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)
):
    """Generate today's reports on demand for scoped members, or one specified userId. Skip members
    without tasks; report inactive ongoing work accurately. notify=False prevents repeated
    desktop notifications.
    """
    from ..services import daily_report as dr, team_daily_report as tdr
    day = (body.get("date") or "").strip() or dr.today_str()
    try:
        parsed_date = calendar_date.fromisoformat(day)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="非法日期，请使用 YYYY-MM-DD 格式") from None
    if parsed_date > calendar_date.today():
        raise HTTPException(status_code=400, detail="不允许为未来日期生成日报")
    uid = (body.get("userId") or "").strip()

    scope = await rbac.scope_org_ids(session, user)
    uids = await rbac.scoped_user_ids(session, scope)          # None leaves superusers unrestricted.
    q = select(User).where(User.is_active.is_(True))
    if uid:
        q = q.where(User.id == uid)
    targets = (await session.execute(q)).scalars().all()
    if uids is not None:
        targets = [u for u in targets if u.id in uids or u.id == user.id]
    if uid and not targets:
        raise HTTPException(status_code=403, detail="该用户不在你的管理范围内")

    made, skipped = 0, 0
    for t in targets:
        try:
            if await dr.generate_for(session, t, day, notify=False):
                made += 1
            else:
                skipped += 1
        except Exception:                                       # noqa: BLE001  Keep one member's failure from affecting other reports.
            await session.rollback()
            skipped += 1
    teams = await tdr.generate_scope(session, day, scope, force=True)
    await audit.log(session, user, "report.generate", "report", uid or None, day,
                    {"made": made, "skipped": skipped, "teams": len(teams), "date": day})
    return {"date": day, "made": made, "skipped": skipped,
            "total": len(targets), "teamReports": len(teams),
            "details": [tdr.to_api(report) for report in teams]}


@router.post("/team-daily-reports/{report_id}/confirm")
async def confirm_team_daily_report(
    report_id: str, body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)
):
    """Confirm current team facts; source changes invalidate prior confirmation and require a new
    summary.
    """
    from ..models import TeamDailyReport
    from ..services import team_daily_report as tdr
    report = await session.get(TeamDailyReport, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="团队日报不存在")
    await _assert_org_in_scope(session, user, report.org_id)
    try:
        report = await tdr.confirm(session, user, report_id, str(body.get("note") or ""))
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await audit.log(session, user, "report.team_confirm", "team_daily_report",
                    report.id, report.org_name, {"date": report.date})
    return tdr.to_api(report)


@router.get("/tasks/{tid}/attachments")
async def task_attachments(
    tid: str, user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)
):
    """Return task attachments with short-lived, single-file download tickets."""
    t = await session.get(Task, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    vis = await _visible_client_ids(session, user)
    if vis is not None and t.owner_client_id not in vis:
        raise HTTPException(status_code=403, detail="超出作用域")
    res = await session.execute(
        select(Attachment).where(Attachment.task_id == tid).order_by(Attachment.created_at)
    )
    return [attachment_to_api(a) for a in res.scalars().all()]


@router.post("/tasks/{tid}/attachments")
async def upload_task_attachment(
    tid: str,
    file: UploadFile = File(...),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Upload attachments to a scoped task, including tasks assigned to another owner."""
    t = await session.get(Task, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    vis = await _visible_client_ids(session, user)
    if vis is not None and t.owner_client_id not in vis:
        raise HTTPException(status_code=403, detail="超出作用域")
    data = await file.read()
    max_bytes = settings.attach_max_mb * 1024 * 1024
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail=f"文件超过 {settings.attach_max_mb}MB 上限")
    if not data:
        raise HTTPException(status_code=400, detail="空文件")
    fn = (file.filename or "file").replace("/", "_").replace("\\", "_").strip()[:200] or "file"
    ct = file.content_type or "application/octet-stream"
    # The column default is applied at flush; the storage key needs the id now.
    a = Attachment(id=str(uuid.uuid4()), task_id=tid, filename=fn, content_type=ct, size=len(data),
                   uploaded_by="admin:" + user.id, evidence_meta={"sha256": hashlib.sha256(data).hexdigest()})
    a.storage_key = f"att/{tid}/{a.id}/{fn}"
    a.backend = storage.put(a.storage_key, data, ct)
    session.add(a)
    await session.commit()
    await session.refresh(a)
    await audit.log(session, user, "task.attachment.upload", "attachment", a.id, fn,
                    {"taskId": tid, "size": len(data),
                     "contentType": ct[:120]})
    return attachment_to_api(a)


@router.delete("/tasks/{tid}/attachments/{aid}")
async def withdraw_task_attachment(
    tid: str, aid: str, user: User = Depends(require_perm("task.dispatch")), session: AsyncSession = Depends(get_session),
):
    from ..services import gate_contract
    from .attachments import remove_unreferenced_object

    task = await _assert_task_in_scope(session, user, tid)
    row = await session.scalar(select(Attachment).where(Attachment.task_id == tid, Attachment.id == aid).with_for_update())
    if row is None:
        raise HTTPException(404, "附件不存在")
    meta = row.evidence_meta or {}
    owner = meta.get("ownerUserId")
    owns_upload = owner == user.id if owner else row.uploaded_by in {"admin:" + user.id, "user:" + user.id}
    if not (user.is_super or task.owner_user_id == user.id or owns_upload):
        raise HTTPException(403, "无权撤回该附件")
    if attachment_role(row) != "input" or row.source_ref or row.workflow_run_id or row.node_run_id or meta.get("cloudRequestId"):
        raise HTTPException(409, "只能撤回普通需求输入附件")
    if await gate_contract.references_attachment(session, row):
        raise HTTPException(409, "附件已被固定版本或审批引用，不能撤回")
    storage_key, backend = row.storage_key, row.backend
    await session.delete(row)
    audit.add(session, user, "task.attachment.delete", "attachment", aid, row.filename, {"taskId": tid})
    await session.commit()
    await remove_unreferenced_object(session, aid, storage_key, backend)
    return {"ok": True}


@router.get("/tasks/{tid}")
async def task_detail(
    tid: str,
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    t = await _assert_task_in_scope(session, user, tid)
    from ..services import task_events
    d = await svc.task_to_api_live(session, t)
    d["timeline"] = await task_events.timeline(session, tid)
    return d

@router.post("/tasks/{tid}/nudge")
async def nudge_task(
    tid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Notify the current task holder with a desktop reminder without changing task state."""
    t = await _assert_task_in_scope(session, user, tid)
    if not t.owner_client_id:
        raise HTTPException(status_code=400, detail="需求没有归属 SoduWork，没法催")
    if t.status == "done":
        raise HTTPException(status_code=400, detail="需求已完成，不用催了")
    who = user.display_name or user.username
    note = str(body.get("note") or "").strip()
    text = f"⏰ {who} 催办：「{t.title}」" + (f"——{note}" if note else "，抽空推进一下~")
    delivered = await publish_owner(session, t, {"type": "notice", "text": text, "taskId": tid})
    await audit.log(session, user, "task.nudge", "task", tid, t.title, {"note": note})
    return {"ok": True, "delivered": delivered and hub.is_online(t.owner_client_id)}


@router.post("/tasks/{tid}/agent-run")
async def agent_run_task(
    tid: str,
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Start a background SoduWork execution, attach outputs, and record timeline events. Reject
    duplicate starts while execution is active.
    """
    from ..services import agent_runner
    t = await _assert_task_in_scope(session, user, tid)
    if t.status == "done":
        raise HTTPException(status_code=400, detail="需求已完成，不需要执行")
    who = user.display_name or user.username
    try:
        r = await agent_runner.start(session, t, who)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    await audit.log(session, user, "task.agent_run", "task", tid, t.title, {})
    return r


@router.get("/tasks/{tid}/agent-status")
async def agent_run_status(
    tid: str,
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    """Return execution activity and the latest terminal event for drawer polling."""
    from sqlalchemy import select as _sel

    from ..services import agent_runner
    await _assert_task_in_scope(session, user, tid)
    ev = (await session.execute(
        _sel(TaskEvent).where(TaskEvent.task_id == tid, TaskEvent.kind.in_(("agent.done", "agent.failed")))
        .order_by(TaskEvent.at.desc()).limit(1)
    )).scalars().first()
    return {
        "running": agent_runner.is_running(tid),
        "last": ({"kind": ev.kind, "detail": ev.detail or {}} if ev else None),
    }


# Projects and repositories: retain existing Python imports and route order.
from .admin_projects import (
    _project_owner, _repo_api,
    add_project_task, add_repo, create_project, delete_project, delete_repo,
    list_ai_projects, list_projects, list_repos, project_detail,
    project_owner_options, update_project, update_repo,
    router as project_router,
)

router.include_router(project_router)


# Configurable development instructions sent to the AI.
# These settings control AI development instructions, not workflow orchestration.
# Plugins and WorkflowRun control handoffs between people and stages.

@router.get("/dev-flow")
async def get_dev_flow(user: User = Depends(require_perm("task.dispatch")),
                       session: AsyncSession = Depends(get_session)):
    """Return shared development defaults and option metadata for the configuration UI."""
    from ..services import ai_flow_presets, ai_prompts
    return {"cfg": await ai_prompts.load_default(session),
            "defaults": dict(ai_prompts.DEFAULTS),
            # Use the built-in steps to display and initialize an uncustomized workflow.
            "defaultSteps": [dict(s) for s in ai_flow_presets.DEFAULT_STEPS],

            "presets": [{"id": p["id"], "name": p["name"], "desc": p["desc"], "cfg": p["cfg"]}
                        for p in ai_flow_presets.PRESETS],
            # Report the execution environment detected on the Runner; it is not an administrator setting.
            "env": ai_prompts.detect_env(),
            # Expose fixed constraints so administrators can distinguish them from configurable options.
            "locked": ["不许合并到基线分支（合并由 SoduWork 做）",
                       "不许发布上线 / 连生产机 / 重启服务 / 动数据库",
                       "不许 force push、不许改已推历史",
                       "浏览器必须用随机高位端口 + 独立 user-data-dir",
                       "不许在前台跑长驻命令（会被静默看门狗掐掉）"]}


@router.put("/dev-flow")
async def put_dev_flow(body: dict = Body(default_factory=dict),
                       user: User = Depends(require_perm("task.dispatch")),
                       session: AsyncSession = Depends(get_session)):
    from ..services import ai_prompts
    cfg = body.get("cfg") if isinstance(body.get("cfg"), dict) else body
    err = ai_prompts.check(cfg)
    if err:
        raise HTTPException(status_code=400, detail=err)
    merged = await ai_prompts.save_default(session, cfg)
    await session.commit()
    await audit.log(session, user, "devflow.update", "setting", ai_prompts.SETTING_KEY,
                    "研发流程默认配置", {"cfg": merged})
    return {"ok": True, "cfg": merged}


@router.post("/dev-flow/preview")
async def preview_dev_flow(body: dict = Body(default_factory=dict),
                           user: User = Depends(require_perm("task.dispatch")),
                           session: AsyncSession = Depends(get_session)):
    """Render the exact instructions that execution will receive. Include repository overrides when
    repoId is supplied, so the preview matches dispatch.
    """
    from ..models import Repo
    from ..services import ai_prompts
    cfg = body.get("cfg") if isinstance(body.get("cfg"), dict) else None
    rid = str(body.get("repoId") or "").strip()
    repo = await session.get(Repo, rid) if rid else None
    if cfg is None:                       # Without cfg, preview the saved configuration.
        cfg = await ai_prompts.resolve(session, repo)
    else:
        cfg = ai_prompts.normalize(cfg, base=await ai_prompts.load_default(session))
    branch = (getattr(repo, "default_branch", "") or "main") if repo else "main"
    return {"cfg": cfg,
            "text": ai_prompts.dev_flow(branch, local=bool(body.get("local", True)),
                                        task_id=str(body.get("taskId") or "tmsxxxxxxxxx"),
                                        cfg=cfg, unattended=bool(body.get("unattended")),
                                        # Use the executor's actual environment, matching dispatch.
                                        env=ai_prompts.detect_env()),
            "branch": ai_prompts.work_branch(str(body.get("taskId") or "tmsxxxxxxxxx"), cfg)}


# Scheduled assignments use the shared contract with organizational scope.
from .admin_schedules import (
    _sch_api, _sch_apply, _scoped_ai_schedule,
    create_ai_schedule, delete_ai_schedule, list_ai_schedule_runs,
    list_ai_schedules, list_automation_templates, run_ai_schedule,
    save_automation_templates, update_ai_schedule,
    router as schedule_router, template_router,
)


def _iso_utc_dt(dt) -> str:
    """Return an unambiguous UTC ISO timestamp; SQLite naive values are UTC."""
    if not dt:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


router.include_router(template_router)


@router.get("/repos")
async def list_all_repos(user: User = Depends(require_perm("task.view")),
                         session: AsyncSession = Depends(get_session)):
    """List repositories across projects, including project names for the schedule selector."""
    from ..models import Project, Repo
    from ..services import rbac
    from ..services.business_records import business_visible
    scope = await rbac.scope_org_ids(session, user)
    repo_q = select(Repo).where(business_visible(Repo)).order_by(Repo.created_at)
    project_q = select(Project).where(business_visible(Project))
    if scope is not None:
        allowed = scope or {"__none__"}
        repo_q = repo_q.where((Repo.org_id.in_(allowed)) | Repo.org_id.is_(None))
        project_q = project_q.where((Project.org_id.in_(allowed)) | Project.org_id.is_(None))
    rows = (await session.execute(repo_q)).scalars().all()
    pnames = {p.id: p.name for p in (await session.execute(project_q)).scalars().all()}
    return [{**_repo_api(r), "projectName": pnames.get(r.project_id, "")}
            for r in rows if not r.project_id or r.project_id in pnames]
router.include_router(schedule_router)


# MCP servers provide external tools for the mcp-tools skill.
# Store configuration outside repository servers.json files because env may contain credentials.
# Write runtime configuration outside the repository and pass its path to the bridge through the environment.

def _mcp_mask(r: dict) -> dict:
    """Redact env values, HTTP authentication headers, clientSecret, and passwords. Return
    configured field names without plaintext credentials.
    """
    kc = dict(r.get("keycloak") or {})
    for k in ("clientSecret", "password"):
        if kc.get(k):
            kc[k] = "••••"
    return {**r,
            "env": {k: "••••" if v else "" for k, v in (r.get("env") or {}).items()},
            "headers": {k: "••••" if v else "" for k, v in (r.get("headers") or {}).items()},
            "keycloak": kc}


def _mcp_restore(r: dict, prev: dict) -> dict:
    """Preserve stored values for masked fields so unrelated edits cannot erase credentials."""
    def merge(cur: dict, old: dict) -> dict:
        return {k: (old.get(k, "") if str(v) == "••••" else v) for k, v in (cur or {}).items()}
    out = dict(r)
    out["env"] = merge(r.get("env") if isinstance(r.get("env"), dict) else {},
                       prev.get("env") or {})
    out["headers"] = merge(r.get("headers") if isinstance(r.get("headers"), dict) else {},
                           prev.get("headers") or {})
    kc = dict(r.get("keycloak") or {})
    old_kc = dict(prev.get("keycloak") or {})
    for k in ("clientSecret", "password"):
        if str(kc.get(k) or "") == "••••":
            kc[k] = old_kc.get(k, "")
    out["keycloak"] = kc
    return out


@router.get("/mcp-servers")
async def list_mcp_servers(user: User = Depends(require_perm("integration.manage")),
                           session: AsyncSession = Depends(get_session)):
    from ..services import mcp_servers as mcp
    rows = await mcp.load(session)
    from ..services import mcp_company_write
    return {**mcp_company_write.view(rows), "runtimeFile": mcp.runtime_path()}


@router.put("/mcp-servers")
async def save_mcp_servers(body: dict = Body(default_factory=dict),
                           user: User = Depends(require_perm("integration.manage")),
                           session: AsyncSession = Depends(get_session)):
    from ..services import mcp_company_write, mcp_servers as mcp
    saved = await mcp_company_write.legacy_save(session, body)
    await session.commit()
    await audit.log(session, user, "mcp.update", "setting", mcp.SETTING_KEY, "连接器",
                    {"count": len(saved), "names": [r["name"] for r in saved]})
    return {"ok": True, **mcp_company_write.view(saved)}


@router.post("/mcp-servers/upsert")
async def upsert_mcp_server(body: dict = Body(default_factory=dict),
                            user: User = Depends(require_perm("integration.manage")),
                            session: AsyncSession = Depends(get_session)):
    from ..services import mcp_company_write
    saved = await mcp_company_write.save_one(session, body)
    await session.commit()
    await audit.log(session, user, "mcp.upsert", "mcp", str(body["server"]["id"]), "连接器", {})
    return {"ok": True, **mcp_company_write.view(saved)}


@router.delete("/mcp-servers/{item_id}")
async def delete_mcp_server(item_id: str, body: dict = Body(default_factory=dict),
                            user: User = Depends(require_perm("integration.manage")),
                            session: AsyncSession = Depends(get_session)):
    from ..services import mcp_company_write
    saved = await mcp_company_write.delete_one(session, item_id, body)
    await session.commit()
    await audit.log(session, user, "mcp.delete", "mcp", item_id, "连接器", {})
    return {"ok": True, **mcp_company_write.view(saved)}


@router.post("/mcp-servers/probe")
async def probe_mcp_server(body: dict = Body(default_factory=dict),
                           user: User = Depends(require_perm("integration.manage")),
                           session: AsyncSession = Depends(get_session)):
    """Probe each transport at its actual execution location: HTTP on Hub, stdio on an online
    Runner.
    """
    from ..services import mcp_servers as mcp
    spec = dict(body or {})
    # Resolve masked UI credentials to their stored values before probing.
    if str(spec.get("id") or ""):
        prev = next((r for r in await mcp.load(session) if r["id"] == spec["id"]), None)
        if prev:
            spec = _mcp_restore(spec, prev)
    return await mcp.probe_managed(spec)


# Agent Skills catalog.
# A skill is a directory with SKILL.md. Inject the enabled set into the executor.
# Pi uses --skill arguments; other executors receive an instruction list. Store skill scripts and references on disk.
# Filesystem storage also supports cloned skill repositories.

@router.get("/skills")
async def list_skills(user: User = Depends(require_perm("task.dispatch")),
                      session: AsyncSession = Depends(get_session)):
    """Manage the skills allowlist, leaving personal selections to GET/PUT /api/v1/skills. Include
    current usage before administrators revoke access.
    """
    from sqlalchemy import select as _sel

    from ..models import Client as _C
    from ..services import skills as sk
    try:
        cfg, found = await sk.catalog_with_policy(session, include_runner=False)
    except sk.PolicyChanged as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    en = set(cfg["allowed"])
    users: dict[str, int] = {}
    for c in (await session.execute(_sel(_C))).scalars().all():
        for n in (c.skills or []):
            users[str(n)] = users.get(str(n), 0) + 1
    return {"skills": [{**s, "allowed": s["name"] in en, "enabled": s["name"] in en,
                        "inUse": users.get(s["name"], 0)} for s in found],
            "cfg": cfg,
            "homeRoot": sk.home_root(),          # Scan skills placed or cloned into this directory.
            "roots": sk.default_roots() + list(cfg.get("roots") or [])}


@router.put("/skills")
async def put_skills(body: dict = Body(default_factory=dict),
                     user: User = Depends(require_perm("task.dispatch")),
                     session: AsyncSession = Depends(get_session)):
    from ..services import skills as sk
    if "cfg" in body and not isinstance(body["cfg"], dict):
        raise HTTPException(400, detail="企业能力开放策略必须是对象")
    try:
        cfg = await sk.save_cfg(session, body.get("cfg") if isinstance(body.get("cfg"), dict) else body)
    except sk.PolicyChanged as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    await session.commit()
    # Audit the allowed key, which replaced cfg["enabled"] when the allowlist was introduced.
    # Reading the old key raises KeyError after saving the allowlist.
    # Keep auditing consistent with persistence so a successful commit is not reported as a failed request.
    await audit.log(session, user, "skills.update", "setting", sk.SETTING_KEY, "技能库开放清单",
                    {"allowed": cfg["allowed"], "byRepo": list(cfg["byRepo"])})
    return {"ok": True, "cfg": cfg}


# Legacy flow-template routes are retired: /flows, /flow-options, /flow-health, and /dispatch-rules.
# Plugins define workflows; plugin runs and delivery evidence expose gate health and approvals.







@router.get("/model-catalog", dependencies=[Depends(require_perm("integration.manage"))])
async def get_model_catalog(session: AsyncSession = Depends(get_session)):
    from ..services import model_catalog
    return await model_catalog.catalog(session)


@router.put("/model-providers/{pid}")
async def put_model_provider(
    pid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Update a provider; built-in providers may be disabled or reconfigured but not deleted. Empty
    apiKey preserves the stored key.
    """
    from ..models import ModelProvider
    from ..services import model_config_guard
    new_key = str(body.get("apiKey") or "").strip()
    if len(new_key) > 400:
        raise HTTPException(status_code=400, detail="模型服务密钥最多 400 个字符，原密钥未更改")
    p = await model_config_guard.catalog(session, ModelProvider, pid, body.get("expectedRevision"))
    if p is None:
        if len(pid) > 48:
            raise HTTPException(status_code=400, detail="模型服务标识最多 48 个字符，请缩短后再保存")
        p = ModelProvider(id=pid, builtin=False)
        session.add(p)
    if "name" in body:
        p.name = str(body.get("name") or "")[:64]
    if "kind" in body:
        p.kind = str(body.get("kind") or "openai-compat")[:24]
    if "baseUrl" in body:
        b = str(body.get("baseUrl") or "").strip()[:400]
        if b and not b.startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail="接口地址要以 http(s):// 开头")
        p.base_url = b
    if "enabled" in body:
        p.enabled = bool(body.get("enabled"))
    if "note" in body:
        p.note = str(body.get("note") or "")[:300]
    if new_key:
        p.api_key = new_key
    await session.commit()
    from ..services.client_domain_events import models_changed
    await models_changed(session)
    await audit.log(session, user, "model.provider", "setting", pid, p.name,
                    {"baseUrl": p.base_url, "enabled": p.enabled, "keyChanged": bool(new_key)})
    return {"ok": True, "keyChanged": bool(new_key)}


async def _provider_deletion_impact(session, user, provider):
    from ..services import model_provider_impact
    vis = await _visible_client_ids(session, user) if not user.is_super and has_perm(user, "task.view") else None
    return await model_provider_impact.preview(session, user, provider, vis)


@router.get("/model-providers/{pid}/deletion-impact")
async def model_provider_deletion_impact(
    pid: str, user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    provider = await session.get(models.ModelProvider, pid)
    if provider is None:
        raise HTTPException(404, detail="没有这个模型服务")
    if provider.builtin:
        raise HTTPException(400, detail="内置的服务不能删——不想用就停用它")
    return await _provider_deletion_impact(session, user, provider)


@router.delete("/model-providers/{pid}")
async def del_model_provider(
    pid: str,
    expectedRevision: str | None = None,
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
    confirmId: str | None = None, expectedImpact: str | None = None,
):
    from sqlalchemy import delete as _del

    from ..models import ModelDef, ModelProvider
    from ..services import model_config_guard
    p = await model_config_guard.catalog(session, ModelProvider, pid, expectedRevision)
    if p is None:
        raise HTTPException(status_code=404, detail="没有这个模型服务")
    if p.builtin:
        raise HTTPException(status_code=400, detail="内置的服务不能删——不想用就停用它")
    if confirmId is None or not expectedImpact:
        raise HTTPException(428, detail="请刷新管理端，预览删除影响并输入服务 ID 后再删除")
    if confirmId != pid:
        raise HTTPException(400, detail="输入的服务 ID 不匹配")
    impact = await _provider_deletion_impact(session, user, p)
    if impact["impactRevision"] != expectedImpact:
        raise HTTPException(409, detail="删除影响已变化，请重新核对清单后确认")
    await session.execute(_del(ModelDef).where(ModelDef.provider_id == pid))
    await session.delete(p)
    await session.commit()
    from ..services.client_domain_events import models_changed
    await models_changed(session)
    await audit.log(session, user, "model.provider.del", "setting", pid, p.name, {})
    return {"ok": True}


@router.post("/model-providers/test-connection", dependencies=[Depends(require_perm("integration.manage"))])
async def test_model_provider_connection(body: dict = Body(default_factory=dict),
                                         session: AsyncSession = Depends(get_session)):
    """List models using draft settings without persisting a provider or its credentials."""
    from ..models import ModelProvider
    from ..services import model_discovery
    base = str(body.get("baseUrl") or "").strip()
    kind = str(body.get("kind") or "openai-compat")
    key = str(body.get("apiKey") or "").strip()
    if not key and body.get("providerId"):
        provider = await session.get(ModelProvider, str(body["providerId"]))
        if provider and provider.api_key:
            if base.rstrip("/") != provider.base_url.rstrip("/") or kind != provider.kind:
                return {"ok": False, "models": [], "code": "model.discovery.reenter-key",
                        "detail": "服务地址或协议已更改，请输入用于测试的密钥"}
            key = provider.api_key
    return await model_discovery.discover(base, key, kind, allow_empty=True)


@router.post("/model-providers/{pid}/discover")
async def discover_model_provider(
    pid: str,
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Ask the saved provider which model identifiers it serves. Read-only: names
    come back for review; importing them stays an explicit model-defs write.
    """
    from ..models import ModelDef, ModelProvider
    from ..services import model_discovery
    p = await session.get(ModelProvider, pid)
    if p is None:
        raise HTTPException(status_code=404, detail="这个模型服务不存在")
    if not p.enabled or not p.base_url or not p.api_key:
        return {"ok": False, "models": [], "known": [],
                "code": "model.discovery.provider-incomplete",
                "detail": "服务需要先启用，并填写地址与密钥后才能读取模型列表"}
    result = await model_discovery.discover(p.base_url, p.api_key, p.kind)
    existing = (await session.execute(
        select(ModelDef.name).where(ModelDef.provider_id == pid))).scalars().all()
    known = set(existing)
    result["known"] = sorted(known)
    result["models"] = [name for name in result["models"] if name not in known]
    if "candidates" in result:
        result["candidates"] = [row for row in result["candidates"] if row["id"] not in known]
    await audit.log(session, user, "model.discover", "setting", pid, p.name,
                    {"ok": result["ok"], "count": len(result["models"])})
    return result


@router.put("/model-defs")
async def put_model_def(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Add a model or change its enabled state. Specify its provider and model ID; credentials
    belong to the provider.
    """
    from ..models import ModelDef, ModelProvider
    from ..services import model_catalog, model_config_guard
    from ..services.model_definition_contracts import ModelConfigTypeError
    pid = str(body.get("providerId") or "").strip()
    name = str(body.get("name") or "").strip()[:160]
    if not pid or not name:
        raise HTTPException(status_code=400, detail="要选一个模型服务、并填模型标识")
    mid = pid + ":" + name
    m = await model_config_guard.catalog(session, ModelDef, mid, body.get("expectedRevision"))
    # Existing SQLite catalogs may contain longer identifiers from older versions.
    # Keep those exact rows editable; never truncate or rename their identities.
    if m is None and len(mid) > 64:
        raise HTTPException(status_code=400, detail="模型服务标识加模型标识共超过 64 个字符，请缩短模型标识")
    provider = await session.get(ModelProvider, pid, populate_existing=True)
    if provider is None:
        raise HTTPException(status_code=400, detail="这个模型服务不存在")
    created = m is None
    if created:
        m = ModelDef(id=mid, provider_id=pid, name=name, builtin=False)
        session.add(m)
    if "label" in body:
        m.label = str(body.get("label") or "")[:80]
    if "enabled" in body:
        m.enabled = bool(body.get("enabled"))
    if "modality" in body:
        m.modality = model_catalog.normalize_modality(body.get("modality"))
    if "config" in body or "modality" in body:
        try:
            m.config = model_catalog.clean_model_config(
                body.get("config") if "config" in body else m.config,
                m.modality,
            )
        except ValueError as exc:
            headers = {"X-Error-Code": "model.config.invalid-object"} if isinstance(exc, ModelConfigTypeError) else None
            raise HTTPException(status_code=400, detail=str(exc), headers=headers) from exc
    if "note" in body:
        m.note = str(body.get("note") or "")[:300]
    try:
        from ..services.model_capabilities import validate_limits
        m.ctx_window = validate_limits(body.get("ctxWindow", m.ctx_window), m.config or {})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    receipt = {}
    if created and model_catalog.normalize_modality(m.modality) == "chat":
        receipt = await model_catalog.creation_receipt(session, provider, m)
    await session.commit()
    from ..services.client_domain_events import models_changed
    await models_changed(session)
    await audit.log(
        session, user, "model.def", "setting", mid, m.label or name,
        {"enabled": m.enabled, "modality": m.modality},
    )
    return {"ok": True, "id": mid, **receipt}


@router.delete("/model-defs/{mid:path}")
async def del_model_def(
    mid: str,
    expectedRevision: str | None = None,
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    from ..models import ModelDef
    from ..services import model_config_guard
    m = await model_config_guard.catalog(session, ModelDef, mid, expectedRevision)
    if m is None:
        raise HTTPException(status_code=404, detail="没有这个模型")
    if m.builtin:
        raise HTTPException(status_code=400, detail="内置模型不能删——不想开放就停用它")
    await session.delete(m)
    await session.commit()
    from ..services.client_domain_events import models_changed
    await models_changed(session)
    await audit.log(session, user, "model.def.del", "setting", mid, m.label or m.name, {})
    return {"ok": True}


# Subordinate task assignment and visibility.

async def _user_box_ids(session: AsyncSession, uid: str) -> list[str]:
    res = await session.execute(select(Client.id).where(Client.user_ref == uid))
    return [r[0] for r in res.all()]


@router.get("/subordinates")
async def subordinates(user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)):
    """List other users in the caller's scope with client availability and task summaries.
    Superusers see all users.
    """
    scope = await rbac.scope_org_ids(session, user)
    uq = select(User)
    if scope is not None:
        uq = uq.where(User.org_id.in_(scope or {"__none__"}))
    users = [u for u in (await session.execute(uq)).scalars().all() if u.id != user.id]
    clients = (await session.execute(select(Client))).scalars().all()
    boxes_by_user: dict[str, list] = {}
    for c in clients:
        if c.user_ref:
            boxes_by_user.setdefault(c.user_ref, []).append(c)
    tasks = (await session.execute(select(Task))).scalars().all()
    tasks_by_client: dict[str, list] = {}
    for t in tasks:
        tasks_by_client.setdefault(t.owner_client_id, []).append(t)
    out = []
    for u in users:
        boxes = boxes_by_user.get(u.id, [])
        allt = [t for b in boxes for t in tasks_by_client.get(b.id, [])]
        d = rbac.user_to_api(u)
        d["boxCount"] = len(boxes)
        d["online"] = any(client_to_api(b, settings.offline_after_seconds)["online"] for b in boxes)
        d["taskOpen"] = sum(1 for t in allt if t.status in ("todo", "doing"))
        d["taskTotal"] = len(allt)
        out.append(d)
    return out


@router.get("/users/{uid}/tasks")
async def subordinate_tasks(
    uid: str, user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)
):
    """Combine tasks from all clients belonging to the specified subordinate."""
    target = await session.get(User, uid)
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    await _assert_user_in_scope(session, user, target)
    boxes = await _user_box_ids(session, uid)
    if not boxes:
        return []
    res = await session.execute(
        select(Task).where(Task.owner_client_id.in_(boxes)).order_by(Task.created_at.desc())
    )
    from ..services import task_requirement_projection
    rows = list(res.scalars().all())
    return await task_requirement_projection.decorate_many(session, rows, [task_to_api(t) for t in rows])


@router.post("/users/{uid}/tasks")
async def create_subordinate_task(
    uid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Dispatch a task to the subordinate's client with origin=dispatch and a live notification."""
    target = await session.get(User, uid)
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    await _assert_user_in_scope(session, user, target)
    title = body.get("title")
    if title is not None and not isinstance(title, str):
        raise HTTPException(status_code=422, detail="需求标题须为字符串")
    if not (title or "").strip():
        raise HTTPException(status_code=400, detail="请填需求标题")
    boxes = await _user_box_ids(session, uid)
    if not boxes:
        raise HTTPException(status_code=400, detail="该下属还没有绑定 SoduWork，无法派需求")
    # Legacy assignment/acceptance templates are retired. Direct assignments use ordinary tasks.
    # The creator becomes the requester through create_task.default_requester and receives completion receipts.
    # Inbox rejection requests rework; mandatory acceptance gates require a plugin workflow.
    leader_name = user.display_name or user.username
    data = {
        "title": title,
        "note": body.get("note") or "",
        "status": "todo",
        "urgent": body.get("urgent"),
        "important": body.get("important"),
        "handler": body.get("handler") or "me",
        "priority": body.get("priority") or "normal",
        "due": body.get("due"),
        "tags": body.get("tags") or [],
        "domainId": body.get("domainId") or "",
        "assigneeUserId": uid,   # Assign to the specified subordinate.
        "source": "领导指派 · " + leader_name,
    }
    creator = (user.id, leader_name)
    created = [await svc.create_task(session, bid, data, origin="dispatch", creator=creator) for bid in boxes]
    await audit.log(session, user, "task.dispatch.sub", "user", uid, target.display_name or target.username,
                    {"title": data["title"], "boxes": len(boxes)})
    return {"created": len(created), "tasks": created}


@router.get("/inbox")
async def list_inbox(
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    """List unclaimed, ownerless tasks in the administrator's visible team inboxes."""
    scope = await rbac.scope_org_ids(session, user)
    return await inbox_svc.list_for_orgs(session, scope)


@router.post("/inbox")
async def create_inbox_task(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Dispatch to a scoped department's inbox for later member claiming."""
    org_id = body.get("orgId") or user.org_id
    title = body.get("title")
    if title is not None and not isinstance(title, str):
        raise HTTPException(status_code=422, detail="需求标题须为字符串")
    if not (title or "").strip():
        raise HTTPException(status_code=400, detail="请填需求标题")
    if not org_id:
        raise HTTPException(status_code=400, detail="请选择目标团队/部门")
    await _assert_org_in_scope(session, user, org_id)
    payload = {
        "title": title, "note": body.get("note") or "",
        "priority": body.get("priority") or "normal", "due": body.get("due"),
        "tags": body.get("tags") or [], "urgent": body.get("urgent"), "important": body.get("important"),
        "domainId": body.get("domainId") or "", "source": "平台派团队 · " + (user.display_name or user.username),
    }
    r = await inbox_svc.create_pool_task(session, org_id, payload, creator=(user.id, user.display_name or user.username))
    await audit.log(session, user, "task.inbox", "task", (r.get("task") or {}).get("id"), payload["title"], {"orgId": org_id})
    return r


@router.post("/inbox/{tid}/assign")
async def assign_inbox_task(
    tid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Assign a visible inbox task to an employee in the caller's management scope and notify the
    employee's client.
    """
    uid = (body.get("userId") or "").strip()
    target = await session.get(User, uid) if uid else None
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    await _assert_user_in_scope(session, user, target)
    scope = await inbox_svc.scope_for_user(session, user)
    r = await inbox_svc.assign_to_user(session, tid, target, scope,
                                       actor_name=user.display_name or user.username, actor_id=user.id)
    if not r.get("ok"):
        code = {"already_claimed": 409, "not_found": 404}.get(r.get("reason"), 400)
        msg = {"not_found": "需求不存在", "already_claimed": "该需求已被认领或已派走",
               "not_in_inbox": "该需求不在收件箱里", "out_of_scope": "该需求不在你的收件箱范围内",
               "no_box": "该员工还没有绑定 SoduWork，无法分配"}.get(r.get("reason"), "分配失败")
        raise HTTPException(status_code=code, detail=msg)
    await audit.log(session, user, "task.assign", "task", tid, (r.get("task") or {}).get("title", ""),
                    {"toUserId": target.id, "toUser": target.display_name or target.username})
    return r


# Administrative inbox views; employees use desktop inbox, report, and board views.

@router.get("/me/inbox")
async def my_inbox(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    """List claimable team tasks; include assignable members when the caller has dispatch
    permission.
    """
    data = await inbox_svc.list_for_user(session, user)
    data["hasBox"] = (await inbox_svc.pick_box(session, user.id)) is not None
    data["canAssign"] = has_perm(user, "task.dispatch")
    if data["canAssign"]:
        scope = await rbac.scope_org_ids(session, user)
        uq = select(User).where(User.is_active.is_(True))
        if scope is not None:
            uq = uq.where(User.org_id.in_(scope or {"__none__"}))
        boxed = {c.user_ref for c in (await session.execute(
            select(Client).where(Client.user_ref.isnot(None))
        )).scalars().all()}
        data["members"] = [{"id": u.id, "name": u.display_name or u.username, "hasBox": u.id in boxed}
                           for u in (await session.execute(uq)).scalars().all()]
    return data


@router.post("/me/inbox/{tid}/claim")
async def claim_my_inbox_task(
    tid: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    """Claim for the signed-in user's own client under the applicable inbox policy."""
    r = await inbox_svc.claim_for_user(session, user, tid)
    if not r.get("ok"):
        if r.get("reason") == "permission_denied":
            raise HTTPException(status_code=403, detail="无该操作权限")
        code = {"already_claimed": 409, "not_found": 404}.get(r.get("reason"), 400)
        msg = {"unassigned": "你还未归属组织，无团队收件箱", "not_found": "需求不存在",
               "already_claimed": "该需求已被别人认领", "out_of_scope": "该需求不在你的团队收件箱内",
               "no_box": "你还没有绑定 SoduWork，请让管理员把 SoduWork 分配给你"}.get(r.get("reason"), "认领失败")
        raise HTTPException(status_code=code, detail=msg)
    return r


@router.post("/dispatch")
async def dispatch(
    body: DispatchCreate,
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Create one dispatched task per target client, restricted to the caller's scope, and notify
    clients immediately.
    """
    if not body.targets:
        raise HTTPException(status_code=400, detail="请至少选择一个目标 SoduWork")
    vis = await _visible_client_ids(session, user)
    data = body.model_dump(exclude={"targets"})
    data["source"] = "平台下发"
    creator = (user.id, user.display_name or user.username)
    created, skipped = [], []
    for cid in body.targets:
        if await session.get(Client, cid) is None or (vis is not None and cid not in vis):
            skipped.append(cid)
            continue
        created.append(await svc.create_task(session, cid, data, origin="dispatch", creator=creator))
    await audit.log(session, user, "task.dispatch", "task", None, data.get("title", ""),
                    {"dispatched": len(created), "targets": len(body.targets)})
    return {"dispatched": len(created), "skipped": skipped, "tasks": created}


# LLM settings for report generation; credentials are write-only.

_LLM_KEYS = ("llm_base_url", "llm_model", "llm_api_key", "llm_models")


def _llm_models(raw: str) -> list:
    """Parse the JSON model list; malformed settings fall back to an empty list so configuration
    remains accessible.
    """
    import json as _json
    try:
        v = _json.loads(raw or "[]")
    except Exception:  # noqa: BLE001
        return []
    return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []


@router.get("/team-module-scope", dependencies=[Depends(require_perm("org.manage"))])
async def get_team_module_scope(session: AsyncSession = Depends(get_session)):
    """Control team-view visibility: managers by default, or everyone."""
    from ..services import team as team_svc
    return {"scope": await team_svc.team_module_scope(session)}


@router.put("/team-module-scope")
async def put_team_module_scope(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("org.manage")),
    session: AsyncSession = Depends(get_session),
):
    from ..services import team as team_svc
    requested_scope = body.get("scope")
    if not isinstance(requested_scope, str) or requested_scope.strip().lower() not in ("everyone", "managers"):
        raise HTTPException(status_code=422, detail="团队模块可见范围仅支持 everyone 或 managers")
    scope = await team_svc.set_team_module_scope(session, requested_scope)
    await audit.log(session, user, "team.module_scope", "setting", None,
                    "团队模块可见范围", {"scope": scope})
    return {"ok": True, "scope": scope}


# Older consoles put the GET result back unchanged when saving the form.
# A fixed non-URL marker preserves that round trip without revealing any URL part.
_HIDDEN_ALERT_URL = "••••••••"


@router.get("/alert-config", dependencies=[Depends(require_perm("integration.manage"))])
async def get_alert_config(session: AsyncSession = Depends(get_session)):
    from ..services import notify
    row = await session.get(models.AppSetting, notify.ALERT_URL_KEY)
    destination = (row.value or "").strip() if row else ""
    return {"configured": bool(destination), "url": _HIDDEN_ALERT_URL if destination else "",
            "usesPlainHttp": destination.lower().startswith("http://")}


@router.put("/alert-config")
async def put_alert_config(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    from ..services import notify
    from ..services.model_runtime import lock_setting

    if not user.is_super:
        raise HTTPException(status_code=403, detail="平台级告警配置仅超级管理员可修改")
    url = body.get("url")
    if url is None or url == _HIDDEN_ALERT_URL:
        row = await session.get(models.AppSetting, notify.ALERT_URL_KEY)
        return {"ok": True, "configured": bool(row and row.value)}
    if not isinstance(url, str):
        raise HTTPException(status_code=422, detail="告警地址必须是字符串")
    url = url.strip()
    if len(url) > 600 or (url and not url.startswith(("http://", "https://"))):
        raise HTTPException(status_code=422, detail="告警地址要以 http:// 或 https:// 开头，最多 600 个字符")
    row = await lock_setting(session, notify.ALERT_URL_KEY, "")
    row.value = url
    configured = bool(url)
    audit.add(session, user, "alert.config", "setting", None, "告警通道",
              {"configured": configured})
    await session.commit()
    return {"ok": True, "configured": configured}


@router.post("/alert-config/test")
async def test_alert_config(
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Send a real test notification to the configured destination."""
    from ..services import client_access, notify

    # The configured channel is shared by all administrators.
    try:
        await email_auth.take_limits(session, [
            (f"alert-test:user:{user.id}", 1, 30),
            ("alert-test:configured-channel", 1, 30),
        ])
    except client_access.ClientAccessError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc),
                            headers={"Retry-After": str(exc.meta.get("retryAfter", 30))}) from exc
    sent = await notify.alert(
        session, "这是一条测试告警：配好了，交付出事时会用这个通道叫人。")
    return {"ok": bool(sent),
            "detail": "发出去了，去群里看看收到没" if sent
            else "没发出去：地址没配，或者这台后端连不上它"}


@router.get("/llm-config", dependencies=[Depends(require_perm("integration.manage"))])
async def get_llm_config(session: AsyncSession = Depends(get_session)):
    """Return redacted LLM settings with key presence and length, never the plaintext key."""
    from ..services import model_config_guard
    cfg = await model_config_guard.setting_values(session, _LLM_KEYS)
    key = cfg.get("llm_api_key", "")
    return {"baseUrl": cfg.get("llm_base_url", ""), "model": cfg.get("llm_model", ""),
            # Expose the model choices available to workflow stages.
            "models": _llm_models(cfg.get("llm_models", "")),
            "keySet": bool(key), "keyLen": len(key), "revision": model_config_guard.fingerprint(cfg)}


@router.put("/llm-config")
async def put_llm_config(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Update LLM settings; omitted or empty apiKey preserves the existing credential."""
    # The LLM gateway is platform-level configuration (#1026): revision only
    # guards concurrent writes, not authorization. Superusers only, mirroring
    # the alert-config and mail-settings gates.
    if not user.is_super:
        raise HTTPException(status_code=403, detail="平台级模型网关配置仅超级管理员可修改")
    import json as _json

    from ..models import AppSetting
    from ..services import llm, model_config_guard
    await model_config_guard.defaults(session, _LLM_KEYS, body.get("expectedRevision"))
    updates = {"llm_base_url": (body.get("baseUrl") or "").strip(),
               "llm_model": (body.get("model") or "").strip()}
    # Change candidate models only when supplied, preserving compatibility with older callers.
    if isinstance(body.get("models"), list):
        names, seen = [], set()
        for x in body["models"][:40]:
            s = str(x).strip()[:120]
            if s and s not in seen:
                seen.add(s)
                names.append(s)
        updates["llm_models"] = _json.dumps(names, ensure_ascii=False)
    new_key = (body.get("apiKey") or "").strip()
    if new_key:
        updates["llm_api_key"] = new_key
    for k, v in updates.items():
        row = (await session.execute(select(AppSetting).where(AppSetting.key == k))).scalars().first()
        if row is None:
            session.add(AppSetting(key=k, value=v))
        else:
            row.value = v
    await session.commit()
    await llm.load(session, force=True)          # Refresh the process cache immediately without requiring a restart.
    await audit.log(session, user, "llm.config", "setting", None, "LLM 配置",
                    {"baseUrl": updates["llm_base_url"], "model": updates["llm_model"],
                     "keyChanged": bool(new_key)})       # Audit whether the credential changed, never its value.
    return {"ok": True, "keyChanged": bool(new_key)}




@router.get("/ai-agents")
async def list_ai_assignees(
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """List dispatchable agents and squads with CLI types. Squad leaders select internal assignees;
    SoduWork does not duplicate that routing.
    """
    import asyncio as _aio

    from ..services import ai_exec, model_catalog
    ctx = await ai_exec.load(session, force=True)
    visible = await _visible_client_ids(session, user)
    if visible is not None:
        ctx["_runnerAllowedClients"] = sorted(visible)
        managed = await rbac.scope_org_ids(session, user)
        inherited = await rbac.ancestor_org_ids(session, str(user.org_id or ""))
        ctx["_runnerAllowedOrgs"] = sorted(set(managed or set()) | inherited)
    # Use a recognizable machine/owner label rather than an opaque hostname alone.
    ctx["_clientNames"] = {c.id: (c.name or "") for c in list((await session.execute(
        select(Client))).scalars().all()) if c.name}
    r = await _aio.to_thread(ai_exec.list_assignees_sync, ctx)
    r["provider"] = ai_exec.provider_name(ctx)
    r["default"] = ai_exec.default_assignee(ctx)
    # Workflow stages select an agent type and model, not a machine-specific instance.
    r["kinds"] = ai_exec.agent_kinds()
    legacy_models = ai_exec.model_choices(ctx)
    mc = await model_catalog.choices(
        session, None, str(legacy_models.get("default") or ""))
    r["defaultModel"] = mc["default"]
    r["models"] = mc["list"]
    r["modelOptions"] = mc["items"]
    if not r["agents"] and not r["squads"]:
        r["reason"] = ("尚未配置托管底座，也没有检测到本机 CLI 或在线 Runner"
                       if not ai_exec.available(ctx) else "当前没有可安排执行的 AI 或小队")
    return r


@router.post("/tasks/{tid}/ai-dispatch")
async def admin_ai_dispatch_task(
    tid: str,
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Authorize admin scope; execute with the owner's environment and admin audit."""
    from ..services.task_dispatch import dispatch
    task = await _assert_task_in_scope(session, user, tid)
    owner = await session.get(Client, task.owner_client_id) if task.owner_client_id else None
    if owner is None or owner.auth_state != "active":
        raise HTTPException(409, "需求负责人尚未绑定可用设备，请先完成设备连接")
    return await dispatch(tid, {}, owner, session, actor=user)


@router.get("/tasks/{tid}/ai-status")
async def admin_ai_status_task(
    tid: str,
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    """Read live execution state and the outputs already collected by the Hub."""
    import asyncio as _aio

    from ..services import ai_exec
    from ..services.dispatch_reconcile import status_for_uncertain
    task = await _assert_task_in_scope(session, user, tid)
    pending = await status_for_uncertain(session, tid)
    if pending:
        return {"dispatched": True, "done": False, **pending}
    ev = await ai_exec.last_dispatch_event(session, tid)   # Recognize historical multica.* events as well.
    if ev is None:
        return {"dispatched": False}
    d = ev.detail or {}
    ctx = await ai_exec.load(session)
    ref = d.get("ref") or d.get("issueId", "")
    status = await _aio.to_thread(ai_exec.preview_status_sync, ctx, ref, d)
    if not (status.get("ok") or status.get("done")):
        from ..services.queued_dispatch_lease import status_for_task
        status.update(await status_for_task(session, tid, ref))
    if status.get("ok") and "attachments" not in status:
        attachments = (await session.execute(select(Attachment.id, Attachment.filename).where(
            Attachment.task_id == tid, Attachment.source_ref == ref,
            Attachment.role.in_(("output", "evidence", "supporting")))
            .order_by(Attachment.filename, Attachment.id))).all()
        status = {**status, "attachments": [{"id": aid, "filename": name} for aid, name in attachments]}
    return {"dispatched": True, "ref": ref, "identifier": d.get("identifier", ""), "url": d.get("url", ""),
            **status, "artifactUrl": status.get("artifactUrl") or task.artifact_url or ""}


@router.post("/tasks/{tid}/ai-status")
async def admin_sync_ai_status_task(
    tid: str, ref: str = Body(..., embed=True, min_length=1, strict=True),
    user: User = Depends(require_perm("task.dispatch")), session: AsyncSession = Depends(get_session),
):
    """Collect the specified dispatch's available outputs within the administrator's scope."""
    import asyncio as _aio

    from ..services import ai_exec
    from ..services.dispatch_reconcile import status_for_uncertain
    task = await _assert_task_in_scope(session, user, tid)
    pending = await status_for_uncertain(session, tid)
    if pending:
        if ref != pending["ref"]:
            raise HTTPException(409, "原执行会话已变化，请刷新需求后重试")
        raise HTTPException(502, "交付结果暂未同步，请恢复本轮重试")
    ev = await ai_exec.last_dispatch_event(session, tid)
    detail = (ev.detail or {}) if ev else {}
    if ref != (detail.get("ref") or detail.get("issueId", "")):
        raise HTTPException(409, "原执行会话已变化，请刷新需求后重试")
    ctx = await ai_exec.load(session)
    result = await _aio.to_thread(ai_exec.status_sync, ctx, ref)
    if not result.get("ok"):
        raise HTTPException(502, "交付结果暂未同步，请恢复本轮重试")
    if result.get("attachments") or result.get("artifactUrl"):
        result["pulled"] = await ai_exec.pull_artifacts(session, tid, ctx, result, ref)
    pulled = result.get("pulled") or {}
    await audit.log(session, user, "task.execution.sync", "task", tid, task.title,
                    {"ref": ref, "files": pulled.get("files", 0), "hasArtifactUrl": bool(pulled.get("url"))})
    return {"dispatched": True, "identifier": detail.get("identifier", ""), "url": detail.get("url", ""), **result}


# Integrations, bindings, and unassigned records.

_REPOSITORY_SOURCE_TYPES = {"github", "gitlab"}


@router.get("/integrations", dependencies=[Depends(require_perm("integration.manage"))])
async def list_integrations(session: AsyncSession = Depends(get_session)):
    return await agg.list_integrations(session)


@router.post("/integrations")
async def create_integration(body: IntegrationCreate,
                             user: User = Depends(require_perm("integration.manage")),
                             session: AsyncSession = Depends(get_session)):
    from ..services import scm_support
    config = body.config
    if body.type.strip().lower() in _REPOSITORY_SOURCE_TYPES:
        await rbac.lock_org_tree(session, shared=True)
        scope = await rbac.scope_org_ids(session, user)
        if scope is not None or "orgId" in config:
            owner = await integration_target_org(session, scope, config.get("orgId", user.org_id))
            config = {**config, "orgId": owner}
    try:
        result = await agg.create_integration(session, body.name, body.type, config)
    except DuplicateName as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except scm_support.RetiredScmError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await audit.log(session, user, "integration.create", "integration",
                    result.get("id"), result.get("name", ""),
                    {"type": result.get("type", "")})
    return result


@router.patch("/integrations/{iid}")
async def update_integration(iid: str, body: IntegrationUpdate,
                             user: User = Depends(require_perm("integration.manage")),
                             session: AsyncSession = Depends(get_session)):
    """Change enabled state and merge integration configuration such as GitLab base_url and
    project.
    """
    from ..services import scm_support
    integration = await repository_catalog.lock_integration(session, iid)
    if integration is None:
        raise HTTPException(status_code=404, detail="集成不存在")
    config = body.config
    if integration.type.strip().lower() in _REPOSITORY_SOURCE_TYPES:
        scope = await rbac.scope_org_ids(session, user)
        current = require_integration_org(scope, (integration.config or {}).get("orgId"))
        if config is not None and "orgId" in config:
            owner = await integration_target_org(session, scope, config["orgId"], current)
            config = {**config, "orgId": owner}
    try:
        r = await agg.update_integration(session, iid, enabled=body.enabled, config=config)
    except scm_support.RetiredScmError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    detail = {"configKeys": sorted(str(key) for key in (body.config or {}).keys())}
    if body.enabled is not None:
        detail["enabled"] = bool(body.enabled)
    await audit.log(session, user, "integration.update", "integration", iid,
                    r.get("name", ""), detail)
    return r


@router.post("/integrations/{iid}/token/rotate")
async def rotate_integration_token(iid: str,
                                   user: User = Depends(require_perm("integration.manage")),
                                   session: AsyncSession = Depends(get_session)):
    """Rotate the access token; reveal plaintext only in this response, never in subsequent reads.

    """
    result = await agg.rotate_integration_token(session, iid)
    if result is None:
        raise HTTPException(status_code=404, detail="集成不存在")
    await audit.log(session, user, "integration.token.rotate", "integration", iid,
                    result.get("name", ""), {"ingestTokenSet": True})
    return result


@router.post("/integrations/{iid}/pull")
async def pull_integration_now(iid: str,
                               user: User = Depends(require_perm("integration.manage")),
                               session: AsyncSession = Depends(get_session)):
    """Run connector.pull immediately and persist the imported records."""
    r = await poller.pull_integration(session, iid)
    if not r.get("ok"):
        reason = r.get("reason", "拉取失败")
        detail = r.get("error") or {
            "not_found": "集成不存在", "disabled": "集成已停用", "no_connector": "该类型不支持拉取",
        }.get(reason, reason)
        raise HTTPException(status_code=404 if reason == "not_found" else 400, detail=detail)
    await audit.log(session, user, "integration.pull", "integration", iid,
                    str(r.get("name") or ""), {"trigger": "manual"})
    return r


@router.delete("/integrations/{iid}")
async def delete_integration(iid: str, user: User = Depends(require_perm("integration.manage")),
                             session: AsyncSession = Depends(get_session)):
    """Delete an integration and its bindings while preserving previously imported tasks."""
    from ..models import Integration, IntegrationBinding
    integ = await session.get(Integration, iid)
    if integ is None:
        raise HTTPException(status_code=404, detail="集成不存在")
    from sqlalchemy import delete as sqldelete
    iname = integ.name
    await session.execute(sqldelete(IntegrationBinding).where(IntegrationBinding.integration_id == iid))
    await session.delete(integ)
    await session.commit()
    await audit.log(session, user, "integration.delete", "integration", iid, iname, {})
    return {"ok": True}


# Audit log.

def _audit_date(value: datetime | None, name: str, alias_value: datetime | None, alias: str) -> datetime | None:
    if value is not None and alias_value is not None and value != alias_value:
        raise HTTPException(422, [{"loc": ["query", alias], "type": "value_error",
                                   "msg": f"{alias} and {name} must identify the same instant"}])
    if alias_value is not None:
        value, name = alias_value, alias
    # SQLite stores UTC without an offset; compare the same instants on both databases.
    try:
        return value.astimezone(timezone.utc) if value is not None else None
    except OverflowError:
        raise HTTPException(422, [{"loc": ["query", name], "type": "value_error",
                                   "msg": "Timestamp is outside the supported UTC range"}]) from None


def _audit_filters(
    action: str | None = None, actor: str | None = None,
    actor_id: Annotated[uuid.UUID | None, Query(alias="actorId")] = None,
    since: AwareDatetime | None = None, until: AwareDatetime | None = None,
    from_date: Annotated[AwareDatetime | None, Query(alias="from")] = None,
    to_date: Annotated[AwareDatetime | None, Query(alias="to")] = None,
):
    since = _audit_date(since, "since", from_date, "from")
    until = _audit_date(until, "until", to_date, "to")
    if since is not None and until is not None and since >= until:
        raise HTTPException(422, "开始时间必须早于结束时间")
    return {"action": action, "actor": actor, "actor_id": str(actor_id) if actor_id is not None else None,
            "since": since, "until": until}


@router.get("/audit")
async def list_audit(
    filters: dict = Depends(_audit_filters),
    limit: Annotated[int, Query(ge=0)] = 50,
    offset: Annotated[int, Query(ge=0, le=2**63-1)] = 0,
    user: User = Depends(require_perm("audit.view")),
    session: AsyncSession = Depends(get_session),
):
    """List audit events for actors in the department subtree; superusers see all events."""
    result = await audit.list_audit(session, user, limit=min(limit, 200), offset=offset, **filters)
    return {**result, "environment": settings.soduwork_env.strip().lower()}


@router.get("/audit/export.csv")
async def export_audit(
    filters: dict = Depends(_audit_filters),
    limit: Annotated[int | None, Query(ge=0, le=2**63-1)] = None,
    offset: Annotated[int, Query(ge=0, le=2**63-1)] = 0,
    user: User = Depends(require_perm("audit.view")),
    session: AsyncSession = Depends(get_session),
):
    """Download matching events after the offset. Omit limit for all matches or use zero for headers only."""
    chunks = await audit.export_csv(session, user, settings.soduwork_env.strip().lower(),
                                    limit=limit, offset=offset, **filters)
    return StreamingResponse(chunks, media_type="text/csv", headers={
        "Content-Disposition": 'attachment; filename="audit-log.csv"',
        "Cache-Control": "no-store",
    })


@router.get("/receipts")
async def list_receipts(
    limit: Annotated[int, Query(ge=0)] = 50,
    offset: Annotated[int, Query(ge=0, le=2**63-1)] = 0,
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    """List completion receipts from TaskEvent(kind='receipt'), scoped by visible task clients, to
    trace requests through resolution.
    """
    from ..schemas import _ms
    query = (select(TaskEvent, Task.title, Task.status)
             .outerjoin(Task, Task.id == TaskEvent.task_id)
             .where(TaskEvent.kind == "receipt"))
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None:
        owners = select(User.id).where(User.org_id.in_(scope))
        query = (query.join(Client, Client.id == Task.owner_client_id)
                 .where(or_(Client.user_ref.is_(None), Client.user_ref.in_(owners))))
    query = query.order_by(TaskEvent.at.desc(), TaskEvent.id.desc()).limit(min(limit, 200)).offset(offset)
    rows = await session.execute(query)
    out = []
    for e, title, status in rows:
        d = receipts.bounded_detail(e.detail or {}, fallback_title=title)
        out.append({
            "id": e.id,
            "taskId": e.task_id,
            "title": d.get("title") or "",
            "requesterName": d.get("to") or "",
            "contact": d.get("contact") or "",
            **({"fieldWarnings": d["fieldWarnings"]} if "fieldWarnings" in d else {}),
            "external": bool(d.get("external")),
            "via": d.get("via") or "",           # box: notify requester; self: self-completion; relay: notify registrar; recorded: retain only.
            "status": status or "",
            "at": _ms(e.at),
        })
    return out


@router.get("/bindings")
async def list_bindings(user: User = Depends(require_perm("binding.manage")),
                        session: AsyncSession = Depends(get_session)):
    rows = await agg.list_bindings(session)
    visible = await _visible_client_ids(session, user)
    if visible is None:
        return rows
    return [row for row in rows if row.get("clientId") in visible]


@router.post("/bindings")
async def create_binding(body: BindingCreate,
                         user: User = Depends(require_perm("binding.manage")),
                         session: AsyncSession = Depends(get_session)):
    client = await session.get(Client, body.client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_in_scope(session, user, client)
    result = await agg.create_binding(
        session, body.integration_id, body.external_actor, body.client_id)
    await audit.log(session, user, "binding.upsert", "integration_binding",
                    result.get("id"), body.external_actor,
                    {"integrationId": body.integration_id,
                     "clientId": body.client_id})
    return result


@router.delete("/bindings/{bid}")
async def delete_binding(bid: str,
                         user: User = Depends(require_perm("binding.manage")),
                         session: AsyncSession = Depends(get_session)):
    binding = await session.get(models.IntegrationBinding, bid)
    if binding is not None:
        client = await session.get(Client, binding.client_id)
        if client is not None:
            await _assert_client_in_scope(session, user, client)
    result = await agg.delete_binding(session, bid)
    if result.get("ok"):
        await audit.log(session, user, "binding.delete", "integration_binding",
                        bid, binding.external_actor if binding else "",
                        {"integrationId": binding.integration_id if binding else "",
                         "clientId": binding.client_id if binding else ""})
    return result


@router.get("/unassigned")
async def list_unassigned(user: User = Depends(require_perm("binding.manage")),
                          session: AsyncSession = Depends(get_session)):
    rows = await agg.list_unassigned(session)
    scope = await rbac.scope_org_ids(session, user)
    if scope is None:
        return rows
    return [row for row in rows if not row.get("poolOrgId")
            or row.get("poolOrgId") in scope]


@router.post("/unassigned/{task_id}/assign")
async def assign_unassigned(task_id: str, body: AssignBody,
                            user: User = Depends(require_perm("binding.manage")),
                            session: AsyncSession = Depends(get_session)):
    client = await session.get(Client, body.client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="SoduWork 不存在")
    await _assert_client_in_scope(session, user, client)
    task = await session.get(Task, task_id)
    if task is not None and task.pool_org_id:
        await _assert_org_in_scope(session, user, task.pool_org_id)
    r = await agg.assign_task(session, task_id, body.client_id, body.create_binding)
    if not r["ok"]:
        raise HTTPException(status_code=404, detail="需求不存在")
    assigned = r.get("task") or {}
    await audit.log(session, user, "task.assign", "task", task_id,
                    assigned.get("title", ""),
                    {"clientId": body.client_id,
                     "createBinding": bool(body.create_binding)})
    return r


# Remote client management over WebSocket.

@router.get("/clients/{cid}")
async def client_detail(
    cid: str,
    user: User = Depends(require_perm("client.view")),
    session: AsyncSession = Depends(get_session),
):
    c = await session.get(Client, cid)
    if c is None:
        raise HTTPException(status_code=404, detail="客户端不存在")
    await _assert_client_in_scope(session, user, c)
    total = await session.scalar(select(func.count()).select_from(Task).where(Task.owner_client_id == cid))
    open_ = await session.scalar(
        select(func.count()).select_from(Task).where(Task.owner_client_id == cid, Task.status.in_(["todo", "doing"]))
    )
    d = client_to_api(c, settings.offline_after_seconds)
    d["config"] = _admin_client_config(c.config)
    d["taskTotal"] = int(total or 0)
    d["taskOpen"] = int(open_ or 0)
    d["connected"] = hub.is_online(cid)
    return d


@router.post("/clients/{cid}/push")
async def client_push(
    cid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("client.control")),
    session: AsyncSession = Depends(get_session),
):
    """Send config.patch, notice, or command messages; persist configuration patches and report
    online delivery.
    """
    c = await session.get(Client, cid)
    if c is None:
        raise HTTPException(status_code=404, detail="客户端不存在")
    await _assert_client_in_scope(session, user, c)
    typ = body.get("type")
    # Hot-update dispatch additionally requires client.update.
    if typ == "command" and body.get("action") == "apply-update" and "client.update" not in getattr(user, "_perms", set()):
        raise HTTPException(status_code=403, detail="无推送热更新权限")
    if typ == "config.patch":
        patch = body.get("patch")
        if patch is None:
            patch = {}
        if not isinstance(patch, dict):
            raise HTTPException(status_code=400, detail="config.patch 必须是对象")
        forbidden = sorted(_CLIENT_PRIVATE_CONFIG_KEYS.intersection(patch))
        if forbidden:
            raise HTTPException(status_code=403,
                                detail="本地模型配置由客户端管理，后台不能读取或修改" if "modelProviders" in forbidden
                                else "首聊状态由客户端报告")
        from ..services import model_config_guard
        await model_config_guard.personal(session, c, allow_patch=True)
        c.config = {**(c.config or {}), **patch}
        await session.commit()
        from ..services.client_domain_events import device_changed
        await device_changed(c, "config")
        await hub.publish(cid, {"type": "config.patch", "patch": patch})
    elif typ == "notice":
        await hub.publish(cid, {"type": "notice", "text": body.get("text") or ""})
    elif typ == "command":
        await hub.publish(cid, {"type": "command", "action": body.get("action"), "payload": body.get("payload")})
    else:
        raise HTTPException(status_code=400, detail="不支持的 type（config.patch|notice|command）")
    delivered = hub.is_online(cid)
    detail = {"type": str(typ or "")}
    if typ == "command":
        detail["action"] = str(body.get("action") or "")[:80]
    await audit.log(session, user, "client.push", "client", cid,
                    c.name or cid, detail)
    return {"ok": True, "delivered": delivered}
