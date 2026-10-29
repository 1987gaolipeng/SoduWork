"""Completion receipts: notify the requester when a task reaches status=done.

Internal requesters (requester_user_id) receive a client notice, except when they complete
their own task. For external requesters (requester_name and contact), notify the registering
user so they can relay the result. Automatic external writeback requires a separate adapter;
this implementation records the receipt and reminds the registering user.

Each completion records a TaskEvent with kind='receipt' for the timeline and receipt dashboard.
Call after committing the done status in tasks.update_task, tasks.sync, or
team.set_team_task_status. closer_box_id identifies the device that completed the task
and suppresses redundant internal notifications.
"""
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..realtime import hub
from .boxes import box_of_user

log = logging.getLogger("uvicorn.error")


async def notify_on_close(session: AsyncSession, task: models.Task, closer_box_id: str | None,
                          *, receipt_id: str = "", raise_errors: bool = False) -> bool:
    """Notify the requester after task completion. Organization administration permissions do not
    imply personal notification subscriptions; return whether a receipt event was created.
    """
    if task is None or task.status != "done":
        return False
    if receipt_id and await session.get(models.TaskEvent, receipt_id) is not None:
        return True
    ruid = task.requester_user_id
    rname = (task.requester_name or "").strip()
    rcontact = (task.requester_contact or "").strip()
    if not (ruid or rname or rcontact):
        return False  # Tasks without a requester need no completion receipt.

    title = task.title or "需求"
    extra = "，产出已就绪" if task.result else ""
    try:
        if ruid:
            # Notify the internal requester unless they performed the completion themselves.
            closer = await session.get(models.Client, closer_box_id) if closer_box_id else None
            self_closed = bool(closer and str(closer.user_ref or "") == str(ruid))
            box = await box_of_user(session, ruid)
            if box and box != closer_box_id and not self_closed:
                await hub.publish(box, {"type": "notice", "kind": "task_receipt",
                                        "recipientId": ruid, "taskId": task.id,
                                        "text": f"✅ 你交办的「{title}」已办结{extra}"}, user_id=ruid)
            via = "self" if self_closed or (box and box == closer_box_id) else ("box" if box else "recorded")
            target = rname or ""
        else:
            # For external requesters, notify the recording user to relay the result.
            box = await box_of_user(session, task.created_by) if task.created_by else None
            if box:
                tail = f"（{rcontact}）" if rcontact else ""
                await hub.publish(box, {"type": "notice", "kind": "task_receipt",
                                        "recipientId": task.created_by, "taskId": task.id,
                                        "text": f"✅ 客户「{rname or '外部'}」提的「{title}」已办结，可回复 TA{tail}"}, user_id=task.created_by)
            via = "relay" if box else "recorded"
            target = rname or "外部客户"

        session.add(models.TaskEvent(
            **({"id": receipt_id} if receipt_id else {}),
            task_id=task.id, kind="receipt",
            detail={"to": target, "contact": rcontact, "via": via,
                    "requesterUserId": ruid, "title": title, "external": not ruid},
            actor="",
        ))
        await session.commit()
        return True
    except Exception as e:  # noqa: BLE001 - Receipt delivery failure must not undo task completion.
        if raise_errors:
            raise
        log.warning("receipt notify failed for %s: %s", task.id, e)
        return False
