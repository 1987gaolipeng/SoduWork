"""Authenticated capability checks of saved model configurations only."""
from types import SimpleNamespace
import anyio
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client, require_perm
from ..models import Client, Role, User
from ..services import audit, model_capabilities as capabilities, model_capability_probe as probe, model_catalog, model_runtime, model_transport

router = APIRouter(prefix="/api/v1", tags=["models"])


def _revision_conflict():
    return HTTPException(409, "模型配置在检测期间已变更，请重新检测",
                         headers={"X-Error-Code": "model_config_revision_changed"})


async def _target(session, client, provider_id, model):
    providers = await model_catalog.effective_provider_map(session, client)
    if client is not None and provider_id in providers and not providers[provider_id].get("personal"):
        raise HTTPException(403, "组织模型能力只能由管理员检测")
    rows = await model_catalog.usable(session, client)
    row = next((item for item in rows if item["providerId"] == provider_id and item["name"] == model), None)
    if row is None:
        raise HTTPException(404, "请先保存模型，并确认服务已启用且凭据可用")
    conf = await model_catalog.resolve(session, client, model, provider_id=provider_id,
                                       available=rows, providers=providers)
    scope = capabilities.principal_scope(client, row, conf.get("keyFrom"))
    slot, base_revision = capabilities.identity(row, providers[provider_id], conf["key"], scope)
    revision = row["configRevision"]
    if revision == base_revision:
        conf["_legacyCapabilityRevision"] = capabilities.identity(row, providers[provider_id], conf["key"], scope, legacy=True)[1]
    return row, conf, slot, revision


async def _revalidate_principal(session, client_binding, admin_binding, request):
    # Cooperate with catalog/personal edits. UPDATE also supplies a short write
    # lock on SQLite, where SELECT FOR UPDATE is ignored.
    await model_runtime.lock_setting(session, "model_catalog_edit_lock_v1")
    client = None
    if client_binding or admin_binding:
        owner_id = client_binding[1] if client_binding else admin_binding[0]
        await session.execute(update(User).where(User.id == owner_id).values(id=User.id))
        owner = await session.get(User, owner_id, populate_existing=True)
        if owner is None or not owner.is_active or owner.account_deleted_at:
            raise HTTPException(401, "账号授权在检测期间已变更，请重新登录")
        if admin_binding:
            if int(owner.auth_version or 1) != admin_binding[1]:
                raise HTTPException(401, "管理员授权在检测期间已变更，请重新登录")
            if not owner.is_super:
                await session.execute(update(Role).where(Role.id == owner.role_id).values(id=Role.id))
                role = await session.get(Role, owner.role_id, populate_existing=True) if owner.role_id else None
                if role is None or "integration.manage" not in (role.permissions or []):
                    raise HTTPException(403, "模型管理权限已失效")
        if request is not None:
            from ..auth import verify_claims
            scheme, _, token = request.headers.get("authorization", "").partition(" ")
            if scheme in ("Device", "Bearer") and not verify_claims(token,
                    token_type="device" if scheme == "Device" else "user"):
                raise HTTPException(401, "登录授权在检测期间已过期，请重新登录")
    if client_binding:
        # Keep the account-before-device lock order stable across final checks.
        identifier, owner_id, version = client_binding
        await session.execute(update(Client).where(Client.id == identifier).values(id=Client.id))
        client = await session.get(Client, identifier, populate_existing=True)
        if (client is None or client.auth_state != "active" or client.user_ref != owner_id
                or int(client.auth_version or 1) != version):
            raise HTTPException(401, "设备授权在检测期间已变更，请重新登录")
    return client


async def check_saved(body, session, client=None, *, request=None, admin_binding=None):
    if set(body) - {"providerId", "model", "checks", "expectedConfigRevision"}:
        raise HTTPException(400, "能力检测只接受已保存的服务和模型标识")
    provider_id, model = body.get("providerId"), body.get("model")
    checks = body.get("checks", list(probe.CHECKS))
    if (not isinstance(provider_id, str) or not provider_id or not isinstance(model, str) or not model
            or not isinstance(checks, list) or not checks or len(checks) > len(probe.CHECKS)
            or any(not isinstance(item, str) or item not in probe.CHECKS for item in checks)):
        raise HTTPException(400, "请选择已保存的模型和有效的检测项目")
    row, conf, slot, revision = await _target(session, client, provider_id, model)
    if "expectedConfigRevision" in body and body["expectedConfigRevision"] != revision:
        raise _revision_conflict()
    global_scope = capabilities.principal_scope(client, row, conf.get("keyFrom")) == "organization"
    client_binding = (client.id, client.user_ref, int(client.auth_version or 1)) if client is not None else None
    # Release the read transaction before waiting for network work.
    await session.rollback()
    lease = await capabilities.begin_run(session, slot, revision, lifetime=probe.TOTAL_TIMEOUT + 10,
                                         legacy_revision=conf.pop("_legacyCapabilityRevision", None))
    stored = False
    try:
        result = await probe.run(conf, list(dict.fromkeys(checks)))
        checks_passed = all(result["checks"][key]["status"] == "passed" for key in checks)
        session.info.clear()
        session.expire_all()
        client = await _revalidate_principal(session, client_binding, admin_binding, request)
        current, _, current_slot, current_revision = await _target(session, client, provider_id, model)
        if current_revision != revision or current_slot != slot:
            raise _revision_conflict()
        result.update({"providerId": provider_id, "model": model, "configRevision": revision})
        result = await capabilities.persist(session, slot, result, lease=lease)
        stored = True
    finally:
        if not stored:
            with anyio.CancelScope(shield=True):
                await session.rollback()
                await capabilities.release_run(session, slot, lease)
    from ..services import client_domain_events
    if global_scope:
        await client_domain_events.models_changed(session)
    else:
        await client_domain_events.device_changed(client, "models")
    fields = capabilities.runtime_fields(current.get("config") or {}, result)
    return {"ok": checks_passed,
            **result, **fields, "runtimeRevision": capabilities.runtime_revision(revision, fields)}


@router.post("/admin/model-capabilities/check")
async def admin_check(request: Request, body: dict = Body(...), session: AsyncSession = Depends(get_session),
                      user=Depends(require_perm("integration.manage"))):
    # The probe releases its read transaction before network I/O, which expires
    # ORM instances. Keep the authenticated audit identity before that rollback.
    actor = SimpleNamespace(id=user.id, username=user.username,
                            display_name=user.display_name, org_id=user.org_id)
    binding = (user.id, int(user.auth_version or 1))
    result = await model_transport.until_disconnect(request, check_saved(body, session, request=request, admin_binding=binding))
    await audit.log(session, actor, "model.capability_check", "model",
                    result["providerId"] + ":" + result["model"],
                    detail={"checks": {key: value["status"] for key, value in result["checks"].items()}})
    return result


@router.post("/my-models/capabilities/check")
async def client_check(request: Request, body: dict = Body(...), client: Client = Depends(current_client),
                       session: AsyncSession = Depends(get_session)):
    return await model_transport.until_disconnect(request, check_saved(body, session, client, request=request))
