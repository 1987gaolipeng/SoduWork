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
import uuid
from datetime import datetime, timezone

from sqlalchemy import literal, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..realtime import hub
from .boxes import box_of_user

log = logging.getLogger("uvicorn.error")


def bounded_detail(detail: dict, *, fallback_title: str = "") -> dict:
    """Bound a receipt snapshot without modifying its source task or historical event."""
    result = detail.copy()
    if fallback_title and not result.get("title"):
        result["title"] = fallback_title
    warnings = dict(result.get("fieldWarnings") or {})
    for key, public_key, limit in (("title", "title", models.TASK_TITLE_MAX),
                                   ("to", "requesterName", models.REQUESTER_NAME_MAX)):
        value = result.get(key) or ""
        if len(value) > limit:
            result[key] = value[:limit - 1] + "…"
            warnings[public_key] = "truncated"
    # Shortening an address or identifier could point to a different recipient.
    for key, limit, empty in (("contact", models.REQUESTER_CONTACT_MAX, ""),
                              ("requesterUserId", models.REQUESTER_USER_ID_MAX, None)):
        if len(result.get(key) or "") > limit:
            result[key] = empty
            warnings[key] = "omitted"
    if warnings:
        result["fieldWarnings"] = warnings
    return result


async def completion_identity(session, task_id, *, closed_at=None):
    """Reuse an existing receipt or bind a new one to the last committed reopen."""
    event = models.TaskEvent
    instance = select(event.id).where(event.task_id == task_id, event.kind.in_(
        ("requirement.definition", "created", "task.execution_started")))
    query = select(event.id, event.kind).where(
        event.task_id == task_id, event.kind.in_(("receipt", "status.reset_from_done")))
    if closed_at is not None:
        # A queued pre-upgrade notification may belong to an earlier cycle.
        query = query.where(event.at <= closed_at)
        instance = instance.where(event.at <= closed_at)
    marker = await session.scalar(instance.order_by(event.at, event.id).limit(1))
    last = (await session.execute(query.order_by(event.at.desc(), event.id.desc()).limit(1))).first()
    if last and last.kind == "receipt":
        identity = last.id
    else:
        reopen_id = last.id if last else ""
        identity = str(uuid.uuid5(uuid.NAMESPACE_URL, f"soduwork/task-receipt/{task_id}/{marker or ''}/{reopen_id}"))
    return identity, closed_at or datetime.now(timezone.utc), marker


def completion_snapshot(task):
    """Only the bounded audit fields and the account eligible for notification."""
    uid = getattr(task, "requester_user_id", None)
    name = (getattr(task, "requester_name", None) or "").strip()
    contact = (getattr(task, "requester_contact", None) or "").strip()
    if not (uid or name or contact):
        return {}
    detail = bounded_detail({"title": getattr(task, "title", None) or "需求", "to": name, "contact": contact,
                             "requesterUserId": uid, "external": not uid})
    recipient = getattr(task, "created_by", None) if detail["external"] else detail["requesterUserId"]
    if recipient and len(recipient) > models.REQUESTER_USER_ID_MAX:
        recipient = None
    return {"detail": detail, "recipient": recipient, "hasResult": bool(getattr(task, "result", None))}


