"""List upstream model identifiers through the provider's model endpoint.

Discovery answers "which model names does this service actually accept" so an
administrator can import them instead of typing identifiers from memory. It is
read-only, returns names only, and fails soft: a gateway without a model
endpoint is a normal outcome, not an error.
"""
from __future__ import annotations

import json

import httpx

TIMEOUT_SECONDS = 15
MAX_BYTES = 512 * 1024
MAX_MODELS = 500


def _headers(kind: str, key: str) -> dict:
    if kind == "anthropic":
        return {"x-api-key": key, "anthropic-version": "2023-06-01",
                "Accept": "application/json"}
    return {"Authorization": "Bearer " + key, "Accept": "application/json"}


def _paths(kind: str, base: str) -> tuple[str, ...]:
    if kind == "anthropic":
        return ("/models",) if base.endswith("/v1") else ("/v1/models",)
    # Gateways mount the list inconsistently: some sit at the host root and
    # need /v1/models, others (and the Agent-plan style bases that already
    # end in /v3) only serve /models. Probe both spellings.
    return ("/models", "/v1/models")


def _names(payload) -> list[str] | None:
    """Extract model identifiers from an OpenAI-style or bare-list envelope."""
    if isinstance(payload, dict):
        if payload.get("error") is not None:
            return None
        rows = payload.get("data")
        if rows is None:
            rows = payload.get("models")
        if rows is None:
            rows = payload.get("items")
    elif isinstance(payload, list):
        rows = payload
    else:
        rows = None
    if not isinstance(rows, list):
        return None
    names: list[str] = []
    for row in rows:
        name = row.get("id") if isinstance(row, dict) else row
        name = name.strip() if isinstance(name, str) else ""
        if name and name not in names:
            names.append(name)
        if len(names) >= MAX_MODELS:
            break
    return names if names or not rows else None


async def discover(base: str, key: str, kind: str = "openai-compat", *, allow_empty=False) -> dict:
    """Return {"ok", "models", "path", "detail"}; never raises for upstream shape."""
    base = str(base or "").strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        return {"ok": False, "models": [], "code": "model.discovery.invalid-url",
                "detail": "先填写以 http(s):// 开头的服务地址"}
    if not str(key or "").strip():
        return {"ok": False, "models": [], "code": "model.discovery.missing-key",
                "detail": "先配置组织密钥"}
    client = httpx.AsyncClient(trust_env=False, follow_redirects=False,
                               timeout=httpx.Timeout(TIMEOUT_SECONDS))
    try:
        status = None
        for path in _paths(kind, base):
            try:
                response = await client.get(base + path, headers=_headers(kind, key))
            except (httpx.HTTPError, httpx.InvalidURL, UnicodeError) as exc:
                return {"ok": False, "models": [], "code": "model.discovery.unreachable",
                        "params": {"error": type(exc).__name__},
                        "detail": "连不上模型服务：" + type(exc).__name__}
            if response.status_code != 200:
                # A missing alternate path should not hide an authentication error.
                if status is None or status in (404, 405):
                    status = response.status_code
                continue
            try:
                payload = json.loads(response.content[:MAX_BYTES].decode("utf-8", "replace"))
            except (ValueError, UnicodeDecodeError):
                return {"ok": False, "models": [], "path": path,
                        "code": "model.discovery.invalid-payload",
                        "detail": "模型列表不是有效的 JSON 响应"}
            names = _names(payload)
            if names is None:
                return {"ok": False, "models": [], "path": path,
                        "code": "model.discovery.invalid-list",
                        "detail": "服务没有返回有效的模型列表"}
            if not names and not allow_empty:
                return {"ok": False, "models": [], "path": path,
                        "code": "model.discovery.empty",
                        "detail": "服务返回了空模型列表"}
            return {"ok": True, "models": names, "path": path, "detail": ""}
        if status in (404, 405):
            return {"ok": False, "models": [],
                    "code": "model.discovery.no-endpoint",
                    "detail": "这个服务不提供模型列表接口，请手动添加模型标识"}
        return {"ok": False, "models": [], "code": "model.discovery.failed",
                "params": {"status": f"HTTP {status}"}, "detail": f"读取模型列表失败：HTTP {status}"}
    finally:
        await client.aclose()
