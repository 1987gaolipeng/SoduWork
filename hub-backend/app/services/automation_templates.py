"""Organization-managed automation templates.

Templates are reusable schedule defaults. They intentionally contain no owner
client, credentials, or personal plugin body; those values are selected by the
employee when a schedule is created. The catalog lives in AppSetting so an
administrator can change it without a schema migration.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AppSetting
from .localized_text import normalize_locales as _locales
from .schedule_timing import parse_schedule_date
from . import template_catalog_revision as catalog_revision

SETTING_KEY = "automation_templates_v1"
MAX_ITEMS = 100
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
_EVERY = {"hourly", "daily", "weekly"}
_CAPABILITIES = {"browser", "computer", "office"}


def _text(value, limit: int = 240) -> str:
    return str(value or "").strip()[:limit]


def _int(value, default: int, low: int, high: int) -> int:
    try:
        value = int(value)
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


def normalize(raw: dict, *, require_name: bool = True) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("自动化模板必须是对象")
    raw_id = raw.get("id") or raw.get("key")
    raw_name = raw.get("name")
    if require_name:
        # Validate writes before normalization: never silently truncate an identity
        # or turn invalid user input into a different template identifier.
        if not isinstance(raw_id, str) or not raw_id:
            raise ValueError("请填写模板标识")
        if not 2 <= len(raw_id) <= 64:
            raise ValueError("模板标识需为 2–64 个字符")
        if not _ID_RE.fullmatch(raw_id):
            raise ValueError("模板标识须以小写字母或数字开头，仅支持小写字母、数字、点（.）、短横线（-）和下划线（_），不能包含空格")
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise ValueError("请填写模板名称，不能全为空白")
        if len(raw_name.strip()) > 80:
            raise ValueError("模板名称最多 80 个字符")
        if re.search(r"[\x00-\x1f\x7f-\x9f]", raw_name):
            raise ValueError("模板名称不能包含换行或控制字符")
        template_id, name = raw_id, raw_name.strip()
    else:
        # Keep historical catalogs readable; strict validation applies to writes.
        template_id = _text(raw_id, 64).lower()
        name = _text(raw_name, 80)
    if not _ID_RE.fullmatch(template_id):
        raise ValueError("模板标识只能包含小写字母、数字、点、短横线和下划线")
    every = _text(raw.get("every") or "daily", 16).lower()
    if every not in _EVERY:
        raise ValueError("模板节奏只能是每小时、每天或每周")
    caps = raw.get("requiredCapabilities")
    if caps is None:
        caps = []
    if not isinstance(caps, list):
        raise ValueError("模板能力要求必须是数组")
    caps = list(dict.fromkeys(_text(x, 24).lower() for x in caps if _text(x, 24)))
    unknown = [x for x in caps if x not in _CAPABILITIES]
    if unknown:
        raise ValueError("未知的能力要求：" + ", ".join(unknown))
    inputs = raw.get("pluginInputs")
    if inputs is None:
        inputs = {}
    if not isinstance(inputs, dict):
        raise ValueError("模板插件参数必须是对象")
    # Reuse schedule input cleaning so template defaults and personal schedules
    # have exactly the same size and secret-handling contract.
    from . import schedules
    start_date = parse_schedule_date(raw.get("startDate"), "开始日期") or ""
    end_date = parse_schedule_date(raw.get("endDate"), "结束日期") or ""
    if start_date and end_date and start_date > end_date:
        raise ValueError("开始日期不能晚于结束日期")
    return {
        "id": template_id,
        "name": name,
        "description": _text(raw.get("description"), 240),
        "title": _text(raw.get("title") or name, 200),
        "note": _text(raw.get("note"), 8000),
        "nameLocales": _locales(raw.get("nameLocales"), 80),
        "titleLocales": _locales(raw.get("titleLocales"), 200),
        "descriptionLocales": _locales(raw.get("descriptionLocales"), 240),
        "noteLocales": _locales(raw.get("noteLocales"), 8000),
        "every": every,
        "atHour": _int(raw.get("atHour"), 9, 0, 23),
        "atMinute": _int(raw.get("atMinute"), 0, 0, 59),
        "weekday": _int(raw.get("weekday"), 1, 1, 7),
        "startDate": start_date,
        "endDate": end_date,
        "timeZone": _text(raw.get("timeZone") or "Asia/Shanghai", 64),
        "requiredCapabilities": caps,
        "retryLimit": _int(raw.get("retryLimit"), 2, 0, 10),
        "retryDelayMinutes": _int(raw.get("retryDelayMinutes"), 5, 1, 1440),
        "pluginBindingId": _text(raw.get("pluginBindingId"), 36),
        "pluginInputs": schedules.clean_plugin_inputs(inputs),
        "enabled": bool(raw.get("enabled", True)),
        "updatedAt": _text(raw.get("updatedAt"), 40) or datetime.now(timezone.utc).isoformat(),
    }


async def load(session: AsyncSession) -> list[dict]:
    row = (await session.execute(select(AppSetting).where(AppSetting.key == SETTING_KEY))).scalars().first()
    if row is None or not row.value:
        return []
    try:
        raw = json.loads(row.value)
    except (TypeError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    result = []
    for item in raw[:MAX_ITEMS]:
        try:
            result.append(normalize(item, require_name=False))
        except ValueError:
            continue
    return result


async def save(session: AsyncSession, items: list[dict], *, expected_revision=None) -> list[dict]:
    previous = await catalog_revision.read(session, SETTING_KEY)
    if expected_revision is not None and expected_revision != catalog_revision.revision(previous):
        raise catalog_revision.CatalogConflict("Template catalog changed. Reload and review your draft before saving.")
    if not isinstance(items, list):
        raise ValueError("自动化模板必须是数组")
    if len(items) > MAX_ITEMS:
        raise ValueError(f"自动化模板最多 {MAX_ITEMS} 个")
    normalized = []
    seen = set()
    for item in items:
        value = normalize(item)
        if value["id"] in seen:
            raise ValueError("模板标识不能重复：" + value["id"])
        seen.add(value["id"])
        normalized.append(value)
    blob = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
    await catalog_revision.replace(session, SETTING_KEY, previous, blob)
    return normalized


async def enabled(session: AsyncSession) -> list[dict]:
    return [item for item in await load(session) if item.get("enabled", True)]
