# -*- coding: utf-8 -*-
"""Runner must register before potentially slow local inventory scans."""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import runner_main  # noqa: E402
from app.services import agent_setup, ai_local  # noqa: E402


class _Socket:
    def __init__(self):
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def recv(self):
        return json.dumps({"op": "welcome", "caps": []})


async def main() -> None:
    runner = runner_main.Runner("http://127.0.0.1:9080", "", "", "smoke")
    # The synthetic dispatch checks handshake latency independently of host load.
    runner._resource_budget.sampler = lambda: {
        "cpuPercent": 0, "cpuCount": 2,
        "memoryAvailableBytes": 4 * 1024 ** 3,
        "memoryTotalBytes": 8 * 1024 ** 3,
    }
    socket = _Socket()
    runner.ws = socket

    async def forbidden_refresh(*args, **kwargs):
        raise AssertionError("hello must not wait for local inventory scans")

    runner._refresh_agents = forbidden_refresh
    await asyncio.wait_for(runner._hello(), timeout=1)
    assert len(socket.sent) == 1, socket.sent
    assert socket.sent[0].get("op") == "hello", socket.sent
    assert socket.sent[0].get("agents") == [], socket.sent
    assert socket.sent[0].get("inventoryReady") is False, socket.sent
    assert runner.bin is False

    calls = {"agents": 0, "skills": 0}
    old_agents, old_scan = runner_main._agents, runner_main._scan_skills
    try:
        def empty_agents():
            calls["agents"] += 1
            return []

        def empty_skills():
            calls["skills"] += 1
            return []

        runner_main._agents, runner_main._scan_skills = empty_agents, empty_skills
        runner._refresh_agents = runner_main.Runner._refresh_agents.__get__(runner)
        await runner._refresh_agents()
        await runner._refresh_agents()
        assert calls == {"agents": 1, "skills": 1}, calls
    finally:
        runner_main._agents, runner_main._scan_skills = old_agents, old_scan

    old_dispatch = ai_local.dispatch_sync
    try:
        launched = asyncio.Event()
        loop = asyncio.get_running_loop()

        def fake_dispatch(*_args, **_kwargs):
            loop.call_soon_threadsafe(launched.set)
            return {"ok": True, "issueId": "fast-ack-ref", "identifier": "LOCAL-fast"}

        ai_local.dispatch_sync = fake_dispatch

        async def forbidden_beat():
            raise AssertionError("dispatch ACK must not wait for a full heartbeat")

        runner._report_beat = forbidden_beat
        runner.max_concurrent = 32
        receipt = await asyncio.wait_for(runner._job({
            "op": "job.dispatch", "task": {"id": "fast-ack-task", "title": "快速回执"},
            "cli": "pi", "cfg": {}, "ctx": {}, "files": {},
        }), timeout=1)
        data = receipt.get("data", {})
        assert receipt.get("ok") and data.get("ref") and data.get("state") in {
            "queued", "running"}, receipt
        await asyncio.wait_for(launched.wait(), timeout=2)
    finally:
        ai_local.dispatch_sync = old_dispatch

    probe_code = (
        "import subprocess,sys,time;"
        "subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);"
        "time.sleep(30)"
    )
    started = time.monotonic()
    version = await asyncio.to_thread(agent_setup._short, sys.executable, ["-c", probe_code], 1)
    elapsed = time.monotonic() - started
    assert version == "" and elapsed < 8, (version, elapsed)
    print("RUNNER_FAST_HANDSHAKE_OK: 8 assertions")


if __name__ == "__main__":
    asyncio.run(main())
