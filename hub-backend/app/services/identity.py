"""Provider-neutral enterprise identity service with a complete OIDC adapter."""
from __future__ import annotations

import base64
import asyncio
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import time
import ipaddress
from urllib.parse import urlencode, urlparse

import httpx
import jwt
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import sign_token
from ..config import get_settings
from ..models import IdentityLink, IdentityProvider, OrgUnit, Role, User


FLOW_COOKIE = "soduwork_oidc_flow"
_KEY_RE = re.compile(r"^[a-z][a-z0-9-]{1,47}$")
_ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ALG_ALLOW = {"RS256", "RS384", "RS512", "PS256", "PS384", "PS512",
              "ES256", "ES384", "ES512"}
_JWKS_CACHE: dict[str, tuple[float, dict]] = {}


class IdentityError(ValueError):
    pass


def _ms(value) -> int | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp() * 1000)


def provider_api(row: IdentityProvider, *, public: bool = False) -> dict:
    if public:
        return {"key": row.key, "name": row.name, "protocol": row.protocol,
                "startUrl": f"/api/v1/auth/oidc/{row.key}/start"}
    secret_set = bool(row.client_secret_env and os.getenv(row.client_secret_env))
    return {
        "id": row.id, "key": row.key, "name": row.name, "protocol": row.protocol,
        "issuer": row.issuer, "clientId": row.client_id,
        "clientSecretEnv": row.client_secret_env, "clientSecretAvailable": secret_set,
        "redirectUri": row.redirect_uri, "scopes": list(row.scopes or []),
        "claimMapping": dict(row.claim_mapping or {}),
        "allowedDomains": list(row.allowed_domains or []), "jitEnabled": row.jit_enabled,
        "defaultOrgId": row.default_org_id or "", "defaultRoleId": row.default_role_id or "",
        "enabled": row.enabled, "probeState": row.probe_state,
        "probeMessage": row.probe_message, "probedAt": _ms(row.probed_at),
        "ready": row.probe_state == "ready",
    }


async def list_admin(session: AsyncSession) -> list[dict]:
    rows = list((await session.execute(select(IdentityProvider).order_by(
        IdentityProvider.created_at))).scalars().all())
    return [provider_api(row) for row in rows]


async def list_public(session: AsyncSession) -> list[dict]:
    rows = list((await session.execute(select(IdentityProvider).where(
        IdentityProvider.enabled.is_(True), IdentityProvider.probe_state == "ready"
    ).order_by(IdentityProvider.name))).scalars().all())
    return [provider_api(row, public=True) for row in rows
            if not row.client_secret_env or os.getenv(row.client_secret_env)]


def _clean_list(value, limit: int, item_limit: int) -> list[str]:
    raw = value if isinstance(value, list) else re.split(r"[,\s]+", str(value or ""))
    out: list[str] = []
    for item in raw:
        text = str(item or "").strip()[:item_limit]
        if text and text not in out:
            out.append(text)
    return out[:limit]


def _validate_url(value: str, label: str, *, strip_trailing: bool = False,
                  allow_query: bool = True) -> str:
    value = str(value or "").strip()
    if strip_trailing:
        value = value.rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username:
        raise IdentityError(f"{label}必须是完整的 http(s) 地址")
    if parsed.fragment:
        raise IdentityError(f"{label}不能带片段")
    if parsed.query and not allow_query:
        raise IdentityError(f"{label}不能带查询参数")
    return value


