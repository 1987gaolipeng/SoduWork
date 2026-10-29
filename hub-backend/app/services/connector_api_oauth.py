"""Standard authorization-code extensions for API documents, reusing connector_oauth state,
storage, and revocation.
"""
from __future__ import annotations
import asyncio
import base64
import ipaddress
import json
import re
import socket
from urllib.parse import urlsplit, quote_plus
import httpx
from . import connector_api, connector_oauth_registry as registry


def application(spec, approved=True):
    item = connector_api.spec(spec, approved=approved)
    meta = item["apiDefinition"]
    schemes = [(key, s) for key, s in meta["securitySchemes"].items() if s.get("flow") == "authorizationCode"]
    if len(schemes) != 1:
        raise ValueError("请选择且仅配置一个授权码认证方式")
    key, scheme = schemes[0]
    from .mcp_servers import tool_allowed
    scopes = sorted({scope for tool in meta["tools"] if tool_allowed(item, tool["name"])
        and (tool["readOnly"] or item["env"].get("ALLOW_WRITES") == "true")
        for scope in tool.get("security", {}).get(key, [])})
    env = item["env"]
    client_id, secret = env.get(scheme["clientIdKey"], ""), env.get(scheme["clientSecretKey"], "")
    if max(len(client_id), len(secret)) > 4096 or len(" ".join(scopes)) > 4096:
        raise ValueError("平台应用标识或权限清单过长，请拆分连接")
    if not client_id or (scheme["tokenAuth"] != "none" and not secret):
        raise ValueError("请先填写平台应用 Client ID 和所需 Client Secret")
    registry.cipher()
    for url in (scheme["authorizationUrl"], scheme["tokenUrl"]):
        checked_url(url)
    return {**scheme, "family": "api", "id": "api", "clientId": client_id, "clientSecret": secret,
        "redirectUri": registry.callback_url(), "requestedScopes": scopes, "scopes": scopes,
        "tokenField": scheme["tokenKey"], "definitionId": meta["id"], "scheme": key}


def checked_url(url):
    parsed = urlsplit(url)
    dev = registry.get_settings().soduwork_env == "development"
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (dev and local and parsed.scheme == "http"):
        raise ValueError("平台授权地址必须使用 HTTPS")
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("平台授权地址格式不正确")
    return parsed


def allowed_address(value, development=False):
    address = ipaddress.ip_address(value)
    if address.version == 6 and address.ipv4_mapped:
        address = address.ipv4_mapped
    if address.is_link_local or address.is_unspecified or address.is_multicast or address.is_reserved:
        return False
    if str(address) in {"100.100.100.200", "169.254.169.254"}:
        return False
    # Self-hosted identity providers may use private networks; only development fixtures permit Hub loopback access.
    return development or not address.is_loopback


async def addresses(url):
    parsed = checked_url(url)
    host = parsed.hostname.lower().rstrip(".")
    if host in {"metadata.google.internal", "metadata", "host.docker.internal"}:
        raise ValueError("不能访问系统元数据或容器宿主地址")
    try:
        resolved = await asyncio.wait_for(asyncio.to_thread(socket.getaddrinfo, host,
            parsed.port or (443 if parsed.scheme == "https" else 80), socket.AF_UNSPEC, socket.SOCK_STREAM), timeout=5)
        values = tuple(dict.fromkeys(row[4][0] for row in resolved))
        if not values or any(not allowed_address(v, registry.get_settings().soduwork_env == "development" and host in {"localhost", "127.0.0.1", "::1"}) for v in values):
            raise ValueError()
        return values
    except (OSError, ValueError):
        raise ValueError("平台授权地址无法安全解析") from None


async def exchange(app, grant):
    from .connector_oauth import AuthorizationExpired, AuthorizationUnavailable
    # Reuse IP-pinned transport while validating TLS against the original hostname; do not resolve DNS again.
    from .video_generation import _PinnedHTTPTransport
    data = dict(grant)
    headers = {"Accept": "application/json"}
    if app["tokenAuth"] == "client_secret_basic":
        pair = quote_plus(app["clientId"]) + ":" + quote_plus(app["clientSecret"])
        headers["Authorization"] = "Basic " + base64.b64encode(pair.encode()).decode()
    else:
        data["client_id"] = app["clientId"]
        if app["tokenAuth"] == "client_secret_post":
            data["client_secret"] = app["clientSecret"]
    try:
        async with asyncio.timeout(15):
            ips = await addresses(app["tokenUrl"])
            async with httpx.AsyncClient(transport=_PinnedHTTPTransport(ips), trust_env=False,
                    follow_redirects=False, timeout=15) as client:
                async with client.stream("POST", app["tokenUrl"], headers=headers, data=data) as response:
                    chunks, total = [], 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > 65536:
                            raise ValueError()
                        chunks.append(chunk)
                    try:
                        value = json.loads(b"".join(chunks))
                    except ValueError:
                        value = {}
                    if not isinstance(value, dict):
                        raise ValueError()
                    if response.status_code in {400, 401, 403} and (response.status_code != 400 or
                            value.get("error") in {"invalid_grant", "invalid_client", "unauthorized_client", "access_denied", "invalid_scope"}):
                        raise AuthorizationExpired("平台授权已失效或应用配置不正确，请重新连接")
                    if response.status_code not in range(200, 300) or not isinstance(value, dict) or value.get("error"):
                        raise ValueError()
                    return value
    except AuthorizationExpired:
        raise
    except Exception:
        raise AuthorizationUnavailable("平台授权暂时无法验证，请检查网络后重试") from None


def tokens(value, app, previous=None):
    from .connector_oauth import now
    access = value.get("access_token")
    refresh = value.get("refresh_token") or (previous or {}).get("refreshToken") or ""
    if (not isinstance(access, str) or not access or len(access) > 16384 or re.search(r"[\s\x00-\x1f\x7f]", access)
            or not isinstance(refresh, str) or len(refresh) > 16384):
        raise ValueError("平台令牌响应无效")
    if str(value.get("token_type", "")).lower() != "bearer":
        raise ValueError("平台令牌类型不受支持")
    try:
        seconds = int(value.get("expires_in", 0))
    except (TypeError, ValueError):
        seconds = 0
    if isinstance(value.get("expires_in"), bool) or not 1 <= seconds <= 2678400:
        raise ValueError("平台未返回有效的令牌有效期")
    granted = str(value.get("scope") or "").split()
    if granted and not set(app["scopes"]) <= set(granted):
        raise ValueError("平台授权范围不足，请重新授权")
    return {"accessToken": access, "refreshToken": refresh, "expiresAt": now() + seconds,
        "grantedScopes": granted or app["scopes"]}


def validate(record, spec):
    if not connector_api.handles(spec):
        raise ValueError("接口授权不能用于其他连接器")
    app = application(spec)
    old = record.get("apiApplication") or {}
    if any(app.get(key) != old.get(key) for key in ("definitionId", "scheme", "clientId", "clientSecret", "redirectUri")):
        raise ValueError("接口定义或平台应用已变化，请重新连接")
    if not set(app["scopes"]) <= set(old.get("scopes", [])):
        raise ValueError("接口权限范围已扩大，请重新连接")
    return app
