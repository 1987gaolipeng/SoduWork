"""In-memory async response for protocol boundary tests."""
import io
import httpx


class FakeResponse:
    def __init__(self, content=b""):
        self.body = io.BytesIO(content)
        self.headers = httpx.Headers({"content-type": "application/json"})
        self.closed = False

    def tell(self):
        return self.body.tell()

    async def read(self, cap=8 * 1024 * 1024):
        try:
            return self.body.read(cap)
        finally:
            await self.aclose()

    async def chunks(self):
        try:
            while chunk := self.body.readline():
                yield chunk
        finally:
            await self.aclose()

    async def aclose(self):
        self.closed = True