async def save(session: AsyncSession, body: dict,
               row: IdentityProvider | None = None) -> IdentityProvider:
    key = str((body.get("key") if row is None else body.get("key", row.key)) or "").strip().lower()
    if not _KEY_RE.fullmatch(key):
        raise IdentityError("标识只能用小写字母、数字和短横线，并以字母开头")
    issuer = _validate_url(body.get("issuer") if row is None else body.get(
        "issuer", row.issuer), "Issuer", strip_trailing=True, allow_query=False)
    redirect = _validate_url(body.get("redirectUri") if row is None else body.get("redirectUri", row.redirect_uri), "回调地址")
    client_id = str((body.get("clientId") if row is None else body.get(
        "clientId", row.client_id)) or "").strip()[:300]
    if not client_id:
        raise IdentityError("Client ID 不能为空")
    secret_env = str((body.get("clientSecretEnv") if row is None else body.get(
        "clientSecretEnv", row.client_secret_env)) or "").strip()[:120]
    if secret_env and not _ENV_RE.fullmatch(secret_env):
        raise IdentityError("客户端密钥环境变量名不合法")
    duplicate = (await session.execute(select(IdentityProvider).where(
        IdentityProvider.key == key))).scalar_one_or_none()
    if duplicate is not None and (row is None or duplicate.id != row.id):
        raise IdentityError("这个身份源标识已经存在")
    old_fingerprint = None if row is None else (row.issuer, row.client_id, row.client_secret_env,
                                                row.redirect_uri, tuple(row.scopes or []))
    if row is None:
        row = IdentityProvider(key=key, name=str(body.get("name") or key).strip()[:100])
        session.add(row)
    row.key, row.issuer, row.client_id = key, issuer, client_id
    row.client_secret_env, row.redirect_uri = secret_env, redirect
    row.name = str(body.get("name", row.name) or key).strip()[:100]
    row.protocol = "oidc"
    row.scopes = _clean_list(body.get("scopes", row.scopes or ["openid", "profile", "email"]), 12, 80)
    if "openid" not in row.scopes:
        row.scopes = ["openid", *row.scopes]
    mapping = dict(body.get("claimMapping", row.claim_mapping or {}) or {})
    row.claim_mapping = {
        "username": str(mapping.get("username") or "preferred_username")[:80],
        "displayName": str(mapping.get("displayName") or "name")[:80],
        "email": str(mapping.get("email") or "email")[:80],
    }
    row.allowed_domains = [x.lower() for x in _clean_list(
        body.get("allowedDomains", row.allowed_domains or []), 30, 160)]
    row.jit_enabled = bool(body.get("jitEnabled", row.jit_enabled))
    row.default_org_id = body.get("defaultOrgId", row.default_org_id) or None
    row.default_role_id = body.get("defaultRoleId", row.default_role_id) or None
    if row.default_org_id and await session.get(OrgUnit, row.default_org_id) is None:
        raise IdentityError("默认部门不存在")
    if row.default_role_id and await session.get(Role, row.default_role_id) is None:
        raise IdentityError("默认角色不存在")
    new_fingerprint = (row.issuer, row.client_id, row.client_secret_env,
                       row.redirect_uri, tuple(row.scopes or []))
    if old_fingerprint is not None and old_fingerprint != new_fingerprint:
        row.probe_state, row.probe_message, row.discovery = "untested", "配置已变化，请重新测试", {}
        row.probed_at = None
        row.enabled = False
    requested_enabled = bool(body.get("enabled", row.enabled))
    if requested_enabled and row.probe_state != "ready":
        raise IdentityError("身份源必须先通过“测试连接”才能启用")
    row.enabled = requested_enabled
    await session.commit()
    await session.refresh(row)
    return row


async def _reject_unsafe_target(url: str) -> None:
    """Block loopback/link-local metadata targets while still allowing enterprise RFC1918 IdPs."""
    host = urlparse(url).hostname or ""
    try:
        records = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except OSError as exc:
        raise IdentityError("身份服务域名无法解析") from exc
    for record in records:
        try:
            ip = ipaddress.ip_address(str(record[4][0]).split("%", 1)[0])
        except ValueError:
            continue
        if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
            raise IdentityError("身份服务地址指向不允许访问的本机或链路本地地址")


