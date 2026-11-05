"""Bounded, process-local read work. Authorization and quotas are never cached."""
import asyncio
import copy
import hashlib
import json
import time
import weakref
from collections import OrderedDict

from . import library_storage


class ReadWorkCache:
    def __init__(self, *, concurrency=4, pending=32, entries=128, max_bytes=8 * 1024 * 1024):
        self.concurrency, self.pending = concurrency, pending
        self.entries, self.max_bytes = entries, max_bytes
        self._loops = weakref.WeakKeyDictionary()

    async def get(self, key, work, *, ttl=5, size=lambda value: 1):
        loop = asyncio.get_running_loop()
        state = self._loops.setdefault(loop, {"cache": OrderedDict(), "tasks": {},
                                              "gate": asyncio.Semaphore(self.concurrency), "bytes": 0})
        cache, tasks = state["cache"], state["tasks"]
        now = time.monotonic()
        for old_key, (expires, value, weight) in list(cache.items()):
            if expires <= now:
                del cache[old_key]
                state["bytes"] -= weight
        if key in cache:
            cache.move_to_end(key)
            return copy.deepcopy(cache[key][1])
        if key not in tasks:
            if len(tasks) >= self.pending:
                raise library_storage.LibraryStorageError("LIBRARY_READ_BUSY", "资料读取繁忙，请稍后重试")

            async def build():
                try:
                    async with state["gate"]:
                        result = await asyncio.to_thread(work)
                    weight = max(1, size(result))
                    if weight <= self.max_bytes:
                        cache[key] = (time.monotonic() + ttl, copy.deepcopy(result), weight)
                        state["bytes"] += weight
                        while len(cache) > self.entries or state["bytes"] > self.max_bytes:
                            _, (_, _, removed) = cache.popitem(last=False)
                            state["bytes"] -= removed
                    return result
                finally:
                    tasks.pop(key, None)

            task = tasks[key] = asyncio.create_task(build())
            # A disconnected waiter must neither cancel shared work nor leave an
            # unobserved failure when it was the final waiter.
            task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        return copy.deepcopy(await asyncio.shield(tasks[key]))


def configuration_key():
    settings = library_storage.get_settings()
    values = settings.model_dump()
    values = {key: str(value) for key, value in values.items()
              if key.startswith(("library_", "minio_"))}
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).digest()


health = ReadWorkCache(concurrency=2, pending=8, entries=16)


async def storage_status():
    # Both this endpoint and list reads use the same per-provider probe. The
    # capability plan itself performs no I/O, so no outer worker/gate is needed.
    payload, backends = library_storage.status_plan()

    async def check(backend):
        try:
            await ensure_ready(backend, lambda: library_storage.ensure_ready(backend))
        except Exception as exc:
            library_storage.apply_status_failure(payload, backend, exc)

    await asyncio.gather(*(check(backend) for backend in backends))
    return payload


async def ensure_ready(backend, work):
    selected = library_storage.resolve_backend(backend)

    def probe():
        try:
            work()
            return None
        except Exception as exc:
            # Cache the safe outcome, including failures, for the same short
            # TTL. This prevents a disconnected provider from being hammered
            # by successive list/status reads. Actual writes never use it.
            error = library_storage._storage_error(exc)
            return {"code": error.code, "message": error.message, "retryable": error.retryable}

    failure = await health.get((configuration_key(), "ready", selected, library_storage.ensure_ready), probe)
    if failure:
        raise library_storage.LibraryStorageError(**failure)
    return True