async def notify_on_close(session: AsyncSession, task: models.Task, closer_box_id: str | None,
                          *, receipt_id: str = "", closed_at: datetime | None = None,
                          previous_job_id: str = "", snapshot: dict | None = None,
                          instance_marker: str | None = None, raise_errors: bool = False) -> bool:
    """Notify the requester after task completion. Organization administration permissions do not
    imply personal notification subscriptions; return whether a receipt event was created.
    """
    if task is None:
        return False
    if previous_job_id and not receipt_id and await session.get(models.TaskEvent, previous_job_id) is not None:
        # A pre-upgrade worker committed this receipt before its job was acknowledged.
        return True
    if previous_job_id and snapshot is None and closed_at is None:
        return False  # Neither an original snapshot nor a traceable completion.
    transition = getattr(task, "_close_receipt", None)
    if transition and not previous_job_id and not receipt_id:
        receipt_id, closed_at, instance_marker, snapshot = transition
    owner = [models.Task.id == task.id]
    if instance_marker:
        owner.append(select(models.TaskEvent.id).where(models.TaskEvent.id == instance_marker,
            models.TaskEvent.task_id == task.id).exists())
    if previous_job_id:
        job = models.TaskNotificationOutbox
        owner.append(select(job.id).where(job.id == previous_job_id, job.task_id == task.id).exists())
    # Post-commit callers can retain an ORM object while another request changes
    # its recipient. Resolve eligibility against the current database row.
    task = await session.scalar(select(models.Task).where(*owner).execution_options(populate_existing=True))
    if task is None:
        return False
    current = completion_snapshot(task)
    if snapshot is None and (not current or task.status != "done"):
        return False
    if snapshot == {}:
        return False
    source = snapshot if snapshot is not None else current
    detail = dict(source["detail"])
    title = detail["title"]
    rname = detail["to"]
    rcontact = detail["contact"]
    notice = {"type": "notice", "kind": "task_receipt", "taskId": task.id}
    if "fieldWarnings" in detail:
        notice["fieldWarnings"] = detail["fieldWarnings"]
    extra = "，产出已就绪" if source["hasResult"] else ""
    try:
        if not receipt_id:
            receipt_id, closed_at, marker = await completion_identity(session, task.id, closed_at=closed_at)
            if marker and not instance_marker:
                owner.append(select(models.TaskEvent.id).where(models.TaskEvent.id == marker,
                    models.TaskEvent.task_id == task.id).exists())
        if await session.get(models.TaskEvent, receipt_id) is not None:
            return True
        can_notify = task.status == "done" and bool(current)
        if previous_job_id or transition:
            current_id, _, _ = await completion_identity(session, task.id)
            can_notify = can_notify and current_id == receipt_id
            if previous_job_id and snapshot is None:
                if current_id != receipt_id:
                    return False  # No original fields survive for the obsolete completion.
                # Legacy jobs used live task data. Keep that delivery only for a current
                # close without evidence of a later edit, using exclusively today's fields.
                changed = await session.scalar(select(models.Task.id).where(
                    models.Task.id == task.id, models.Task.updated_at > closed_at))
                can_notify = can_notify and changed is None
                closed_at = datetime.now(timezone.utc)
        if snapshot is not None and current:
            can_notify = (can_notify and snapshot["recipient"] == current["recipient"] and
                          all(detail[field] == current["detail"][field]
                              for field in ("external", "requesterUserId", "to", "contact")))
        if not can_notify:
            via = "recorded"
            if detail["external"]:
                detail["to"] = rname or "外部客户"
        elif not detail["external"]:
            # Notify the internal requester unless they performed the completion themselves.
            ruid = detail["requesterUserId"]
            closer = await session.get(models.Client, closer_box_id) if closer_box_id else None
            self_closed = bool(closer and str(closer.user_ref or "") == str(ruid))
            box = await box_of_user(session, ruid)
            if box and box != closer_box_id and not self_closed:
                await hub.publish(box, {**notice, "recipientId": ruid,
                                        "text": f"✅ 你交办的「{title}」已办结{extra}"}, user_id=ruid)
            via = "self" if self_closed or (box and box == closer_box_id) else ("box" if box else "recorded")
        else:
            # For external requesters, notify the recording user to relay the result.
            recipient = source["recipient"]
            box = await box_of_user(session, recipient)
            if box:
                tail = f"（{rcontact}）" if rcontact else ""
                if "contact" in detail.get("fieldWarnings", {}):
                    tail = "（联系方式过长，请查看原任务）"
                await hub.publish(box, {**notice, "recipientId": recipient,
                                        "text": f"✅ 客户「{rname or '外部'}」提的「{title}」已办结，可回复 TA{tail}"}, user_id=recipient)
            via = "relay" if box else "recorded"
            detail["to"] = rname or "外部客户"

        # Dispatch is at least once. Independent workers may send concurrently;
        # the primary key still permits only one durable audit event for this close.
        insert = pg_insert if session.get_bind().dialect.name == "postgresql" else sqlite_insert
        event = models.TaskEvent.__table__
        values = {"id": receipt_id, "task_id": task.id, "kind": "receipt",
                  "at": closed_at or datetime.now(timezone.utc), "detail": {**detail, "via": via}, "actor": ""}
        # Recheck the original incarnation in the insert, after network I/O. A concurrent
        # deletion either purges this row afterwards or invalidates its marker before it lands.
        columns = [literal(value, type_=event.c[key].type) for key, value in values.items()]
        source = select(*columns).select_from(models.Task).where(*owner).with_for_update(of=models.Task)
        stored = await session.scalar(insert(event).from_select(list(values), source)
            .on_conflict_do_nothing(index_elements=["id"]).returning(event.c.id))
        if stored is None and await session.get(models.TaskEvent, receipt_id) is None:
            await session.rollback()
            return False
        await session.commit()
        return True
    except Exception as e:  # noqa: BLE001 - Receipt delivery failure must not undo task completion.
        if raise_errors:
            raise
        log.warning("receipt notify failed for %s: %s", task.id, e)
        return False
