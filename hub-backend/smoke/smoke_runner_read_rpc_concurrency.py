# -*- coding: utf-8 -*-
"""A slow Runner read RPC must not block probes behind it."""
import asyncio
import json
import sys

sys.path.insert(0, ".")

import runner_main  # noqa: E402


class _Messages:
    def __init__(self, rows, finish: asyncio.Event):
        self.rows = list(rows)
        self.finish = finish
        self.index = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.index < len(self.rows):
            row = self.rows[self.index]
            self.index += 1
            return json.dumps(row)
        await self.finish.wait()
        raise StopAsyncIteration


async def main() -> None:
    runner = runner_main.Runner("http://127.0.0.1:9080", "", "", "smoke")
    status_started = asyncio.Event()
    status_finished = asyncio.Event()
    release_status = asyncio.Event()
    probe_seen = asyncio.Event()
    finish_stream = asyncio.Event()

    async def fake_on(message):
        op = str(message.get("op") or "")
        if op == "job.status":
            status_started.set()
            await release_status.wait()
            status_finished.set()
        elif op == "runner.probe":
            assert status_started.is_set()
            probe_seen.set()

    runner._on = fake_on
    runner.ws = _Messages([
        {"op": "job.status", "id": "slow-status"},
        {"op": "runner.probe", "id": "probe"},
    ], finish_stream)

    pump = asyncio.create_task(runner._pump())
    await asyncio.wait_for(status_started.wait(), timeout=1)
    await asyncio.wait_for(probe_seen.wait(), timeout=1)
    assert not status_finished.is_set()

    release_status.set()
    await asyncio.wait_for(status_finished.wait(), timeout=1)
    for _ in range(20):
        if not runner._dispatch_tasks:
            break
        await asyncio.sleep(0)
    assert not runner._dispatch_tasks, runner._dispatch_tasks
    finish_stream.set()
    await asyncio.wait_for(pump, timeout=1)
    print("RUNNER_READ_RPC_CONCURRENCY_OK: 5 assertions")


if __name__ == "__main__":
    asyncio.run(main())
