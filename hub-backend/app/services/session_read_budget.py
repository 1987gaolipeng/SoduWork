"""One cancellable deadline for HTTP session reads, including endpoint content."""
import asyncio
import re
from contextvars import ContextVar

from starlette.responses import JSONResponse


# Leave delivery time before the desktop's eight-second request timeout.
READ_SECONDS = 6.0
_deadline = ContextVar("session_read_deadline", default=None)
_PATH = re.compile(r"^/api/v1/(?:tasks/[^/]+/ai-session|cloud-execution-sync/[^/]+)/?$")


def remaining(default):
    """Cap cluster envelopes to this request's deadline, never extend a retry."""
    deadline = _deadline.get()
    if deadline is None:
        return default
    left = deadline - asyncio.get_running_loop().time()
    if left <= 0:
        return 0.001
    return min(default, left)


def deadline_active() -> bool:
    """Return whether the current task belongs to a bounded session read."""
    return _deadline.get() is not None


class SessionReadBudgetMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (scope["type"] != "http" or scope.get("method") != "GET"
                or not _PATH.fullmatch(scope.get("path", ""))):
            return await self.app(scope, receive, send)
        deadline = asyncio.get_running_loop().time() + READ_SECONDS
        token = _deadline.set(deadline)
        started = False

        async def tracked_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            grace = min(0.2, max(0.01, READ_SECONDS * 2))
            async with asyncio.timeout_at(deadline + grace):
                await self.app(scope, receive, tracked_send)
        except TimeoutError:
            if started:
                raise
            # No successful page/cursor is returned for an incomplete body.
            response = JSONResponse(status_code=504, headers={"Retry-After": "3"}, content={
                "detail": {"code": "SESSION_READ_TIMEOUT", "retryable": True,
                           "message": "会话同步暂时超时，已有内容已保留，请稍后重试"}})
            await response(scope, receive, send)
        finally:
            _deadline.reset(token)
