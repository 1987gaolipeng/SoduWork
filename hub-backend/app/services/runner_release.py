"""Runner release and health facts for the administration read model.

This module deliberately contains no deployment side effects. It tells the
operator what is running and whether it matches this hub; a later, signed
upgrade protocol can consume the same contract without pretending that a key
rotation or reinstall is a safe rolling upgrade.
"""
from __future__ import annotations

import re
import time


RUNNER_VERSION = "1.9.8"
_VERSION_RE = re.compile(r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?")


def version_tuple(value: str) -> tuple[int, int, int] | None:
    match = _VERSION_RE.match(str(value or "").strip())
    if not match:
        return None
    return tuple(int(part or 0) for part in match.groups())


def release_state(current: str, target: str = RUNNER_VERSION) -> dict:
    current_value = str(current or "").strip()
    current_tuple = version_tuple(current_value)
    target_tuple = version_tuple(target)
    if current_tuple is None or target_tuple is None:
        state, label = "unknown", "\u7248\u672c\u672a\u77e5"
    elif current_tuple < target_tuple:
        state, label = "upgrade_needed", "\u9700\u8981\u5347\u7ea7"
    elif current_tuple > target_tuple:
        state, label = "ahead", "\u9ad8\u4e8e\u670d\u52a1\u7aef"
    else:
        state, label = "current", "\u7248\u672c\u4e00\u81f4"
    return {
        "currentVersion": current_value,
        "targetVersion": target,
        "state": state,
        "label": label,
        "upgradeAvailable": state == "upgrade_needed",
    }


def install_source(item: dict) -> dict:
    if item.get("embedded"):
        return {"key": "client", "label": "\u968f\u5ba2\u6237\u7aef\u5b89\u88c5"}
    if str(item.get("authState") or "") == "active":
        return {"key": "managed", "label": "\u72ec\u7acb\u88c5\u673a"}
    if item.get("shared"):
        return {"key": "legacy", "label": "\u5171\u4eab\u4ee4\u724c\u63a5\u5165"}
    return {"key": "independent", "label": "\u72ec\u7acb\u6267\u884c\u673a"}


def health_state(item: dict, now: int | None = None) -> dict:
    now = int(now or time.time())
    last_seen = max(0, int(item.get("lastSeen") or 0))
    if item.get("shared") and item.get("scopeState") == "unassigned":
        state, label = "unassigned", "\u5f85\u5f52\u5c5e"
    elif item.get("online"):
        mode = str(item.get("mode") or "accepting")
        if mode == "disabled":
            state, label = "disabled", "\u5df2\u505c\u7528"
        elif mode == "draining":
            state, label = "draining", "\u6392\u7a7a\u4e2d"
        elif item.get("busy"):
            state, label = "busy", "\u6267\u884c\u4e2d"
        else:
            state, label = "healthy", "\u5065\u5eb7"
    elif item.get("enrolled"):
        state, label = "pending", "\u7b49\u5f85\u9996\u6b21\u8fde\u63a5"
    elif last_seen:
        state, label = "offline", "\u79bb\u7ebf"
    else:
        state, label = "unknown", "\u4ece\u672a\u4e0a\u62a5"
    return {
        "state": state,
        "label": label,
        "lastSeen": last_seen,
        "ageSeconds": max(0, now - last_seen) if last_seen else None,
    }


def enrich(items: list[dict], now: int | None = None) -> dict:
    counts = {
        "total": len(items), "online": 0, "accepting": 0,
        "busy": 0, "upgradeNeeded": 0, "attention": 0,
    }
    for item in items:
        item["installSource"] = install_source(item)
        item["health"] = health_state(item, now)
        item["release"] = release_state(str(item.get("version") or ""))
        counts["online"] += int(bool(item.get("online")))
        counts["accepting"] += int(bool(item.get("accepting")))
        counts["busy"] += int(bool(item.get("busy")))
        counts["upgradeNeeded"] += int(item["release"]["state"] == "upgrade_needed")
        counts["attention"] += int(
            item["health"]["state"] in {"offline", "unknown", "disabled", "unassigned"}
            or item["release"]["state"] in {"unknown", "upgrade_needed"}
        )
    return {
        "items": items,
        "summary": counts,
        "release": {"targetVersion": RUNNER_VERSION},
    }
