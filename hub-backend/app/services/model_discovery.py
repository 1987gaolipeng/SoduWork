"""List upstream model identifiers and their explicitly advertised output purposes."""
from __future__ import annotations

import json

import httpx

from .model_definition_contracts import MODEL_MODALITIES

TIMEOUT_SECONDS = 15
MAX_BYTES = 512 * 1024
MAX_MODELS = 500

_OUTPUT_PURPOSES = {
    **{purpose: purpose for purpose in MODEL_MODALITIES}, "text": "chat",
    **dict.fromkeys(("decision", "embedding", "embeddings", "rerank", "reranking",
                     "classification", "moderation", "audio", "speech"), "unsupported"),
}
# Only explicit endpoint paths establish a purpose. A protocol such as "openai"
# can carry several kinds of model and does not identify the output.
_ENDPOINT_PURPOSES = {
    "chat/completions": "chat", "responses": "chat", "messages": "chat",
    "images/generations": "image", "videos/generations": "video",
    "embeddings": "unsupported", "rerank": "unsupported", "moderations": "unsupported",
    "audio/speech": "unsupported", "audio/transcriptions": "unsupported",
    "systemone": "unsupported", "ocr": "unsupported",
}


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


def _declaration(value, *, endpoint=False) -> frozenset[str]:
    values = value if isinstance(value, list) else [value]
    purposes = set()
    for item in values:
        if not isinstance(item, str) or not item.strip():
            continue
        token = item.strip().lower()
        if endpoint:
            path = token.strip("/").removeprefix("v1/")
            if path in _ENDPOINT_PURPOSES:
                purposes.add(_ENDPOINT_PURPOSES[path])
        else:
            purposes.add(_OUTPUT_PURPOSES.get(token, "unknown"))
    return frozenset(purposes)


def _candidate(name: str, rows: list[dict]) -> dict:
    outputs = set()
    endpoints = set()
    for row in rows:
        architecture = row.get("architecture")
        for value in (row.get("output"), row.get("output_modalities"),
                      architecture.get("output_modalities") if isinstance(architecture, dict) else None):
            if declared := _declaration(value):
                outputs.add(declared)
        for key in ("endpoint", "endpoints", "supported_endpoints", "supported_endpoint_types"):
            if declared := _declaration(row.get(key), endpoint=True):
                endpoints.add(declared)
    # A specialized endpoint can return text (e.g. OCR) without supporting chat.
    if endpoints and all(paths == {"unsupported"} for paths in endpoints):
        declared = {"unsupported"}
    else:
        declarations = outputs | endpoints
        declared = frozenset.intersection(*declarations) if declarations else frozenset()
    purposes = [purpose for purpose in MODEL_MODALITIES if purpose in declared]
    status = "unknown"
    if purposes:
        status = "declared"
    elif declared == {"unsupported"}:
        status = "unsupported"
    return {"id": name, "purposes": purposes, "status": status}


def _candidates(payload) -> list[dict] | None:
    """Keep the first bounded set of distinct IDs from supported list envelopes."""
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
    by_name: dict[str, list[dict]] = {}
    for row in rows:
        name = row.get("id") if isinstance(row, dict) else row
        name = name.strip() if isinstance(name, str) else ""
        if not name or (len(by_name) >= MAX_MODELS and name not in by_name):
            continue
        entries = by_name.setdefault(name, [])
        if isinstance(row, dict):
            entries.append(row)
    if rows and not by_name:
        return None
    return [_candidate(name, entries) for name, entries in by_name.items()]


async def discover(base: str, key: str, kind: str = "openai-compat", *, allow_empty=False) -> dict:
    """Return legacy names and classified candidates without probing individual models."""
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
            candidates = _candidates(payload)
            if candidates is None:
                return {"ok": False, "models": [], "path": path,
                        "code": "model.discovery.invalid-list",
                        "detail": "服务没有返回有效的模型列表"}
            if not candidates and not allow_empty:
                return {"ok": False, "models": [], "path": path,
                        "code": "model.discovery.empty",
                        "detail": "服务返回了空模型列表"}
            counts = {"total": len(candidates),
                      "chat": sum("chat" in row["purposes"] for row in candidates),
                      "unknown": sum(row["status"] == "unknown" for row in candidates)}
            return {"ok": True, "models": [row["id"] for row in candidates],
                    "candidates": candidates, "counts": counts, "path": path, "detail": ""}
        if status in (404, 405):
            return {"ok": False, "models": [],
                    "code": "model.discovery.no-endpoint",
                    "detail": "这个服务不提供模型列表接口，请手动添加模型标识"}
        return {"ok": False, "models": [], "code": "model.discovery.failed",
                "params": {"status": f"HTTP {status}"}, "detail": f"读取模型列表失败：HTTP {status}"}
    finally:
        await client.aclose()
