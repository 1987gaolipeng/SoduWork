# -*- coding: utf-8 -*-
"""MCP Streamable HTTP lifecycle, SSE and result-fidelity smoke."""
import asyncio
import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import tempfile
_SMOKE_DATA = tempfile.TemporaryDirectory(prefix="soduwork-mcp-http-")
DB = os.path.join(_SMOKE_DATA.name, "test.db")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = os.path.join(_SMOKE_DATA.name, "data")
sys.path.insert(0, ".")

from app.services import mcp_http, mcp_servers  # noqa: E402

ok = fail = 0


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


SEEN = {"methods": [], "initialized": False, "deleted": False}
SESSION_ID = "mcp-smoke-session"


class H(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _json(self, code, value, *, session=False):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        if session:
            self.send_header("MCP-Session-Id", SESSION_ID)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_DELETE(self):
        SEEN["deleted"] = self.headers.get("MCP-Session-Id") == SESSION_ID
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        size = int(self.headers.get("Content-Length") or 0)
        request = json.loads(self.rfile.read(size) or b"{}")
        method = request.get("method")
        SEEN["methods"].append(method)
        SEEN["xkey"] = self.headers.get("X-MCP-Key")
        if method == "initialize":
            SEEN["requestedVersion"] = (request.get("params") or {}).get("protocolVersion")
            return self._json(200, {
                "jsonrpc": "2.0", "id": request.get("id"),
                "result": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {"tools": {"listChanged": True}},
                    "serverInfo": {"name": "smoke", "version": "1.0"},
                },
            }, session=True)
        if method == "notifications/initialized":
            SEEN["initialized"] = self.headers.get("MCP-Session-Id") == SESSION_ID
            self.send_response(202)
            self.end_headers()
            return
        if (not SEEN["initialized"]
                or self.headers.get("MCP-Session-Id") != SESSION_ID
                or self.headers.get("MCP-Protocol-Version") != "2025-11-25"):
            return self._json(400, {"error": "session headers missing"})
        if method == "tools/list":
            cursor = (request.get("params") or {}).get("cursor")
            SEEN.setdefault("listCursors", []).append(cursor)
            if cursor == "page-2":
                return self._json(200, {
                    "jsonrpc": "2.0", "id": request.get("id"),
                    "result": {"tools": [{
                        "name": "page_two", "description": "分页工具",
                        "inputSchema": {"type": "object", "properties": {}},
                    }]},
                })
            return self._json(200, {
                "jsonrpc": "2.0", "id": request.get("id"),
                "result": {"tools": [{
                    "name": "bug_list", "title": "缺陷列表", "description": "列 bug",
                    "inputSchema": {
                        "type": "object", "required": ["productId"],
                        "properties": {"productId": {"type": "integer"}},
                    },
                    "outputSchema": {"type": "object", "required": ["echo"]},
                    "annotations": {"readOnlyHint": True},
                }, {"name": "rich_result", "description": "返回截图与资源"}],
                    "nextCursor": "page-2"},
            })
        args = (request.get("params") or {}).get("arguments") or {}
        tool = (request.get("params") or {}).get("name")
        if tool == "rich_result":
            result = {
                "content": [
                    {"type": "text", "text": "已生成证据"},
                    {"type": "image", "data": "aGVsbG8=", "mimeType": "image/png"},
                    {"type": "resource_link", "name": "report", "uri": "file:///report.pdf"},
                ],
                "structuredContent": {"evidenceCount": 2},
                "_meta": {"trace": "safe-trace"},
            }
        else:
            result = {"content": [{"type": "text",
                                     "text": json.dumps({"echo": args}, ensure_ascii=False)}]}
        reply = json.dumps({
            "jsonrpc": "2.0", "id": request.get("id"), "result": result,
        }, ensure_ascii=False)
        body = ("id: event-1\nevent: message\ndata: " + reply + "\n\n").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=server.serve_forever, daemon=True).start()
SPEC = {"url": "http://127.0.0.1:" + str(server.server_port) + "/mcp", "headers": {"X-MCP-Key": "secret-123"}}

tools = mcp_http.list_tools(SPEC)
chk("先 initialize 再读取工具", SEEN["methods"][:4] == [
    "initialize", "notifications/initialized", "tools/list", "tools/list"], SEEN)
chk("使用当前协议版本", SEEN["requestedVersion"] == "2025-11-25", SEEN)
chk("静态鉴权头到达服务端", SEEN.get("xkey") == "secret-123", SEEN)
chk("复杂 inputSchema 不被压扁", tools[0]["inputSchema"].get("required") == ["productId"], tools)
chk("工具输出 Schema 与注解保留", tools[0].get("outputSchema") and
    tools[0].get("annotations", {}).get("readOnlyHint") is True, tools)
chk("工具目录按 nextCursor 取全", [item["name"] for item in tools] == [
    "bug_list", "rich_result", "page_two"], tools)
