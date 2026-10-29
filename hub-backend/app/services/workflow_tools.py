# -*- coding: utf-8 -*-
"""Trusted Hub-side tool registry. Plugins may invoke registered tools only; unknown names or
invalid arguments are configuration failures. Tools return bounded node output; long Runner
commands belong to script nodes. Registered implementations distinguish configuration errors
from retryable runtime failures.
"""
from __future__ import annotations

import asyncio
import logging
import time
import urllib.request

from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from . import workflow_contracts

log = logging.getLogger("uvicorn.error")

_HTTP_TIMEOUT_MAX = 60


async def _http_check(session: AsyncSession, task, args: dict) -> dict:
    url = str(args.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        raise workflow_contracts.WorkflowConfigurationError(
            "http_check 需要 http(s):// 开头的 url 参数")
    expect = int(args.get("expectStatus") or 200)
    contains = str(args.get("contains") or "")
    timeout = min(_HTTP_TIMEOUT_MAX, max(1, int(args.get("timeoutSeconds") or 20)))

    def _probe() -> tuple[int, str]:
        req = urllib.request.Request(url, method=str(args.get("method") or "GET"))
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=timeout) as r:
                return int(r.status), r.read(64 * 1024).decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return int(e.code), e.read(4096).decode("utf-8", "replace")

    started = time.perf_counter()
    try:
        status, body = await asyncio.to_thread(_probe)
    except Exception as e:  # noqa: BLE001 - Connectivity and timeout failures are retryable runtime errors.
        raise ValueError(f"{url} 访问失败（{type(e).__name__}）") from e
    elapsed = int((time.perf_counter() - started) * 1000)
    if status != expect:
        raise ValueError(f"{url} 返回 {status}，期望 {expect}（{elapsed}ms）")
    if contains and contains not in body:
        raise ValueError(f"{url} 响应里没有「{contains[:60]}」（{elapsed}ms）")
    return {"url": url, "status": status, "elapsedMs": elapsed,
            **({"matched": contains[:60]} if contains else {})}


async def _notify(session: AsyncSession, task, args: dict) -> dict:
    message = str(args.get("message") or "").strip()
    if not message:
        raise workflow_contracts.WorkflowConfigurationError("notify 需要 message 参数")
    cid = str(getattr(task, "owner_client_id", "") or "")
    if not cid:
        raise ValueError("需求没有归属 SoduWork，通知没有收件人")
    from .task_access import publish_owner
    delivered = await publish_owner(session, task, {"type": "notice",
                            "text": f"「{task.title}」流程提醒：{message[:400]}",
                            "taskId": task.id})
    return {"notified": cid if delivered else "", "message": message[:400]}


_REGISTRY = {
    "http_check": _http_check,
    "notify": _notify,
}


def known_tools() -> list[str]:
    return sorted(_REGISTRY)


async def execute(session: AsyncSession, task, node: dict) -> dict:
    """Execute a registered tool node and return its output; reject invalid names or arguments as
    configuration errors.
    """
    cfg = dict(node.get("config") or {})
    name = str(cfg.get("tool") or "").strip()
    fn = _REGISTRY.get(name)
    if fn is None:
        raise workflow_contracts.WorkflowConfigurationError(
            "插件声明的工具「%s」不在受信名单里（当前可用：%s）"
            % (name or "（空）", "、".join(known_tools())))
    args = dict(cfg.get("args") or {})
    out = await fn(session, task, args)
    # Retain bounded argument snapshots in node output for auditing.
    return {"tool": name, "result": out,
            "args": {k: str(v)[:200] for k, v in args.items()}}
