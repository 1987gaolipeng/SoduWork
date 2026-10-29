"""Slack Events API with signed requests and bot-token replies."""
import hashlib
import hmac
import html
import re

from fastapi import HTTPException

from .im_adapters import _fresh, _id, _mapping, _same


def validate(credentials):
    if (not re.fullmatch(r"xoxb-[A-Za-z0-9-]{20,500}", credentials["bot_token"])
            or not re.fullmatch(r"[A-Za-z0-9]{16,128}", credentials["signing_secret"])
            or not re.fullmatch(r"A[A-Z0-9]{5,30}", credentials["app_id"])):
        raise ValueError("Slack 机器人字段格式不正确")


def parse(credentials, config, headers, body, raw):
    timestamp = headers.get("x-slack-request-timestamp", "")
    _fresh(timestamp, max_age=300)
    signature = "v0=" + hmac.new(credentials["signing_secret"].encode(),
        b"v0:" + timestamp.encode() + b":" + raw, hashlib.sha256).hexdigest()
    if not _same(headers.get("x-slack-signature"), signature):
        raise HTTPException(401, "平台消息验证失败")
    if body.get("type") == "url_verification":
        challenge = body.get("challenge")
        if not isinstance(challenge, str) or not 1 <= len(challenge) <= 1024:
            raise HTTPException(400, "平台验证内容无效")
        return None, {"challenge": challenge}
    if body.get("api_app_id") != credentials["app_id"] or body.get("team_id") != config.get("tenant_id"):
        raise HTTPException(401, "平台消息归属不正确")
    if body.get("type") != "event_callback":
        return None, {"ok": True}
    event = _mapping(body.get("event"))
    if event.get("bot_id") or event.get("subtype") or event.get("user") == config.get("bot_id"):
        return None, {"ok": True}
    direct = event.get("type") == "message" and event.get("channel_type") == "im"
    if not direct and event.get("type") != "app_mention":
        return None, {"ok": True}
    text = event.get("text")
    if not isinstance(text, str):
        return None, {"ok": True}
    _fresh(body.get("event_time"))
    if not direct:
        mention = "<@" + str(config.get("bot_id")) + ">"
        if mention not in text:
            return None, {"ok": True}
        text = text.replace(mention, "").strip()
    text = html.unescape(text)
    if text.startswith("pair "):
        text = "/" + text
    return {"eventId": _id(body.get("event_id")), "tenant": _id(body["team_id"]),
        "sender": _id(event.get("user")), "chat": _id(event.get("channel")),
        "thread": _id(event["thread_ts"]) if event.get("thread_ts") else "", "text": text}, {"ok": True}


def checked(value):
    from .im_transport import TransportError
    if value.get("ok") is not True:
        error = value.get("error")
        if value.get("ok") is not False or not isinstance(error, str) or not error:
            raise TransportError("platform_invalid_response", uncertain=True)
        if error in {"internal_error", "fatal_error", "service_unavailable", "request_timeout"}:
            raise TransportError("platform_send_unconfirmed", uncertain=True)
        if error == "ratelimited":
            raise TransportError("platform_rate_limited", retry_after=30)
        raise TransportError("platform_rejected")


async def connect(credentials):
    from . import im_transport as transport
    value = await transport.request("https://slack.com/api/auth.test", {}, token=credentials["bot_token"])
    checked(value)
    if not value.get("bot_id") or not value.get("team_id") or not value.get("user_id"):
        raise transport.TransportError("platform_bot_unavailable")
    return {"bot_id": _id(value["user_id"]), "tenant_id": _id(value["team_id"])}


async def send(credentials, identity, text, message_id):
    from . import im_transport as transport
    payload = {"channel": identity["chat"], "text": text, "mrkdwn": False, "parse": "none",
        "unfurl_links": False, "unfurl_media": False, "client_msg_id": message_id}
    if identity.get("thread"):
        payload["thread_ts"] = identity["thread"]
    value = await transport.request("https://slack.com/api/chat.postMessage", payload,
        token=credentials["bot_token"], sending=True)
    checked(value)
    if not isinstance(value.get("ts"), str) or not value["ts"]:
        raise transport.TransportError("platform_receipt_missing", uncertain=True)
    return value["ts"][:180]
