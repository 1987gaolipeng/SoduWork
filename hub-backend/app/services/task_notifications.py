"""Request-independent single-task notifications with leased, retryable delivery.

Task updates queue delivery metadata and project the current authorized task.
Completion jobs also retain the bounded receipt snapshot for the audit timeline.
Delivery is at least once; events retain the existing idempotent task IDs.
"""
import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, delete, exists, or_, select, update
from sqlalchemy.orm import aliased

from .. import models
from ..db import SessionLocal

log = logging.getLogger("uvicorn.error")
LEASE_SECONDS = 120
DELIVERY_SECONDS = 60


def enqueue(session, task, event_type, **metadata):
    if metadata.get("closed"):
        from . import receipts
        transition = getattr(task, "_close_receipt", None)
        if transition:
            receipt_id, closed_at, marker, snapshot = transition
            metadata.update(receipt_id=receipt_id, closed_at=closed_at.isoformat(), instance_marker=marker)
        else:
            snapshot = receipts.completion_snapshot(task)
            metadata["closed_at"] = datetime.now(timezone.utc).isoformat()
        metadata["receipt_snapshot"] = snapshot
    metadata["memory_orgs"] = sorted({metadata.get("previous_org"),
                                      getattr(task, "shared_org_id", None)} - {None, ""})
    job = models.TaskNotificationOutbox(task_id=task.id, event_type=event_type,
                                         payload=metadata)
    session.add(job)
    return job


def _due(now):
    row = models.TaskNotificationOutbox
    return (row.available_at <= now,
            or_(row.lease_until.is_(None), row.lease_until < now))


async def claim(sessions=SessionLocal):
    """CAS also protects against overlap during cluster leader failover."""
    row = models.TaskNotificationOutbox
    now = datetime.now(timezone.utc)
    earlier = aliased(row)
    first_for_task = ~exists(select(earlier.id).where(earlier.task_id == row.task_id,
        or_(earlier.created_at < row.created_at,
            and_(earlier.created_at == row.created_at, earlier.id < row.id))))
    async with sessions() as session:
        ids = list(await session.scalars(select(row.id).where(*_due(now), first_for_task)
                    .order_by(row.created_at, row.id).limit(20)))
        for job_id in ids:
            token = str(uuid.uuid4())
            result = await session.execute(update(row).where(row.id == job_id, *_due(now))
                .values(lease_token=token, lease_until=now + timedelta(seconds=LEASE_SECONDS),
                        attempts=row.attempts + 1).execution_options(synchronize_session=False))
            if result.rowcount:
                await session.commit()
                job = await session.get(row, job_id)
                metadata = dict(job.payload)
                if metadata.get("closed"):
                    # Existing queued jobs predate per-completion receipt IDs.
                    metadata.setdefault("closed_at", job.created_at.isoformat())
                return job.id, token, job.task_id, job.event_type, metadata, job.attempts
        await session.rollback()
    return None


