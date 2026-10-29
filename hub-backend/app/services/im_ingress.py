"""Persist authenticated events before acknowledging them to the IM platform."""
import hashlib
import json
import re
import uuid
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from .. import im_models as im
from . import im_connections as connections


def identity_key(identity):
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def text_chunks(text, limit=3500, *, utf8=False):
    """Bound UTF-16 units as well as code points without splitting a character."""
    chunk, size = [], 0
    for character in text:
        width = len(character.encode("utf-8")) if utf8 else (2 if ord(character) > 0xffff else 1)
        if size + width > limit:
            yield "".join(chunk)
            chunk, size = [], 0
        chunk.append(character)
        size += width
    if chunk:
        yield "".join(chunk)


async def enqueue_reply(session, inbox, kind, text):
    # Keep platform limits and delivery order stable across retries and worker restarts.
    text = str(text)
    if len(text) > 14000:
        text = text[:13920] + "\n\n内容较长，完整结果请在 SoduWork 原会话查看。"
    connection = await session.get(im.IMConnection, inbox.connection_id)
    compact = connection and connection.provider == "wecom"
    limit = 2000 if compact else (1900 if connection and connection.provider == "discord" else 3500)
    for part, chunk in enumerate(text_chunks(text, limit, utf8=bool(compact))):
        identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, "soduwork:im:out:" + inbox.id + ":" + kind + ":" + str(part)))
        if await session.get(im.IMOutbox, identifier) is None:
            session.add(im.IMOutbox(id=identifier, inbox_id=inbox.id, connection_id=inbox.connection_id,
                binding_id=inbox.binding_id, kind=kind, part=part, text=chunk,
                available_at=connections.now(), created_at=connections.now()))


async def accept(session, connection, event):
    # A database row lock serializes duplicate callbacks and pairing consumption
    # across Hub workers. No network or execution call runs inside this lock.
    locked = await session.execute(update(im.IMConnection).where(
        im.IMConnection.id == connection.id, im.IMConnection.enabled.is_(True))
        .values(enabled=True).execution_options(synchronize_session=False))
    if locked.rowcount != 1:
        raise HTTPException(403, "远程连接已停用")
    await session.refresh(connection)
    await connections.authorize(session, connection)
    identity = {key: event[key] for key in ("tenant", "sender", "chat", "thread")}
    key = identity_key(identity)
    identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, "soduwork:im:in:" + connection.id + ":" + event["eventId"]))
    digest = identity_key({key: value for key, value in event.items() if not key.startswith("verification")})
    previous = await session.get(im.IMInbox, identifier)
    if previous:
        if previous.content_hash != digest:
            raise HTTPException(409, "平台事件编号内容冲突")
        return
    binding = (await session.scalars(select(im.IMBinding).where(
        im.IMBinding.connection_id == connection.id, im.IMBinding.identity_key == key))).first()
    match = re.fullmatch(r"/pair ([A-Za-z0-9_-]{24})", event["text"])
    paired = False
    if match:
        code_hash = hashlib.sha256(match[1].encode()).hexdigest()
        grant = await session.get(im.IMPairing, code_hash)
        if not grant or grant.connection_id != connection.id or (binding and binding.enabled):
            return
        await connections.target(session, connection, grant.task_id, grant.runner_id, quota=True)
        used = await session.execute(update(im.IMPairing).where(im.IMPairing.code_hash == code_hash,
            im.IMPairing.used_at.is_(None), im.IMPairing.expires_at > connections.now()).values(
                used_at=connections.now()).execution_options(synchronize_session=False))
        if used.rowcount != 1:
            return
        if binding:
            binding.identity_key = hashlib.sha256((key + ":revoked:" + binding.id).encode()).hexdigest()
            await session.flush()
        binding = im.IMBinding(id=str(uuid.uuid4()), connection_id=connection.id, identity_key=key,
            external_identity=identity, task_id=grant.task_id, runner_id=grant.runner_id, options=dict(grant.options), enabled=True)
        session.add(binding)
        if await session.get(im.IMRoute, grant.task_id) is None:
            try:
                async with session.begin_nested():
                    session.add(im.IMRoute(task_id=grant.task_id))
                    await session.flush()
            except IntegrityError:
                if await session.get(im.IMRoute, grant.task_id) is None:
                    raise
        paired = True
    elif event["text"].startswith("/pair") or not binding or not binding.enabled:
        return
    count = await session.scalar(select(func.count()).select_from(im.IMInbox).where(
        im.IMInbox.connection_id == connection.id, im.IMInbox.status.in_(("queued", "sending", "waiting", "uncertain"))))
    if count >= 1000:
        raise HTTPException(429, "远程消息队列已满，请稍后重试")
    inbox = im.IMInbox(id=identifier, connection_id=connection.id, event_id=event["eventId"], content_hash=digest,
        binding_id=binding.id, task_id=binding.task_id, text="" if paired else event["text"],
        reply_context={"replyTo": event.get("replyTo", ""), **event.get("replyContext", {})}, status="done" if paired else "queued",
        available_at=connections.now(), created_at=connections.now())
    session.add(inbox)
    continuation = "发送文字即可继续工作"
    if connection.provider == "discord":
        continuation = "请用 /soduwork 命令的 text 参数继续工作"
    elif connection.provider == "telegram" and (connection.config or {}).get("bot_username"):
        continuation = "私聊可发送文字，群聊请用 /soduwork@" + connection.config["bot_username"] + " 加请求内容"
    elif connection.provider in {"slack", "teams", "feishu", "dingtalk"}:
        continuation = "继续在此会话或已配对话题内发送文字；群聊请提及机器人"
    await enqueue_reply(session, inbox, "paired" if paired else "received",
        "已绑定你的 SoduWork 会话。" + continuation + "；执行机离线时消息会等待上线。" if paired else
        "已收到，等待执行。执行机离线或原会话忙碌时会排队，结果将在这里回复。")
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        previous = await session.get(im.IMInbox, identifier)
        if previous and previous.content_hash == digest:
            return
        raise HTTPException(409, "消息并发更新，请重试原事件") from None


async def record_verification(session, connection, event):
    key = event.get("verificationKey")
    if not key:
        return
    await session.execute(update(im.IMConnection).where(im.IMConnection.id == connection.id)
        .values(enabled=im.IMConnection.enabled).execution_options(synchronize_session=False))
    await session.refresh(connection)
    await connections.authorize(session, connection)
    cutoff = connections.now() - timedelta(minutes=10)
    await session.execute(delete(im.IMWebhookReceipt).where(im.IMWebhookReceipt.connection_id == connection.id,
        im.IMWebhookReceipt.created_at < cutoff).execution_options(synchronize_session=False))
    receipt = await session.get(im.IMWebhookReceipt, (connection.id, key))
    if receipt:
        if receipt.content_hash != event["verificationHash"]:
            raise HTTPException(409, "平台签名已用于不同消息，请平台重新签名投递")
    else:
        count = await session.scalar(select(func.count()).select_from(im.IMWebhookReceipt)
            .where(im.IMWebhookReceipt.connection_id == connection.id))
        if count >= 10000:
            raise HTTPException(429, "平台消息过于频繁，请稍后重试")
        session.add(im.IMWebhookReceipt(connection_id=connection.id, verification_key=key,
            content_hash=event["verificationHash"], created_at=connections.now()))
    await session.commit()
