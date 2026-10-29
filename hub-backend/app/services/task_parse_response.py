"""Keep the read-only draft request alive without changing its JSON payload.

JSON permits leading whitespace. Send it while parsing so access proxies do
not mistake a slow model for an idle Hub. This is negotiated by the client;
legacy callers retain the ordinary HTTP error/status contract.
"""
import asyncio
import json
import logging
from contextvars import ContextVar

import anyio
from fastapi import HTTPException
from fastapi.responses import StreamingResponse

ACCEPT = "application/json; keepalive=1"
KEEPALIVE_SECONDS = 15.0
TOTAL_SECONDS = 120.0  # Includes admission, model generation and field parsing.
REQUIREMENT_REQUEST = ContextVar("requirement_parse_request", default=False)
log = logging.getLogger("uvicorn.error")


class ParseResponse(StreamingResponse):
    async def stream_response(self, send):
        try:
            await super().stream_response(send)
        finally:
            # ASGI send can fail while the generator is suspended at yield.
            await self.body_iterator.aclose()


def response(parse, *, requirement=True):
    async def bounded():
        token = REQUIREMENT_REQUEST.set(requirement)
        try:
            async with asyncio.timeout(TOTAL_SECONDS if requirement else 85.0):
                fields = await parse()
                return {"ok": bool(fields) and not fields.get("_parseError"), "fields": fields}
        finally:
            REQUIREMENT_REQUEST.reset(token)

    async def generate():
        task = asyncio.create_task(bounded())
        try:
            yield b" \n"
            while not task.done():
                done, _ = await asyncio.wait({task}, timeout=KEEPALIVE_SECONDS)
                if not done:
                    yield b" \n"
            try:
                payload = task.result()
            except TimeoutError:
                payload = failure("需求解析超时，请稍后重试或手动填写；原文已保留")
            except HTTPException as exc:
                # Headers have left already. Use the existing field warning
                # contract; never turn a parse failure into a successful draft.
                payload = failure(f"需求解析失败（HTTP {exc.status_code}）；原文已保留，请重试或手动填写")
            except Exception as exc:
                log.warning("Task parsing failed: %s", type(exc).__name__)
                payload = failure("需求解析服务异常；原文已保留，请稍后重试或手动填写")
            yield json.dumps(payload, ensure_ascii=False).encode("utf-8")
        finally:
            task.cancel()
            async def settle():
                await asyncio.gather(task, return_exceptions=True)
            cleanup = asyncio.create_task(settle())
            cancelled = False
            with anyio.CancelScope(shield=True):
                while not cleanup.done():
                    try:
                        await asyncio.shield(cleanup)
                    except asyncio.CancelledError:
                        cancelled = True
            cleanup.result()
            if cancelled:
                raise asyncio.CancelledError

    return ParseResponse(generate(), media_type="application/json",
                         headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


def failure(message):
    return {"ok": False, "fields": {"_parseError": message}}
