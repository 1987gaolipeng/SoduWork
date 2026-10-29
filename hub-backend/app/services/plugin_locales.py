"""Bounded presentation metadata; locale variants cannot change execution contracts."""
from __future__ import annotations

import re


def _copy(value, fields, path):
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    result = {}
    for key, item in value.items():
        if key not in fields:
            raise ValueError(f"{path}: unsupported presentation field {key}")
        rule = fields[key]
        if isinstance(rule, int):
            if not isinstance(item, str) or not item.strip() or len(item) > rule:
                raise ValueError(f"{path}.{key}: invalid text")
            result[key] = item.strip()
        else:
            result[key] = rule(item, f"{path}.{key}")
    return result


def _map(value, rule, path):
    if not isinstance(value, dict) or len(value) > 100:
        raise ValueError(f"{path}: invalid translation map")
    result = {}
    for key, item in value.items():
        if not isinstance(key, str) or not key or len(key) > 180 or key in {"__proto__", "prototype", "constructor"}:
            raise ValueError(f"{path}: invalid translation key")
        result[key] = rule(item, f"{path}.{key}")
    return result


def _option(item, path):
    if not isinstance(item, str) or not item.strip() or len(item) > 180:
        raise ValueError(f"{path}: invalid option label")
    return item.strip()


def _field(value, path):
    return _copy(value, {"label": 100, "description": 300, "placeholder": 180, "group": 60,
                         "options": lambda v, p: _map(v, _option, p)}, path)


def _fields(value, path):
    return _map(value, _field, path)


def normalize(value):
    if value is None:
        return None
    if not isinstance(value, dict) or not 1 <= len(value) <= 30:
        raise ValueError("locales must contain 1–30 languages")
    fields = {"name": 120, "description": 600, "inputs": _fields,
              "ui": lambda v, p: _map(v, lambda i, at: _copy(i, {"title": 80, "description": 240}, at), p),
              "setup": lambda v, p: _copy(v, {"title": 120, "description": 500, "preferences": _fields}, p)}
    result = {}
    for key, item in value.items():
        language = str(key).replace("_", "-").lower()
        if not re.fullmatch(r"[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}", language) or language in result:
            raise ValueError(f"locales: invalid or duplicate language {key}")
        result[language] = _copy(item, fields, "locales." + language)
    for language in ("zh", "en"):
        if not any(key.split("-")[0] == language and item.get("name") and item.get("description")
                   for key, item in result.items()):
            raise ValueError("locales requires Chinese and English name/description (zh/en)")
    return result
