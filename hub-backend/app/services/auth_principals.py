"""Explicit authentication projections, separate from business ORM entities."""
from dataclasses import dataclass
from types import SimpleNamespace

from sqlalchemy import select

from ..auth import verify_claims
from ..models import Client, User, Role
from . import shared_auth_cache


@dataclass(frozen=True)
class DevicePrincipal:
    id: str
    user_ref: str | None
    auth_state: str
    auth_version: int
    automation_conversation_v1: bool = False


async def device_snapshot(session, device_id):
    async def read():
        row = (await session.execute(select(
            Client.id, Client.user_ref, Client.auth_state, Client.auth_version,
            Client.config["automationConversationV1"].label("capability")
        ).where(Client.id == device_id))).mappings().one_or_none()
        if row is None:
            return None
        return {"id": row["id"], "user_ref": row["user_ref"],
                "auth_state": row["auth_state"], "auth_version": row["auth_version"],
                "automation_conversation_v1": row["capability"] == 1}
    return await shared_auth_cache.load("device", device_id, read)


async def user_snapshot(session, user_id):
    async def read():
        row = (await session.execute(select(
            User.id, User.is_active, User.account_deleted_at, User.auth_version,
            User.role_id, User.org_id, User.is_super,
        ).where(User.id == user_id))).mappings().one_or_none()
        if row is None:
            return None
        return {**dict(row), "account_deleted_at": bool(row["account_deleted_at"])}
    return await shared_auth_cache.load("user", user_id, read)


async def from_token(session, token, *, token_type="device"):
    from .device_auth import DeviceAuthError, _assert_active_binding_loaded
    claims = verify_claims(token, token_type=token_type)
    if not claims:
        raise DeviceAuthError("设备会话已失效，请重新连接", 401)
    raw = await device_snapshot(session, str(claims.get("cid") or ""))
    principal = DevicePrincipal(**raw) if raw else None
    # Validate device ownership against claims BEFORE fetching another account.
    owner_id = str(principal.user_ref or "") if principal else ""
    if principal and owner_id != str(claims.get("uid") or ""):
        raise DeviceAuthError("设备归属已变更，请重新连接", 401)
    owner = await user_snapshot(session, owner_id) if owner_id else None
    _assert_active_binding_loaded(principal, SimpleNamespace(**owner) if owner else None, claims)
    return principal, claims


async def active_user(session, client):
    """Read-only services can reuse identity without loading user profile JSON."""
    from fastapi import HTTPException
    value = await user_snapshot(session, str(client.user_ref or ""))
    if (not value or not value["is_active"] or value["account_deleted_at"] or
            client.auth_state != "active"):
        raise HTTPException(403, "请先登录有效的 SoduWork 账号")
    return SimpleNamespace(**value)


async def role_permissions(session, role_id):
    async def read():
        row = (await session.execute(select(Role.id, Role.permissions).where(
            Role.id == role_id))).one_or_none()
        return {"permissions": list(row.permissions or [])} if row else None
    value = await shared_auth_cache.load("role", role_id, read)
    return set(value["permissions"]) if value else set()
