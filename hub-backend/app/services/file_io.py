"""Bound blocking file work and retain ownership until worker threads finish."""
import asyncio
from weakref import WeakKeyDictionary

import anyio

_limits = WeakKeyDictionary()


async def run(function, /, *args, **kwargs):
    """Keep cancellation from racing file cleanup against an active worker.

    AsyncSession objects and database operations must stay on the event loop.
    Four jobs bound disk pressure without occupying the entire default executor.
    """
    loop = asyncio.get_running_loop()
    limit = _limits.setdefault(loop, asyncio.Semaphore(4))
    async with limit:
        task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # AnyIO scopes cancel at every checkpoint; shield the join from
            # that repeated cancellation while still handling raw Task.cancel().
            with anyio.CancelScope(shield=True):
                while not task.done():
                    try:
                        await asyncio.shield(task)
                    except asyncio.CancelledError:
                        continue
                    except Exception:
                        break
            if not task.cancelled():
                task.exception()
            raise
