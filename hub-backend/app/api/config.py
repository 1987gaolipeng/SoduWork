"""Per-device configuration stored in client.config, matching the client configuration API."""
from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import Field, TypeAdapter, ValidationError
from typing import Annotated, Literal
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client
from ..models import Client

router = APIRouter(prefix="/api/v1", tags=["config"])

# Model and skill settings are server-owned and saved through dedicated APIs.
# Never include them in generic configuration downloads or apply them from generic uploads.
# Ignore echoed legacy fields instead of rejecting otherwise valid configuration updates.
_CFG_SERVER_OWNED = ("modelProviders", "skillPreferences", "personalConversationRelay", "_configKeys")


_label = TypeAdapter(Annotated[str, Field(strict=True, max_length=160)])
_flag = TypeAdapter(Annotated[bool, Field(strict=True)])
_coordinate = TypeAdapter(Annotated[int, Field(strict=True, ge=-2**31, le=2**31-1)] | None)
_version = TypeAdapter(Annotated[int, Field(strict=True, ge=0, le=1)])
_bindings = TypeAdapter(Annotated[dict[Annotated[str, Field(max_length=80)],
                                      Annotated[str, Field(max_length=120)]], Field(max_length=128)])
_fields = {
    **dict.fromkeys(("theme", "shape", "mode", "gender", "character", "_lastSkinId", "tube",
                     "deskView"), _label),
    "locale": TypeAdapter(Literal["zh-CN", "en-US", "ja-JP", "ko-KR"]),
    "remind": TypeAdapter(Literal["off", "light", "strong"]),
    **dict.fromkeys(("uiScale", "fontScale"), TypeAdapter(Literal["small", "medium", "large"])),
    **dict.fromkeys(("mute", "dockVisible", "petVisible", "trayVisible", "tasksOn", "docked"), _flag),
    **dict.fromkeys(("hubX", "hubY", "dockX", "dockY"), _coordinate),
    **dict.fromkeys(("automationConversationV1", "_defaultLogoVersion", "shortcutBindingsVersion"), _version),
    "shortcutBindings": _bindings,
    "tubeCols": TypeAdapter(Annotated[int, Field(strict=True, ge=1, le=100)]),
}


def _validate_patch(patch):
    for key, value in patch.items():
        if key not in _fields:
            raise HTTPException(422, f"未知配置字段：{key[:80]}")
        try:
            _fields[key].validate_python(value, strict=True)
        except ValidationError:
            raise HTTPException(422, f"配置字段的类型或取值无效：{key}") from None


def _public_config(cfg):
    return {key: value for key, value in cfg.items() if key in _fields}


def _revision(client, config):
    from ..services.model_runtime import fingerprint
    return fingerprint({"device": client.id, "owner": client.user_ref, "settings": config})


def _response(client, cfg, versioned):
    public = _public_config(cfg)
    return {**public, "_configRevision": _revision(client, public), "_configKeys": sorted(_fields)} if versioned else public


def _check_revision(client, current, patch, expected):
    if expected is not None and expected != _revision(client, current):
        raise HTTPException(409, "设置已在其他窗口更新，请重新核对后保存")
    if expected is None and any(key in current and current[key] != value for key, value in patch.items()):
        raise HTTPException(428, "更改已保存的设置前需要读取当前配置版本")


def _strip_server_owned(cfg: dict) -> dict:
    for k in _CFG_SERVER_OWNED:
        cfg.pop(k, None)
    return cfg


@router.get("/config")
async def get_config(client: Client = Depends(current_client), withRevision: bool = False):
    return _response(client, _strip_server_owned(dict(client.config or {})), withRevision)


@router.put("/config")
async def put_config(
    patch: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
    withRevision: bool = False,
):
    from ..services import model_config_guard
    expected = patch.pop("_configRevision", None)
    _strip_server_owned(patch)
    _validate_patch(patch)
    await model_config_guard.personal(session, client, allow_patch=True)
    _check_revision(client, _public_config(client.config or {}), patch, expected)
    client.config = {**(client.config or {}), **(patch or {})}
    await session.commit()
    from ..services.client_domain_events import device_changed
    await device_changed(client, "config")
    return _response(client, _strip_server_owned(dict(client.config or {})), withRevision)
