"""Durable send receipts around the existing Runner comment/turnId queue.

If the Hub dies after sending but before storing the receipt, keep the send
uncertain. Never manufacture an ACK or blindly replay that external operation.
"""
import asyncio
import hashlib
import json
import re
import uuid

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from ..conversation_handoff_models import ConversationMessageReceipt as Receipt
from . import ai_exec


async def send(session, client, task_id, ref, text, message_id, ctx, *, execution_selection=None):
    if not isinstance(message_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", message_id):
        raise HTTPException(400, "消息编号格式不正确")
    row_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "soduwork:message:" + client.id + ":" + task_id + ":" + message_id))
    content = text if execution_selection is None else json.dumps(
        {"text": text, "executionSelection": execution_selection}, sort_keys=True, ensure_ascii=False)
    digest = hashlib.sha256(content.encode()).hexdigest()
    row = await session.get(Receipt, row_id)
    if row is None:
        row = Receipt(id=row_id, task_id=task_id, owner_client_id=client.id,
                      message_id=message_id, content_hash=digest)
        session.add(row)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
        else:
            result = await asyncio.to_thread(ai_exec.say_sync, ctx, ref, text, message_id=row_id)
            if result.get("ok"):
                row.phase, row.receipt = "accepted", dict(result)
                await session.commit()
                return {**result, "messageId": message_id, "delivery": "accepted"}
            # An explicit refusal before send is retryable; an unconfirmed RPC
            # remains fenced. Keep the original error for a useful user recovery.
            row.phase = "uncertain" if result.get("uncertain") else "rejected"
            row.receipt = dict(result)
            await session.commit()
    row = await session.get(Receipt, row_id, populate_existing=True)
    if row.content_hash != digest:
        raise HTTPException(409, "消息编号已用于另一段内容")
    if row.phase == "accepted":
        return {**row.receipt, "messageId": message_id, "delivery": "accepted", "duplicate": True}
    if row.phase == "rejected":
        return {**row.receipt, "messageId": message_id, "delivery": "rejected"}
    return {"ok": False, "pending": True, "uncertain": True, "messageId": message_id,
            "delivery": "uncertain", "error": "正在核对这条消息是否已送达，请不要重复发送"}
