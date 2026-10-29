"""Coverage for Harness²'s ordinary interactive execution setup probe."""
from __future__ import annotations

import json

from .agent_setup_probe import _clean

COVERAGE = "execute-v2"
TIMEOUT = 180
INTRO = "② 验证 Harness² 日常执行与完整回复；会使用所选模型额度，最多 3 分钟。"
MISSING_PROOF = "收到执行回复，但尚未确认 Harness² 日常执行完整结束，请点「测一下」重试。"
UNVERIFIED = "上次测试尚未验证当前日常执行路径；请点「测一下」重新验证。"


def _event(line: str) -> dict:
    try:
        value = json.loads(_clean(line).lstrip("\ufeff"))
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def completed(output: str) -> bool:
    for line in str(output or "").splitlines():
        event = _event(line)
        if (event.get("type") == "harness2_probe_complete"
                and event.get("coverage") == COVERAGE
                and type(event.get("stages")) is int and event["stages"] == 0):
            return True
    return False


def visible_record(record: dict) -> dict:
    if record.get("ok") is True and record.get("coverage") != COVERAGE:
        return {"ok": None, "detail": UNVERIFIED, "previous": dict(record)}
    return record


def success_detail(version: str) -> str:
    return f"通了 —— Google Harness² {version} 日常执行已完整结束，口令对上了。"
