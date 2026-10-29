"""Public module behavior and service contracts."""
from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import time
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from . import storage

log = logging.getLogger("uvicorn.error")

_TIMEOUT = 45
_WINDOW = "1366,900"
# Virtual-time budget for initial SPA rendering.
_VIRTUAL_TIME_MS = 8000

_WIN_CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
)
_NIX_CANDIDATES = ("google-chrome", "chromium-browser", "chromium", "microsoft-edge")


def find_browser() -> str:
    """Find a screenshot-capable browser executable or return empty for caller-controlled failure
    handling.
    """
    explicit = os.environ.get("SODUWORK_SHOT_BROWSER", "").strip()
    if explicit and os.path.isfile(explicit):
        return explicit
    if os.name == "nt":
        for path in _WIN_CANDIDATES:
            if os.path.isfile(path):
                return path
        return ""
    import shutil
    for name in _NIX_CANDIDATES:
        found = shutil.which(name)
        if found:
            return found
    return ""


def capture(url: str, *, timeout: int = _TIMEOUT) -> tuple[bytes, str]:
    """Capture the configured page viewport and return PNG bytes plus a failure reason. This
    synchronous operation must run through asyncio.to_thread.
    """
    url = str(url or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        return b"", "回执截图只支持 http/https 地址"
    browser = find_browser()
    if not browser:
        return b"", "这台 Hub 上没有可用的 Chrome/Edge（装一个，或用 SODUWORK_SHOT_BROWSER 指路径）"
    out_dir = tempfile.mkdtemp(prefix="soduwork-shot-")
    out_png = os.path.join(out_dir, "shot.png")
    argv = [
        browser, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--hide-scrollbars", "--window-size=" + _WINDOW,
        "--virtual-time-budget=%d" % _VIRTUAL_TIME_MS,
        # Use a disposable browser profile, leaving the user's sessions and single-instance locks untouched.
        "--user-data-dir=" + os.path.join(out_dir, "profile"),
        "--no-first-run", "--no-default-browser-check",
        "--screenshot=" + out_png, url,
    ]
    env = dict(os.environ)
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        env.pop(key, None)  # Connect screenshot requests directly to the target service.
    try:
        proc = subprocess.run(argv, capture_output=True, timeout=timeout, env=env)
        if os.path.isfile(out_png) and os.path.getsize(out_png) > 0:
            with open(out_png, "rb") as fh:
                return fh.read(), ""
        tail = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        return b"", ("浏览器没有产出截图：" + (tail[-1][:200] if tail else "无输出"))
    except subprocess.TimeoutExpired:
        return b"", f"抓图超过 {timeout} 秒（页面打不开？内网地址通不通）"
    except Exception as exc:  # noqa: BLE001
        return b"", f"抓图失败（{type(exc).__name__}）"
    finally:
        import shutil
        shutil.rmtree(out_dir, ignore_errors=True)


async def attach_shot(session: AsyncSession, task, png: bytes, *, url: str,
                      label: str = "", run_id: str = "", node_run_id: str = "",
                      source_ref: str = "", evidence_meta: dict | None = None) -> str:
    """Store the screenshot as a verification attachment and return its ID."""
    meta = {
        "kind": "deploy_screenshot", "url": url[:400], "label": label[:120],
        "verification": {"state": "passed", "by": "SoduWork",
                         "at": int(time.time() * 1000)},
        **dict(evidence_meta or {}),
    }
    row = models.Attachment(
        id=str(uuid.uuid4()), task_id=task.id,
        filename=("上线回执-%s.png" % (label or "截图"))[:250],
        content_type="image/png", size=len(png), uploaded_by="agent:SoduWork",
        role="verification", source_ref=source_ref,
        workflow_run_id=run_id, node_run_id=node_run_id,
        evidence_meta=meta)
    row.storage_key = "att/%s/%s/receipt.png" % (task.id, row.id)
    row.backend = storage.put(row.storage_key, png, "image/png")
    session.add(row)
    await session.commit()
    return row.id


async def shot_check(session: AsyncSession, task, spec: dict, *,
                     variables: dict | None = None, run_id: str = "",
                     node_run_id: str = "", source_ref: str = "",
                     evidence_meta: dict | None = None) -> dict:
    """Run a screenshot assertion and return a check record with attachmentId. required defaults to
    True; explicitly optional screenshots must set required=False.
    """
    import asyncio

    from . import http_assertions
    spec = dict(spec or {})
    url = str(http_assertions.materialize(
        {"url": spec.get("url")}, variables).get("url") or "")
    name = str(spec.get("name") or "上线回执截图")[:100]
    required = bool(spec.get("required", True))
    png, why = await asyncio.to_thread(capture, url)
    if not png:
        return {"name": name, "type": "screenshot", "ok": not required,
                "detail": (why + ("" if required else "（此检查按配置可跳过）"))[:1000],
                "url": url[:400]}
    att_id = await attach_shot(session, task, png, url=url, label=name,
                               run_id=run_id, node_run_id=node_run_id,
                               source_ref=source_ref, evidence_meta=evidence_meta)
    return {"name": name, "type": "screenshot", "ok": True,
            "detail": "已抓取 %s（%.0f KB）" % (url[:200], len(png) / 1024),
            "url": url[:400], "attachmentId": att_id}
