"""Runner control-channel handshake; wait for Hub confirmation before reporting inventory or
accepting work.
"""
from __future__ import annotations

import asyncio
import json
from .runner_identity_error import RunnerIdentityConflict


HELLO_TIMEOUT_S = 30.0


async def negotiate(ws, send, payload: dict, *, timeout: float = HELLO_TIMEOUT_S):
    """Use one deadline for sending hello and receiving welcome, returning failures to the
    reconnect loop.
    """
    async def exchange():
        # Handshake sends must propagate network failures rather than use best-effort status delivery.
        await send(json.dumps(payload, ensure_ascii=False))
        prefetched: list[dict] = []
        while True:
            raw = await ws.recv()
            try:
                message = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(message, dict):
                continue
            op = str(message.get("op") or "")
            if op == "welcome":
                return message, prefetched
            if op == "bye":
                if message.get("code") == RunnerIdentityConflict.code:
                    raise RunnerIdentityConflict()
                raise ConnectionError(str(message.get("error") or "后台拒绝了执行机连接"))
            # Queue early recovery commands from older Hubs and process them in order after confirmation.
            prefetched.append(message)
            if len(prefetched) > 100:
                raise ConnectionError("执行机握手前收到过多后台指令")

    try:
        async with asyncio.timeout(timeout):
            return await exchange()
    except TimeoutError as error:
        raise TimeoutError("执行机握手超时：后台未确认上线，将重新连接") from error
