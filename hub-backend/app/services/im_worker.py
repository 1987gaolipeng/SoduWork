"""Leased IM inbox/outbox processing; no automatic replay of ambiguous side effects."""
import asyncio
import logging
import re
import uuid
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import and_, exists, func, or_, select, update
from sqlalchemy.orm import aliased

from .. import automation_models as am, im_models as im
from ..config import get_settings
from ..db import SessionLocal
from . import im_connections as connections, im_execution, im_transport
from .im_ingress import enqueue_reply

log = logging.getLogger("uvicorn.error")
TERMINAL = {"done", "rejected", "cancelled"}
LEASE_SECONDS = 90


def _outbox_head():
    earlier = aliased(im.IMOutbox)
    return ~exists(select(earlier.id).where(earlier.binding_id == im.IMOutbox.binding_id,
        earlier.status.in_(("queued", "sending", "uncertain")), or_(
            earlier.created_at < im.IMOutbox.created_at,
            and_(earlier.created_at == im.IMOutbox.created_at, earlier.part < im.IMOutbox.part),
            and_(earlier.created_at == im.IMOutbox.created_at, earlier.part == im.IMOutbox.part,
                earlier.id < im.IMOutbox.id))))


async def _claim_route(sessions, task_id):
    token = str(uuid.uuid4())
    async with sessions() as session:
        claimed = await session.execute(update(im.IMRoute).where(im.IMRoute.task_id == task_id,
            or_(im.IMRoute.lease_until.is_(None), im.IMRoute.lease_until < connections.now())).values(
                lease_token=token, lease_until=connections.now() + timedelta(seconds=LEASE_SECONDS)))
        await session.commit()
        return token if claimed.rowcount == 1 else ""


async def _finish(session, inbox, status, detail, reply=""):
    inbox.status, inbox.detail = status, detail
    if reply:
        await enqueue_reply(session, inbox, status, reply)
    if status in TERMINAL:
        route = await session.get(im.IMRoute, inbox.task_id)
        if route and route.active_inbox_id == inbox.id:
            route.active_inbox_id = ""
    else:
        inbox.available_at = connections.now() + timedelta(seconds=30)
    await session.commit()


