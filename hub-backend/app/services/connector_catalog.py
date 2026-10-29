"""Reviewed commercial connector definitions shared with the bundled MCP bridge."""
from __future__ import annotations
import json
import re
from functools import lru_cache
from pathlib import Path

COMMAND = "soduwork-connector"

@lru_cache(maxsize=1)
def templates() -> tuple[dict, ...]:
    from .skills import bundled_root
    root = Path(bundled_root()) / "mcp-tools" / "connectors" / "providers"
    rows = []
    for file in sorted(root.glob("*.json")):
        value = json.loads(file.read_text(encoding="utf-8"))
        key = value.get("id", "")
        if value.get("schemaVersion") != 1 or not re.fullmatch(r"[a-z][a-z0-9-]{1,60}", key):
            raise ValueError("内置连接器定义无效")
        fields, tools = value.get("fields", []), value.get("tools", [])
        if any(not t.get("readOnly") for t in tools) and not any(f.get("key") == "ALLOW_WRITES" for f in fields):
            fields = [*fields, {"key": "ALLOW_WRITES", "label": "允许写入操作", "type": "boolean",
                               "secret": False, "required": False, "default": "false", "pattern": "^(true|false)$"}]
        if not fields or not tools or any(not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", f.get("key", "")) for f in fields):
            raise ValueError("内置连接器字段无效")
        rows.append({
            "key": "connector-" + key, "providerId": key, "kind": "mcp",
            "name": value["name"], "description": value["description"],
            "category": value.get("category", "其他"), "source": "SoduWork 连接器",
            "trust": "reviewed", "configurable": True,
            "risk": "write" if any(not t.get("readOnly") for t in tools) else "read",
            "permissions": ["仅调用所列平台工具", "凭据只用于当前账号连接"],
            "requires": ["平台账号授权", "本机 Runner 在线"],
            "officialDocs": list(dict.fromkeys([*value.get("authDocs", []), *value.get("officialDocs", [])])),
            "limitations": value.get("limitations", []),
            "connectionFields": fields,
            "tools": [{k: t[k] for k in ("name", "description", "readOnly")} for t in tools],
            "template": {"name": value["name"], "type": "stdio", "command": COMMAND,
                         "args": [key], "env": {f["key"]: "" for f in fields},
                         "enabled": False, "description": value["description"]},
        })
    return tuple(rows)


def configurable(template: dict | None) -> bool:
    return bool(template and template.get("configurable") and
                template.get("template", {}).get("command") == COMMAND)


def configuration(template: dict, raw: dict) -> dict:
    """Only reviewed fields. Never inherit NODE_OPTIONS, PATH, or host secrets."""
    fields = {f["key"]: f for f in template.get("connectionFields", [])}
    if not isinstance(raw, dict) or set(raw) - set(fields):
        raise ValueError("连接器配置包含未声明字段")
    result = {}
    for key, field in fields.items():
        value = str(raw.get(key, field.get("default", "")))
        if len(value) > 16384 or re.search(r"[\x00-\x1f\x7f]", value):
            raise ValueError("连接器字段格式不正确：" + field["label"])
        if value and field.get("pattern") and not re.fullmatch(field["pattern"], value):
            raise ValueError("连接器字段格式不正确：" + field["label"])
        result[key] = value
    return result
