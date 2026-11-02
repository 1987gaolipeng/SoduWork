"""Bounded requests to the owning Electron process over its private pipe."""
import asyncio
import json
import uuid
import time

PREFIX = "@@SODUWORK_LOCAL_RPC@@"


class DesktopCapabilities:
    def __init__(self, write):
        self.write = write
        self.pending = {}

    async def call(self, body, timeout=90):
        if len(self.pending) >= 8:
            raise ValueError("电脑正在处理其他操作，请稍后再试")
        if len(json.dumps(body).encode()) > 512_000:
            raise ValueError("插件内容过大")
        key = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[key] = future
        try:
            self.write(PREFIX + json.dumps({"kind": "desktop-capability", "id": key,
                                           "body": {**body, "expiresAt": time.time() + timeout}}, ensure_ascii=False) + "\n")
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(key, None)

    def reply(self, message):
        future = self.pending.get(str(message.get("requestId") or ""))
        if future and not future.done():
            future.set_result(message.get("result") or {"ok": False, "error": "电脑未返回结果"})
        return {"ok": True}
