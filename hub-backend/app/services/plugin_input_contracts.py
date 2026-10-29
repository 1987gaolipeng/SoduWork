"""Public, non-secret input contracts exposed by immutable plugin versions."""
from __future__ import annotations

import math
import re


_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_SECRET_FIELD = re.compile(
    r"password|passwd|token|secret|private.?key|api.?key", re.I)
_SECRET_VALUE = re.compile(
    r"(?:sk|pk|pat|ghp|glpat)-[A-Za-z0-9_-]{12,}|"
    r"(?:api[_ -]?key|token|password)\s*[:=]\s*\S{8,}", re.I)
_TYPES = {"text", "textarea", "boolean", "number", "select"}
_ALIASES = {"string": "text", "bool": "boolean", "enum": "select"}


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def normalize(value) -> list[dict]:
    """Normalize safe form fields shared by imports and employee-made drafts."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 50:
        raise ValueError("插件 inputs 必须是至多 50 项的数组")
    out: list[dict] = []
    seen: set[str] = set()
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("插件的每个输入字段都必须是对象")
        key = _text(raw.get("key"), 64)
        if not _KEY.fullmatch(key) or key in seen:
            raise ValueError(f"插件输入字段名不合法或重复：{key or '（空）'}")
        if _SECRET_FIELD.search(key) or bool(raw.get("sensitive")):
            raise ValueError(f"插件输入 {key} 不能收集凭据，请改用 SecretReference")
        kind = _text(raw.get("type"), 20).lower() or "text"
        kind = _ALIASES.get(kind, kind)
        if kind == "text" and bool(raw.get("multiline")):
            kind = "textarea"
        if kind not in _TYPES:
            raise ValueError(f"插件输入 {key} 使用了不支持的类型：{kind}")
        field = {
            "key": key,
            "label": _text(raw.get("label"), 100) or key,
            "type": kind,
            "required": bool(raw.get("required")),
            "description": _text(raw.get("description"), 300),
            "placeholder": _text(raw.get("placeholder"), 180),
        }
        if _SECRET_VALUE.search(
                f"{field['description']}\n{field['placeholder']}"):
            raise ValueError(f"插件输入 {key} 的说明疑似包含凭据")
        option_values: set[str] = set()
        if kind == "select":
            source = raw.get("options")
            if not isinstance(source, list) or not (1 <= len(source) <= 50):
                raise ValueError(f"插件输入 {key} 的 options 必须有 1 到 50 项")
            options = []
            for option in source:
                option = dict(option) if isinstance(option, dict) else {
                    "value": option, "label": option}
                option_value = _text(option.get("value"), 200)
                if not option_value or option_value in option_values:
                    raise ValueError(f"插件输入 {key} 包含空值或重复选项")
                options.append({
                    "value": option_value,
                    "label": _text(option.get("label"), 100) or option_value,
                })
                option_values.add(option_value)
            field["options"] = options
        if "default" in raw:
            default = raw.get("default")
            if kind == "boolean":
                if not isinstance(default, bool):
                    raise ValueError(f"插件输入 {key} 的默认值必须是布尔值")
            elif kind == "number":
                if (isinstance(default, bool)
                        or not isinstance(default, (int, float))
                        or not math.isfinite(default)):
                    raise ValueError(f"插件输入 {key} 的默认值必须是数字")
            else:
                default = _text(default, 8000)
                if kind == "select" and default not in option_values:
                    raise ValueError(f"插件输入 {key} 的默认值不在 options 中")
            if isinstance(default, str) and _SECRET_VALUE.search(default):
                raise ValueError(f"插件输入 {key} 的默认值疑似包含凭据")
            field["default"] = default
        out.append(field)
        seen.add(key)
    return out
