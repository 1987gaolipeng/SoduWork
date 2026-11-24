"""First-chat checklist for the signed-in user's desktop and available models."""
from time import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, StrictBool
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client, require_perm
from ..models import Client, User
from ..services import model_catalog, model_config_guard
from ..services.desktop_login_policy import DESKTOP_PLATFORMS

router = APIRouter(prefix="/api/v1", tags=["first-chat"])
REPORT_KEY = "firstChatReadiness"
REPORT_TTL = 5 * 60


class DesktopReadiness(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runtimeReady: StrictBool | None
    modelReady: StrictBool | None


def _report(device):
    data = (device.config or {}).get(REPORT_KEY)
    if (isinstance(data, dict) and data.get("owner") == device.user_ref
            and data.get("version") == device.auth_version and isinstance(data.get("checkedAt"), int)):
        return data
    return {}


@router.put("/first-chat-readiness")
async def report_readiness(body: DesktopReadiness, client: Client = Depends(current_client),
                           session: AsyncSession = Depends(get_session)):
    binding = (client.user_ref, client.auth_version)
    await model_config_guard.personal(session, client, allow_patch=True)
    if not client.user_ref or client.auth_state != "active" or (client.user_ref, client.auth_version) != binding:
        raise HTTPException(401, "设备登录状态已变化，请重新登录")
    client.config = {**(client.config or {}), REPORT_KEY: {
        **body.model_dump(), "checkedAt": int(time()), "owner": client.user_ref, "version": client.auth_version}}
    await session.commit()
    return {"ok": True}


@router.get("/admin/first-chat-readiness")
async def first_chat_readiness(user: User = Depends(require_perm("integration.manage")),
                               session: AsyncSession = Depends(get_session)):
    devices = await session.scalars(select(Client).where(
        Client.user_ref == user.id, Client.auth_state == "active"
    ).order_by(Client.last_seen_at.desc().nulls_last(), Client.id))
    desktops = (d for d in devices if (d.platform or "").split("/", 1)[0].strip().lower() in DESKTOP_PLATFORMS)
    # An account can have older clients without a report. Prefer the most recent
    # observation; the stable query order breaks ties and supplies a legacy device.
    device = max(desktops, key=lambda d: _report(d).get("checkedAt", 0), default=None)
    report = _report(device) if device else {}
    if report.get("checkedAt", 0) < time() - REPORT_TTL:
        report = {}
    providers = await model_catalog.effective_provider_map(session, device)
    provider_ready = any(p["enabled"] and p["baseUrl"] and model_catalog.provider_key(p, device)[0]
                         for p in providers.values())
    return {"providerReady": provider_ready,
            "chatModelReady": bool(await model_catalog.usable(session, device, "chat")),
            "runtimeReady": report.get("runtimeReady"), "modelReady": report.get("modelReady")}
