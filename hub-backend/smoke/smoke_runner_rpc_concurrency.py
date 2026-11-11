# -*- coding: utf-8 -*-
"""Runner control-plane regression: slow dispatch must not block probe/retry RPCs."""
import asyncio
import json
import sys
import tempfile

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
    dispatch_started = asyncio.Event()
    release_dispatch = asyncio.Event()
    dispatch_finished = asyncio.Event()
    probe_seen = asyncio.Event()
    finish_stream = asyncio.Event()
    order = []

    async def fake_on(message):
        op = str(message.get("op") or "")
        order.append("start:" + op)
        if op == "job.dispatch":
            dispatch_started.set()
            await release_dispatch.wait()
            dispatch_finished.set()
        elif op == "runner.probe":
            if not dispatch_started.is_set():
                raise AssertionError("probe ran before the slow dispatch started")
            probe_seen.set()
        order.append("end:" + op)

    runner._on = fake_on
    runner.ws = _Messages([
        {"op": "job.dispatch", "id": "slow"},
        {"op": "runner.probe", "id": "probe"},
    ], finish_stream)

    pump = asyncio.create_task(runner._pump())
    await asyncio.wait_for(dispatch_started.wait(), timeout=1)
    await asyncio.wait_for(probe_seen.wait(), timeout=1)
    assert not dispatch_finished.is_set(), order
    assert "end:runner.probe" in order, order
    assert "end:job.dispatch" not in order, order

    release_dispatch.set()
    await asyncio.wait_for(dispatch_finished.wait(), timeout=1)
    for _ in range(20):
        if not runner._dispatch_tasks:
            break
        await asyncio.sleep(0)
    assert not runner._dispatch_tasks, runner._dispatch_tasks

    finish_stream.set()
    await asyncio.wait_for(pump, timeout=1)
    assert order.index("end:runner.probe") < order.index("end:job.dispatch"), order

    pressure = runner_main.Runner("http://127.0.0.1:9080", "", "", "pressure")
    pressure_seen = asyncio.Event()
    release_slot = asyncio.Event()

    async def accept_after_pressure(message):
        if message.get("op") == "job.dispatch":
            pressure_seen.set()

    pressure._on = accept_after_pressure
    blocker = asyncio.create_task(release_slot.wait())
    pressure._rpc_tasks.add(blocker)
    blocker.add_done_callback(pressure._rpc_tasks.discard)
    old_limit = runner_main.MAX_INFLIGHT_RPC
    runner_main.MAX_INFLIGHT_RPC = 1
    try:
        admission = asyncio.create_task(pressure._queue_message(
            {"op": "job.dispatch", "id": "wait-dont-reject"}, object()))
        await asyncio.sleep(0)
        assert not admission.done(), "conversation admission should apply backpressure"
        release_slot.set()
        await asyncio.wait_for(admission, timeout=1)
        await asyncio.wait_for(pressure_seen.wait(), timeout=1)
    finally:
        runner_main.MAX_INFLIGHT_RPC = old_limit
        release_slot.set()
        await asyncio.gather(blocker, *list(pressure._rpc_tasks), return_exceptions=True)

    from app.services import skills as skill_service
    with tempfile.TemporaryDirectory(prefix="soduwork-skill-cache-") as local_skill:
        ctx = {"skills": [{"name": "cached-skill", "path": "/server/skill"}]}
        real_scan = skill_service.scan
        skill_service.scan = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("dispatch must not rescan skill roots"))
        try:
            runner_main._localize_skills(
                ctx, [{"name": "cached-skill", "path": local_skill}])
        finally:
            skill_service.scan = real_scan
        assert ctx["skills"][0]["path"] == local_skill, ctx
    print("RUNNER_RPC_CONCURRENCY_OK: 9 assertions")


if __name__ == "__main__":
    asyncio.run(main())
