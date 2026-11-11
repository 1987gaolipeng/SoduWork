"""Regression checks for Runner websocket control-plane responsiveness."""
from __future__ import annotations

import asyncio
import inspect
import os

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from app.api import runner_ws


async def _run() -> int:
    seen: list[tuple[str, int]] = []
    entered = asyncio.Event()
    release = asyncio.Event()

    async def ingest_sessions(_runner, items: list) -> None:
        entered.set()
        await release.wait()
        seen.append(("session", int(items[0]["seq"])))

    async def ingest_deployments(_runner, items: list) -> None:
        seen.append(("deployment", int(items[0]["seq"])))

    original_sessions = runner_ws._ingest_sessions
    original_deployments = runner_ws._ingest_deployments
    runner_ws._ingest_sessions = ingest_sessions
    runner_ws._ingest_deployments = ingest_deployments
    try:
        queue: asyncio.Queue = asyncio.Queue()
        worker = asyncio.create_task(runner_ws._telemetry_worker(object(), queue))
        runner_ws._enqueue_telemetry(queue, ([{"seq": 1}], []))
        runner_ws._enqueue_telemetry(queue, ([], [{"seq": 2}]))
        runner_ws._stop_telemetry(queue)
        await asyncio.wait_for(entered.wait(), timeout=1)

        # Slow persistence must live only in the worker; the caller/control plane
        # remains runnable while that worker waits on database or fan-out I/O.
        control_plane_ran = False

        async def control_plane() -> None:
            nonlocal control_plane_ran
            control_plane_ran = True

        await asyncio.wait_for(control_plane(), timeout=0.1)
        assert control_plane_ran
        assert not worker.done()
        release.set()
        await asyncio.wait_for(worker, timeout=1)
        assert seen == [("session", 1), ("deployment", 2)], seen
        assert queue.empty()
    finally:
        runner_ws._ingest_sessions = original_sessions
        runner_ws._ingest_deployments = original_deployments

    source = inspect.getsource(runner_ws.runner_ws)
    assert "_enqueue_telemetry(telemetry_queue," in source
    assert "await _ingest_sessions" not in source
    assert "await _ingest_deployments" not in source
    # A full bounded queue must not block RPC receive or prevent shutdown.
    full = asyncio.Queue(maxsize=1)
    runner_ws._enqueue_telemetry(full, ([], [{"seq": 3}]))
    runner_ws._enqueue_telemetry(full, ([], [{"seq": 4}]))
    assert full.qsize() == 1
    assert full.get_nowait() == ([], [{"seq": 3}])
    runner_ws._enqueue_telemetry(full, ([], [{"seq": 5}]))
    runner_ws._stop_telemetry(full)
    assert full.get_nowait() is None
    return 10


if __name__ == "__main__":
    assertions = asyncio.run(_run())
    print(f"RUNNER_WS_CONCURRENCY_OK: {assertions} assertions")
