"""Request-independent single-task notifications with leased, retryable delivery.

Only delivery metadata is queued. The worker projects the current authoritative
task and permissions, so delayed jobs cannot replay old private task payloads.
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
                return job.id, token, job.task_id, job.event_type, dict(job.payload), job.attempts
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
                await receipts.notify_on_close(session, task, metadata.get("closer"),
                                                receipt_id=job_id, raise_errors=True)


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
