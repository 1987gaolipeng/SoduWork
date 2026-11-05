"""Bounded, failure-isolated cleanup of Hub-owned tasks and resources."""
import asyncio
import logging
import time

log = logging.getLogger("uvicorn.error")


async def shutdown(tasks, resources, *, timeout=15.0, step_timeout=5.0):
    """Attempt every cleanup and re-raise the first failure after resource release.

    A task that ignores cancellation cannot consume the remaining shutdown budget.
    Resource callbacks start in dependency order; overdue cleanup is cancelled.
    """
    deadline = time.monotonic() + timeout
    errors = []

    async def settle(group, name):
        if not group:
            return
        try:
            done, pending = await asyncio.wait(group, timeout=max(
                0, min(step_timeout, deadline - time.monotonic())))
        except asyncio.CancelledError as error:
            errors.append(error)
            done, pending = {t for t in group if t.done()}, {t for t in group if not t.done()}
        for task in done:
            if not task.cancelled() and task.exception() is not None:
                errors.append(task.exception())
        if pending:
            for task in pending:
                task.cancel()
                task.add_done_callback(lambda t: None if t.cancelled() else t.exception())
            errors.append(TimeoutError(f"Shutdown deadline exceeded: {name}"))
            log.error("Shutdown incomplete: %s (%d tasks)", name, len(pending))

    for task in tasks:
        task.cancel()
    await settle(set(tasks), "background")
    for name, close in resources:
        async def run(callback=close):
            await callback()
        await settle({asyncio.create_task(run(), name="shutdown:" + name)}, name)
    if errors:
        for error in errors:
            log.error("Shutdown failure: %s", type(error).__name__)
        cancellation = next((e for e in errors if isinstance(e, asyncio.CancelledError)), None)
        raise cancellation or errors[0]
