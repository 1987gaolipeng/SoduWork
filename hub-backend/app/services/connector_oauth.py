"""Authorization-code/PKCE flows, encrypted tokens, and refresh scoped to the current Hub, device
account, and connection.
"""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import secrets
import time
from urllib.parse import urlencode
import httpx
from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import async_sessionmaker
from ..models import AppSetting, Client, User
from . import connector_oauth_registry as registry

PREFIX = "connector_oauth_"


class AuthorizationExpired(ValueError):
    """Explicit provider authorization rejection; transient network failures must not permanently
    disable valid authorization.
    """


class AuthorizationUnavailable(ValueError):
    """Temporary network or provider-response failure that callers may retry later."""


def now():
    return int(time.time())


def pack(record):
    return registry.cipher().encrypt(json.dumps(record, separators=(",", ":")).encode()).decode()


def unpack(row):
    try:
        return json.loads(registry.cipher().decrypt(row.value.encode()))
    except Exception:
        raise ValueError("连接授权记录无法读取，请重新连接") from None


def owner(client):
    if not client or not client.user_ref:
        raise ValueError("请先登录后再连接平台账号")
    return {"clientId": str(client.id), "userId": str(client.user_ref), "hub": registry.callback_url()}


def guard(record, client):
    if any(record.get(k) != v for k, v in owner(client).items()):
        raise ValueError("此连接授权不属于当前账号或服务")


async def row_for(session, kind, item_id, lock=False):
    if not isinstance(item_id, str) or not __import__("re").fullmatch(r"[A-Za-z0-9_-]{32,64}", item_id):
        raise ValueError("连接授权不存在或无权访问")
    query = select(AppSetting).where(AppSetting.key == PREFIX + kind + "_" + item_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(query)).scalar_one_or_none()
    if row is None:
        raise ValueError("连接授权不存在或已过期")
    return row


