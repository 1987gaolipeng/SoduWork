"""Bounded official API calls. Ambiguous sends are never replayed automatically."""
import asyncio
import hashlib
import json
import re
import time
import weakref
from urllib.parse import quote

import httpx

_token_caches = weakref.WeakKeyDictionary()


def _zero(value):
    return type(value) is int and value == 0


def _mapping(value):
    return value if isinstance(value, dict) else {}


def check_code(value, field):
    code = value.get(field)
    if type(code) is not int:
        raise TransportError("platform_invalid_response", uncertain=True)
    if code != 0:
        raise TransportError("platform_rejected")


async def cached_token(provider, credentials, loader):
    cache, lock = _token_caches.setdefault(asyncio.get_running_loop(), ({}, asyncio.Lock()))
    key = hashlib.sha256((provider + json.dumps(credentials, sort_keys=True)).encode()).hexdigest()
    async with lock:
        token, expires = cache.get(key, ("", 0))
        if expires > time.monotonic():
            return token
        token, ttl = await loader()
        ttl = min(7200, max(0, ttl - 120)) if type(ttl) is int else 0
        if len(cache) >= 128:
            cache.clear()
        cache[key] = (token, time.monotonic() + ttl)
        return token

class TransportError(Exception):
    def __init__(self, code, *, retry_after=0, uncertain=False):
        super().__init__(code)
        try:
            self.retry_after = min(3600, max(0, int(retry_after)))
        except (TypeError, ValueError, OverflowError):
            self.retry_after = 0
        self.uncertain = uncertain


async def request(url, body=None, *, token="", method="POST", sending=False, headers=None, form=None,
                  max_response_bytes=128 * 1024):
    try:
        async with asyncio.timeout(15):
            async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as client:
                async with client.stream(method, url, **({"data": form} if form is not None else {"json": body}),
                        headers={**(headers or {}), **({"Authorization": "Bearer " + token} if token else {})}) as response:
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        raw.extend(chunk)
                        if len(raw) > max_response_bytes:
                            raise TransportError("platform_response_too_large", uncertain=sending)
                    if response.status_code == 429:
                        retry = response.headers.get("Retry-After", "30")
                        raise TransportError("platform_rate_limited", retry_after=int(retry) if retry.isdigit() else 30)
                    if not 200 <= response.status_code < 300:
                        raise TransportError("platform_http_error", uncertain=sending and response.status_code >= 500)
                    try:
                        value = json.loads(raw)
                    except (ValueError, UnicodeError):
                        raise TransportError("platform_invalid_response", uncertain=sending) from None
                    if not isinstance(value, dict):
                        raise TransportError("platform_invalid_response", uncertain=sending)
                    return value
    except (httpx.ConnectError, httpx.ConnectTimeout):
        raise TransportError("platform_unreachable", retry_after=30) from None
    except (httpx.HTTPError, TimeoutError):
        raise TransportError("platform_timeout", uncertain=sending, retry_after=0 if sending else 30) from None


def validate_credentials(provider, body):
    from .im_provider_registry import FIELDS
    if not isinstance(provider, str):
        raise ValueError("平台连接字段不正确")
    keys = {key for key, _ in FIELDS.get(provider, ("", ()))[1]}
    if not keys or not isinstance(body, dict) or set(body) != keys:
        raise ValueError("平台连接字段不正确")
    if any(not isinstance(value, str) or not 1 <= len(value) <= 1024 or re.search(r"[^\x21-\x7e]", value)
           for value in body.values()):
        raise ValueError("平台连接字段无效")
    if provider == "telegram" and not re.fullmatch(r"[0-9]{5,20}:[A-Za-z0-9_-]{20,200}", body["bot_token"]):
        raise ValueError("Telegram Bot Token 格式不正确")
    if provider == "wecom":
        from . import im_wecom
        im_wecom.validate(body)
    if provider == "dingtalk":
        from . import im_dingtalk
        im_dingtalk.validate(body)
    if provider in {"slack", "discord"}:
        from . import im_slack, im_discord
        (im_slack if provider == "slack" else im_discord).validate(body)
    if provider == "teams":
        from . import im_teams
        im_teams.validate(body)
    result = dict(body)
    if provider == "teams":
        result.update({name: result[name].lower() for name in ("app_id", "tenant_id")})
    return result


