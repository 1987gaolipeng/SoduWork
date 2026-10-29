"""Shared per-locale copies of admin-authored text fields.

Entities such as automation templates keep optional ``{"en-US": "..."}`` maps
next to the base (Chinese) field. Employees resolve the map with their UI
locale and fall back to the base field; nothing is machine translated. The
client-side counterpart is ``client/core/localized_text.js``; the admin UI
editor is ``hub-frontend/src/components/LocalesEditor.jsx``.
"""
from __future__ import annotations

import re

LOCALE_TAG_RE = re.compile(r"^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})?$")
MAX_LOCALES = 8


def _clean(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def normalize_locales(value, limit: int, *, max_locales: int = MAX_LOCALES) -> dict:
    """Validate an optional per-locale copy map and return a clean copy.

    Keys are language tags as shown to administrators (``zh-CN``, ``en-US``,
    ``ja-JP``, ...); values reuse the base field's length limit. Empty
    translations are dropped so a partial map cleanly falls back to the base
    field on the client. ``zh-CN`` keys are accepted but pointless: clients
    treat zh-CN as the base field itself.
    """
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("多语言字段必须是对象，键为语言代码")
    if len(value) > max_locales:
        raise ValueError(f"多语言条目最多 {max_locales} 种")
    result = {}
    for key, translated in value.items():
        tag = _clean(key, 16)
        text = _clean(translated, limit)
        if not tag or not text:
            continue
        if not LOCALE_TAG_RE.fullmatch(tag):
            raise ValueError("多语言键必须是语言代码，例如 en-US")
        result[tag] = text
    return result
