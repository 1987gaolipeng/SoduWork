"""Commercial-cloud Teams Bot Connector with endorsed keys and pinned reply URLs."""
import asyncio
import hashlib
import html
import re
import time
import weakref
from datetime import datetime
from urllib.parse import quote, urlsplit

import jwt
from fastapi import HTTPException

from .im_adapters import _fresh, _id, _mapping, _object, _validated

ISSUER = "https://api.botframework.com"
METADATA = "https://login.botframework.com/v1/.well-known/openidconfiguration"
KEYS = "https://login.botframework.com/v1/.well-known/keys"
_key_caches = weakref.WeakKeyDictionary()


def validate(credentials):
    for name in ("app_id", "tenant_id"):
        if not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", credentials[name]):
            raise ValueError("Teams 应用和租户 ID 必须为有效 GUID")


def service_url(value):
    if not isinstance(value, str) or len(value) > 512:
        raise HTTPException(401, "平台回复地址无效")
    try:
        parsed = urlsplit(value)
    except ValueError:
        raise HTTPException(401, "平台回复地址无效") from None
    if (parsed.scheme != "https" or parsed.netloc != "smba.trafficmanager.net" or parsed.query or parsed.fragment
            or not re.fullmatch(r"/[A-Za-z0-9._/-]*/", parsed.path) or ".." in parsed.path.split("/")):
        raise HTTPException(401, "仅支持已验证的 Teams 商业云回复地址")
    return value


async def signing_key(key_id=None):
    """Refresh fixed Microsoft metadata, with one bounded fetch per loop and minute."""
    from . import im_transport as transport
    cache, lock = _key_caches.setdefault(asyncio.get_running_loop(), ({"keys": [], "loaded": 0, "attempt": 0}, asyncio.Lock()))
    async with lock:
        stamp = time.monotonic()
        found = next((key for key in cache["keys"] if key.get("kid") == key_id), None)
        refresh = stamp - cache["loaded"] > 3600 or not cache["keys"] or (key_id is not None and found is None)
        if refresh and (not cache["attempt"] or stamp - cache["attempt"] >= 60):
            cache["attempt"] = stamp
            metadata = await transport.request(METADATA, method="GET")
            if (metadata.get("issuer") != ISSUER or metadata.get("jwks_uri") != KEYS
                    or "RS256" not in metadata.get("id_token_signing_alg_values_supported", [])):
                raise transport.TransportError("platform_signing_metadata_invalid")
            value = await transport.request(KEYS, method="GET", max_response_bytes=2 * 1024 * 1024)
            keys = value.get("keys")
            if not isinstance(keys, list) or not 1 <= len(keys) <= 512 or any(not isinstance(item, dict) for item in keys):
                raise transport.TransportError("platform_signing_metadata_invalid")
            cache["keys"], cache["loaded"] = keys, stamp
            found = next((key for key in keys if key.get("kid") == key_id), None)
        if not cache["keys"] or stamp - cache["loaded"] > 86400:
            raise transport.TransportError("platform_signing_metadata_unavailable")
        if key_id is None:
            return None
        if not found or found.get("kty") != "RSA" or found.get("use", "sig") != "sig" or found.get("alg", "RS256") != "RS256":
            raise HTTPException(401, "平台签名密钥无效")
        if not isinstance(found.get("endorsements"), list) or "msteams" not in found["endorsements"]:
            raise HTTPException(403, "平台签名未获 Teams 授权")
        try:
            return jwt.algorithms.RSAAlgorithm.from_jwk(found)
        except (ValueError, TypeError, jwt.PyJWTError):
            raise HTTPException(401, "平台签名密钥无效") from None


