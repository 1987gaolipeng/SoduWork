"""Discord signed slash commands; durable replies use the installed bot's channel."""
import hashlib
import re

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

from .im_adapters import _fresh, _id, _mapping

BASE = "https://discord.com/api/v10"
ACK = {"type": 4, "data": {"content": "请求已收到；绑定成功或任务结果将由机器人另行回复。", "flags": 64,
    "allowed_mentions": {"parse": []}}}


def validate(credentials):
    if (not re.fullmatch(r"[0-9]{5,25}", credentials["application_id"])
            or not re.fullmatch(r"[a-fA-F0-9]{64}", credentials["public_key"])
            or not re.fullmatch(r"[A-Za-z0-9_.-]{20,500}", credentials["bot_token"])):
        raise ValueError("Discord 机器人字段格式不正确")


def parse(credentials, config, headers, body, raw):
    timestamp = headers.get("x-signature-timestamp", "")
    _fresh(timestamp, max_age=300)
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(credentials["public_key"])).verify(
            bytes.fromhex(headers.get("x-signature-ed25519", "")), timestamp.encode() + raw)
    except (ValueError, InvalidSignature):
        raise HTTPException(401, "平台消息验证失败") from None
    if body.get("application_id") != credentials["application_id"]:
        raise HTTPException(401, "平台消息归属不正确")
    if body.get("type") == 1:
        return None, {"type": 1}
    if body.get("type") != 2:
        return None, ACK
    context = body.get("context")
    guild = str(body.get("guild_id") or "")
    owners = _mapping(body.get("authorizing_integration_owners"))
    if type(context) is not int or context not in (0, 1) or owners.get("0") != (guild if context == 0 else "0"):
        raise HTTPException(403, "请在已安装机器人的服务器或机器人私聊内使用")
    sender = _mapping(_mapping(body.get("member") or {}).get("user") if guild else body.get("user"))
    if sender.get("bot"):
        return None, ACK
    data = _mapping(body.get("data"))
    name = data.get("name")
    if name not in {"pair", "soduwork"} or data.get("type") != 1:
        return None, ACK
    if str(data.get("id")) != config.get("commands", {}).get(name):
        raise HTTPException(401, "平台命令归属不正确")
    options = data.get("options")
    expected = "code" if name == "pair" else "text"
    if (not isinstance(options, list) or len(options) != 1 or not isinstance(options[0], dict)
            or options[0].get("type") != 3 or options[0].get("name") != expected
            or not isinstance(options[0].get("value"), str)):
        raise HTTPException(400, "平台命令参数不正确")
    text = ("/pair " if name == "pair" else "") + options[0]["value"]
    channel = _id(body.get("channel_id") or _mapping(body.get("channel") or {}).get("id"))
    if not channel.isdigit():
        raise HTTPException(400, "平台消息标识无效")
    return {"eventId": _id(body.get("id")), "tenant": _id(guild or credentials["application_id"]),
        "sender": _id(sender.get("id")), "chat": channel, "thread": "", "text": text}, ACK


async def connect(credentials):
    from . import im_transport as transport
    headers = {"Authorization": "Bot " + credentials["bot_token"]}
    value = await transport.request(BASE + "/oauth2/applications/@me", method="GET", headers=headers)
    if value.get("id") != credentials["application_id"] or value.get("verify_key") != credentials["public_key"]:
        raise transport.TransportError("platform_credentials_rejected")
    commands = {}
    for name, argument, description in (("pair", "code", "Pair this chat with your SoduWork desktop"),
            ("soduwork", "text", "Send a request to your paired SoduWork desktop")):
        value = await transport.request(BASE + "/applications/" + credentials["application_id"] + "/commands",
            {"name": name, "type": 1, "description": description, "integration_types": [0], "contexts": [0, 1],
             "options": [{"type": 3, "name": argument, "description": "Pairing code" if name == "pair" else "Your request",
                 "required": True, "max_length": 24 if name == "pair" else 6000}]}, headers=headers, sending=True)
        if value.get("name") != name or not value.get("id"):
            raise transport.TransportError("platform_command_unconfirmed", uncertain=True)
        commands[name] = str(value["id"])
    return {"bot_id": credentials["application_id"], "commands": commands}


async def send(credentials, identity, text, message_id):
    from . import im_transport as transport
    channel = identity["chat"]
    if not re.fullmatch(r"[0-9]{5,25}", channel):
        raise transport.TransportError("platform_recipient_rejected")
    value = await transport.request(BASE + "/channels/" + channel + "/messages",
        {"content": text, "allowed_mentions": {"parse": []},
         "nonce": hashlib.sha256(message_id.encode()).hexdigest()[:24], "enforce_nonce": True},
        headers={"Authorization": "Bot " + credentials["bot_token"]}, sending=True)
    if not isinstance(value.get("id"), str) or not value["id"].isdigit():
        raise transport.TransportError("platform_receipt_missing", uncertain=True)
    return value["id"][:180]
