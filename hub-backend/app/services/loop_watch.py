"""Detect event-loop stalls without blocking the service."""
from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time
import traceback

log = logging.getLogger("uvicorn.error")

TICK = 0.25          # Heartbeat interval.
STALL = 3.0          # Event-loop stall threshold.
_QUIET = 60.0        # Report once per stall to avoid repeated diagnostics.

_beat = 0.0
_started = False


def _dump(stalled: float) -> None:
    """Dump relevant stacks from all threads, including workers that may hold locks awaited by the
    event loop.
    """
    log.error("★事件循环卡住 %.1f 秒——下面是卡住那一刻所有线程的栈", stalled)
    frames = sys._current_frames()
    main_id = threading.main_thread().ident
    names = {t.ident: t.name for t in threading.enumerate()}
    for tid, frame in frames.items():
        tag = "主线程(事件循环)" if tid == main_id else names.get(tid, "线程%s" % tid)
        stack = "".join(traceback.format_stack(frame))
        # Keep the deepest frames and omit repetitive framework entry points.
        tail = "".join(stack.splitlines(keepends=True)[-14:])
        log.error("--- %s ---\n%s", tag, tail.rstrip())


def _watch() -> None:
    last_report = 0.0
    while True:
        time.sleep(TICK)
        b = _beat
        if not b:
            continue
        gap = time.time() - b
        if gap >= STALL and (time.time() - last_report) > _QUIET:
            last_report = time.time()
            try:
                _dump(gap)
            except Exception as e:  # noqa: BLE001 - Watchdog failures must not terminate the service.
                log.warning("看门狗打栈失败: %s", type(e).__name__)


async def _heartbeat() -> None:
    global _beat
    while True:
        _beat = time.time()
        await asyncio.sleep(TICK)


def start() -> asyncio.Task:
    """Start once during lifespan and return the heartbeat task for shutdown cancellation."""
    global _started, _beat
    _beat = time.time()
    if not _started:
        _started = True
        threading.Thread(target=_watch, name="loop-watch", daemon=True).start()
        log.info("事件循环看门狗启动（卡住超过 %.0f 秒就打栈）", STALL)
    return asyncio.create_task(_heartbeat())
