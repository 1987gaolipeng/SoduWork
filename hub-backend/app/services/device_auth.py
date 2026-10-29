"""SoduWork device enrollment, activation and short-lived session verification."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import time
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from starlette.websockets import WebSocket

from ..auth import sign_claims, verify_claims
from ..models import AppSetting, Client, User
from . import plugin_mcp_limits


SESSION_TTL_SECONDS = 30 * 60
AGENT_TTL_SECONDS = 12 * 60 * 60
PLUGIN_MCP_TTL_SECONDS = 30 * 60
_DEVICE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$")
LAST_SEEN_WRITE_INTERVAL_SECONDS = 30.0
_LAST_SEEN_WRITES: dict[str, float] = {}


def should_write_last_seen(client_id: str, now: float | None = None) -> bool:
    """Claim one bounded presence write for a device without weakening auth."""
    key = str(client_id or "")
    current = time.monotonic() if now is None else float(now)
    previous = _LAST_SEEN_WRITES.get(key, float("-inf"))
    if current - previous < LAST_SEEN_WRITE_INTERVAL_SECONDS:
        return False
    _LAST_SEEN_WRITES[key] = current
    if len(_LAST_SEEN_WRITES) > 10_000:
        cutoff = current - LAST_SEEN_WRITE_INTERVAL_SECONDS * 4
        for stale in [item for item, seen in _LAST_SEEN_WRITES.items() if seen < cutoff]:
            _LAST_SEEN_WRITES.pop(stale, None)
    return True



class DeviceAuthError(ValueError):
    def __init__(self, message: str, status: int = 401):
        super().__init__(message)
        self.status = status


def validate_device_id(value: str) -> str:
    device = str(value or "").strip()
    if not _DEVICE_RE.fullmatch(device):
        raise DeviceAuthError("设备标识格式不正确", 422)
    return device


def validate_secret(value: str) -> str:
    secret = str(value or "").strip()
    if len(secret) < 32 or len(secret) > 256:
        raise DeviceAuthError("设备密钥格式不正确", 422)
    return secret


# WebSocket first-frame authentication.
# Keep credentials out of URLs because proxies and access logs may record them.
# The first frame supplies auth, device, and session or secret fields.
# DEVICE_AUTH_COMPAT controls the temporary query-parameter compatibility path.
WS_AUTH_FRAME_TIMEOUT = 10.0


async def creds_from_first_frame(websocket: WebSocket, device: str) -> tuple[str, str] | None:
    """Wait for the first auth frame and return secret/session, or None on timeout, mismatch, or
    disconnect. The frame's device must match the URL routing device.
    """
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=WS_AUTH_FRAME_TIMEOUT)
    except Exception:  # noqa: BLE001 - Treat timeouts and disconnects as authentication failure.
        return None
    try:
        msg = json.loads(raw)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(msg, dict) or msg.get("t") != "auth":
        return None
    frame_device = str(msg.get("device") or "")
    if frame_device and frame_device != device:
        return None
    return str(msg.get("secret") or ""), str(msg.get("session") or "")


def hash_secret(secret: str) -> str:
    return hashlib.sha256(str(secret or "").encode("utf-8")).hexdigest()


def secret_matches(client: Client | None, secret: str) -> bool:
    have = str(getattr(client, "secret_hash", "") or "")
    return bool(have and secret and hmac.compare_digest(have, hash_secret(secret)))


def issue_session(client: Client) -> tuple[str, int]:
    if client.auth_state != "active" or not client.user_ref:
        raise DeviceAuthError("这台 SoduWork 还没有被管理员激活", 403)
    token = sign_claims(
        {"cid": client.id, "uid": client.user_ref, "ver": int(client.auth_version or 1)},
        ttl_seconds=SESSION_TTL_SECONDS,
        token_type="device",
    )
    return token, SESSION_TTL_SECONDS


def issue_proxy_ticket(client: Client) -> tuple[str, int]:
    if client.auth_state != "active" or not client.user_ref:
        raise DeviceAuthError("这台 SoduWork 还没有被管理员激活", 403)
    token = sign_claims(
        {"cid": client.id, "uid": client.user_ref, "ver": int(client.auth_version or 1)},
        ttl_seconds=AGENT_TTL_SECONDS,
        token_type="ai-proxy",
    )
    return token, AGENT_TTL_SECONDS


def issue_mcp_ticket(client: Client) -> tuple[str, int]:
    if client.auth_state != "active" or not client.user_ref:
        raise DeviceAuthError("这台 SoduWork 还没有被管理员激活", 403)
    token = sign_claims(
        {"cid": client.id, "uid": client.user_ref, "ver": int(client.auth_version or 1)},
        ttl_seconds=AGENT_TTL_SECONDS,
        token_type="device-mcp",
    )
    return token, AGENT_TTL_SECONDS


def issue_plugin_mcp_ticket(
    client: Client,
    binding_ids: list[str] | None = None,
    personal_mcp: list[str] | None = None,
    conversation_ref: str = "",
    plugin_version_ids: list[str] | None = None,
) -> tuple[str, int]:
    """Issue a short-lived MCP capability for one resolved conversation turn.

    The ticket contains only immutable binding ids and logical MCP names. URLs,
    headers and secrets remain on the Hub and are re-resolved on every call.
    """
    if client.auth_state != "active" or not client.user_ref:
        raise DeviceAuthError("这台 SoduWork 还没有被管理员激活", 403)
    bindings = list(dict.fromkeys(
        str(value or "").strip()[:36] for value in (binding_ids or [])
        if str(value or "").strip()))[:3]
    personal = list(dict.fromkeys(
        str(value or "").strip()[:128] for value in (personal_mcp or [])
        if str(value or "").strip()))[:20]
    token = sign_claims(
        {
            "cid": client.id,
            "uid": client.user_ref,
            "ver": int(client.auth_version or 1),
            "bids": bindings,
            "pvids": list(dict.fromkeys(
                str(value).strip()[:36] for value in (plugin_version_ids or [])
                if str(value).strip()))[:3],
            "pmcp": personal,
            "ref": str(conversation_ref or "").strip()[:120],
            **plugin_mcp_limits.ticket_claims(),
        },
        ttl_seconds=PLUGIN_MCP_TTL_SECONDS,
        token_type="plugin-mcp",
    )
    return token, PLUGIN_MCP_TTL_SECONDS


def _assert_active_binding_loaded(client: Client | None, owner: User | None,
                                  claims: dict) -> None:
    if client is None:
        raise DeviceAuthError("这台 SoduWork 尚未登记", 401)
    if client.auth_state != "active" or not client.user_ref:
        raise DeviceAuthError("这台 SoduWork 尚未激活或已被停用", 403)
    if owner is None or not owner.is_active or owner.account_deleted_at:
        raise DeviceAuthError("设备所属账号不存在或已停用", 403)
    if int(claims.get("ver") or 0) != int(client.auth_version or 1):
        raise DeviceAuthError("设备授权已变更，请重新连接", 401)
    if not hmac.compare_digest(str(claims.get("uid") or ""), str(client.user_ref or "")):
        raise DeviceAuthError("设备归属已变更，请重新连接", 401)


async def _binding_with_quota(session: AsyncSession, client_id: str):
    """Read identity and both quota rules in one indexed authentication query."""
    from . import client_access
    default = aliased(AppSetting, name="quota_default")
    personal = aliased(AppSetting, name="quota_personal")
    row = (await session.execute(
        select(Client, User, default.value, personal.value)
        .outerjoin(User, Client.user_ref == User.id)
        .outerjoin(default, default.key == client_access.POLICY_KEY)
        .outerjoin(personal, personal.key == client_access.USER_QUOTA_PREFIX + Client.user_ref)
        .where(Client.id == client_id).execution_options(populate_existing=True)
    )).one_or_none()
    if row:
        row[0]._quota_policy_rows = {
            client_access.POLICY_KEY: row[2],
            client_access.USER_QUOTA_PREFIX + str(row[0].user_ref or ""): row[3],
        }
    return row


async def client_from_session(session: AsyncSession, token: str) -> Client:
    claims = verify_claims(token, token_type="device")
    if not claims:
        raise DeviceAuthError("设备会话已失效，请重新连接", 401)
    row = await _binding_with_quota(session, str(claims.get("cid") or ""))
    client = row[0] if row else None
    _assert_active_binding_loaded(client, row[1] if row else None, claims)
    assert client is not None
    client._device_claims = claims
    return client


async def client_from_proxy_ticket(session: AsyncSession, token: str) -> Client:
    claims = verify_claims(token, token_type="ai-proxy")
    if not claims:
        raise DeviceAuthError("AI 对话凭证已失效，请重新打开对话", 401)
    row = await _binding_with_quota(session, str(claims.get("cid") or ""))
    client = row[0] if row else None
    _assert_active_binding_loaded(client, row[1] if row else None, claims)
    return client


async def principal_from_mcp_ticket(session: AsyncSession, token: str) -> tuple[Client, dict]:
    """Accept either the ordinary SoduWork-tool ticket or a per-turn plugin ticket."""
    claims = verify_claims(token, token_type="device-mcp")
    if claims is None:
        claims = verify_claims(token, token_type="plugin-mcp")
    if not claims:
        raise DeviceAuthError("SoduWork 工具凭证已失效，请重新打开对话", 401)
    client = await session.get(Client, str(claims.get("cid") or ""))
    await assert_active_binding(session, client, claims)
    assert client is not None
    return client, claims


async def client_from_secret(session: AsyncSession, device: str, secret: str) -> Client:
    row = await _binding_with_quota(session, validate_device_id(device))
    client = row[0] if row else None
    if client is None or not secret_matches(client, secret):
        raise DeviceAuthError("设备身份或密钥不正确", 401)
    _assert_active_binding_loaded(client, row[1] if row else None, {
        "uid": client.user_ref,
        "ver": int(client.auth_version or 1),
    })
    return client


async def client_from_transport(
    session: AsyncSession,
    device: str,
    *,
    device_session: str = "",
    secret: str = "",
    allow_legacy: bool = False,
) -> Client:
    """Authenticate an HTTP-upgraded channel with the same rules as REST.

    WebSocket endpoints cannot use the normal header dependency, so they must
    call this helper instead of open-coding a digest comparison.  In
    particular, a matching long-lived key is not enough: the device and its
    owner must still be active.
    """
    expected = validate_device_id(device)
    if device_session:
        client = await client_from_session(session, device_session)
    elif allow_legacy:
        client = await client_from_secret(session, expected, secret)
    else:
        raise DeviceAuthError("需要有效的 SoduWork 设备会话", 401)
    if client.id != expected:
        raise DeviceAuthError("设备会话与设备标识不匹配", 401)
    return client


async def assert_active_binding(session: AsyncSession, client: Client | None, claims: dict) -> None:
    await assert_active_owner(session, client)
    assert client is not None
    if int(claims.get("ver") or 0) != int(client.auth_version or 1):
        raise DeviceAuthError("设备授权已变更，请重新连接", 401)
    if not hmac.compare_digest(str(claims.get("uid") or ""), str(client.user_ref or "")):
        raise DeviceAuthError("设备归属已变更，请重新连接", 401)


async def assert_active_owner(session: AsyncSession, client: Client | None) -> None:
    """Validate the mutable device-owner state before minting or accepting credentials."""
    if client is None:
        raise DeviceAuthError("这台 SoduWork 尚未登记", 401)
    if client.auth_state != "active" or not client.user_ref:
        raise DeviceAuthError("这台 SoduWork 尚未激活或已被停用", 403)
    user = await session.get(User, client.user_ref)
    if user is None or not user.is_active or user.account_deleted_at:
        raise DeviceAuthError("设备所属账号不存在或已停用", 403)


def activate(client: Client, user: User) -> None:
    now = datetime.now(timezone.utc)
    client.user_ref = user.id
    client.auth_state = "active"
    client.auth_version = int(client.auth_version or 0) + 1
    client.activated_at = now
    client.revoked_at = None


def revoke(client: Client) -> None:
    client.auth_state = "revoked"
    client.auth_version = int(client.auth_version or 0) + 1
    client.revoked_at = datetime.now(timezone.utc)


def reset_enrollment(client: Client) -> None:
    client.secret_hash = ""
    client.secret = None
    client.user_ref = None
    client.auth_state = "pending"
    client.auth_version = int(client.auth_version or 0) + 1
    client.activated_at = None
    client.revoked_at = None
