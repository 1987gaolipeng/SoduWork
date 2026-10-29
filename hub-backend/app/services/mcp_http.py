"""Standards-aligned MCP client for Streamable HTTP connectors.

The connector boundary stays dependency-free, but it still follows the MCP
lifecycle: initialize, negotiate a protocol version, notify initialized, then
perform the requested operation. Both JSON and SSE responses are accepted and
stateful servers keep their ``MCP-Session-Id`` for the lifetime of this object.

Secrets never enter diagnostics. Redirects are deliberately rejected because
an approved MCP endpoint must not silently move a credential-bearing request to
another host.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field


_TIMEOUT = 30
_MAX_RESPONSE_BYTES = 2_000_000
_PROTOCOL_VERSION = "2025-11-25"
_SUPPORTED_VERSIONS = frozenset({"2025-11-25", "2025-06-18", "2025-03-26"})
_TOKENS: dict[tuple[str, ...], dict] = {}
_TOKEN_LOCK = threading.Lock()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _opener():
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}), _NoRedirect())


def _read_bounded(response, label: str = "MCP") -> bytes:
    body = response.read(_MAX_RESPONSE_BYTES + 1)
    if len(body) > _MAX_RESPONSE_BYTES:
        raise ValueError(f"{label} 返回内容超过安全上限，请缩小查询范围或使用分页")
    return body


def _credential_revision(kc: dict) -> str:
    raw = "\0".join(str(kc.get(key) or "") for key in (
        "clientSecret", "password"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def keycloak_token(kc: dict) -> str:
    """Exchange an explicitly configured service identity for a bearer token."""
    url = str(kc.get("tokenUrl") or "").strip()
    user = str(kc.get("username") or "").strip()
    client_id = str(kc.get("clientId") or "").strip() or "autoloop"
    scope = str(kc.get("scope") or "openid").strip()
    if not url or not user:
        raise ValueError("Keycloak 还缺 tokenUrl 或 username")
    key = (url, client_id, user, scope, _credential_revision(kc))
    now = time.time()
    with _TOKEN_LOCK:
        hit = _TOKENS.get(key)
        if hit and hit["exp"] - 60 > now:
            return str(hit["token"])
    form = {
        "grant_type": "password",
        "client_id": client_id,
        "username": user,
        "password": str(kc.get("password") or ""),
        "scope": scope,
    }
    if kc.get("clientSecret"):
        form["client_secret"] = str(kc["clientSecret"])
    req = urllib.request.Request(
        url, data=urllib.parse.urlencode(form).encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    try:
        with _opener().open(req, timeout=_TIMEOUT) as resp:
            body = json.loads(_read_bounded(
                resp, "Keycloak").decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        raise ValueError(f"Keycloak 换令牌被拒绝（HTTP {exc.code}），请检查账号与客户端配置") from None
    except urllib.error.URLError as exc:
        raise ValueError(f"Keycloak 连接失败（{type(exc.reason).__name__}）") from None
    token = str(body.get("access_token") or "")
    if not token:
        raise ValueError("Keycloak 响应里没有 access_token")
    with _TOKEN_LOCK:
        _TOKENS[key] = {
            "token": token,
            "exp": now + max(60, int(body.get("expires_in") or 300)),
        }
    return token


def _headers(spec: dict) -> dict[str, str]:
    out = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    for key, value in (spec.get("headers") or {}).items():
        if str(key).strip() and str(value).strip():
            out[str(key).strip()] = str(value)
    kc = spec.get("keycloak")
    if isinstance(kc, dict) and kc.get("tokenUrl"):
        out["Authorization"] = "Bearer " + keycloak_token(kc)
    return out


def _response_chunks(response, deadline: float):
    """Bound total time and bytes, including peers that send endless keepalives."""
    total = 0
    reader = getattr(response, "read1", response.read)
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        # urllib's timeout is otherwise an idle timeout, reset by every byte.
        sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
        if sock is not None:
            sock.settimeout(remaining)
        chunk = reader(min(65536, _MAX_RESPONSE_BYTES + 1 - total))
        if not chunk:
            return
        total += len(chunk)
        if total > _MAX_RESPONSE_BYTES:
            raise ValueError("MCP 返回内容超过安全上限，请缩小查询范围或使用分页")
        yield chunk


def _matching_reply(message, request_id):
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        raise ValueError("MCP 返回的不是合法 JSON-RPC 2.0 消息")
    if "method" in message:
        if "id" in message:
            raise ValueError("MCP 发来了当前连接未支持的服务器请求，未获得调用结果")
        return None
    # bool is an int subclass in Python, but never a valid matching JSON-RPC id.
    if type(message.get("id")) is not type(request_id) or message.get("id") != request_id:
        raise ValueError("MCP 返回的响应 ID 与请求不一致")
    if ("result" in message) == ("error" in message):
        raise ValueError("MCP 响应必须包含且仅包含 result 或 error")
    if "error" in message:
        error = message["error"]
        if not isinstance(error, dict) or type(error.get("code")) is not int:
            raise ValueError("MCP 返回的协议错误格式不合法")
        # Remote error bodies may echo request credentials; do not log them.
        raise ValueError(f"MCP 服务返回协议错误（{error['code']}）")
    if not isinstance(message["result"], dict):
        raise ValueError("MCP 返回的结果必须是 JSON 对象")
    return message["result"]


def _read_reply(response, request_id, deadline: float):
    content_type = str(response.headers.get("Content-Type", "")).split(";")[0].strip().lower()
    if content_type == "application/json":
        raw = b"".join(_response_chunks(response, deadline))
        try:
            message = json.loads(raw)
        except (ValueError, UnicodeError):
            raise ValueError("MCP 返回的不是合法 JSON") from None
        result = _matching_reply(message, request_id)
        if result is not None:
            return result
    elif content_type == "text/event-stream":
        pending, data_lines, skip_lf = b"", [], False
        for chunk in _response_chunks(response, deadline):
            if skip_lf:
                chunk = chunk[1:] if chunk.startswith(b"\n") else chunk
                skip_lf = False
            pending += chunk
            while True:
                match = re.search(rb"[\r\n]", pending)
                if not match:
                    break
                line, pending = pending[:match.start()], pending[match.end():]
                if match[0] == b"\r":
                    # CR ends a line immediately, even when the stream stays
                    # open. Swallow its optional LF across chunk boundaries.
                    if pending.startswith(b"\n"):
                        pending = pending[1:]
                    elif not pending:
                        skip_lf = True
                if not line:
                    if not data_lines:
                        continue
                    if not b"".join(data_lines):
                        data_lines = []
                        continue
                    try:
                        message = json.loads(b"\n".join(data_lines))
                    except (ValueError, UnicodeError):
                        raise ValueError("MCP SSE 返回的不是合法 JSON") from None
                    data_lines = []
                    result = _matching_reply(message, request_id)
                    if result is not None:
                        # SSE may remain open after the reply. Never wait for EOF.
                        return result
                elif line.startswith(b"data:"):
                    value = line[5:]
                    data_lines.append(value[1:] if value.startswith(b" ") else value)
                elif line == b"data":
                    data_lines.append(b"")
        # An event is complete only after its blank line, not at a network EOF.
    else:
        raise ValueError("MCP 返回不支持的内容类型，需要 JSON 或 SSE")
    raise ValueError("MCP 连接结束，但没有返回请求的完整对应结果")


class _ExpiredSession(ValueError):
    pass


@dataclass
class HttpSession:
    spec: dict
    timeout: int = _TIMEOUT
    session_id: str = ""
    protocol_version: str = _PROTOCOL_VERSION
    _next_id: int = 0
    generation: int = 0
    initialized: bool = False
    _lock: object = field(default_factory=threading.RLock, repr=False)

    @property
    def url(self) -> str:
        value = str(self.spec.get("url") or "").strip()
        if not value:
            raise ValueError("HTTP 型 MCP 还没有配置 url")
        return value

    def _reset(self):
        self.session_id = ""
        self.protocol_version = _PROTOCOL_VERSION
        self.initialized = False

    def _request_headers(self) -> dict[str, str]:
        # Transport state cannot be replaced by stale user-configured headers.
        controlled = {"mcp-protocol-version", "mcp-session-id", "accept", "content-type"}
        headers = {key: value for key, value in _headers(self.spec).items()
                   if key.lower() not in controlled}
        for key, value in headers.items():
            if (not re.fullmatch(r"[!#$%&'*+.^_\x60|~0-9A-Za-z-]+", key)
                    or any(ord(c) < 32 or ord(c) == 127 or ord(c) > 255 for c in value)):
                raise ValueError("MCP 请求头格式不合法，请检查连接配置")
        headers.update({"Content-Type": "application/json",
                        "Accept": "application/json, text/event-stream"})
        if self.initialized:
            headers["MCP-Protocol-Version"] = self.protocol_version
        if self.session_id:
            headers["MCP-Session-Id"] = self.session_id
        return headers

    def _post(self, method: str, params: dict | None = None, *, notification: bool = False):
        self._next_id += 1
        request_id = None if notification else self._next_id
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        if request_id is not None:
            payload["id"] = request_id
        req = urllib.request.Request(
            self.url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=self._request_headers(), method="POST")
        timeout = min(120, max(3, float(self.timeout)))
        deadline = time.monotonic() + timeout
        try:
            with _opener().open(req, timeout=timeout) as resp:
                if notification:
                    # No response is expected. Closing urllib releases the socket
                    # even for a peer that omits a body length and keeps it open.
                    return {}
                if int(resp.status) == 202:
                    raise ValueError("MCP 仅确认受理，未返回结果；请先核实执行状态，不要重复调用")
                if method == "initialize":
                    sid = str(resp.headers.get("MCP-Session-Id") or "")
                    if sid and (len(sid) > 512 or not all(0x21 <= ord(c) <= 0x7e for c in sid)):
                        raise ValueError("MCP 会话标识格式不合法")
                    self.session_id = sid
                return _read_reply(resp, request_id, deadline)
        except urllib.error.HTTPError as exc:
            code = int(exc.code)
            exc.close()
            if 300 <= code < 400:
                raise ValueError("MCP 地址发生重定向，出于凭据安全已拒绝；请填写最终端点") from None
            if code == 404 and self.session_id and method != "initialize":
                raise _ExpiredSession("MCP 会话已过期，请重新连接；本次工具调用不会自动重试") from None
            if code in (401, 403):
                raise ValueError(f"MCP 鉴权或权限被拒绝（HTTP {code}），请检查连接授权") from None
            raise ValueError(f"MCP 调用被拒绝（HTTP {code}）") from None
        except urllib.error.URLError as exc:
            raise ValueError(f"MCP 连接失败（{type(exc.reason).__name__}），未自动重试") from None
        except TimeoutError:
            raise ValueError(f"MCP 等待 {method} 超时，执行结果可能尚未返回；未自动重试") from None
        except (OSError, http.client.HTTPException):
            raise ValueError("MCP 连接中断，未获得完整结果；未自动重试") from None

    def initialize(self) -> "HttpSession":
        with self._lock:
            if self.initialized:
                return self
            try:
                result = self._post("initialize", {
                    "protocolVersion": _PROTOCOL_VERSION, "capabilities": {},
                    "clientInfo": {"name": "soduwork-hub", "title": "SoduWork Hub", "version": "1.12"},
                })
                negotiated = result.get("protocolVersion")
                if not isinstance(negotiated, str) or negotiated not in _SUPPORTED_VERSIONS:
                    raise ValueError("MCP 协议版本不受支持，需要支持 Streamable HTTP 的协议版本")
                self.generation += 1
                self.protocol_version = negotiated
                self.initialized = True
                self._post("notifications/initialized", {}, notification=True)
                return self
            except Exception:
                self.close()
                raise

    def call(self, method: str, params: dict | None = None) -> dict:
        with self._lock:
            self.initialize()
            try:
                return self._post(method, params or {})
            except _ExpiredSession:
                self._reset()
                # Only discovery/ping can be transparently repeated. A tool may
                # already have committed side effects; never replay tools/call.
                if method not in {"tools/list", "ping"} or (params or {}).get("cursor"):
                    raise
                self.initialize()
                try:
                    return self._post(method, params or {})
                except _ExpiredSession:
                    self._reset()
                    raise

    def close(self) -> None:
        with self._lock:
            try:
                if self.session_id:
                    req = urllib.request.Request(
                        self.url, headers=self._request_headers(), method="DELETE")
                    with _opener().open(req, timeout=min(2, max(1, float(self.timeout)))):
                        pass
            except urllib.error.HTTPError as exc:
                exc.close()
            except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
                pass
            finally:
                self._reset()

    def __enter__(self) -> "HttpSession":
        return self.initialize()

    def __exit__(self, *_args) -> None:
        self.close()


def _clean_tool(value: dict) -> dict:
    out = {
        "name": str(value.get("name") or "")[:200],
        "description": str(value.get("description") or "")[:1000],
        "inputSchema": (dict(value.get("inputSchema"))
                        if isinstance(value.get("inputSchema"), dict)
                        else {"type": "object", "properties": {}}),
    }
    for key in ("title", "outputSchema", "annotations", "icons", "_meta"):
        if key in value:
            out[key] = value[key]
    return out


def list_tools(spec: dict, timeout: int = _TIMEOUT) -> list[dict]:
    """Return a complete bounded catalog; never report partial discovery as success."""
    tools: list[dict] = []
    cursor = ""
    seen: set[str] = set()
    names: set[str] = set()
    with HttpSession(dict(spec or {}), timeout) as session:
        generation, recoveries = session.generation, 0
        for _page in range(20):
            try:
                result = session.call("tools/list", {"cursor": cursor} if cursor else {})
            except _ExpiredSession:
                if recoveries or session.generation != generation:
                    raise
                recoveries += 1
                session.initialize()
                generation = session.generation
                tools.clear()
                names.clear()
                seen.clear()
                cursor = ""
                continue
            if session.generation != generation:
                if recoveries:
                    raise ValueError("MCP 会话反复过期，停止自动重试")
                recoveries += 1
                generation = session.generation
                tools.clear()
                names.clear()
                seen.clear()
            page = result.get("tools")
            if not isinstance(page, list):
                raise ValueError("MCP 工具目录格式不合法")
            for tool in page:
                if (not isinstance(tool, dict) or not isinstance(tool.get("name"), str)
                        or not tool["name"].strip() or tool["name"] in names):
                    raise ValueError("MCP 分页工具目录有无效或重复名称")
                if len(tool["name"]) > 200:
                    raise ValueError("MCP 工具名称过长")
                names.add(tool["name"])
                tools.append(_clean_tool(tool))
            if len(tools) > 500:
                raise ValueError("MCP 工具目录超过分页安全上限，未返回不完整目录")
            next_cursor = result.get("nextCursor")
            if next_cursor is None:
                return tools
            if not isinstance(next_cursor, str) or not next_cursor or len(next_cursor) > 2000:
                raise ValueError("MCP 分页游标格式不合法")
            if next_cursor in seen:
                raise ValueError("MCP 分页游标循环，未返回不完整目录")
            seen.add(next_cursor)
            cursor = next_cursor
    raise ValueError("MCP 工具目录超过分页安全上限，未返回不完整目录")


def normalize_tool_result(result: dict):
    """Keep old text ergonomics while preserving typed MCP content losslessly."""
    content = [dict(item) for item in (result.get("content") or [])
               if isinstance(item, dict)]
    text = "".join(str(item.get("text") or "") for item in content
                   if item.get("type") == "text")
    if result.get("isError"):
        raise ValueError(text[:240] or "MCP 工具返回失败")
    typed = any(item.get("type") != "text" for item in content)
    structured = result.get("structuredContent")
    if typed or structured is not None or result.get("_meta") is not None:
        out = {"content": content}
        for key in ("structuredContent", "_meta"):
            if key in result:
                out[key] = result[key]
        return out
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text


def call(spec: dict, tool: str, arguments: dict | None = None,
         timeout: int = _TIMEOUT):
    with HttpSession(dict(spec or {}), timeout) as session:
        result = session.call(
            "tools/call", {"name": str(tool or ""), "arguments": arguments or {}})
    return normalize_tool_result(result)
