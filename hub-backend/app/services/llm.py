"""Minimal chat-completion client for work-report generation. Reuse configured LLM settings, expose
only chat behavior, and return unavailable when unconfigured so callers can use templates. Never
log credentials.
"""
import json
import logging
import ssl
import urllib.request

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models

log = logging.getLogger("uvicorn.error")

# llm_models is the administrator-enabled candidate model list, serialized as a JSON array.
# Providers may omit /v1/models, so administrators explicitly configure available choices.
# Milestone model selectors use this list through ai_exec.model_choices.
_KEYS = ("llm_base_url", "llm_api_key", "llm_model", "llm_models")
_cache: dict = {}          # Keep the latest read values, but query on every load so multiple nodes do not retain stale keys.


async def load(session: AsyncSession, force: bool = False) -> dict:
    """Read the shared configuration; never keep a worker-local stale credential."""
    global _cache
    rows = (await session.execute(
        select(models.AppSetting).where(models.AppSetting.key.in_(_KEYS))
        .execution_options(populate_existing=True)
    )).scalars().all()
    _cache = {r.key: (r.value or "").strip() for r in rows}
    return _cache


def enabled(cfg: dict | None = None) -> bool:
    c = cfg if cfg is not None else _cache
    return bool(c.get("llm_base_url") and c.get("llm_api_key"))


def _call_sync(base: str, key: str, model: str, system: str, user: str,
               temperature: float, timeout: int) -> str:
    """Call OpenAI-compatible /chat/completions using stdlib urllib without extra dependencies.
    Connect directly to the configured model service by default rather than inheriting system
    proxies."""
    url = base.rstrip("/") + "/chat/completions"
    body = json.dumps({
        "model": model or "",
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": temperature,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + key)
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        urllib.request.ProxyHandler({}),          # An empty proxy mapping disables proxy use.
    )
    with opener.open(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return (data.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""


async def chat(session: AsyncSession, system: str, user: str,
               temperature: float = 0.3, timeout: int = 60) -> str | None:
    """Return generated text, or None when unconfigured or failed so the caller can fall back
    without interrupting business work.
    """
    import asyncio
    cfg = await load(session)
    if not enabled(cfg):
        return None
    try:
        # Legacy report generation can own uncommitted report rows. It cannot
        # acquire a second database write transaction on SQLite for admission.
        # Keep its existing transport until report transactions are separated.
        txt = await asyncio.to_thread(
            _call_sync, cfg["llm_base_url"], cfg["llm_api_key"], cfg.get("llm_model", ""),
            system, user, temperature, timeout,
        )
        return (txt or "").strip() or None
    except Exception as e:  # noqa: BLE001 - Log only exception types, never content that may contain secrets or internal details.
        log.warning("LLM 调用失败：%s", type(e).__name__)
        return None
