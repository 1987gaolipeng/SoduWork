"""Bounded temporary storage for provider video responses."""
from __future__ import annotations

import asyncio
import tempfile

JSON_MAX_BYTES = 8 * 1024 * 1024
CHUNK_SIZE = 1024 * 1024


async def disk_call(function, *args):
    """Wait for file IO to finish before cancellation closes its handle."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


class VideoBody:
    def __init__(self):
        self.handle = tempfile.TemporaryFile(prefix="soduwork-video-")
        self.size = 0
        self.prefix = b""

    def __len__(self):
        return self.size

    def close(self):
        self.handle.close()

    def write(self, chunk):
        self.handle.write(chunk)
        self.size += len(chunk)
        if len(self.prefix) < 376:
            self.prefix += chunk[:376 - len(self.prefix)]


def prefix(body):
    return body.prefix if isinstance(body, VideoBody) else body[:376]


def media_type(body):
    head = prefix(body)
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "video/quicktime" if head[8:12] == b"qt  " else "video/mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"
    if head.startswith(b"OggS"):
        return "video/ogg"
    return ""


async def collect(chunks, cap: int, *, json_allowed: bool = True):
    """Spool video to disk; only small provider JSON remains in memory."""
    body = VideoBody()
    delivered = False
    try:
        async for chunk in chunks:
            for offset in range(0, len(chunk), CHUNK_SIZE):
                part = chunk[offset:offset + CHUNK_SIZE]
                if len(body) + len(part) > cap:
                    raise ValueError("视频文件超过平台允许的大小")
                await disk_call(body.write, part)
                if not media_type(body) and len(body) > JSON_MAX_BYTES:
                    raise ValueError("视频服务的 JSON 响应过大，请改用视频下载地址")
        if media_type(body):
            body.handle.seek(0)
            delivered = True
            return body
        if not json_allowed:
            raise ValueError("视频服务返回的内容不是可识别的视频文件")
        body.handle.seek(0)
        raw = await disk_call(body.handle.read, JSON_MAX_BYTES + 1)
        # Invalid HTML or a corrupt binary body is rejected by the resolver.
        return raw
    finally:
        if not delivered:
            body.close()


async def store_body(storage, key, body, content_type):
    if isinstance(body, VideoBody):
        return await disk_call(storage.put_stream, key, body.handle, len(body), content_type)
    return await disk_call(storage.put, key, body, content_type)
