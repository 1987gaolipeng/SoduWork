"""Public module behavior and service contracts."""
from __future__ import annotations

import asyncio
import json
import logging
import urllib.request
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..realtime import hub

log = logging.getLogger("uvicorn.error")


async def _clients_of_user(session: AsyncSession, uid: str) -> list[str]:
    uid = str(uid or "").strip()
    if not uid:
        return []
    rows = (await session.execute(
        select(models.Client.id).where(models.Client.user_ref == uid))).scalars().all()
    return [str(r) for r in rows]


async def stakeholder_clients(session: AsyncSession, task) -> list[str]:
    """Return the deduplicated devices that should receive notices for this task."""
    return sorted(await _stakeholder_accounts(session, task))


async def _stakeholder_accounts(session: AsyncSession, task) -> dict[str, str]:
    from .task_access import is_owner
    seen: dict[str, str] = {}
    oc = str(getattr(task, "owner_client_id", "") or "").strip()
    if oc:
        client = await session.get(models.Client, oc, populate_existing=True)
        if is_owner(task, client):
            seen[oc] = str(client.user_ref or "")
    for uid in (getattr(task, "requester_user_id", None),
                getattr(task, "created_by", None),
                getattr(task, "assignee_user_id", None)):
        for cid in await _clients_of_user(session, str(uid or "")):
            seen[cid] = str(uid)
    return seen


async def notify_task(session: AsyncSession, task, text: str,
                      *, extra: dict | None = None) -> int:
    """Push an in-app notice to task participants and return the delivery count without propagating notification failures."""
    targets = await _stakeholder_accounts(session, task)
    n = 0
    for cid, uid in targets.items():
        try:
            ev = {"type": "notice", "taskId": str(getattr(task, "id", "") or ""), "text": text}
            if extra:
                ev.update(extra)
            await hub.publish(cid, ev, user_id=uid)
            n += 1
        except Exception:  # noqa: BLE001 - Notification failure must not interrupt the main operation.
            log.warning("notify_task 推送失败 client=%s", cid[:8])
    log.info("notify_task %s → %d 个设备", str(getattr(task, "id", "") or "")[:8], n)
    return n


# External alerts.
# In-app notices reach only users with an active client.
# Use the optional webhook channel for critical release and verification failures.
# An empty alert_webhook_url disables this channel.
# Alert failures are nonfatal; messages contain facts and next steps, never secrets.

ALERT_URL_KEY = "alert_webhook_url"
_ALERT_TIMEOUT = 8
_ALERT_RESPONSE_LIMIT = 64 * 1024


def _alert_response_ok(url: str, status: int, body: bytes) -> bool:
    """Require platform ACKs; generic webhooks retain their HTTP success contract."""
    if not 200 <= status < 300 or len(body) > _ALERT_RESPONSE_LIMIT:
        return False
    host = (urlsplit(url).hostname or "").lower()
    if host in {"qyapi.weixin.qq.com", "oapi.dingtalk.com"}:
        fields = ("errcode",)
    elif host in {"open.feishu.cn", "open.larksuite.com"}:
        fields = ("code", "StatusCode")
    else:
        return True
    try:
        reply = json.loads(body)
    except (ValueError, UnicodeError):
        return False
    if not isinstance(reply, dict):
        return False
    codes = [reply[field] for field in fields if field in reply]
    # Reject booleans and missing codes; a legacy success must not hide a current error.
    return bool(codes) and all(type(code) is int and code == 0 for code in codes)


def _payload(text: str) -> bytes:
    """Build a text webhook payload compatible with WeCom, DingTalk, Feishu, and generic receivers
    using their supported text fields.
    """
    return json.dumps({
        "msgtype": "text", "text": {"content": text},
        "msg_type": "text", "content": {"text": text},
    }, ensure_ascii=False).encode("utf-8")


async def alert(session: AsyncSession, text: str, *, task=None) -> bool:
    """Send an alert only when a destination is configured and return whether delivery succeeded."""
    row = (await session.execute(select(models.AppSetting).where(
        models.AppSetting.key == ALERT_URL_KEY))).scalars().first()
    url = str((row.value if row else "") or "").strip()
    if not url.startswith(("http://", "https://")):
        return False
    title = str(getattr(task, "title", "") or "").strip()
    body = ("【SoduWork】%s\n%s" % (title, text)) if title else ("【SoduWork】" + text)

    def _post():
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # Connect directly to internal destinations.
        req = urllib.request.Request(url, data=_payload(body),
                                     headers={"Content-Type": "application/json"})
        with opener.open(req, timeout=_ALERT_TIMEOUT) as resp:
            return _alert_response_ok(url, int(resp.status), resp.read(_ALERT_RESPONSE_LIMIT + 1))

    try:
        accepted = await asyncio.to_thread(_post)
        if not accepted:
            log.warning("告警 webhook 未确认接收")
        return accepted
    except Exception as e:  # noqa: BLE001 - Alert delivery failure must not interrupt the main operation.
        log.warning("告警 webhook 发送失败：%s", type(e).__name__)
        return False


async def notify_and_alert(session: AsyncSession, task, text: str,
                           *, extra: dict | None = None) -> dict:
    """Send both stakeholder notices and external alerts for critical events; each channel fails
    independently.
    """
    devices = await notify_task(session, task, text, extra=extra)
    sent = await alert(session, text, task=task)
    return {"devices": devices, "webhook": sent}
