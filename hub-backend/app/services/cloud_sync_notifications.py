"""Post-commit, account-scoped hints for durable cloud projections.

Hints never authorize work or replace reconciliation. Coalescing is bounded and
uses a separate session after commit, so slow transports cannot retain a writer's
connection. Rollbacks and savepoints retain their own notification sets.
"""
from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from weakref import WeakKeyDictionary

from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sqlalchemy.orm import Session

log = logging.getLogger(__name__)
_KEY = "cloud_sync_notifications"
_QUEUES = WeakKeyDictionary()
_STOPPED = WeakKeyDictionary()
_TABLES = {"task", "conversation_handoff", "conversation_message_receipt",
           "attachment", "automation_approval_request", "automation_execution_session"}
_LIMIT = 10000


def mark(session, task_id, *, owner="", execution_id=""):
    session = getattr(session, "sync_session", session)
    transaction = session.get_nested_transaction() or session.get_transaction()
    if transaction is None or not (task_id or execution_id):
        return
    records = session.info.setdefault(_KEY, {}).setdefault(transaction, set())
    if len(records) < _LIMIT:
        records.add((str(task_id or ""), str(owner or ""), str(execution_id or "")))


def _collect(session, *_):
    for row in session.new | session.dirty | session.deleted:
        table = getattr(type(row), "__tablename__", "")
        if table not in _TABLES and table != "automation_execution_event":
            continue
        if row in session.dirty and not session.is_modified(row, include_collections=False):
            continue
        values = vars(row)
        if table == "automation_execution_event":
            mark(session, "", execution_id=values.get("session_id"))
        else:
            mark(session, values.get("id") if table == "task" else values.get("task_id"),
                 owner=values.get("owner_user_id", "") if table == "conversation_handoff" else "")


def _committed(session):
    transaction = session.get_nested_transaction() or session.get_transaction()
    groups = session.info.get(_KEY, {})
    records = groups.pop(transaction, set())
    if not records:
        return
    if transaction.nested:
        groups.setdefault(transaction.parent, set()).update(records)
        return
    try:
        _enqueue(session.get_bind(), records)
    except Exception as error:
        # Commit already succeeded. A failed hint is repaired by HTTP reconcile.
        log.warning("Cloud sync hint unavailable: %s", type(error).__name__)


def _ended(session, transaction):
    session.info.get(_KEY, {}).pop(transaction, None)


def install():
    for name, callback in (("after_flush", _collect), ("after_commit", _committed),
                           ("after_transaction_end", _ended)):
        if not event.contains(Session, name, callback):
            event.listen(Session, name, callback)


def _enqueue(bind, records):
    from ..realtime import hub
    from .cluster_bus import bus
    if not bus.enabled and not hub._conns:
        return  # A newly connected client always reconciles before caching.
    loop = asyncio.get_running_loop()
    if _STOPPED.get(loop):
        return
    queues = _QUEUES.setdefault(loop, {})
    state = queues.setdefault(bind, {"pending": OrderedDict(), "worker": None})
    for record in records:
        state["pending"][record] = None
    while len(state["pending"]) > _LIMIT:
        state["pending"].popitem(last=False)
    if state["worker"] is None:
        state["worker"] = loop.create_task(_drain(bind, state))


def start():
    _STOPPED.pop(asyncio.get_running_loop(), None)


async def flush_for_test():
    workers = [state["worker"] for state in _QUEUES.get(asyncio.get_running_loop(), {}).values()
               if state["worker"] is not None]
    if workers:
        await asyncio.gather(*workers, return_exceptions=True)


async def stop():
    loop = asyncio.get_running_loop()
    _STOPPED[loop] = True
    states = _QUEUES.get(loop, {})
    workers = [state["worker"] for state in states.values() if state["worker"] is not None]
    if workers:
        _, pending = await asyncio.wait(workers, timeout=2)
        for worker in pending:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
    _QUEUES.pop(loop, None)


async def _drain(bind, state):
    try:
        while state["pending"]:
            await asyncio.sleep(.25)
            records = [state["pending"].popitem(last=False)[0]
                       for _ in range(min(128, len(state["pending"])))]
            try:
                await publish(bind, records)
            except Exception as error:
                log.warning("Cloud sync hint unavailable: %s", type(error).__name__)
    finally:
        state["worker"] = None


async def publish(bind, records):
    from .. import models, automation_models as am
    from ..conversation_handoff_models import ConversationHandoff
    from ..realtime import hub
    tasks = {task for task, _, _ in records if task}
    executions = {execution for _, _, execution in records if execution}
    # The handoff's frozen owner is safe even after a handoff is deleted. It is
    # never inferred from the device's current owner or from a caller payload.
    recipients = {(task, owner) for task, owner, _ in records if task and owner}
    async with AsyncSession(bind=AsyncEngine(bind), expire_on_commit=False) as session:
        if executions:
            tasks.update(await session.scalars(select(am.ExecutionSession.task_id)
                .where(am.ExecutionSession.id.in_(executions))))
        if tasks:
            rows = await session.execute(select(ConversationHandoff.task_id,
                ConversationHandoff.owner_user_id).where(ConversationHandoff.task_id.in_(tasks)))
            recipients.update((task, owner) for task, owner in rows if owner)
        owners = {owner for _, owner in recipients}
        if not owners:
            return
        devices = list(await session.execute(select(models.Client.id, models.Client.user_ref)
            .join(models.User, models.Client.user_ref == models.User.id)
            .where(models.Client.user_ref.in_(owners), models.Client.auth_state == "active",
                   models.User.is_active.is_(True), models.User.account_deleted_at.is_(None))))
    # Return DB connections before waiting on websocket/cluster delivery.
    for task, owner in recipients:
        for device, current_owner in devices:
            if current_owner == owner:
                try:
                    await asyncio.wait_for(hub.publish(device,
                        {"type": "native-discovery", "topic": "cloud-execution-sync", "taskId": task},
                        user_id=owner), timeout=2)
                except Exception:
                    pass