async def _step(session, route, inbox):
    binding = await session.get(im.IMBinding, inbox.binding_id, populate_existing=True)
    connection = await session.get(im.IMConnection, inbox.connection_id, populate_existing=True)
    if not binding or not binding.enabled:
        await _finish(session, inbox, "cancelled", "绑定已撤销")
        return
    try:
        await connections.target(session, connection, binding.task_id, binding.runner_id)
    except HTTPException:
        await _finish(session, inbox, "cancelled", "账号、连接或执行机授权已变更")
        return
    if inbox.status == "sending":
        # The previous lease died after persisting intent. Never replay the RPC.
        await _finish(session, inbox, "uncertain", "执行送达结果待核对",
            "尚未确认上一条消息是否送达。为避免重复执行，已暂停此会话队列，请在 SoduWork 核对。")
        return
    if inbox.status == "uncertain":
        inbox.available_at = connections.now() + timedelta(seconds=60)
        await session.commit()
        return
    if inbox.status == "waiting":
        row = (await session.scalars(select(am.ExecutionSession).where(
            am.ExecutionSession.task_id == inbox.task_id, am.ExecutionSession.ref == inbox.ref))).first()
        if row and row.runner_id != binding.runner_id:
            await _finish(session, inbox, "cancelled", "执行机已变更")
            return
        try:
            answer = await im_execution.final_text(session, row, inbox, binding) if row else None
        except HTTPException:
            await _finish(session, inbox, "uncertain", "执行机缺少消息关联回执，请升级并核对原会话",
                "无法确认本条消息对应的执行结果，请升级桌面执行机并在 SoduWork 核对原会话；系统不会转发其他轮次的结果。")
            return
        if answer is not None:
            await _finish(session, inbox, "done", "本轮结果已进入回传队列", answer)
        else:
            elapsed = (connections.now() - (inbox.accepted_at or inbox.created_at)
                .replace(tzinfo=connections.now().tzinfo)).total_seconds()
            if elapsed >= 86400:
                await _finish(session, inbox, "uncertain", "超过24小时未收到本条消息的确定结果，请核对原会话",
                    "本条消息超过24小时未收到可核对的结果，已暂停后续自动派发，请在 SoduWork 原会话检查；系统不会重复执行。")
                return
            if elapsed >= 60 and (not inbox.diagnosed_at or
                    (connections.now() - inbox.diagnosed_at.replace(tzinfo=connections.now().tzinfo)).total_seconds() >= 60):
                diagnosis = await im_execution.diagnose(binding, inbox)
                inbox.diagnosed_at = connections.now()
                if diagnosis == "failed":
                    await _finish(session, inbox, "rejected", "执行机确认本条消息未完成，请检查原会话",
                        "执行机确认本条消息未能完成，请在 SoduWork 原会话查看原因。")
                    return
                inbox.detail = {"offline": "执行机离线，等待重连后核对本条消息结果",
                    "queued": "执行机已接收，本条消息正在等待前序工作完成"}.get(diagnosis,
                        "等待本条消息的完整结果归档，可在原会话检查执行进度")
            inbox.available_at = connections.now() + timedelta(seconds=2)
            await session.commit()
        return
    try:
        client, row, waiting = await im_execution.preflight(session, connection, binding)
    except HTTPException as exc:
        # Local policy errors are bounded by this adapter; never relay arbitrary upstream details.
        message = str(exc.detail) if isinstance(exc.detail, str) else "当前任务不能远程执行，请在 SoduWork 检查"
        await _finish(session, inbox, "rejected", message[:160], message[:160])
        return
    if waiting:
        inbox.detail, inbox.available_at = waiting, connections.now() + timedelta(seconds=10)
        await session.commit()
        return
    inbox.ref = row.ref if row else ""
    follow_up = bool(inbox.ref)
    inbox.base_seq = int(row.seq or 0) if row else 0
    inbox.base_round = int((row.metadata_ or {}).get("round") or 1) if row else 0
    inbox.status, inbox.detail = "sending", "正在交给执行机"
    inbox_id = inbox.id
    await session.commit()
    try:
        async with asyncio.timeout(45):
            result = await im_execution.submit(session, client, binding, inbox)
        if not follow_up and (result.get("already") or result.get("reused")):
            await _finish(session, inbox, "rejected", "任务已由另一条请求启动，本条未重新派发",
                "此任务刚由另一条请求启动，本条消息未重新派发。请在 SoduWork 检查原会话后再发送。")
            return
        if not result.get("ok") or result.get("uncertain") or result.get("pending"):
            status = "rejected" if result.get("delivery") == "rejected" else "uncertain"
            await _finish(session, inbox, status, "执行机未确认接受消息",
                "执行机未确认接受消息，请在 SoduWork 核对；系统不会自动重复执行。")
            return
        if not inbox.ref:
            inbox.ref = str(result.get("ref") or result.get("issueId") or "")
        if not inbox.ref:
            await _finish(session, inbox, "uncertain", "缺少执行回执，请人工核对")
            return
        admission_key = result.get("admissionKey")
        expected_key = ("comment:" + str(uuid.uuid5(uuid.NAMESPACE_URL,
            "soduwork:message:" + client.id + ":" + inbox.task_id + ":im-" + inbox.id))
            if follow_up else "dispatch:" + inbox.ref)
        if (not isinstance(admission_key, str) or admission_key != expected_key
                or not re.fullmatch(r"(?:comment|dispatch):[A-Za-z0-9][A-Za-z0-9._:-]{7,127}", admission_key)):
            await _finish(session, inbox, "uncertain", "执行机缺少消息关联回执，请升级并核对原会话",
                "执行机已接收请求，但版本缺少可靠的消息关联回执。请升级桌面执行机并在 SoduWork 核对原会话；系统不会自动重复执行。")
            return
        inbox.admission_key = admission_key
        inbox.accepted_at = connections.now()
        inbox.status, inbox.detail = "waiting", "执行中，等待本轮结果"
        inbox.available_at = connections.now() + timedelta(seconds=2)
        await session.commit()
    except (Exception, asyncio.CancelledError):
        # Core services may have committed an RPC receipt before raising or cancellation.
        # Leave the durable sending fence for recovery if this transaction cannot commit.
        await session.rollback()
        current = await session.get(im.IMInbox, inbox_id)
        if current:
            await _finish(session, current, "uncertain", "执行送达结果待核对",
                "执行送达结果待核对，已暂停自动发送。请在 SoduWork 原会话检查。")
        raise


