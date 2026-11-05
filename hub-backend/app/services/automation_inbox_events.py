"""Post-commit hints for native automation inbox membership and handoff changes.

No work or authorization is carried by the hint. The existing authenticated
inbox/claim protocol remains authoritative. Pure lease renewals do not publish:
otherwise every poll would wake itself and defeat the discovery backoff.
"""
import asyncio
import logging

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

_KEY = "automation_inbox_events"
_PROTOCOL = "soduwork.automation-conversation/v1"
_ACTIVE = {"starting", "running", "waiting"}
_pending = set()
_worker = None
_accepting = True
_MAX_PENDING = 2048
log = logging.getLogger("uvicorn.error")


def _view(row, previous=False):
    state = inspect(row)
    def value(name):
        history = state.attrs[name].history
        return history.deleted[0] if previous and history.deleted else state.dict.get(name)
    receipt = value("receipt") or {}
    return (value("owner_client_id"), value("owner_user_id") or "", value("state"),
            receipt.get("executionMode"), receipt.get("conversationId"))


@event.listens_for(Session, "after_flush")
def _collect(session, _context):
    from ..models import AiScheduleRun
    transaction = session.get_nested_transaction() or session.get_transaction()
    if transaction is None:
        return
    # Mapper hooks freeze the execution owner while inserting. Collect only
    # after SQL has run, while SQLAlchemy still retains pre-flush history.
    for row in set(session.new) | set(session.dirty) | set(session.deleted):
        if not isinstance(row, AiScheduleRun):
            continue
        before = None if row in session.new else _view(row, True)
        after = None if row in session.deleted else _view(row)
        if before == after:
            continue
        targets = {(view[0], view[1]) for view in (before, after)
                   if view and view[0] and view[3] == _PROTOCOL and view[2] in _ACTIVE}
        if targets:
            session.info.setdefault(_KEY, {}).setdefault(transaction, set()).update(targets)


async def _publish(targets):
    from .native_discovery import wake
    async def one(device, owner):
        try:
            await asyncio.wait_for(wake(device, owner, "automation-inbox"), timeout=5)
        except Exception as error:
            # Business data is committed. Periodic inbox reads repair a lost hint.
            log.warning("Automation inbox notification failed: %s", type(error).__name__)
    await asyncio.gather(*(one(device, owner) for device, owner in targets))


async def _drain():
    global _worker
    try:
        await asyncio.sleep(0.25)
        while _pending:
            batch = set()
            while _pending and len(batch) < 16:
                batch.add(_pending.pop())
            await _publish(batch)
    finally:
        _worker = None


def _enqueue(targets):
    global _worker
    if not _accepting:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # Synchronous maintenance sessions retain periodic HTTP fallback.
    for target in targets:
        if len(_pending) < _MAX_PENDING:
            _pending.add(target)
    if _pending and _worker is None:
        _worker = loop.create_task(_drain(), name="automation-inbox-hints")


def start():
    global _accepting
    _accepting = True


async def flush_for_test():
    while _worker is not None:
        await asyncio.shield(_worker)


async def stop():
    global _accepting
    _accepting = False
    worker = _worker
    if worker is not None:
        try:
            await asyncio.wait_for(asyncio.shield(worker), timeout=2)
        except (TimeoutError, asyncio.CancelledError):
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
    _pending.clear()


@event.listens_for(Session, "after_commit")
def _committed(session):
    transaction = session.get_nested_transaction() or session.get_transaction()
    pending = session.info.get(_KEY, {})
    targets = pending.pop(transaction, set())
    if not targets:
        return
    if transaction.nested:
        pending.setdefault(transaction.parent, set()).update(targets)
        return
    _enqueue(targets)


@event.listens_for(Session, "after_transaction_end")
def _ended(session, transaction):
    pending = session.info.get(_KEY)
    if pending is not None:
        pending.pop(transaction, None)
        if not pending:
            session.info.pop(_KEY, None)
