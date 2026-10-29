"""WeCom internal-application direct messages using the official encrypted callback protocol."""
import base64
import hashlib
import re
import struct
import xml.etree.ElementTree as ET
from urllib.parse import urlencode

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from fastapi import HTTPException

from .im_adapters import MAX_BODY, _fresh, _id, _same


def validate(credentials):
    if (not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", credentials["corp_id"])
            or not re.fullmatch(r"[1-9][0-9]{0,11}", credentials["agent_id"])
            or not re.fullmatch(r"[A-Za-z0-9]{3,32}", credentials["verification_token"])
            or not re.fullmatch(r"[A-Za-z0-9+/]{43}", credentials["encoding_aes_key"])):
        raise ValueError("企业微信应用或回调字段不正确")


def _xml(raw):
    if len(raw) > MAX_BODY or b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise HTTPException(400, "平台消息格式无效")
    try:
        root = ET.fromstring(raw)
    except (ET.ParseError, ValueError):
        raise HTTPException(400, "平台消息格式无效") from None
    if root.tag != "xml" or len(root) > 64:
        raise HTTPException(400, "平台消息格式无效")
    return {child.tag: child.text or "" for child in root}


def _decrypt(credentials, query, encrypted):
    timestamp, nonce = query.get("timestamp", ""), query.get("nonce", "")
    _fresh(timestamp, max_age=300)
    if not isinstance(encrypted, str) or len(encrypted) > MAX_BODY or not nonce or len(nonce) > 128:
        raise HTTPException(401, "平台消息验证失败")
    digest = hashlib.sha1("".join(sorted([credentials["verification_token"], timestamp, nonce, encrypted])).encode()).hexdigest()
    if not _same(query.get("msg_signature"), digest):
        raise HTTPException(401, "平台消息验证失败")
    try:
        key = base64.b64decode(credentials["encoding_aes_key"] + "=", validate=True)
        data = base64.b64decode(encrypted, validate=True)
        decryptor = Cipher(algorithms.AES(key), modes.CBC(key[:16])).decryptor()
        padded = decryptor.update(data) + decryptor.finalize()
        unpadder = padding.PKCS7(256).unpadder()
        plain = unpadder.update(padded) + unpadder.finalize()
        size = struct.unpack("!I", plain[16:20])[0]
        if size > MAX_BODY or len(plain) < 20 + size or plain[20 + size:] != credentials["corp_id"].encode():
            raise ValueError("receiver mismatch")
        return plain[20:20 + size]
    except (ValueError, TypeError, struct.error):
        raise HTTPException(401, "平台消息验证失败") from None


def parse(credentials, query, raw, method):
    if method == "GET":
        plain = _decrypt(credentials, query, query.get("echostr", ""))
        if len(plain) > 1024:
            raise HTTPException(400, "平台验证内容无效")
        try:
            return None, plain.decode("utf-8")
        except UnicodeError:
            raise HTTPException(400, "平台验证内容无效") from None
    envelope = _xml(raw)
    message = _xml(_decrypt(credentials, query, envelope.get("Encrypt", "")))
    if message.get("ToUserName") != credentials["corp_id"] or message.get("AgentID") != credentials["agent_id"]:
        raise HTTPException(401, "平台消息归属不正确")
    if message.get("MsgType") != "text":
        return None, "success"
    _fresh(message.get("CreateTime"))
    sender = _id(message.get("FromUserName"))
    return {"eventId": _id(message.get("MsgId")), "tenant": credentials["corp_id"],
            "sender": sender, "chat": sender, "thread": "", "text": message.get("Content", "")}, "success"


async def access_token(credentials):
    from . import im_transport as transport
    async def load():
        value = await transport.request("https://qyapi.weixin.qq.com/cgi-bin/gettoken?" + urlencode({
            "corpid": credentials["corp_id"], "corpsecret": credentials["app_secret"]}), method="GET")
        if not transport._zero(value.get("errcode")) or not isinstance(value.get("access_token"), str) or not value["access_token"]:
            raise transport.TransportError("platform_credentials_rejected")
        return value["access_token"], value.get("expires_in")
    return await transport.cached_token("wecom", credentials, load)


async def connect(credentials):
    from . import im_transport as transport
    token = await access_token(credentials)
    value = await transport.request("https://qyapi.weixin.qq.com/cgi-bin/agent/get?" + urlencode({
        "access_token": token, "agentid": credentials["agent_id"]}), method="GET")
    if not transport._zero(value.get("errcode")) or str(value.get("agentid")) != credentials["agent_id"]:
        raise transport.TransportError("platform_bot_unavailable")
    return {"bot_id": credentials["agent_id"], "tenant_id": credentials["corp_id"]}


async def send(credentials, identity, text):
    from . import im_transport as transport
    if identity.get("tenant") != credentials["corp_id"] or identity.get("chat") != identity.get("sender"):
        raise transport.TransportError("platform_recipient_rejected")
    token = await access_token(credentials)
    value = await transport.request("https://qyapi.weixin.qq.com/cgi-bin/message/send?" + urlencode({"access_token": token}),
        {"touser": identity["sender"], "agentid": int(credentials["agent_id"]), "msgtype": "text",
         "text": {"content": text}, "enable_duplicate_check": 0}, sending=True)
    transport.check_code(value, "errcode")
    if value.get("invaliduser") or value.get("unlicenseduser"):
        raise transport.TransportError("platform_recipient_rejected")
    if not value.get("msgid"):
        raise transport.TransportError("platform_receipt_missing", uncertain=True)
    return str(value["msgid"])[:180]