async def _get_json(url: str) -> dict:
    timeout = max(3, min(30, get_settings().oidc_http_timeout_seconds))
    _validate_url(url, "身份服务地址")
    await _reject_unsafe_target(url)
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(url, headers={"Accept": "application/json"})
            response.raise_for_status()
            await _reject_unsafe_target(str(response.url))
            data = response.json()
    except IdentityError:
        raise
    except httpx.HTTPStatusError as exc:
        raise IdentityError(f"身份服务返回 HTTP {exc.response.status_code}") from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise IdentityError("无法读取身份服务的 JSON 配置") from exc
    if not isinstance(data, dict):
        raise IdentityError("身份服务返回的不是 JSON 对象")
    return data


async def probe(session: AsyncSession, row: IdentityProvider) -> dict:
    try:
        discovery = await _get_json(row.issuer + "/.well-known/openid-configuration")
        if str(discovery.get("issuer") or "").rstrip("/") != row.issuer:
            raise IdentityError("Discovery 返回的 issuer 与配置不一致")
        for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
            endpoint = _validate_url(discovery.get(key), key)
            await _reject_unsafe_target(endpoint)
        if "code" not in list(discovery.get("response_types_supported") or ["code"]):
            raise IdentityError("身份服务不支持 Authorization Code Flow")
        challenges = list(discovery.get("code_challenge_methods_supported") or [])
        if challenges and "S256" not in challenges:
            raise IdentityError("身份服务不支持 PKCE S256")
        if row.client_secret_env and not os.getenv(row.client_secret_env):
            raise IdentityError(f"Hub 环境变量 {row.client_secret_env} 尚未设置")
        methods = list(discovery.get("token_endpoint_auth_methods_supported") or [])
        if row.client_secret_env and methods and not ({"client_secret_basic", "client_secret_post"} & set(methods)):
            raise IdentityError("身份服务不支持当前客户端密钥认证方式")
        if not row.client_secret_env and methods and "none" not in methods:
            raise IdentityError("身份服务要求客户端密钥，请填写对应环境变量名")
        row.discovery = {k: discovery.get(k) for k in (
            "issuer", "authorization_endpoint", "token_endpoint", "jwks_uri",
            "token_endpoint_auth_methods_supported", "code_challenge_methods_supported")}
        row.probe_state, row.probe_message = "ready", "发现地址、回调与密钥引用均可用"
    except Exception as exc:  # noqa: BLE001 - return a safe user-facing probe result
        row.discovery = {}
        row.enabled = False
        row.probe_state = "failed"
        row.probe_message = str(exc)[:500]
    row.probed_at = datetime.now(timezone.utc)
    await session.commit()
    return provider_api(row)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _sign_flow(payload: dict) -> str:
    raw = _b64(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(get_settings().auth_secret.encode("utf-8"), raw.encode("ascii"), hashlib.sha256).digest()
    return raw + "." + _b64(sig)


def _read_flow(value: str) -> dict:
    try:
        raw, signature = str(value or "").split(".", 1)
        expected = _b64(hmac.new(get_settings().auth_secret.encode("utf-8"),
                                 raw.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise IdentityError("登录状态签名不正确")
        data = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        if int(data.get("exp") or 0) < int(time.time()):
            raise IdentityError("登录已超时，请重新开始")
        return data
    except IdentityError:
        raise
    except Exception as exc:
        raise IdentityError("登录状态无效，请重新开始") from exc


async def begin(session: AsyncSession, key: str) -> tuple[str, str, bool]:
    row = (await session.execute(select(IdentityProvider).where(
        IdentityProvider.key == key))).scalar_one_or_none()
    if row is None or not row.enabled or row.probe_state != "ready":
        raise IdentityError("这个企业登录入口尚未启用")
    if row.client_secret_env and not os.getenv(row.client_secret_env):
        raise IdentityError("身份源密钥环境变量当前不可用")
    discovery = dict(row.discovery or {})
    if not discovery.get("authorization_endpoint"):
        raise IdentityError("身份源需要重新测试")
    verifier = secrets.token_urlsafe(64)
    challenge = _b64(hashlib.sha256(verifier.encode("ascii")).digest())
    state, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    flow = _sign_flow({"provider": row.id, "state": state, "nonce": nonce,
                       "verifier": verifier, "exp": int(time.time()) + 300})
    params = {"client_id": row.client_id, "response_type": "code",
              "scope": " ".join(row.scopes or ["openid"]), "redirect_uri": row.redirect_uri,
              "state": state, "nonce": nonce, "code_challenge": challenge,
              "code_challenge_method": "S256"}
    return discovery["authorization_endpoint"] + "?" + urlencode(params), flow, row.redirect_uri.startswith("https://")


async def _jwks(url: str) -> dict:
    cached = _JWKS_CACHE.get(url)
    if cached and cached[0] > time.time() - 300:
        return cached[1]
    data = await _get_json(url)
    if not isinstance(data.get("keys"), list):
        raise IdentityError("JWKS 没有可用的公钥")
    _JWKS_CACHE[url] = (time.time(), data)
    return data


async def _verify_id_token(row: IdentityProvider, token: str, nonce: str) -> dict:
    try:
        header = jwt.get_unverified_header(token)
        alg, kid = str(header.get("alg") or ""), str(header.get("kid") or "")
        if alg not in _ALG_ALLOW or not kid:
            raise IdentityError("身份令牌使用了不受信任的签名算法")
        keys = (await _jwks(str(row.discovery.get("jwks_uri") or ""))).get("keys") or []
        item = next((x for x in keys if str(x.get("kid") or "") == kid), None)
        if item is None:
            _JWKS_CACHE.pop(str(row.discovery.get("jwks_uri") or ""), None)
            keys = (await _jwks(str(row.discovery.get("jwks_uri") or ""))).get("keys") or []
            item = next((x for x in keys if str(x.get("kid") or "") == kid), None)
        if item is None:
            raise IdentityError("身份令牌的签名密钥不存在")
        claims = jwt.decode(token, key=jwt.PyJWK.from_dict(item).key, algorithms=[alg],
                            audience=row.client_id, issuer=row.issuer,
                            options={"require": ["exp", "iat", "iss", "sub"]})
        if not hmac.compare_digest(str(claims.get("nonce") or ""), str(nonce or "")):
            raise IdentityError("身份令牌 nonce 不匹配")
        return claims
    except IdentityError:
        raise
    except jwt.PyJWTError as exc:
        raise IdentityError("身份令牌签名或声明校验失败") from exc


async def _exchange(row: IdentityProvider, code: str, verifier: str) -> dict:
    if not code or not verifier:
        raise IdentityError("授权码或 PKCE 校验信息缺失")
    payload = {"grant_type": "authorization_code", "code": code,
               "redirect_uri": row.redirect_uri, "client_id": row.client_id,
               "code_verifier": verifier}
    secret = os.getenv(row.client_secret_env, "") if row.client_secret_env else ""
    methods = list(row.discovery.get("token_endpoint_auth_methods_supported") or [])
    auth = None
    if secret and "client_secret_basic" in methods:
        auth = httpx.BasicAuth(row.client_id, secret)
    elif secret:
        payload["client_secret"] = secret
    timeout = max(3, min(30, get_settings().oidc_http_timeout_seconds))
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(str(row.discovery.get("token_endpoint") or ""), data=payload, auth=auth,
                                         headers={"Accept": "application/json"})
            if response.status_code >= 400:
                raise IdentityError(f"身份服务拒绝了授权码（HTTP {response.status_code}）")
            data = response.json()
    except IdentityError:
        raise
    except (httpx.HTTPError, ValueError) as exc:
        raise IdentityError("无法连接身份服务完成授权码交换") from exc
    if not isinstance(data, dict) or not data.get("id_token"):
        raise IdentityError("身份服务没有返回 ID Token")
    return data


def _claim(claims: dict, name: str) -> str:
    value = claims.get(name)
    return str(value or "").strip()


async def _resolve_user(session: AsyncSession, row: IdentityProvider, claims: dict) -> User:
    subject = _claim(claims, "sub")[:300]
    if not subject:
        raise IdentityError("身份令牌缺少稳定 subject")
    mapping = dict(row.claim_mapping or {})
    email = _claim(claims, mapping.get("email") or "email")[:300].lower()
    if row.allowed_domains:
        if claims.get("email_verified") is not True:
            raise IdentityError("身份服务没有确认邮箱已验证")
        domain = email.rsplit("@", 1)[-1] if "@" in email else ""
        if domain not in {str(x).lower() for x in row.allowed_domains or []}:
            raise IdentityError("这个账号不属于允许登录的企业域")
    link = (await session.execute(select(IdentityLink).where(
        IdentityLink.provider_id == row.id, IdentityLink.subject == subject))).scalar_one_or_none()
    if link is not None:
        user = await session.get(User, link.user_id)
        if user is None or not user.is_active or user.account_deleted_at:
            raise IdentityError("绑定的 SoduWork 账号不存在或已停用")
    else:
        if not row.jit_enabled:
            raise IdentityError("账号尚未绑定，且该身份源没有开启自动开户")
        base = (_claim(claims, mapping.get("username") or "preferred_username") or
                (email.split("@", 1)[0] if email else "user"))
        base = re.sub(r"[^A-Za-z0-9._-]+", "-", base).strip(".-_")[:48] or "user"
        username, suffix = base, 1
        while (await session.execute(select(User.id).where(User.username == username))).scalar_one_or_none():
            suffix += 1
            username = f"{base[:42]}-{suffix}"
        display = _claim(claims, mapping.get("displayName") or "name")[:64] or username
        user = User(username=username, password_hash="", display_name=display,
                    org_id=row.default_org_id, role_id=row.default_role_id, is_active=True)
        session.add(user)
        await session.flush()
        from . import quota_plans
        await quota_plans.register_trial(session, user.id)
        link = IdentityLink(provider_id=row.id, subject=subject, user_id=user.id)
        session.add(link)
    now = datetime.now(timezone.utc)
    link.email, link.last_login_at = email, now
    link.claims_snapshot = {"sub": subject, "email": email,
                            "name": _claim(claims, mapping.get("displayName") or "name")[:100]}
    user.last_login_at = now
    try:
        await session.commit()
    except IntegrityError as exc:
        # Two callbacks for the same first-time subject can race. The winner owns the stable
        # identity link; the loser resolves that fact instead of surfacing a random 500.
        await session.rollback()
        winner = (await session.execute(select(IdentityLink).where(
            IdentityLink.provider_id == row.id,
            IdentityLink.subject == subject))).scalar_one_or_none()
        user = await session.get(User, winner.user_id) if winner else None
        if user is None or not user.is_active or user.account_deleted_at:
            raise IdentityError("账号自动建立发生冲突，请联系管理员") from exc
        return user
    return user


async def complete(session: AsyncSession, cookie: str, state: str,
                   code: str, expected_key: str = "") -> tuple[str, User]:
    flow = _read_flow(cookie)
    if not hmac.compare_digest(str(flow.get("state") or ""), str(state or "")):
        raise IdentityError("登录状态不匹配，请重新开始")
    row = await session.get(IdentityProvider, str(flow.get("provider") or ""))
    if row is None or not row.enabled or row.probe_state != "ready":
        raise IdentityError("企业登录入口已停用")
    if expected_key and not hmac.compare_digest(row.key, expected_key):
        raise IdentityError("登录入口与回调地址不匹配")
    token_set = await _exchange(row, code, str(flow.get("verifier") or ""))
    claims = await _verify_id_token(row, str(token_set["id_token"]), str(flow.get("nonce") or ""))
    user = await _resolve_user(session, row, claims)
    return sign_token(user.id, user.auth_version), user


def success_url(row: IdentityProvider | None = None) -> str:
    configured = get_settings().hub_public_url.strip().rstrip("/")
    if configured:
        return configured + "/"
    parsed = urlparse(row.redirect_uri) if row is not None else None
    return f"{parsed.scheme}://{parsed.netloc}/" if parsed and parsed.netloc else "/"