async def feishu_token(credentials):
    cache, lock = _token_caches.setdefault(asyncio.get_running_loop(), ({}, asyncio.Lock()))
    key = hashlib.sha256((credentials["app_id"] + ":" + credentials["app_secret"]).encode()).hexdigest()
    async with lock:
        token, expires = cache.get(key, ("", 0))
        if expires > time.monotonic():
            return token
        result = await request("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            {"app_id": credentials["app_id"], "app_secret": credentials["app_secret"]})
        token = result.get("tenant_access_token")
        if not _zero(result.get("code")) or not isinstance(token, str) or not token:
            raise TransportError("platform_credentials_rejected")
        ttl = result.get("expire")
        ttl = min(7200, max(0, ttl - 120)) if type(ttl) is int else 0
        if len(cache) >= 128:
            cache.clear()
        cache[key] = (token, time.monotonic() + ttl)
        return token


async def connect(provider, credentials, callback):
    if provider == "teams":
        from . import im_teams
        return await im_teams.connect(credentials)
    if provider in {"slack", "discord"}:
        from . import im_slack, im_discord
        return await (im_slack if provider == "slack" else im_discord).connect(credentials)
    if provider == "dingtalk":
        from . import im_dingtalk
        return await im_dingtalk.connect(credentials)
    if provider == "wecom":
        from . import im_wecom
        return await im_wecom.connect(credentials)
    if provider == "telegram":
        base = "https://api.telegram.org/bot" + credentials["bot_token"]
        me = await request(base + "/getMe", {})
        result = _mapping(me.get("result"))
        if me.get("ok") is not True or not result.get("is_bot") or not result.get("id") or not result.get("username"):
            raise TransportError("platform_credentials_rejected")
        configured = await request(base + "/setWebhook", {"url": callback,
            "secret_token": credentials["webhook_secret"], "allowed_updates": ["message"], "drop_pending_updates": False})
        if configured.get("ok") is not True:
            raise TransportError("platform_webhook_rejected")
        return {"bot_id": str(result["id"]), "bot_username": str(result["username"])}
    token = await feishu_token(credentials)
    result = await request("https://open.feishu.cn/open-apis/bot/v3/info", token=token, method="GET")
    bot = _mapping(result.get("bot") or _mapping(result.get("data")).get("bot"))
    if not _zero(result.get("code")) or not bot.get("open_id") or bot.get("activate_status") not in (None, 2):
        raise TransportError("platform_bot_unavailable")
    return {"bot_id": str(bot["open_id"])}


async def send(provider, credentials, identity, text, message_id):
    if provider == "teams":
        from . import im_teams
        return await im_teams.send(credentials, identity, text)
    if provider in {"slack", "discord"}:
        from . import im_slack, im_discord
        return await (im_slack if provider == "slack" else im_discord).send(credentials, identity, text, message_id)
    if provider == "dingtalk":
        from . import im_dingtalk
        return await im_dingtalk.send(credentials, identity, text)
    if provider == "wecom":
        from . import im_wecom
        return await im_wecom.send(credentials, identity, text)
    if provider == "telegram":
        payload = {"chat_id": identity["chat"], "text": text}
        if identity.get("thread"):
            payload["message_thread_id"] = int(identity["thread"])
        result = await request("https://api.telegram.org/bot" + credentials["bot_token"] + "/sendMessage", payload, sending=True)
        if result.get("ok") is not True:
            if result.get("ok") is not False or type(result.get("error_code")) is not int:
                raise TransportError("platform_invalid_response", uncertain=True)
            if result.get("error_code") == 429:
                raise TransportError("platform_rate_limited", retry_after=_mapping(result.get("parameters")).get("retry_after", 30))
            raise TransportError("platform_rejected")
        identifier = _mapping(result.get("result")).get("message_id")
    else:
        token = await feishu_token(credentials)
        payload = {"msg_type": "text", "content": json.dumps({"text": text}, ensure_ascii=False), "uuid": message_id}
        if identity.get("replyTo"):
            url = "https://open.feishu.cn/open-apis/im/v1/messages/" + quote(identity["replyTo"], safe="") + "/reply"
            payload["reply_in_thread"] = bool(identity.get("thread"))
        else:
            url = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id"
            payload["receive_id"] = identity["chat"]
        result = await request(url, payload, token=token, sending=True)
        check_code(result, "code")
        identifier = _mapping(result.get("data")).get("message_id")
    if not identifier:
        raise TransportError("platform_receipt_missing", uncertain=True)
    return str(identifier)[:180]
