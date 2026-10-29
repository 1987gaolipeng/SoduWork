"""Notify device owners about outdated runner versions, with rate limits.

The client installer bundles the runner, so postponed or failed client updates can leave
devices accepting work with an outdated runtime. Server-side recovery handles known
dispatch failures, while these notices direct owners to the necessary client update.

Emit notices only on actual dispatch or recovered dispatch receipts, never on frequent
heartbeats. Apply one notification window per device (six hours by default).
Reuse runner_release.release_state for version checks and preserve its display-only
contract: send a notice without deploying or updating anything.
"""
from __future__ import annotations

import logging
import time

from . import runner_release

log = logging.getLogger("uvicorn.error")

_INTERVAL_SECONDS = 6 * 3600
_CLIENT_INTERVAL_SECONDS = 24 * 3600
_last_sent: dict[str, float] = {}
_client_last_sent: dict[str, float] = {}


def _due(client_id: str, now: float | None = None, *,
         store: dict[str, float] | None = None,
         interval: int = _INTERVAL_SECONDS) -> bool:
    bucket = _last_sent if store is None else store
    moment = time.time() if now is None else now
    previous = bucket.get(client_id)
    if previous is not None and moment - previous < interval:
        return False
    bucket[client_id] = moment
    return True


def reset_for_test() -> None:
    _last_sent.clear()
    _client_last_sent.clear()


def stale_message(host: str, current: str, target: str, healed: bool) -> str:
    where = ("执行机 %s" % host) if host else "这台机器的执行机"
    head = "⚠ 刚才那条任务的派活回执没送到，靠会话实况才接回来——" if healed else ""
    return (head + "%s 版本 %s 低于服务端配套 %s。执行机随客户端一起升级，"
            "请尽快完成客户端更新（更新提示被推迟过的话，重启 SoduWork 会再次提示）。"
            % (where, current or "未知", target))


async def latest_client_release(session) -> str:
    """Return the latest available stable Windows x64 client version, or empty when unavailable."""
    try:
        from sqlalchemy import select
        from ..models import ClientRelease
        rows = (await session.execute(select(ClientRelease.version).where(
            ClientRelease.enabled.is_(True), ClientRelease.channel == "stable",
            ClientRelease.platform == "win32", ClientRelease.arch == "x64",
        ))).scalars().all()
        from . import runner_release
        best = ""
        for version in rows:
            if not best or (runner_release.version_tuple(version) or (0, 0, 0)) > \
                    (runner_release.version_tuple(best) or (0, 0, 0)):
                best = version
        return best
    except Exception as e:  # noqa: BLE001 - Missing update metadata must not block device connection.
        log.warning("查询最新客户端版本失败: %s", type(e).__name__)
        return ""


async def nudge_stale_client(client_id: str, current: str, latest: str,
                             *, now: float | None = None) -> bool:
    """Send a throttled connection-time upgrade notice for clients whose updater cannot complete
    the required upgrade. Limit notices to once per device per day.
    """
    cid = str(client_id or "")
    from . import runner_release
    current_v = runner_release.version_tuple(str(current or ""))
    latest_v = runner_release.version_tuple(str(latest or ""))
    if not cid or current_v is None or latest_v is None or current_v >= latest_v:
        return False
    if not _due(cid, now, store=_client_last_sent, interval=_CLIENT_INTERVAL_SECONDS):
        return False
    text = ("📦 你的 SoduWork 客户端是 %s，最新版 %s 已发布（修复了任务派活丢失等问题）。"
            "请从下载页重新安装一次：老版本这次需要手动装，装完以后就恢复自动更新了。"
            % (current, latest))
    try:
        from ..realtime import hub
        await hub.publish(cid, {"type": "notice", "text": text})
    except Exception as e:  # noqa: BLE001
        log.warning("客户端升级提醒发送失败 %s: %s", cid, type(e).__name__)
        return False
    return True


async def nudge_stale_runner(client_id: str, runner_version: str, host: str = "",
                             *, healed: bool = False, now: float | None = None) -> bool:
    """Send an upgrade reminder and return whether it was delivered; throttled or current versions
    return False.
    """
    cid = str(client_id or "")
    if not cid:
        return False
    state = runner_release.release_state(str(runner_version or ""))
    if not state["upgradeAvailable"]:
        return False
    if not _due(cid, now):
        return False
    text = stale_message(str(host or ""), state["currentVersion"],
                         state["targetVersion"], healed)
    try:
        from ..realtime import hub
        await hub.publish(cid, {"type": "notice", "text": text})
    except Exception as e:  # noqa: BLE001 - Upgrade guidance must not affect dispatch or recovery.
        log.warning("执行机升级提醒发送失败 %s: %s", cid, type(e).__name__)
        return False
    return True
