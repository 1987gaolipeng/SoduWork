"""Validated optional UI contributions for immutable plugin versions."""
from __future__ import annotations

import re
from urllib.parse import urlsplit

MAX_CONTRIBUTIONS = 12
BRIDGE_CAPABILITIES = {
    "context.read", "conversation.open", "conversation.send",
    "requirements.propose", "notifications.send", "composer.control", "mcp.connect", "settings.read", "settings.write",
    "automation.create",
}
SLOTS = {
    "workspace.navigation", "conversation.sidebar", "task.detail.tab",
    "requirement.detail.tab", "approval.detail.tab", "automation.detail.tab",
}
ICONS = {
    "plugin", "globe", "task", "requirement", "shield",
    "automation", "chart", "document", "team", "link",
}
BUILTIN_ACTIONS = {
    "work.requirement.create", "work.automation.create",
}
_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z][A-Za-z0-9_.-]{0,95})\s*\}\}")
_CONTEXT = {
    "task.id", "task.projectId", "task.repoId", "task.status",
    "requirement.id", "approval.id", "automation.id", "project.id", "user.id",
}
_SECRET_QUERY = re.compile(
    r"(?:^|[?&])(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|"
    r"authorization|credential)=", re.I)


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _setup_keys(setup: dict | None) -> set[str]:
    return {str(item.get("key") or "")
            for item in dict(setup or {}).get("preferences") or []
            if isinstance(item, dict) and item.get("key")}


def _external(value: dict, setup: dict | None) -> dict:
    template = _text(value.get("url"), 1600)
    if not template or "\r" in template or "\n" in template:
        raise ValueError("插件外部界面必须填写有效地址")
    if _SECRET_QUERY.search(template):
        raise ValueError("插件界面地址不能携带账号、Token、密码或密钥")
    setup_keys = _setup_keys(setup)
    placeholders = _PLACEHOLDER.findall(template)
    unknown = [name for name in placeholders if name not in _CONTEXT
               and not (name.startswith("setup.") and name[6:] in setup_keys)]
    if unknown:
        raise ValueError("插件界面地址包含未声明变量：" + "、".join(sorted(set(unknown))))
    residue = _PLACEHOLDER.sub("", template)
    if "{{" in residue or "}}" in residue:
        raise ValueError("插件界面地址变量格式不正确")
    probe = template
    for name in placeholders:
        replacement = ("https://example.invalid"
                       if name.startswith("setup.")
                       and template.lstrip().startswith("{{" + name + "}}")
                       else "sample")
        probe = re.sub(r"\{\{\s*" + re.escape(name) + r"\s*\}\}", replacement, probe)
    parsed = urlsplit(probe)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("插件界面只支持 http 或 https 地址")
    if parsed.username or parsed.password:
        raise ValueError("插件界面地址不能内嵌账号或密码")
    mode = _text(value.get("openMode"), 20)
    bridge = _bridge(value.get("bridge"))
    return {"type": "external", "url": template,
            "openMode": mode if mode in {"workspace", "external"} else "workspace",
            **({"bridge": bridge} if bridge is not None else {})}


def _builtin(value: dict) -> dict:
    action_id = _text(value.get("actionId"), 100)
    if action_id == "work.task.create":
        action_id = "work.requirement.create"
    if action_id not in BUILTIN_ACTIONS:
        raise ValueError("插件引用了未开放的 SoduWork 内置界面")
    return {"type": "builtin", "actionId": action_id}


def _package(value: dict) -> dict:
    entry = value.get("entry")
    if (not isinstance(entry, str) or len(entry) > 240
            or not re.fullmatch(r"ui/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.html?", entry, re.I)
            or any(part.startswith('.') for part in entry.split('/'))):
        raise ValueError("包内页面入口必须是 ui 目录下的 HTML 相对路径")
    if value.get("openMode") not in (None, "workspace"):
        raise ValueError("包内页面只能由应用壳打开")
    bridge = _bridge(value.get("bridge"))
    return {"type": "package", "entry": entry, "openMode": "workspace",
            **({"bridge": bridge} if bridge is not None else {})}