async def process_route(sessions, task_id):
    token = await _claim_route(sessions, task_id)
    if not token:
        return
    try:
        async with sessions() as session:
            route = await session.get(im.IMRoute, task_id)
            inbox = await session.get(im.IMInbox, route.active_inbox_id) if route.active_inbox_id else None
            if inbox is None or inbox.status in TERMINAL:
                inbox = (await session.scalars(select(im.IMInbox).where(im.IMInbox.task_id == task_id,
                    im.IMInbox.status == "queued").order_by(im.IMInbox.created_at, im.IMInbox.id).limit(1))).first()
                route.active_inbox_id = inbox.id if inbox else ""
                await session.commit()
            if inbox and inbox.available_at.replace(tzinfo=connections.now().tzinfo) <= connections.now():
                await _step(session, route, inbox)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        log.warning("IM execution worker failed: %s", type(exc).__name__)
    finally:
        async with sessions() as session:
            await session.execute(update(im.IMRoute).where(im.IMRoute.task_id == task_id,
                im.IMRoute.lease_token == token).values(lease_token="", lease_until=None))
            await session.commit()


async def process_outbox(sessions, outbox_id):
    token = str(uuid.uuid4())
    async with sessions() as session:
        claimed = await session.execute(update(im.IMOutbox).where(im.IMOutbox.id == outbox_id,
            im.IMOutbox.status == "queued", im.IMOutbox.available_at <= connections.now(), _outbox_head()).values(
                status="sending", lease_token=token, lease_until=connections.now() + timedelta(seconds=LEASE_SECONDS),
                attempts=im.IMOutbox.attempts + 1).execution_options(synchronize_session=False))
        await session.commit()
        if claimed.rowcount != 1:
            return
        row = await session.get(im.IMOutbox, outbox_id)
        binding = await session.get(im.IMBinding, row.binding_id, populate_existing=True)
        connection = await session.get(im.IMConnection, row.connection_id, populate_existing=True)
        inbox = await session.get(im.IMInbox, row.inbox_id)
        try:
            if not binding or not binding.enabled or not inbox:
                raise HTTPException(403, "绑定已撤销")
            await connections.target(session, connection, binding.task_id, binding.runner_id)
            credentials = connections.unpack(connection)
            identity = {**binding.external_identity, **(inbox.reply_context or {})}
            await session.commit()
            identifier = await im_transport.send(connection.provider, credentials, identity, row.text, row.id)
            row.status, row.external_message_id, row.detail = "sent", identifier, ""
        except HTTPException:
            row.status, row.detail = "cancelled", "绑定或账号授权已撤销"
        except im_transport.TransportError as exc:
            row.detail = str(exc)
            if exc.uncertain:
                row.status = "uncertain"
            elif exc.retry_after and row.attempts < 5:
                row.status = "queued"
                row.available_at = connections.now() + timedelta(seconds=exc.retry_after)
            else:
                row.status = "failed"
        except asyncio.CancelledError:
            raise
        except Exception:
            row.status, row.detail = "uncertain", "platform_send_unconfirmed"
        row.lease_token, row.lease_until = "", None
        await session.commit()


async def run_once(sessions=SessionLocal):
    if not get_settings().im_enabled:
        return
    async with sessions() as session:
        await session.execute(update(im.IMOutbox).where(im.IMOutbox.status == "sending",
            im.IMOutbox.lease_until < connections.now()).values(status="uncertain", detail="platform_send_unconfirmed"))
        await session.commit()
        task_ids = list((await session.scalars(select(im.IMInbox.task_id).join(im.IMRoute,
            im.IMRoute.task_id == im.IMInbox.task_id).where(
            im.IMInbox.status.in_(("queued", "sending", "waiting", "uncertain")),
            im.IMInbox.available_at <= connections.now(),
            or_(im.IMRoute.active_inbox_id == "", im.IMRoute.active_inbox_id == im.IMInbox.id))
            .group_by(im.IMInbox.task_id).order_by(func.min(im.IMInbox.available_at), im.IMInbox.task_id).limit(4))).all())
        # Filter blocked bindings before limiting, so one paused chat cannot starve others.
        outgoing = list((await session.scalars(select(im.IMOutbox.id).where(im.IMOutbox.status == "queued",
            im.IMOutbox.available_at <= connections.now(), _outbox_head())
            .order_by(im.IMOutbox.available_at, im.IMOutbox.created_at, im.IMOutbox.part, im.IMOutbox.id).limit(4))).all())
    await asyncio.gather(*(process_route(sessions, task_id) for task_id in task_ids),
                         *(process_outbox(sessions, identifier) for identifier in outgoing))


async def loop():
    if not get_settings().im_enabled:
        return
    while True:
        try:
            await run_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("IM queue iteration failed: %s", type(exc).__name__)
        await asyncio.sleep(1)
