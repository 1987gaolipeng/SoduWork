"""Authenticated capability checks of saved model configurations only."""
from types import SimpleNamespace
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client, require_perm
from ..models import Client
from ..services import audit, model_capabilities as capabilities, model_capability_probe as probe, model_catalog

router = APIRouter(prefix="/api/v1", tags=["models"])


async def _target(session, client, provider_id, model):
    rows = await model_catalog.usable(session, client)
    row = next((item for item in rows if item["providerId"] == provider_id and item["name"] == model), None)
    if row is None:
        raise HTTPException(404, "请先保存模型，并确认服务已启用且凭据可用")
    providers = await model_catalog.effective_provider_map(session, client)
    conf = await model_catalog.resolve(session, client, model, provider_id=provider_id,
                                       available=rows, providers=providers)
    scope = capabilities.principal_scope(client, row, conf.get("keyFrom"))
    slot, revision = capabilities.identity(row, providers[provider_id], conf["key"], scope)
    return row, conf, slot, revision


async def check_saved(body, session, client=None):
    if set(body) - {"providerId", "model", "checks"}:
        raise HTTPException(400, "能力检测只接受已保存的服务和模型标识")
    provider_id, model = body.get("providerId"), body.get("model")
    checks = body.get("checks", list(probe.CHECKS))
    if (not isinstance(provider_id, str) or not provider_id or not isinstance(model, str) or not model
            or not isinstance(checks, list) or not checks or len(checks) > len(probe.CHECKS)
            or any(not isinstance(item, str) or item not in probe.CHECKS for item in checks)):
        raise HTTPException(400, "请选择已保存的模型和有效的检测项目")
    row, conf, slot, revision = await _target(session, client, provider_id, model)
    global_scope = capabilities.principal_scope(client, row, conf.get("keyFrom")) == "organization"
    client_id = client.id if client is not None else None
    # Release the read transaction before waiting for network work.
    await session.rollback()
    result = await probe.run(conf, list(dict.fromkeys(checks)))
    session.info.clear()
    if client_id is not None:
        client = await session.get(Client, client_id, populate_existing=True)
        if client is None or client.auth_state != "active":
            raise HTTPException(401, "设备授权已失效，请重新登录")
    current, _, _, current_revision = await _target(session, client, provider_id, model)
    if current_revision != revision:
        raise HTTPException(409, "模型配置在检测期间已变更，请重新检测")
    result.update({"providerId": provider_id, "model": model, "configRevision": revision})
    result = await capabilities.persist(session, slot, result)
    from ..services import client_domain_events
    if global_scope:
        await client_domain_events.models_changed(session)
    else:
        await client_domain_events.device_changed(client, "models")
    fields = capabilities.runtime_fields(current.get("config") or {}, result)
    return {"ok": all(item["status"] == "passed" for item in result["checks"].values()),
            **result, **fields, "runtimeRevision": capabilities.runtime_revision(revision, fields)}


@router.post("/admin/model-capabilities/check")
async def admin_check(body: dict = Body(...), session: AsyncSession = Depends(get_session),
                      user=Depends(require_perm("integration.manage"))):
    # The probe releases its read transaction before network I/O, which expires
    # ORM instances. Keep the authenticated audit identity before that rollback.
    actor = SimpleNamespace(id=user.id, username=user.username,
                            display_name=user.display_name, org_id=user.org_id)
    result = await check_saved(body, session)
    await audit.log(session, actor, "model.capability_check", "model",
                    result["providerId"] + ":" + result["model"],
                    detail={"checks": {key: value["status"] for key, value in result["checks"].items()}})
    return result


@router.post("/my-models/capabilities/check")
async def client_check(body: dict = Body(...), client: Client = Depends(current_client),
                       session: AsyncSession = Depends(get_session)):
    return await check_saved(body, session, client)