def _bridge(value) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("bridge must be an object")
    unknown = set(value) - {"version", "capabilities"}
    if unknown:
        raise ValueError("bridge contains unsupported fields")
    try:
        version = int(value.get("version", 1))
    except (TypeError, ValueError) as exc:
        raise ValueError("bridge version must be an integer") from exc
    raw = value.get("capabilities")
    if not isinstance(raw, list) or len(raw) > len(BRIDGE_CAPABILITIES):
        raise ValueError("bridge capabilities must be an array with at most 9 items")
    capabilities = [_text(item, 80) for item in raw]
    if version != 1 or any(item not in BRIDGE_CAPABILITIES for item in capabilities):
        raise ValueError("bridge capability is not enabled or version is unsupported")
    return {"version": 1, "capabilities": list(dict.fromkeys(capabilities))}


def normalize(value, setup: dict | None = None) -> dict:
    """Return one stable UI contract; no UI is the default."""
    if value in (None, {}, []):
        return {"contributions": []}
    if not isinstance(value, dict):
        raise ValueError("插件 ui 必须是对象")
    raw = value.get("contributions") or []
    if not isinstance(raw, list) or len(raw) > MAX_CONTRIBUTIONS:
        raise ValueError(f"插件界面贡献必须是至多 {MAX_CONTRIBUTIONS} 项的数组")
    result, seen = [], set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"第 {index + 1} 个插件界面贡献不合法")
        key = _text(item.get("id") or f"view-{index + 1}", 64)
        title, slot = _text(item.get("title"), 80), _text(item.get("slot"), 40)
        if not _KEY.fullmatch(key) or key in seen:
            raise ValueError(f"插件界面贡献 id 不合法或重复：{key}")
        if not title:
            raise ValueError(f"插件界面贡献 {key} 缺少名称")
        if slot not in SLOTS:
            raise ValueError(f"插件界面贡献 {key} 的位置不受支持：{slot or '（空）'}")
        source = item.get("source")
        if not isinstance(source, dict):
            raise ValueError(f"插件界面贡献 {key} 缺少内容来源")
        source_type = _text(source.get("type"), 20)
        if source_type == "package" and slot != "workspace.navigation":
            raise ValueError("包内页面仅支持应用入口 workspace.navigation")
        normalized_source = (_external(source, setup) if source_type == "external"
                             else _package(source) if source_type == "package"
                             else _builtin(source) if source_type == "builtin" else None)
        if normalized_source is None:
            raise ValueError(f"插件界面贡献 {key} 只支持 external、package 或 builtin 来源")
        try:
            order = int(item.get("order") if item.get("order") is not None else 100)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"插件界面贡献 {key} 的排序必须是整数") from exc
        icon = _text(item.get("icon"), 24)
        result.append({
            "id": key, "title": title,
            "description": _text(item.get("description"), 240),
            "slot": slot, "icon": icon if icon in ICONS else "plugin",
            "order": max(-1000, min(1000, order)), "source": normalized_source,
        })
        seen.add(key)
    result.sort(key=lambda item: (item["order"], item["title"].lower(), item["id"]))
    return {"contributions": result}


def public(value, setup: dict | None = None) -> dict:
    """Legacy-safe projection for employee catalog APIs."""
    try:
        return normalize(value, setup)
    except ValueError:
        return {"contributions": []}


def has_contributions(value: dict | None) -> bool:
    """One source of truth for the product's interactive-plugin boundary."""
    return bool(dict(value or {}).get("contributions"))


def effective_entrypoints(value, ui: dict | None, *, has_workflow: bool) -> dict[str, bool]:
    """Interactive plugins are never eligible for unattended automation.

    This is derived from the immutable UI contract instead of stored as another
    mutable switch, so legacy versions and every read model follow the same rule.
    """
    raw = dict(value or {})
    return {
        "conversation": bool(raw.get("conversation", True)),
        "task": bool(raw.get("task", True)),
        "automation": bool(raw.get("automation", has_workflow))
        and not has_contributions(ui),
    }


def require_unattended(ui: dict | None) -> None:
    """Reject an interactive plugin at the final background-execution boundary."""
    if has_contributions(ui):
        raise ValueError(
            "该插件包含交互页面，只能在会话或需求等可见场景中使用，不能用于后台自动化")


def external_count(value: dict | None) -> int:
    return sum(1 for item in dict(value or {}).get("contributions") or []
               if dict(item.get("source") or {}).get("type") == "external")
