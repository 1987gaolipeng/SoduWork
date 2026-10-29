"""Enterprise identity administration and public OIDC login endpoints."""
from urllib.parse import quote

from fastapi import APIRouter, Body, Cookie, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import require_perm
from ..models import IdentityProvider, Role, User
from ..services import audit, identity, rbac


router = APIRouter(tags=["identity"])


async def _assert_default_assignment(session: AsyncSession, user: User, body: dict,
                                     row: IdentityProvider | None = None) -> None:
    """A delegated identity admin cannot JIT-create accounts above their own authority."""
    if user.is_super:
        return
    org_id = body.get("defaultOrgId", row.default_org_id if row else None) or None
    role_id = body.get("defaultRoleId", row.default_role_id if row else None) or None
    scope = await rbac.scope_org_ids(session, user)
    if org_id and scope is not None and org_id not in scope:
        raise HTTPException(status_code=403, detail="只能把新账号放进自己管理的部门")
    if role_id:
        role = await session.get(Role, role_id)
        own = set(getattr(user, "_perms", set()))
        if role is None or not set(role.permissions or []).issubset(own):
            raise HTTPException(status_code=403, detail="不能给新账号授予高于自己的权限")


@router.get("/api/v1/auth/providers")
async def public_providers(session: AsyncSession = Depends(get_session)):
    return {"items": await identity.list_public(session)}


@router.get("/api/v1/auth/oidc/{key}/start")
async def oidc_start(key: str, session: AsyncSession = Depends(get_session)):
    try:
        url, flow, secure = await identity.begin(session, key)
    except identity.IdentityError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    response = RedirectResponse(url, status_code=302)
    response.set_cookie(identity.FLOW_COOKIE, flow, max_age=300, httponly=True,
                        secure=secure, samesite="lax", path="/api/v1/auth/oidc")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@router.get("/api/v1/auth/oidc/{key}/callback")
async def oidc_callback(
    key: str,
    state: str = Query(default=""),
    code: str = Query(default=""),
    error: str = Query(default=""),
    flow: str = Cookie(default="", alias=identity.FLOW_COOKIE),
    session: AsyncSession = Depends(get_session),
):
    home = identity.success_url()
    if error:
        response = RedirectResponse(home + "#sso_error=" + quote("身份服务取消或拒绝了登录"), status_code=302)
    else:
        try:
            token, _user = await identity.complete(session, flow, state, code, key)
            response = RedirectResponse(home + "#sso=" + quote(token), status_code=302)
        except identity.IdentityError as exc:
            response = RedirectResponse(home + "#sso_error=" + quote(str(exc)), status_code=302)
    response.delete_cookie(identity.FLOW_COOKIE, path="/api/v1/auth/oidc")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@router.get("/api/v1/admin/identity-providers")
async def admin_providers(
    _user: User = Depends(require_perm("identity.manage")),
    session: AsyncSession = Depends(get_session),
):
    return {"items": await identity.list_admin(session)}


@router.post("/api/v1/admin/identity-providers")
async def create_provider(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("identity.manage")),
    session: AsyncSession = Depends(get_session),
):
    await _assert_default_assignment(session, user, body)
    try:
        row = await identity.save(session, body)
    except identity.IdentityError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await audit.log(session, user, "identity_provider.create", "identity_provider",
                    row.id, row.name, {"protocol": row.protocol, "key": row.key})
    return identity.provider_api(row)


@router.patch("/api/v1/admin/identity-providers/{provider_id}")
async def update_provider(
    provider_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("identity.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(IdentityProvider, provider_id)
    if row is None:
        raise HTTPException(status_code=404, detail="身份源不存在")
    await _assert_default_assignment(session, user, body, row)
    try:
        row = await identity.save(session, body, row)
    except identity.IdentityError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await audit.log(session, user, "identity_provider.update", "identity_provider",
                    row.id, row.name, {"enabled": row.enabled, "key": row.key})
    return identity.provider_api(row)


@router.post("/api/v1/admin/identity-providers/{provider_id}/probe")
async def probe_provider(
    provider_id: str,
    user: User = Depends(require_perm("identity.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(IdentityProvider, provider_id)
    if row is None:
        raise HTTPException(status_code=404, detail="身份源不存在")
    result = await identity.probe(session, row)
    await audit.log(session, user, "identity_provider.probe", "identity_provider",
                    row.id, row.name, {"ok": result["ready"]})
    return result


@router.delete("/api/v1/admin/identity-providers/{provider_id}")
async def delete_provider(
    provider_id: str,
    user: User = Depends(require_perm("identity.manage")),
    session: AsyncSession = Depends(get_session),
):
    from sqlalchemy import func, select
    from ..models import IdentityLink
    row = await session.get(IdentityProvider, provider_id)
    if row is None:
        raise HTTPException(status_code=404, detail="身份源不存在")
    links = int(await session.scalar(select(func.count(IdentityLink.id)).where(
        IdentityLink.provider_id == row.id)) or 0)
    if links:
        raise HTTPException(status_code=409, detail="已有账号通过这个身份源登录；请停用，不能删除审计关系")
    await session.delete(row)
    await session.commit()
    await audit.log(session, user, "identity_provider.delete", "identity_provider",
                    row.id, row.name, {})
    return {"ok": True}