chk("分页游标只向后传递", SEEN.get("listCursors") == [None, "page-2"], SEEN)

out = mcp_http.call(SPEC, "bug_list", {"productId": 1})
chk("SSE tools/call 解出业务负载", out == {"echo": {"productId": 1}}, out)
rich = mcp_http.call(SPEC, "rich_result", {})
chk("图片、资源和结构化结果不丢失",
    rich.get("structuredContent", {}).get("evidenceCount") == 2
    and [item.get("type") for item in rich.get("content", [])]
    == ["text", "image", "resource_link"], rich)
chk("有状态会话主动关闭", SEEN["deleted"] is True, SEEN)

c = mcp_servers._clean_one({
    "name": "PPM", "type": "http", "url": "https://x/mcp",
    "headers": {"X-MCP-Key": "k"},
    "keycloak": {"tokenUrl": "https://kc/t", "clientId": "a", "username": "u",
                 "password": "p", "clientSecret": "s", "scope": "one"},
})
chk("HTTP 配置字段被保留", c["type"] == "http" and c["url"] == "https://x/mcp")
chk("HTTP 有 url 即可用", mcp_servers._usable(c))
chk("HTTP 缺 url 不可用", not mcp_servers._usable({**c, "url": ""}))
chk("令牌缓存区分客户端、scope 与凭据版本",
    mcp_http._credential_revision(c["keycloak"])
    != mcp_http._credential_revision({**c["keycloak"], "password": "changed"}))
try:
    mcp_http._read_bounded(io.BytesIO(
        b"x" * (mcp_http._MAX_RESPONSE_BYTES + 1)))
    oversized_blocked = False
except ValueError:
    oversized_blocked = True
chk("超大 MCP 响应在进入内存解析前被拒绝", oversized_blocked)

stdio = mcp_servers._clean_one({"name": "本地", "command": "npx", "args": ["-y", "x"]})
from unittest.mock import patch
# This assertion tests configuration shape, not external identity infrastructure.
with patch.object(mcp_http, "keycloak_token", return_value="isolated-fixture-token"):
    payload = mcp_servers.runtime_payload([c, stdio])
chk("HTTP 派活形状完整", payload["servers"]["PPM"]["type"] == "http")
chk("stdio 派活形状保持兼容", "command" in payload["servers"]["本地"])

bridge_source = os.path.abspath(os.path.join(
    "..", "skills", "mcp-tools", "scripts", "mcp.mjs"))
bridge_packaged = os.path.abspath(os.path.join(
    "..", "client", "runner", "_internal", "skills", "mcp-tools", "scripts", "mcp.mjs"))
with open(bridge_source, encoding="utf-8") as f:
    bridge_text = f.read()
chk("stdio 桥也支持工具目录分页", "nextCursor" in bridge_text and "listTools" in bridge_text)
from pathlib import Path
from app.services import runner_sources
backend = Path(__file__).resolve().parent.parent
chk("Runner 冻结配方包含实际 MCP 桥源码",
    Path(bridge_source) in runner_sources.build_inputs(backend, backend.parent))
if os.path.isfile(bridge_packaged):
    with open(bridge_packaged, encoding="utf-8") as f:
        packaged_text = f.read()
    chk("Runner 内置桥与源码完全一致", bridge_text == packaged_text)
else:
    print("  SKIP  冻结 Runner 尚未构建；包内字节一致性由原生候选安装验收检查")

from app.api.admin import _mcp_mask, _mcp_restore  # noqa: E402

masked = _mcp_mask(c)
chk("接口不回显鉴权头和密码", masked["headers"]["X-MCP-Key"] == "••••"
    and masked["keycloak"]["password"] == "••••")
restored = _mcp_restore({**masked, "name": "PPM改名"}, c)
chk("掩码保存沿用旧凭据", restored["headers"]["X-MCP-Key"] == "k"
    and restored["keycloak"]["password"] == "p")

probe = mcp_servers.probe_sync({"name": "假PPM", "type": "http", **SPEC})
chk("HTTP 探活走完整会话", probe.get("ok") and "bug_list" in probe.get("tools", []), probe)


async def ref_chain():
    from app.db import SessionLocal, init_db, engine
    await init_db()
    async with SessionLocal() as session:
        await mcp_servers.save(session, [{
            "name": "PPMMCP", "type": "http", **SPEC, "enabled": True,
        }])
        await session.commit()
    async with SessionLocal() as session:
        rows = await mcp_servers.load(session)
        hit = next((item for item in rows if item.get("name") == "PPMMCP"), None)
        chk("mcpRef 能解析 HTTP 连接", hit is not None and hit["url"].endswith("/mcp"), hit)
    await engine.dispose()


asyncio.run(ref_chain())
server.shutdown()
server.server_close()
_SMOKE_DATA.cleanup()
print(f"\n{ok} PASS / {fail} FAIL")
sys.exit(1 if fail else 0)
