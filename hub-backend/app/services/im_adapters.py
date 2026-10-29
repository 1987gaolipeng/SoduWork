"""Verified platform text events, normalized without granting authority."""
import base64
import hashlib
import hmac
import json
import re
import time

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from fastapi import HTTPException

MAX_BODY = 128 * 1024
MAX_TEXT = 16000


def _same(left, right):
    try:
        return (isinstance(left, str) and isinstance(right, str) and bool(right)
                and hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8")))
    except UnicodeError:
        return False


def _object(raw):
    try:
        value = json.loads(raw)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise HTTPException(400, "消息格式无效") from None
    if not isinstance(value, dict):
        raise HTTPException(400, "消息格式无效")
    return value


def _id(value, limit=180):
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        raise HTTPException(400, "平台消息标识无效")
    value = str(value or "")
    if not value or len(value) > limit or re.search(r"[\x00-\x20\x7f]", value):
        raise HTTPException(400, "平台消息标识无效")
    return value


def _mapping(value):
    if not isinstance(value, dict):
        raise HTTPException(400, "消息格式无效")
    return value


def _fresh(value, *, milliseconds=False, max_age=86400):
    try:
        timestamp = int(value) / (1000 if milliseconds else 1)
    except (TypeError, ValueError, OverflowError):
        raise HTTPException(400, "平台消息时间无效") from None
    age = time.time() - timestamp
    if age < -120 or age > max_age:
        raise HTTPException(401, "平台消息已过期")


def parse(provider, credentials, config, headers, raw, *, query=None, method="POST"):
    if len(raw) > MAX_BODY:
        raise HTTPException(413, "平台消息过大")
    if provider == "wecom":
        from . import im_wecom
        event, response = im_wecom.parse(credentials, query or {}, raw, method)
        if event is None:
            return event, response
        return _validated(event), response
    body = _object(raw)
    if provider in {"slack", "discord"}:
        from . import im_slack, im_discord
        adapter = im_slack if provider == "slack" else im_discord
        event, response = adapter.parse(credentials, config, headers, body, raw)
        return (_validated(event) if event else None), response
    if provider == "dingtalk":
        from . import im_dingtalk
        event, response = im_dingtalk.parse(credentials, headers, body, raw)
        return (_validated(event) if event else None), response
    if provider == "telegram":
        if not _same(headers.get("x-telegram-bot-api-secret-token"), credentials.get("webhook_secret")):
            raise HTTPException(401, "平台消息验证失败")
        message = body.get("message")
        if not isinstance(message, dict):
            return None, {"ok": True}
        sender, chat = _mapping(message.get("from") or {}), _mapping(message.get("chat") or {})
        if sender.get("is_bot") or not sender.get("id") or chat.get("type") not in {"private", "group", "supergroup"}:
            return None, {"ok": True}
        text = message.get("text")
        if not isinstance(text, str):
            return None, {"ok": True}
        _fresh(message.get("date"))
        if chat.get("type") != "private" or re.match(r"^/(pair|soduwork)@", text):
            username = config.get("bot_username", "")
            match = re.match(r"^/(pair|soduwork)@([A-Za-z0-9_]+)\s+(.+)$", text, re.S)
            if not username or not match or match[2].lower() != username.lower():
                return None, {"ok": True}
            text = ("/pair " if match[1] == "pair" else "") + match[3]
        elif text.startswith("/soduwork "):
            text = text[10:]
        event = {"eventId": _id(body.get("update_id") if body.get("update_id") != 0 else "0"),
                 "tenant": _id(config.get("bot_id")), "sender": _id(sender["id"]),
                 "chat": _id(chat.get("id")), "thread": _id(message["message_thread_id"]) if message.get("message_thread_id") else "", "text": text}
        if event["thread"] and not event["thread"].isdigit():
            raise HTTPException(400, "平台话题标识无效")
    elif provider == "feishu":
        if "encrypt" in body:
            try:
                encrypted = base64.b64decode(body["encrypt"], validate=True)
                key = hashlib.sha256(credentials["encrypt_key"].encode()).digest()
                decryptor = Cipher(algorithms.AES(key), modes.CBC(encrypted[:16])).decryptor()
                padded = decryptor.update(encrypted[16:]) + decryptor.finalize()
                unpadder = padding.PKCS7(128).unpadder()
                body = _object(unpadder.update(padded) + unpadder.finalize())
            except (KeyError, ValueError, TypeError):
                raise HTTPException(401, "平台消息验证失败") from None
        header = body.get("header") or {}
        if not isinstance(header, dict) or not _same(header.get("token") or body.get("token"), credentials.get("verification_token")):
            raise HTTPException(401, "平台消息验证失败")
        if body.get("type") == "url_verification":
            challenge = body.get("challenge")
            if not isinstance(challenge, str) or len(challenge) > 1024:
                raise HTTPException(400, "平台验证内容无效")
            return None, {"challenge": challenge}
        timestamp = headers.get("x-lark-request-timestamp", "")
        nonce = headers.get("x-lark-request-nonce", "")
        _fresh(timestamp, max_age=300)
        if not nonce or len(nonce) > 128:
            raise HTTPException(401, "平台消息验证失败")
        digest = hashlib.sha256((timestamp + nonce + credentials["encrypt_key"]).encode() + raw).hexdigest()
        if not _same(headers.get("x-lark-signature"), digest) or header.get("app_id") != credentials["app_id"]:
            raise HTTPException(401, "平台消息验证失败")
        if header.get("event_type") != "im.message.receive_v1":
            return None, {"code": 0}
        event = _mapping(body.get("event") or {})
        sender, message = _mapping(event.get("sender") or {}), _mapping(event.get("message") or {})
        if sender.get("sender_type") != "user" or message.get("message_type") != "text":
            return None, {"code": 0}
        if message.get("chat_type") not in {"p2p", "group"}:
            return None, {"code": 0}
        _fresh(message.get("create_time"), milliseconds=True)
        text = _object(message.get("content", "{}")).get("text")
        if not isinstance(text, str):
            return None, {"code": 0}
        if message.get("chat_type") == "group":
            mentions = message.get("mentions") or []
            if not isinstance(mentions, list):
                raise HTTPException(400, "消息格式无效")
            mention = next((item for item in mentions if isinstance(item, dict)
                and isinstance(item.get("id"), dict) and item["id"].get("open_id") == config.get("bot_id")), None)
            if not mention:
                return None, {"code": 0}
            text = text.replace(str(mention.get("key") or "@_user_0"), "").strip()
        event = {"eventId": _id(header.get("event_id")), "tenant": _id(header.get("tenant_key")),
                 "sender": _id(_mapping(sender.get("sender_id") or {}).get("open_id")),
                 "chat": _id(message.get("chat_id")), "thread": _id(message["thread_id"]) if message.get("thread_id") else "",
                 "replyTo": _id(message.get("message_id")), "text": text}
    else:
        raise HTTPException(400, "暂不支持此消息平台")
    return _validated(event), ({"ok": True} if provider == "telegram" else {"code": 0})


def _validated(event):
    event["text"] = event["text"].strip()
    try:
        event["text"].encode("utf-8")
    except UnicodeError:
        raise HTTPException(400, "消息文字编码无效") from None
    if not event["text"] or len(event["text"]) > MAX_TEXT or "\0" in event["text"] or len(event["thread"]) > 180:
        raise HTTPException(413, "消息为空或超过长度限制")
    return event
