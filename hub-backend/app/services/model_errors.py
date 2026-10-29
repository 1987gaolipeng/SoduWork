"""Shared model gateway errors for synchronous probes and async transports."""


class UpstreamError(Exception):
    """Preserve the gateway status and response without converting it to HTTP 500."""

    def __init__(self, status: int, body: str, detail: str = ""):
        super().__init__(detail or f"HTTP {status}")
        self.status = status
        self.body = body
        self.detail = detail or f"HTTP {status}"
