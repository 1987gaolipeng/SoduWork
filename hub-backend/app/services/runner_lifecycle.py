"""Desktop-owned Runner startup and pipe lifetime (standalone CLI stays supported)."""
import asyncio
import json
import logging
import os
import threading

CONFIG_PREFIX = "@@SODUWORK_RUNNER_CONFIG@@"
CONFIG_LIMIT = 64 * 1024


def read_config(stream):
    # Do not read ahead: subsequent bytes belong to the local RPC channel.
    line = getattr(stream, "raw", stream).readline(CONFIG_LIMIT + 1)
    if len(line) > CONFIG_LIMIT or not line.endswith(b"\n"):
        raise ValueError("Missing or oversized Runner startup configuration")
    text = line.decode("utf-8-sig")
    if not text.startswith(CONFIG_PREFIX):
        raise ValueError("Invalid Runner startup configuration frame")
    config = json.loads(text[len(CONFIG_PREFIX):])
    if not isinstance(config, dict):
        raise ValueError("Runner startup configuration must be an object")
    return config


async def parent_lines(stream):
    # A blocking read must not occupy asyncio's default executor: shutting down
    # that executor would wait forever while the desktop still owns the pipe.
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()
    closed = threading.Event()

    def read():
        pending = b""
        while not closed.is_set():
            try:
                chunk = os.read(stream.fileno(), 64 * 1024)
            except (OSError, ValueError):
                chunk = b""
            pending += chunk
            while b"\n" in pending or (not chunk and pending):
                if b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    line += b"\n"
                else:
                    line, pending = pending, b""
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, line)
                except RuntimeError:
                    return
            if not chunk:
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, b"")
                except RuntimeError:
                    pass
                return

    threading.Thread(target=read, name="soduwork-parent-input", daemon=True).start()
    try:
        while True:
            line = await queue.get()
            yield line
            if not line:
                return
    finally:
        closed.set()


async def run_until_stopped(runner):
    # Wake immediately even if DNS/TCP/WebSocket handshake is still pending.
    running = asyncio.create_task(runner.run())
    stopped = asyncio.create_task(runner._shutdown_event.wait())
    try:
        done, _ = await asyncio.wait((running, stopped), return_when=asyncio.FIRST_COMPLETED)
        if running in done:
            await running
    finally:
        running.cancel()
        stopped.cancel()
        try:
            await asyncio.gather(running, stopped, return_exceptions=True)
        finally:
            # Device authorization belongs to this Runner lifetime. Drain its
            # cancellation cleanup before daemon threads disappear at exit.
            from . import codex_login_flow
            if not await asyncio.to_thread(codex_login_flow.shutdown):
                logging.getLogger(__name__).warning(
                    "Codex authorization cleanup exceeded the Runner shutdown deadline")
