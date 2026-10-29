"""FastAPI authentication dependencies for devices, users and integrations."""
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import verify_user_claims
from .config import get_settings
from .db import get_session
from .models import Client, Integration, Role, User
from .permissions import ALL_KEYS
from .services import client_access, device_auth

settings = get_settings()


async def authenticated_client(
    authorization: str | None = Header(default=None),
    x_soduwork_device: str | None = Header(default=None, alias="X-Soduwork-Device"),
    x_soduwork_secret: str | None = Header(default=None, alias="X-Soduwork-Secret"),
    session: AsyncSession = Depends(get_session),
) -> Client:
    """Authenticate a device session, with a bounded hash-only rollout bridge."""
    if authorization and authorization.startswith("Device "):
        try:
            client = await device_auth.client_from_session(session, authorization[7:].strip())
        except device_auth.DeviceAuthError as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    elif settings.device_auth_compat and x_soduwork_device and x_soduwork_secret:
        try:
            client = await device_auth.client_from_secret(session, x_soduwork_device, x_soduwork_secret)
        except device_auth.DeviceAuthError as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    else:
        raise HTTPException(status_code=401, detail="需要有效的 SoduWork 设备会话")
    if device_auth.should_write_last_seen(client.id):
        client.last_seen_at = datetime.now(timezone.utc)
        await session.commit()
    return client


async def enforce_client_quota(session: AsyncSession, client: Client) -> dict:
    try:
        # Consume only this authentication query's rules, never a prior request's cache.
        rows = client.__dict__.pop("_quota_policy_rows", None)
        status = await client_access.assert_quota(session, str(client.user_ref or ""), policy_rows=rows)
    except client_access.ClientAccessError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc
    client._token_quota_status = status
    return status


async def current_client(
    client: Client = Depends(authenticated_client),
) -> Client:
    """Keep authenticated business data available independently of AI quota."""
    return client


async def current_ai_client(
    client: Client = Depends(authenticated_client),
    session: AsyncSession = Depends(get_session),
) -> Client:
    """Check fresh account quota only when authorizing new AI work or tickets."""
    await enforce_client_quota(session, client)
    return client


# Administrative authentication: signed bearer token to user and permissions.
async def current_user(
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="需要登录")
    claims = verify_user_claims(authorization[7:])
    if not claims:
        raise HTTPException(status_code=401, detail="登录已失效，请重新登录")
    user = await session.get(User, str(claims.get("uid") or ""))
    if user is None or not user.is_active or user.account_deleted_at:
        raise HTTPException(status_code=401, detail="账号不存在或已停用")
    if int(claims.get("ver") or 0) != int(user.auth_version or 1):
        raise HTTPException(status_code=401, detail="登录授权已变更，请重新登录")
    # Attach effective permissions in memory: all for superusers, otherwise role permissions.
    if user.is_super:
        user._perms = set(ALL_KEYS)
    elif user.role_id:
        role = await session.get(Role, user.role_id)
        user._perms = set(role.permissions or []) if role else set()
    else:
        user._perms = set()
    return user


def has_perm(user: User, key: str) -> bool:
    return key in getattr(user, "_perms", set())


def require_perm(key: str):
    """Require a permission on the authenticated user, returning HTTP 403 when absent."""
    async def dep(user: User = Depends(current_user)) -> User:
        if not has_perm(user, key):
            raise HTTPException(status_code=403, detail="无该操作权限")
        return user
    setattr(dep, "__soduwork_permissions__", (key,))
    return dep


def require_any_perm(*keys: str):
    """Allow read models shared by operators and capability users."""
    wanted = tuple(str(key) for key in keys if str(key))

    async def dep(user: User = Depends(current_user)) -> User:
        if not wanted or not any(has_perm(user, key) for key in wanted):
            raise HTTPException(
                status_code=403,
                detail="\u65e0\u8be5\u64cd\u4f5c\u6743\u9650",
            )
        return user
    setattr(dep, "__soduwork_permissions__", wanted)
    return dep


async def current_integration(
    x_ingest_token: str | None = Header(default=None, alias="X-Ingest-Token"),
    session: AsyncSession = Depends(get_session),
) -> Integration:
    """Resolve an integration from its X-Ingest-Token for ingest and webhook authentication."""
    if not x_ingest_token:
        raise HTTPException(status_code=401, detail="缺少 X-Ingest-Token")
    res = await session.execute(select(Integration).where(Integration.ingest_token == x_ingest_token))
    integ = res.scalar_one_or_none()
    if integ is None:
        raise HTTPException(status_code=401, detail="无效的 ingest token")
    if not integ.enabled:
        raise HTTPException(status_code=403, detail="该集成已停用")
    return integ
