"""Bound native automation handoff and receipt lifetimes using Hub timestamps.

Device presence is only a dispatch prerequisite. Once accepted, the execution
worker's renewable lease is authoritative; another logged-in desktop or an open
history drawer cannot keep an abandoned occurrence alive.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, or_, select, update

from .. import models
from .schedule_run_contracts import RUN_ACTIVE
from .schedule_timing import utc

PROTOCOL = 'soduwork.automation-conversation/v1'
DEVICE_ONLINE_SECONDS = 300
ACCEPT_TIMEOUT_SECONDS = 300
RECEIPT_GRACE_SECONDS = 120


def device_available(client, now=None):
    current = now or datetime.now(timezone.utc)
    seen = getattr(client, 'last_seen_at', None)
    seen = utc(seen) if seen else None
    return bool(seen and seen >= current - timedelta(seconds=DEVICE_ONLINE_SECONDS))


def expired_clause(now):
    run = models.AiScheduleRun
    lease = run.receipt['leaseUntil'].as_float()
    return and_(
        run.state.in_(RUN_ACTIVE),
        run.receipt['executionMode'].as_string() == PROTOCOL,
        or_(
            and_(lease > 0, lease <= now.timestamp() - RECEIPT_GRACE_SECONDS),
            and_(or_(lease.is_(None), lease <= 0),
                 run.started_at <= now - timedelta(seconds=ACCEPT_TIMEOUT_SECONDS)),
        ),
    )


async def expire_run(session, run, now=None):
    """Conditionally close a lost native attempt; never overwrite a fresh ack.

The conditional UPDATE is needed even when the caller holds a row lock:
SQLite ignores FOR UPDATE and another Hub may have renewed the lease after
this session loaded its snapshot.
"""
    current = now or datetime.now(timezone.utc)
    receipt = dict(run.receipt or {})
    if run.state not in RUN_ACTIVE or receipt.get('executionMode') != PROTOCOL:
        return False
    try:
        lease = float(receipt.get('leaseUntil') or 0)
    except (TypeError, ValueError):
        lease = 0
    started = utc(run.started_at) if run.started_at else None
    if lease > 0:
        if lease + RECEIPT_GRACE_SECONDS > current.timestamp():
            return False
    elif not started or started + timedelta(seconds=ACCEPT_TIMEOUT_SECONDS) > current:
        return False
    has_chat = bool(receipt.get('conversationId'))
    code = 'AUTOMATION_RECEIPT_TIMEOUT' if has_chat else 'AUTOMATION_DEVICE_TIMEOUT'
    reason = ('执行端已失联，未收到完成回执，本次记为失败。请确认客户端在线后检查原会话，必要时重新执行。'
              if has_chat else
              '执行端未在规定时间内接收，本次未执行。请启动原执行设备上的客户端后重新执行。')
    receipt.update(errorCode=code)
    receipt.pop('phase', None)
    owner = models.AiScheduleRun.receipt['worker'].as_string()
    conversation = models.AiScheduleRun.receipt['conversationId'].as_string()
    result = await session.execute(update(models.AiScheduleRun).where(
        models.AiScheduleRun.id == run.id, models.AiScheduleRun.state == run.state,
        expired_clause(current),
        owner == receipt['worker'] if receipt.get('worker') is not None else owner.is_(None),
        conversation == receipt['conversationId'] if receipt.get('conversationId') is not None
        else conversation.is_(None),
        # Preserve a newer lease even if it too has since expired. Reconcile
        # that newer snapshot on the next pass instead of restoring old fields.
        models.AiScheduleRun.receipt['leaseUntil'].as_float() == lease if lease else
        or_(models.AiScheduleRun.receipt['leaseUntil'].as_float().is_(None),
            models.AiScheduleRun.receipt['leaseUntil'].as_float() == 0),
    ).values(state='failed', error=reason, finished_at=current, receipt=receipt)
        .execution_options(synchronize_session=False))
    await session.refresh(run)
    if not result.rowcount:
        return False
    # Historical cleanup must not rewrite a newer occurrence or consume its
    # retry budget. The existing scheduler still owns all future triggers.
    from . import schedule_timing
    plan = await schedule_timing.locked_schedule(session, run.schedule_id)
    if plan is not None and schedule_timing.matches(plan, run):
        latest = await session.scalar(select(models.AiScheduleRun.id).where(
            models.AiScheduleRun.schedule_id == run.schedule_id
        ).order_by(models.AiScheduleRun.started_at.desc()).limit(1))
        if latest == run.id:
            plan.last_error = reason[:400]
    return True


async def reconcile_expired(session, *, schedule_id='', owner_client_id='',
                            owner_user_id=None, limit=200, now=None):
    current = now or datetime.now(timezone.utc)
    query = select(models.AiScheduleRun).where(expired_clause(current))
    if schedule_id:
        query = query.where(models.AiScheduleRun.schedule_id == schedule_id)
    if owner_client_id:
        query = query.where(models.AiScheduleRun.owner_client_id == owner_client_id)
    if owner_user_id is not None:
        query = query.where(models.AiScheduleRun.owner_user_id == owner_user_id if owner_user_id
                            else models.AiScheduleRun.owner_user_id.is_(None))
    # Filter before limiting: fresh active runs must not starve old abandoned
    # runs. Bounded batches allow existing history to heal without a DB rewrite.
    rows = list((await session.scalars(query.order_by(models.AiScheduleRun.started_at)
        .limit(max(1, min(500, int(limit or 200))))
        .with_for_update(skip_locked=True).execution_options(populate_existing=True))).all())
    # The oldest-first selection is for fairness; acquire plan locks in a
    # stable order across disjoint Hub batches to avoid A/B vs B/A deadlocks.
    for run in sorted(rows, key=lambda row: (row.schedule_id, row.id)):
        await expire_run(session, run, current)
    return rows
