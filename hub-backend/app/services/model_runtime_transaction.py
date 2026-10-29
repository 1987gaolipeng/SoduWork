"""Cancellation boundary for the short model admission transaction."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import logging
import time

log = logging.getLogger(__name__)
CLEANUP_SECONDS = 5
_pending = set()


class CleanupBudget:
    def __init__(self):
        self.deadline = None

    def remaining(self):
        if self.deadline is None:
            self.deadline = time.perf_counter() + CLEANUP_SECONDS
        return self.deadline - time.perf_counter()


class AbortTransaction(Exception):
    """Roll back before commit when the waiting caller has left."""


class TransactionControl:
    def __init__(self):
        self.aborted = False
        self.ready = asyncio.get_running_loop().create_future()
        self.finished = asyncio.Event()
        self.ready.add_done_callback(lambda future: None if future.cancelled() else future.exception())

    async def deliver(self, value):
        if self.aborted:
            raise AbortTransaction()
        self.ready.set_result(value)
        await self.finished.wait()
        if self.aborted:
            raise AbortTransaction()


def _track(coroutine, name):
    task = asyncio.create_task(coroutine, name=name)
    _pending.add(task)

    def settled(completed):
        _pending.discard(completed)
        if not completed.cancelled() and (error := completed.exception()) is not None:
            # Never log exception text: a DB exception may contain bound values.
            log.warning("Model admission %s failed: %s", name, type(error).__name__)

    task.add_done_callback(settled)
    return task


async def _finish_bounded(task, budget=None):
    budget = budget or CleanupBudget()
    while not task.done():
        remaining = budget.remaining()
        if remaining <= 0:
            log.warning("Model admission cleanup continues after caller timeout")
            return
        try:
            await asyncio.wait({task}, timeout=remaining)
        except asyncio.CancelledError:
            # A second cancellation must neither kill the transaction nor
            # replace the original cancellation/timeout being propagated.
            continue


async def finish_cleanup(operation, budget=None):
    """Finish lease cleanup without replacing the caller's existing exception."""
    await _finish_bounded(_track(operation, "lease-cleanup"), budget)


@asynccontextmanager
async def transaction_boundary(operation, compensate=None, cleanup_budget=None):
    control = TransactionControl()

    async def execute():
        try:
            await operation(control)
        except AbortTransaction:
            pass
        except BaseException as error:
            if not control.ready.done():
                control.ready.set_exception(error)
            raise

    worker = _track(execute(), "transaction")
    try:
        value = await asyncio.shield(control.ready)
        yield value
        control.finished.set()
        await asyncio.shield(worker)
    except BaseException as original:
        control.aborted = True
        control.finished.set()

        async def cleanup(cause=original):
            try:
                await worker
            except BaseException:
                pass  # Preserve the caller's original exception.
            if compensate is not None:
                await compensate(cause)

        # This separate worker also covers cancellation during/after commit;
        # compensation is idempotent and runs only after that commit finishes.
        clean = _track(cleanup(), "compensation")
        await _finish_bounded(clean, cleanup_budget)
        raise
