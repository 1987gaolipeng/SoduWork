"""DingTalk application-robot HTTPS callbacks and durable proactive text replies."""
import base64
import hashlib
import hmac
import json
import re

from fastapi import HTTPException

from .im_adapters import _fresh, _id, _mapping, _same


def validate(credentials):
    for key in ("client_id", "robot_code", "corp_id"):
        if not re.fullmatch(r"[A-Za-z0-9_-]{4,128}", credentials[key]):
            raise ValueError("钉钉应用标识不正确")
    if len(credentials["app_secret"]) < 8:
        raise ValueError("钉钉应用密钥不正确")


def parse(credentials, headers, body, raw):
    timestamp = headers.get("timestamp", "")
    _fresh(timestamp, milliseconds=True, max_age=300)
    secret = credentials["app_secret"]
    signature = base64.b64encode(hmac.new(secret.encode(), (timestamp + "\n" + secret).encode(), hashlib.sha256).digest()).decode()
    if not _same(headers.get("sign"), signature):
        raise HTTPException(401, "平台消息验证失败")
    if (body.get("robotCode") != credentials["robot_code"]
            or body.get("chatbotCorpId") != credentials["corp_id"]
            or body.get("senderCorpId") != credentials["corp_id"]):
        raise HTTPException(401, "平台消息归属不正确")
    if body.get("msgtype") != "text" or body.get("conversationType") not in ("1", "2"):
        return None, {"msgtype": "empty"}
    if body["conversationType"] == "2" and body.get("isInAtList") is not True:
        return None, {"msgtype": "empty"}
    _fresh(body.get("createAt"), milliseconds=True)
    text = _mapping(body.get("text")).get("content")
    if not isinstance(text, str):
        raise HTTPException(400, "平台文字消息无效")
    event = {"eventId": _id(body.get("msgId")), "tenant": credentials["corp_id"],
        "sender": _id(body.get("senderId")), "chat": _id(body.get("conversationId")), "thread": "", "text": text,
        "replyContext": {"conversationType": body["conversationType"], "staffId": _id(body.get("senderStaffId"))},
        "verificationKey": hashlib.sha256((timestamp + ":" + signature).encode()).hexdigest(),
        "verificationHash": hashlib.sha256(raw).hexdigest()}
    return event, {"msgtype": "empty"}


async def access_token(credentials):
    from . import im_transport as transport
    async def load():
        result = await transport.request("https://api.dingtalk.com/v1.0/oauth2/accessToken",
            {"appKey": credentials["client_id"], "appSecret": credentials["app_secret"]})
        if not isinstance(result.get("accessToken"), str) or not result["accessToken"]:
            raise transport.TransportError("platform_credentials_rejected")
        return result["accessToken"], result.get("expireIn")
    return await transport.cached_token("dingtalk", credentials, load)


async def connect(credentials):
    await access_token(credentials)
    return {"bot_id": credentials["robot_code"], "tenant_id": credentials["corp_id"]}


async def send(credentials, identity, text):
    from . import im_transport as transport
    if identity.get("tenant") != credentials["corp_id"] or identity.get("conversationType") not in ("1", "2"):
        raise transport.TransportError("platform_recipient_rejected")
    token = await access_token(credentials)
    payload = {"robotCode": credentials["robot_code"], "msgKey": "sampleText", "msgParam": json.dumps({"content": text}, ensure_ascii=False)}
    if identity["conversationType"] == "1":
        payload["userIds"] = [identity["staffId"]]
        path = "oToMessages/batchSend"
    else:
        payload["openConversationId"] = identity["chat"]
        path = "groupMessages/send"
    result = await transport.request("https://api.dingtalk.com/v1.0/robot/" + path, payload,
        headers={"x-acs-dingtalk-access-token": token}, sending=True)
    if result.get("invalidStaffIdList"):
        raise transport.TransportError("platform_recipient_rejected")
    if result.get("flowControlledStaffIdList"):
        raise transport.TransportError("platform_rate_limited", retry_after=30)
    if not isinstance(result.get("processQueryKey"), str) or not result["processQueryKey"]:
        raise transport.TransportError("platform_receipt_missing", uncertain=True)
    return result["processQueryKey"][:180]
