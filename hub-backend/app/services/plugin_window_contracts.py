"""Optional portable app-window defaults, carried by immutable plugin metadata."""
from __future__ import annotations

import math
import re
from decimal import Decimal

_DEFAULTS = {"width": "1800px", "height": "1125px", "minWidth": "480px", "minHeight": "360px"}
_FIELDS = ("width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight")


def _text(value):
    if type(value) not in (str, int, float) or (type(value) is float and not math.isfinite(value)):
        raise ValueError("appWindow 尺寸须为数字或 px/vw/vh 字符串")
    if type(value) is float and value.is_integer():
        value = int(value)
    return str(value)


def _length(value, field, fallback=None):
    if value is None or value == "":
        return fallback
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(px|vw|vh)?", _text(value).strip().lower())
    if not match:
        raise ValueError(f"appWindow.{field} 请使用数字或 px/vw/vh")
    number, unit = Decimal(match[1]), match[2] or "px"
    if not 0 < number <= (100000 if unit == "px" else 1000):
        raise ValueError(f"appWindow.{field} 超出允许范围")
    return format(number.normalize(), "f") + unit


def _threshold(value, field, fallback):
    if value is None or value == "":
        return fallback
    source = _text(value)
    if not re.fullmatch(r"\d+", source) or int(source) > 100000:
        raise ValueError(f"appWindow.{field} 须为非负整数且不超过 100000")
    return int(source)


def normalize(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("appWindow 须为对象")
    result = {field: _length(value.get(field), field, _DEFAULTS.get(field)) for field in _FIELDS}
    for axis in ("Width", "Height"):
        low, high = result["min" + axis], result["max" + axis]
        if high and low.endswith("px") and high.endswith("px") and Decimal(low[:-2]) > Decimal(high[:-2]):
            raise ValueError("appWindow 最小尺寸不能大于打开上限")
    rules = value.get("rules")
    if rules is None:
        rules = []
    if not isinstance(rules, list) or len(rules) > 12:
        raise ValueError("appWindow.rules 须为最多 12 条规则的数组")
    result["rules"] = []
    for rule in rules:
        if not isinstance(rule, dict):
            raise ValueError("appWindow.rules 每条规则须为对象")
        low = _threshold(rule.get("minScreenWidth"), "minScreenWidth", 0)
        high = _threshold(rule.get("maxScreenWidth"), "maxScreenWidth", None)
        width = _length(rule.get("width"), "rules.width")
        height = _length(rule.get("height"), "rules.height")
        if (high is not None and high < low) or not (width or height):
            raise ValueError("appWindow.rules 需填写尺寸且屏幕宽度区间不能反向")
        result["rules"].append({"minScreenWidth": low, "maxScreenWidth": high, "width": width, "height": height})
    return result


def public(value):
    try:
        return normalize(value)
    except (ValueError, TypeError):
        return None