async def replace(session, row, record):
    old = row.value
    encoded = pack(record)
    changed = await session.execute(update(AppSetting).where(AppSetting.key == row.key,
        AppSetting.value == old).values(value=encoded).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        raise ValueError("授权状态刚发生变化，请刷新后重试")
    # Retain the local version for the next conditional update within this transaction.
    from sqlalchemy.orm.attributes import set_committed_value
    set_committed_value(row, "value", encoded)


async def start(session, client, provider, connector_id, spec=None):
    if not isinstance(connector_id, str) or not __import__("re").fullmatch(r"[A-Za-z0-9_-]{1,36}", connector_id):
        raise ValueError("请先生成连接标识")
    from . import connector_api_oauth as api
    if provider == "api" and (not isinstance(spec, dict) or spec.get("id") != connector_id):
        raise ValueError("接口连接标识无效")
    if provider == "api":
        from .mcp_servers import restore
        previous = next((r for r in (client.mcp_servers or []) if isinstance(r, dict) and r.get("id") == connector_id), {})
        spec = restore(spec, previous)
    app = api.application(spec) if provider == "api" else registry.application(provider)
    if provider == "api":
        await api.addresses(app["authorizationUrl"])
        await api.addresses(app["tokenUrl"])
    attempt, nonce, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(32), secrets.token_urlsafe(48)
    scopes = app["requestedScopes"]
    state = attempt + "." + nonce
    record = {**owner(client), "provider": provider, "connectorId": connector_id,
              "nonceHash": hashlib.sha256(nonce.encode()).hexdigest(), "verifier": verifier,
              "state": "pending", "expiresAt": now() + 600, "application": app["clientId"],
              "redirectUri": app["redirectUri"]}
    if provider == "api":
        record["apiApplication"] = app
    session.add(AppSetting(key=PREFIX + "attempt_" + attempt, value=pack(record)))
    await session.flush()
    query = {"client_id": app["clientId"], "redirect_uri": app["redirectUri"],
             "response_type": "code", "scope": " ".join(scopes), "state": state,
             "code_challenge": base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("="),
             "code_challenge_method": "S256"}
    if app["family"] == "google":
        query.update(access_type="offline", prompt="consent")
    elif app["family"] == "microsoft":
        query.update(response_mode="query", prompt="select_account")
    return {"attemptId": attempt, "authorizationUrl": app["authorizationUrl"] + "?" + urlencode(query),
            "expiresAt": record["expiresAt"], "state": "pending"}


async def request_json(url, *, data=None, token=None):
    # Use catalog-defined endpoints without redirects; never log or display failed responses or third-party profiles.
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            async with client.stream("POST" if data else "GET", url, headers=headers, data=data) as response:
                if response.status_code not in range(200, 300):
                    if response.status_code in {400, 401, 403}:
                        raise AuthorizationExpired("平台授权已失效，请重新连接")
                    raise ValueError("平台授权未成功，请重新连接")
                chunks, total = [], 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > 65536:
                        raise ValueError("平台授权响应过大")
                    chunks.append(chunk)
                value = json.loads(b"".join(chunks))
                if not isinstance(value, dict) or value.get("error"):
                    raise ValueError("平台授权未成功，请重新连接")
                return value
    except AuthorizationExpired:
        raise
    except Exception:
        raise AuthorizationUnavailable("平台授权暂时无法验证，请检查网络后重试") from None


def tokens(value, app, previous=None):
    access = value.get("access_token")
    refresh = value.get("refresh_token") or (previous or {}).get("refreshToken")
    if not isinstance(access, str) or not access or len(access) > 16384 or not isinstance(refresh, str) or not refresh or len(refresh) > 16384:
        raise ValueError("平台未提供可续期的授权，请重新同意离线访问")
    if str(value.get("token_type", "Bearer")).lower() != "bearer":
        raise ValueError("平台令牌类型不受支持")
    try:
        seconds = int(value.get("expires_in", 0))
    except (TypeError, ValueError):
        seconds = 0
    if seconds < 60 or seconds > 86400:
        raise ValueError("平台令牌有效期不正确")
    granted = str(value.get("scope") or "").split()
    needed = app["scopes"]
    # Normalize Microsoft permission names by removing the optional Graph URL prefix.
    normalize = lambda scope: scope.removeprefix("https://graph.microsoft.com/")
    if granted and not {normalize(s) for s in needed} <= {normalize(s) for s in granted}:
        raise ValueError("平台授权范围不足，请重新连接并同意所需权限")
    return {"accessToken": access, "refreshToken": refresh, "expiresAt": now() + seconds,
            "grantedScopes": granted or needed}


async def identity(app, token):
    value = await request_json(app["identityUrl"], token=token)
    for key in app["identityPath"]:
        value = value.get(key) if isinstance(value, dict) else None
    if not isinstance(value, str) or not value or len(value) > 256:
        raise ValueError("无法确认平台账号，请重新连接")
    return value


async def active_owner(session, record):
    client = (await session.execute(select(Client).where(Client.id == record["clientId"])
        .execution_options(populate_existing=True))).scalar_one_or_none()
    user = (await session.execute(select(User).where(User.id == record["userId"])
        .execution_options(populate_existing=True))).scalar_one_or_none()
    if client is None or user is None or not user.is_active or client.user_ref != user.id or client.auth_state != "active":
        raise ValueError("当前账号已停用，请重新登录")


async def finish(session, state, code, denied=False):
    attempt, sep, nonce = str(state or "").partition(".")
    if not sep or len(nonce) > 128:
        raise ValueError("授权回调无效")
    row = await row_for(session, "attempt", attempt, True)
    record = unpack(row)
    if record["state"] != "pending" or record["expiresAt"] < now() or not hmac.compare_digest(
            record["nonceHash"], hashlib.sha256(nonce.encode()).hexdigest()):
        raise ValueError("授权已过期或已处理，请返回客户端重试")
    if record["hub"] != registry.callback_url():
        raise ValueError("授权服务地址已变化，请重新连接")
    await active_owner(session, record)
    app = record["apiApplication"] if record["provider"] == "api" else registry.application(record["provider"])
    if record["application"] != app["clientId"] or record["redirectUri"] != app["redirectUri"]:
        raise ValueError("平台应用配置已变化，请重新连接")
    record["state"] = "processing"
    await replace(session, row, record)
    await session.commit()
    try:
        if denied or not isinstance(code, str) or not code or len(code) > 8192:
            raise ValueError("授权未完成")
        if record["provider"] == "api":
            from . import connector_api_oauth as api
            value = await api.exchange(app, {"grant_type": "authorization_code", "code": code,
                "redirect_uri": app["redirectUri"], "code_verifier": record["verifier"]})
            token, account = api.tokens(value, app), ""
        else:
            value = await request_json(app["tokenUrl"], data={"grant_type": "authorization_code", "code": code,
                "client_id": app["clientId"], "client_secret": app["clientSecret"],
                "redirect_uri": app["redirectUri"], "code_verifier": record["verifier"]})
            token = tokens(value, app)
            account = await identity(app, token["accessToken"])
        await active_owner(session, record)
        # Reacquire the lock before saving tokens so cancellation during processing remains effective.
        row = await row_for(session, "attempt", attempt, True)
        current = unpack(row)
        if current["state"] != "processing":
            raise ValueError("授权已取消")
        connection_id = secrets.token_urlsafe(24)
        saved = {k: record[k] for k in ("clientId", "userId", "hub", "provider", "connectorId", "application")}
        saved.update(**token, account=account, state="connected")
        if record["provider"] == "api":
            saved["apiApplication"] = app
        session.add(AppSetting(key=PREFIX + "token_" + connection_id, value=pack(saved)))
        current.update(state="connected", connectionId=connection_id)
        current.pop("verifier", None); current.pop("nonceHash", None)
        current.pop("apiApplication", None)
        await replace(session, row, current)
        await session.commit()
        return True
    except Exception:
        await session.rollback()
        row = await row_for(session, "attempt", attempt, True)
        current = unpack(row)
        if current["state"] == "processing":
            current.update(state="needs_auth")
            current.pop("verifier", None); current.pop("nonceHash", None)
            current.pop("apiApplication", None)
            await replace(session, row, current)
            await session.commit()
        return False


async def status(session, client, attempt):
    record = unpack(await row_for(session, "attempt", attempt))
    guard(record, client)
    state = record["state"]
    if state in {"pending", "processing"} and record["expiresAt"] < now():
        state = "expired"
    if state == "processing":
        state = "pending"
    result = {"state": state, "message": "账号已连接" if state == "connected" else
              "请在平台完成授权" if state == "pending" else "授权未完成，请重新连接"}
    if state == "connected":
        token = unpack(await row_for(session, "token", record["connectionId"]))
        guard(token, client)
        if token["state"] != "connected":
            return {"state": "needs_auth", "message": "账号授权已失效，请重新连接"}
        result["oauth"] = {"provider": record["provider"], "connectionId": record["connectionId"]}
    return result


async def cancel(session, client, attempt):
    # Use the same device lock as saving so a late close request cannot revoke a saved connection.
    await session.refresh(client, with_for_update=True)
    row = await row_for(session, "attempt", attempt, True)
    record = unpack(row); guard(record, client)
    if record["state"] == "connected":
        binding = {"provider": record["provider"], "connectionId": record["connectionId"]}
        if any(isinstance(item, dict) and item.get("oauth") == binding for item in (client.mcp_servers or [])):
            return {"state": "connected"}
        await session.execute(delete(AppSetting).where(AppSetting.key == PREFIX + "token_" + record["connectionId"]))
        record.pop("connectionId", None)
    if record["state"] in {"pending", "processing", "connected"}:
        record["state"] = "cancelled"
        record.pop("verifier", None); record.pop("nonceHash", None)
        record.pop("apiApplication", None)
        await replace(session, row, record)
    return {"state": record["state"]}


async def validate_binding(session, client, spec, lock=True):
    binding = spec.get("oauth")
    if not binding:
        return None
    if not isinstance(binding, dict) or set(binding) != {"provider", "connectionId"}:
        raise ValueError("连接授权引用无效")
    provider = binding["provider"]
    if provider != "api":
        registry.definition(provider)
    if provider != "api" and (spec.get("command") != "soduwork-connector" or spec.get("args") != [provider]):
        raise ValueError("平台授权不能用于其他连接器")
    row = await row_for(session, "token", binding["connectionId"], lock)
    record = unpack(row); guard(record, client)
    if record["connectorId"] != spec.get("id") or record["provider"] != provider:
        raise ValueError("平台授权与当前连接不匹配")
    if provider == "api":
        from . import connector_api_oauth
        connector_api_oauth.validate(record, spec)
    return record


async def resolve(session, client, spec):
    binding = spec.get("oauth")
    if not binding:
        return spec
    # Read-only validation does not hold the token-row lock; the independent refresh transaction locks and revalidates.
    await validate_binding(session, client, spec, lock=False)
    # Commit rotated refresh tokens in a short independent transaction so later business rollbacks cannot lose them.
    sessions = async_sessionmaker(session.bind, expire_on_commit=False)
    async with sessions() as auth_session:
        row = await row_for(auth_session, "token", binding["connectionId"], True)
        record = unpack(row); guard(record, client)
        app = record["apiApplication"] if record["provider"] == "api" else registry.application(record["provider"])
        if record["application"] != app["clientId"] or record["state"] != "connected":
            raise ValueError("平台授权已失效，请重新连接")
        grace = 0 if record["provider"] == "api" and not record.get("refreshToken") else 60
        if record["expiresAt"] <= now() + grace:
            try:
                if record["provider"] == "api":
                    from . import connector_api_oauth as api
                    if not record.get("refreshToken"):
                        raise AuthorizationExpired("平台未提供续期授权，请重新连接")
                    value = await api.exchange(app, {"grant_type": "refresh_token", "refresh_token": record["refreshToken"]})
                    refreshed = api.tokens(value, app, record)
                else:
                    value = await request_json(app["tokenUrl"], data={"grant_type": "refresh_token",
                        "client_id": app["clientId"], "client_secret": app["clientSecret"],
                        "refresh_token": record["refreshToken"]})
                    refreshed = tokens(value, app, record)
                    if await identity(app, refreshed["accessToken"]) != record["account"]:
                        raise AuthorizationExpired("续期后的平台账号不一致，请重新连接")
                record.update(refreshed)
            except AuthorizationExpired:
                record["state"] = "needs_auth"
                await replace(auth_session, row, record)
                await auth_session.commit()
                raise
            await replace(auth_session, row, record)
            await auth_session.commit()
        env = {**spec.get("env", {}), app["tokenField"]: record["accessToken"]}
        if record["provider"] != "api":
            env["ALLOW_WRITES"] = "false"
        return {**spec, "env": env}


async def release_removed(session, previous, following):
    """Remove local tokens using only the old configuration stored in the database, in the same
    transaction as deletion or rebinding.
    """
    def references(rows):
        return {item["oauth"]["connectionId"] for item in rows if isinstance(item, dict)
                and isinstance(item.get("oauth"), dict) and isinstance(item["oauth"].get("connectionId"), str)}
    removed = references(previous) - references(following)
    if removed:
        # Delete token references without decryption so users can remove invalid connections even if the key is lost.
        await session.execute(delete(AppSetting).where(AppSetting.key.in_([PREFIX + "token_" + value for value in removed])))
