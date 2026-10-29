"""Read-only regression checks for live-view request coalescing and invalidation."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

from app.services import execution_capabilities, live_view_cache


async def _cache_checks() -> int:
    live_view_cache.reset_for_tests()
    builds = 0

    async def build():
        nonlocal builds
        builds += 1
        await asyncio.sleep(0.02)
        return {"build": builds}

    values = await asyncio.gather(*[
        live_view_cache.get_or_build("trace", "client-1", "task-1", build)
        for _ in range(12)
    ])
    assert builds == 1
    assert all(value == {"build": 1} for value in values)
    assert await live_view_cache.get_or_build(
        "trace", "client-1", "task-1", build) == {"build": 1}

    live_view_cache.invalidate("client-1", {"taskId": "task-1"})
    assert await live_view_cache.get_or_build(
        "trace", "client-1", "task-1", build) == {"build": 2}

    started, release = asyncio.Event(), asyncio.Event()

    async def changing_build():
        nonlocal builds
        builds += 1
        started.set()
        await release.wait()
        return {"build": builds}

    live_view_cache.invalidate("client-1", {"taskId": "task-1"})
    pending = asyncio.create_task(live_view_cache.get_or_build(
        "trace", "client-1", "task-1", changing_build))
    await started.wait()
    live_view_cache.invalidate("client-1", {"taskId": "task-1"})
    release.set()
    await pending
    # A snapshot built across an event boundary must not be cached as current.
    assert await live_view_cache.get_or_build(
        "trace", "client-1", "task-1", build) == {"build": 4}
    first_actor = SimpleNamespace(user_ref="first-user", auth_version=1)
    second_actor = SimpleNamespace(user_ref="second-user", auth_version=2)
    first = await live_view_cache.get_or_build(
        "trace", "shared-device", "shared-task", build, actor=first_actor)
    second = await live_view_cache.get_or_build(
        "trace", "shared-device", "shared-task", build, actor=second_actor)
    assert first != second
    assert await live_view_cache.get_or_build(
        "trace", "shared-device", "shared-task", build, actor=second_actor) == second
    second_actor.auth_version += 1
    assert await live_view_cache.get_or_build(
        "trace", "shared-device", "shared-task", build, actor=second_actor) != second
    return 10


def _capability_checks() -> int:
    execution_capabilities.invalidate_bridge_cache()
    first = execution_capabilities.runtime_report("")
    assert execution_capabilities._REPORT_CACHE  # noqa: SLF001 - smoke verifies the cache
    first["items"].append({"key": "mutated"})
    second = execution_capabilities.runtime_report("")
    assert all(item.get("key") != "mutated" for item in second["items"])
    execution_capabilities.invalidate_bridge_cache()
    assert not execution_capabilities._REPORT_CACHE  # noqa: SLF001
    return 3


if __name__ == "__main__":
    passed = asyncio.run(_cache_checks()) + _capability_checks()
    print(f"live view cache: {passed} passed")
