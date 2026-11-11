# -*- coding: utf-8 -*-
"""A slow SCM inspection must not block dispatch or control-plane probes."""
from __future__ import annotations

import asyncio
import json
import sys

sys.path.insert(0, ".")

import runner_main  # noqa: E402


class _Messages:
    def __init__(self, rows: list[dict], finish: asyncio.Event):
        self.rows = list(rows)
        self.finish = finish

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.rows:
            return json.dumps(self.rows.pop(0))
        await self.finish.wait()
        raise StopAsyncIteration


async def main() -> None:
    runner = runner_main.Runner("http://127.0.0.1:9080", "", "", "smoke")
    release_scm = asyncio.Event()
    scm_started = asyncio.Event()
    dispatch_seen = asyncio.Event()
    probe_seen = asyncio.Event()
    finish = asyncio.Event()

    async def fake_on(message: dict) -> None:
        op = str(message.get("op") or "")
        if op == "git.inspect":
            scm_started.set()
            await release_scm.wait()
        elif op == "job.dispatch":
            dispatch_seen.set()
        elif op == "runner.probe":
            probe_seen.set()

    runner._on = fake_on
    runner.ws = _Messages([
        {"op": "git.inspect", "id": "scm"},
        {"op": "job.dispatch", "id": "dispatch"},
        {"op": "runner.probe", "id": "probe"},
    ], finish)

    pump = asyncio.create_task(runner._pump())
    await asyncio.wait_for(scm_started.wait(), timeout=1)
    await asyncio.wait_for(dispatch_seen.wait(), timeout=1)
    await asyncio.wait_for(probe_seen.wait(), timeout=1)
    assert not release_scm.is_set()

    release_scm.set()
    for _ in range(30):
        if not runner._dispatch_tasks:
            break
        await asyncio.sleep(0)
    assert not runner._dispatch_tasks, runner._dispatch_tasks
    finish.set()
    await asyncio.wait_for(pump, timeout=1)
    print("RUNNER_SCM_RPC_CONCURRENCY_OK: 5 assertions")


if __name__ == "__main__":
    asyncio.run(main())