async def deliver(job, sessions=SessionLocal):
    from . import task_access, tasks
    job_id, _, tid, event_type, metadata, _ = job
    async with sessions() as session:
        from . import org_memory
        for org_id in metadata.get("memory_orgs", []):
            await org_memory.refresh(session, org_id)
        await session.commit()
        task = await session.get(models.Task, tid)
        if event_type == "task.deleted":
            # A subsequently recreated task must not be removed by an old job.
            # Legacy device-only receipts cannot prove the original account.
            accounts = metadata.get("recipient_accounts", {})
            events = []
            if task is None:
                for recipient in metadata.get("recipients", []):
                    if isinstance(recipient, dict):
                        # The concurrent main line stored the same account
                        # evidence inline. Never infer it from a later login.
                        cid, account = recipient.get("device"), recipient.get("user")
                    else:
                        cid, account = recipient, accounts.get(recipient)
                    if isinstance(cid, str) and cid and isinstance(account, str):
                        events.append((cid, {"type": "task.deleted", "id": tid}, account))
        elif task is None:
            return  # A later delete job owns removal of the cached card.
        else:
            # Automation runs are ordinary conversations and must never fan
            # out task notifications, even for outbox rows created by the
            # pre-conversation implementation.
            # A normal requirement may link a follow-up schedule without being
            # a scheduler-generated run. Match the task-list origin boundary.
            if (str(getattr(task, "origin", "") or "") == "automation" or
                    str(getattr(task, "source", "") or "") == "定时派活"):
                return
            arrival = metadata.get("arrival", "")
            if metadata.get("assignee") != task.assignee_user_id:
                arrival = ""
            api = await tasks.task_to_api_live(session, task)
            events = await task_access.prepare_task_events(session, task, event_type, api,
                arrival=arrival, by=metadata.get("by", ""),
                notification_id=metadata.get("notification_id", ""))
            previous_org = metadata.get("previous_org")
            if previous_org and previous_org != task.shared_org_id:
                current = {c.id for c in await task_access.recipient_clients(session, task)}
                previous = await task_access.recipient_clients(session, task, shared_org_id=previous_org)
                events.extend((c.id, {"type": "task.deleted", "id": tid}, c.user_ref or "")
                              for c in previous if c.id not in current)
    # Return the connection to the pool before waiting on device transports.
    await task_access.publish_events(events, publish=publish_reliably)
    if metadata.get("review_request_id"):
        from ..automation_models import ApprovalRequest
        from . import code_delivery
        async with sessions() as session:
            task = await session.get(models.Task, tid)
            request = await session.get(ApprovalRequest, metadata["review_request_id"])
            # Delayed/retried notifications cannot invite acceptance of a gate
            # already decided, cancelled, or superseded by a later revision.
            if (task is not None and request is not None and request.task_id == tid
                    and request.action == "review" and request.status == "pending"
                    and not task.archived_at and not task.reviewed_at):
                await code_delivery.notify_reviewer(session, task, request.artifact_version_id,
                                                    "交付成果", publish=publish_reliably)
    if metadata.get("notification_id"):
        from . import task_assignment_notifications
        async with sessions() as session:
            notice = await session.get(models.MateMessage, metadata["notification_id"])
            if notice is not None:
                await task_assignment_notifications.publish(session, notice)
    if metadata.get("closed"):
        from . import receipts
        async with sessions() as session:
            task = await session.get(models.Task, tid)
            if task is not None:
                closed_at = metadata.get("closed_at")
                await receipts.notify_on_close(session, task, metadata.get("closer"),
                    receipt_id=metadata.get("receipt_id", ""), previous_job_id=job_id,
                    snapshot=metadata.get("receipt_snapshot"), instance_marker=metadata.get("instance_marker"),
                    closed_at=datetime.fromisoformat(closed_at) if closed_at else None, raise_errors=True)


async def publish_reliably(device_id, event, *, user_id):
    from . import task_access
    from .cluster_bus import bus
    if bus.enabled:
        # The normal live broadcast is best effort. A durable job must retain
        # partial cross-node failures rather than acknowledging them as sent.
        await bus.broadcast({"kind": "publish", "device": device_id, "event": event,
                             "userId": user_id}, strict=True)
        await task_access.hub.publish(device_id, event, _local=True, user_id=user_id)
    else:
        await task_access.hub.publish(device_id, event, user_id=user_id)


async def run_once(sessions=SessionLocal):
    job = await claim(sessions)
    if job is None:
        return False
    job_id, token, _, _, _, attempts = job
    row = models.TaskNotificationOutbox
    try:
        await asyncio.wait_for(deliver(job, sessions), DELIVERY_SECONDS)
    except asyncio.CancelledError:
        # Keep the lease: another worker can recover it after expiration.
        raise
    except Exception:
        log.exception("task notification delivery failed id=%s attempt=%s", job_id, attempts)
        async with sessions() as session:
            await session.execute(update(row).where(row.id == job_id, row.lease_token == token)
                .values(lease_token=None, lease_until=None,
                        available_at=datetime.now(timezone.utc) + timedelta(seconds=min(60, 2 ** min(attempts, 6)))))
            await session.commit()
    else:
        async with sessions() as session:
            await session.execute(delete(row).where(row.id == job_id, row.lease_token == token))
            await session.commit()
    return True


async def loop():
    while True:
        try:
            if await run_once():
                continue
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("task notification worker failed")
        await asyncio.sleep(0.5)
