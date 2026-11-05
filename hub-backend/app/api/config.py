"""Per-device configuration stored in client.config, matching the client configuration API."""
from fastapi import APIRouter, Body, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client
from ..models import Client

router = APIRouter(prefix="/api/v1", tags=["config"])

# Model and skill settings are server-owned and saved through dedicated APIs.
# Never include them in generic configuration downloads or apply them from generic uploads.
# Ignore echoed legacy fields instead of rejecting otherwise valid configuration updates.
_CFG_SERVER_OWNED = ("modelProviders", "skillPreferences")


def _strip_server_owned(cfg: dict) -> dict:
    for k in _CFG_SERVER_OWNED:
        cfg.pop(k, None)
    return cfg


@router.get("/config")
async def get_config(client: Client = Depends(current_client)):
    return _strip_server_owned(dict(client.config or {}))


@router.put("/config")
async def put_config(
    patch: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    from ..services import model_config_guard
    _strip_server_owned(patch)
    await model_config_guard.personal(session, client, allow_patch=True)
    client.config = {**(client.config or {}), **(patch or {})}
    await session.commit()
    from ..services.client_domain_events import device_changed
    await device_changed(client, "config")
    return _strip_server_owned(dict(client.config or {}))