async def parse(credentials, headers, raw):
    from . import im_transport as transport
    body = _object(raw)
    auth = headers.get("authorization", "")
    if not re.fullmatch(r"Bearer [A-Za-z0-9_.-]{20,16384}", auth):
        raise HTTPException(401, "平台消息验证失败")
    token = auth[7:]
    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str) or len(header["kid"]) > 160:
            raise HTTPException(401, "平台消息验证失败")
        key = await signing_key(header["kid"])
        claims = jwt.decode(token, key, algorithms=["RS256"], audience=credentials["app_id"], issuer=ISSUER,
            leeway=300, options={"require": ["exp", "nbf", "iss", "aud", "serviceurl"], "strict_aud": True})
    except transport.TransportError:
        raise HTTPException(503, "平台签名密钥暂不可用，请稍后重试") from None
    except (jwt.PyJWTError, ValueError, TypeError):
        raise HTTPException(401, "平台消息验证失败") from None
    url = service_url(body.get("serviceUrl"))
    if claims.get("serviceurl") != url or body.get("channelId") != "msteams":
        raise HTTPException(401, "平台消息归属不正确")
    channel_data = _mapping(body.get("channelData") or {})
    if _mapping(channel_data.get("tenant") or {}).get("id") != credentials["tenant_id"]:
        raise HTTPException(401, "平台租户归属不正确")
    recipient = _mapping(body.get("recipient") or {})
    if recipient.get("id") != "28:" + credentials["app_id"]:
        raise HTTPException(401, "平台机器人归属不正确")
    if body.get("type") != "message":
        return None, {}
    try:
        stamp = datetime.fromisoformat(body.get("timestamp", "").replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError()
        _fresh(stamp.timestamp())
    except (TypeError, ValueError, AttributeError, OverflowError):
        raise HTTPException(400, "平台消息时间无效") from None
    conversation, sender = _mapping(body.get("conversation")), _mapping(body.get("from"))
    if sender.get("role") == "bot" or sender.get("id") == recipient["id"]:
        return None, {}
    if conversation.get("tenantId") not in (None, credentials["tenant_id"]):
        raise HTTPException(401, "平台会话归属不正确")
    kind = conversation.get("conversationType")
    text = body.get("text")
    if kind not in {"personal", "groupChat", "channel"} or not isinstance(text, str):
        return None, {}
    if kind != "personal":
        entities = body.get("entities") or []
        if not isinstance(entities, list):
            raise HTTPException(400, "平台消息格式无效")
        mentions = [item for item in entities if isinstance(item, dict) and item.get("type") == "mention"
            and isinstance(item.get("mentioned"), dict) and item["mentioned"].get("id") == recipient["id"]]
        if not mentions:
            return None, {}
        for item in mentions:
            if isinstance(item.get("text"), str):
                text = text.replace(item["text"], "")
    text = html.unescape(text).strip()
    if text.startswith("pair "):
        text = "/" + text
    chat, activity = _id(conversation.get("id"), 1024), _id(body.get("id"))
    # Teams normally embeds the root in conversation.id; replyToId may name a quoted reply.
    root = chat.rsplit(";messageid=", 1)[1].split(";", 1)[0] if ";messageid=" in chat else body.get("replyToId") or activity
    thread = _id(root) if kind == "channel" else ""
    event = {"eventId": hashlib.sha256((chat + ":" + activity).encode()).hexdigest(),
        "tenant": credentials["tenant_id"], "sender": _id(sender.get("id"), 512),
        "chat": chat, "thread": thread, "text": text,
        "replyContext": {"serviceUrl": url, "botId": recipient["id"], "replyTo": _id(body.get("replyToId") or body.get("id"))}}
    return _validated(event), {}


async def access_token(credentials):
    from . import im_transport as transport
    async def load():
        value = await transport.request("https://login.microsoftonline.com/" + credentials["tenant_id"] + "/oauth2/v2.0/token",
            form={"grant_type": "client_credentials", "client_id": credentials["app_id"],
                  "client_secret": credentials["client_secret"], "scope": ISSUER + "/.default"})
        token = value.get("access_token")
        if not isinstance(token, str) or not token or str(value.get("token_type", "")).lower() != "bearer":
            raise transport.TransportError("platform_credentials_rejected")
        return token, value.get("expires_in")
    return await transport.cached_token("teams", credentials, load)


async def connect(credentials):
    await signing_key()
    await access_token(credentials)
    return {"bot_id": "28:" + credentials["app_id"], "tenant_id": credentials["tenant_id"]}


async def send(credentials, identity, text):
    from . import im_transport as transport
    if identity.get("tenant") != credentials["tenant_id"] or identity.get("botId") != "28:" + credentials["app_id"]:
        raise transport.TransportError("platform_recipient_rejected")
    url = service_url(identity.get("serviceUrl"))
    token = await access_token(credentials)
    payload = {"type": "message", "text": text, "textFormat": "plain", "channelId": "msteams",
        "from": {"id": identity["botId"]}, "recipient": {"id": identity["sender"]},
        "conversation": {"id": identity["chat"]}, "channelData": {"tenant": {"id": identity["tenant"]}}}
    endpoint = url + "v3/conversations/" + quote(identity["chat"], safe="") + "/activities"
    if identity.get("replyTo"):
        endpoint += "/" + quote(identity["replyTo"], safe="")
        payload["replyToId"] = identity["replyTo"]
    value = await transport.request(endpoint, payload, token=token, sending=True)
    if not isinstance(value.get("id"), str) or not value["id"]:
        raise transport.TransportError("platform_receipt_missing", uncertain=True)
    return value["id"][:180]
