"""Durable task arrivals reuse the coworker inbox and its recipient acknowledgements."""
import uuid

from .. import models
from . import mate_messages, task_assignment


async def create(session, task, sender_id, *, event_id=""):
    recipient_id = str(task.assignee_user_id or "")
    if not sender_id or not recipient_id or str(sender_id) == recipient_id:
        return None
    sender = await session.get(models.User, sender_id)
    recipient = await session.get(models.User, recipient_id)
    if sender is None or recipient is None:
        return None
    key = "handoff:" + event_id if event_id else "task:" + task.id
    who = sender.display_name or sender.username
    text = f"{who} 将需求「{task.title or '未命名'}」交给你"
    return await mate_messages.create(
        session, sender, recipient, {"messageId": key}, text, [], task_id=task.id)


async def transition(session, task, sender_id, kind, detail, actor):
    event = models.TaskEvent(id=str(uuid.uuid4()), task_id=task.id,
                             kind=kind, detail=detail or {}, actor=actor or "")
    session.add(event)
    return await create(session, task, sender_id, event_id=event.id)


async def publish(session, row):
    if row is None:
        return
    sender = await session.get(models.User, row.sender_id)
    recipient = await session.get(models.User, row.recipient_id)
    value = mate_messages.public(row, sender, recipient)
    event = {"type": "notice", "text": value["text"], "kind": "task_assignment",
             "taskId": value["taskId"], "messageId": row.client_message_id,
             "serverMessageId": row.id, "senderId": row.sender_id,
             "senderName": value["senderName"], "recipientId": row.recipient_id,
             "recipientName": value["recipientName"], "sentAt": value["createdAt"],
             "status": value["status"], "deliveredAt": value["deliveredAt"], "readAt": value["readAt"]}
    for device in await task_assignment.active_devices(session, row.recipient_id):
        await mate_messages.publish_event(device.id, event, user_id=row.recipient_id)
    await mate_messages.publish_state(session, row, "mate_message_accepted", recipients=False)
