"""Safe import adapter for Claude/Cowork and Codex MCP configuration files.

The preflight response never returns credential values. Import reparses the
original file, skips collisions, keeps every new server disabled, and relies on
the existing MCP editor for explicit review, probing and activation.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from urllib.parse import parse_qsl, urlsplit, urlunsplit

try:
    import tomllib
except ImportError:  # pragma: no cover - production images use Python 3.11+
    tomllib = None


_MAX_BYTES = 1024 * 1024
_MAX_SERVERS = 100
_SUPPORTED_HTTP = {"http", "streamable-http"}
_IGNORED_FIELDS = {
    "alwaysLoad", "approval_mode", "default_tools_approval_mode",
    "headersHelper", "oauth", "tools", "timeout",
}


def _mapping(value) -> dict:
    return dict(value) if isinstance(value, dict) else {}


def _strings(value, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item)[:400] for item in value[:limit]]


def _timeout(raw: dict, snake: str, camel: str, default: int,
             low: int, high: int, warnings: list[str]) -> int:
    value = raw.get(snake, raw.get(camel, default))
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        warnings.append(f"{snake} 不是整数，已使用默认值 {default} 秒")
        return default
    if not low <= parsed <= high:
        warnings.append(f"{snake} 超出范围，已限制为 {low}–{high} 秒")
    return min(high, max(low, parsed))


def _secret_names(raw: dict, kind: str) -> list[str]:
    keys = set(_mapping(raw.get("env")))
    keys.update(_mapping(raw.get("headers")))
    keys.update(_mapping(raw.get("http_headers")))
    if raw.get("bearer_token_env_var"):
        keys.add("Bearer token (environment)")
    keys.update(str(x) for x in _strings(raw.get("env_vars"), 30))
    keys.update(str(x) for x in _mapping(raw.get("env_http_headers")).values())
    return sorted(x for x in keys if x)[:40]


def _normalise(name: str, raw: dict, kind: str) -> dict:
    warnings: list[str] = []
    errors: list[str] = []
    clean_name = str(name or "").strip()[:60]
    if not clean_name:
        errors.append("缺少连接名称")
    if not isinstance(raw, dict):
        return {"name": clean_name or "未命名", "valid": False, "type": "", "target": "", "credentialKeys": [],
                "errors": ["连接配置必须是对象"], "warnings": [], "row": {}}

    # Never claim a successful import after dropping command arguments or keys.
    for field, limit in (("name", 60), ("command", 200), ("url", 400)):
        if len(str(name if field == "name" else raw.get(field) or "")) > limit:
            errors.append(field + " 超出长度上限，请先整理配置")
    for field, limit in (("args", 30), ("env", 20), ("headers", 10), ("http_headers", 10)):
        value = raw.get(field)
        if value is not None and not isinstance(value, list if field == "args" else dict):
            errors.append(field + " 格式不正确")
        elif value is not None and (len(value) > limit or any(
                len(str(v)) > (400 if field == "args" else 16384) for v in (value.values() if isinstance(value, dict) else value))):
            errors.append(field + " 超出容量，不能无损导入")
    if raw.get("env_vars") or raw.get("bearer_token_env_var") or raw.get("env_http_headers"):
        errors.append("包含宿主机环境变量引用，请先改为显式配置；不会读取或复制宿主机密钥")
    if raw.get("oauth") or raw.get("headersHelper"):
        errors.append("包含专属鉴权流程，需管理员配置，不能静默忽略")
    raw_type = str(raw.get("type") or "").strip().lower()
    if raw_type and raw_type not in ("stdio", "http", "streamable-http", "sse", "ws", "websocket"):
        errors.append("不支持该传输方式")
    from . import mcp_servers
    try:
        mcp_servers.validate_controls({
            **raw, "enabledTools": raw.get("enabled_tools", raw.get("enabledTools")),
            "disabledTools": raw.get("disabled_tools", raw.get("disabledTools"))})
    except ValueError as exc:
        errors.append(str(exc))
    url = str(raw.get("url") or "").strip()
    command = str(raw.get("command") or "").strip()
    parsed_url = urlsplit("")
    parsed_port = None
    if raw_type in ("sse", "websocket", "ws"):
        errors.append("当前仅支持 stdio 和 Streamable HTTP；该旧传输方式需先迁移")
    type_ = "http" if url or raw_type in _SUPPORTED_HTTP else "stdio"
    if type_ == "http" and not url:
        errors.append("HTTP 连接缺少 url")
    if type_ == "http" and url:
        try:
            parsed_url = urlsplit(url)
            parsed_port = parsed_url.port
        except ValueError:
            parsed_url = urlsplit("")
            parsed_port = None
            errors.append("HTTP 地址格式无效")
        if parsed_url.scheme not in ("http", "https") or not parsed_url.hostname:
            errors.append("HTTP 连接必须使用完整的 http/https 地址")
        if parsed_url.username or parsed_url.password:
            errors.append("URL 不能内嵌账号或密码，请改用只写请求头")
        sensitive = {"access_token", "api_key", "apikey", "key", "password",
                     "secret", "signature", "token"}
        if any(key.casefold() in sensitive for key, _value in parse_qsl(
                parsed_url.query, keep_blank_values=True)):
            errors.append("URL 查询参数疑似包含凭据，请改用只写请求头")
    if type_ == "stdio" and not command:
        errors.append("stdio 连接缺少 command")

    env = {str(k)[:64]: str(v)[:16384]
           for k, v in list(_mapping(raw.get("env")).items())[:20]}
    headers_source = _mapping(raw.get("headers")) or _mapping(raw.get("http_headers"))
    headers = {str(k)[:64]: str(v)[:16384]
               for k, v in list(headers_source.items())[:10]}
    if len(_mapping(raw.get("env"))) > 20:
        warnings.append("环境变量超过 20 项，仅导入前 20 项")
    if len(headers_source) > 10:
        warnings.append("请求头超过 10 项，仅导入前 10 项")
    if raw.get("env_vars"):
        warnings.append("Codex env_vars 只声明变量名，SoduWork 不读取宿主机隐式密钥；请在编辑页补值")
    if raw.get("bearer_token_env_var") or raw.get("env_http_headers"):
        warnings.append("环境变量引用的 HTTP 凭据未复制；请在编辑页安全补录")

    enabled_tools = _strings(
        raw.get("enabled_tools", raw.get("enabledTools")), 200)
    disabled_tools = _strings(
        raw.get("disabled_tools", raw.get("disabledTools")), 200)
    overlap = set(enabled_tools) & set(disabled_tools)
    if overlap:
        errors.append(
            "同一个工具不能同时启用和禁用：" +
            "、".join(sorted(overlap)[:10]))
    startup_timeout = _timeout(
        raw, "startup_timeout_sec", "startupTimeoutSeconds",
        10, 3, 120, warnings)
    tool_timeout = _timeout(
        raw, "tool_timeout_sec", "toolTimeoutSeconds",
        60, 3, 300, warnings)

    unsupported = sorted(key for key in _IGNORED_FIELDS if key in raw)
    if unsupported:
        warnings.append("未导入底座专属策略：" + "、".join(unsupported))
    known = {"apiDefinition",
        "args", "bearer_token_env_var", "command", "description", "enabled",
        "env", "env_http_headers", "env_vars", "headers", "http_headers",
        "type", "url", "startup_timeout_sec", "tool_timeout_sec",
        "startupTimeoutSeconds", "toolTimeoutSeconds",
        "enabled_tools", "disabled_tools", "enabledTools", "disabledTools",
        *_IGNORED_FIELDS,
    }
    unknown = sorted(str(key) for key in raw if key not in known)
    if unknown:
        warnings.append("忽略未识别字段：" + "、".join(unknown[:12]))

    if type_ == "http":
        safe_host = parsed_url.hostname or ""
        if parsed_port:
            safe_host += ":" + str(parsed_port)
        target = urlunsplit((parsed_url.scheme, safe_host, parsed_url.path, "", ""))
    else:
        args_count = len(_strings(raw.get("args"), 30))
        safe_command = command.replace(chr(92), '/').rsplit('/', 1)[-1]
        target = safe_command + (' · %d 个参数' % args_count if args_count else '')
    row = {
        "id": str(uuid.uuid4()), "name": clean_name, "type": type_,
        "command": command[:200] if type_ == "stdio" else "",
        "args": _strings(raw.get("args"), 30) if type_ == "stdio" else [],
        "env": env if type_ == "stdio" else {},
        "url": url[:400] if type_ == "http" else "",
        "headers": headers if type_ == "http" else {},
        "description": str(raw.get("description") or "")[:200],
        "startupTimeoutSeconds": startup_timeout,
        "toolTimeoutSeconds": tool_timeout,
        "enabledTools": enabled_tools,
        "disabledTools": disabled_tools,
        # Import is discovery, never authorization.
        "enabled": False,
    }
    if command == "soduwork-api":
        from . import connector_api
        try:
            row = connector_api.spec({**row, "apiDefinition": raw.get("apiDefinition")})
            target = row["apiDefinition"]["baseUrl"]
        except ValueError as exc:
            errors.append(str(exc))
    return {
        "name": clean_name or "未命名", "type": type_, "target": target[:220],
        "credentialKeys": _secret_names(raw, kind), "warnings": warnings,
        "errors": errors, "valid": not errors, "row": row,
    }


def parse(data: bytes, filename: str = "") -> dict:
    if not data or len(data) > _MAX_BYTES:
        raise ValueError("MCP 配置为空或超过 1MB")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("MCP 配置必须是 UTF-8 文本") from exc

    lower = str(filename or "").lower()
    try:
        if lower.endswith(".toml"):
            if tomllib is None:
                raise ValueError("当前服务端 Python 版本不支持 TOML")
            document = tomllib.loads(text)
            source = "Codex config.toml"
            servers = document.get("mcp_servers")
            kind = "codex"
        elif lower.endswith((".yaml", ".yml")):
            from .connector_api import yaml_document
            document = yaml_document(text)
            source, kind, servers = "OpenAPI YAML", "api", None
        else:
            document = json.loads(text)
            source = "Claude / Cowork .mcp.json"
            servers = document.get("mcpServers") if isinstance(document, dict) else None
            if servers is None and isinstance(document, dict):
                servers = document.get("mcp_servers")
            if servers is None and isinstance(document, dict):
                servers = document.get("servers")
            kind = "claude"
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        if isinstance(exc, ValueError) and str(exc).startswith("当前服务端"):
            raise
        raise ValueError("MCP 配置文件无法解析，请检查 JSON / YAML / TOML 语法") from exc
    if isinstance(document, dict) and ("openapi" in document or "endpoints" in document or "openapiDocument" in document):
        from . import connector_api
        compiled = connector_api.imported(document)
        servers = {compiled["apiDefinition"]["name"]: compiled}
        source, kind = "OpenAPI / 接口清单", "api"
    if not isinstance(servers, dict):
        key = "mcp_servers" if kind == "codex" else "mcpServers"
        raise ValueError("配置中找不到 %s 服务器清单" % key)
    if not servers:
        raise ValueError("配置中没有 MCP 服务器")
    if len(servers) > _MAX_SERVERS:
        raise ValueError("一次最多导入 100 个 MCP 服务器")

    items = [_normalise(str(name), value, kind) for name, value in servers.items()]
    seen: set[str] = set()
    for item in items:
        key = item["name"].casefold()
        if key in seen:
            item["valid"] = False
            item["errors"].append("配置文件内名称重复")
        seen.add(key)
    return {
        "filename": str(filename or "")[:180], "source": source, "kind": kind,
        "checksum": hashlib.sha256(data).hexdigest(), "items": items,
    }


def public_preview(parsed: dict, existing_names=()) -> dict:
    existing = {str(name).casefold() for name in existing_names}
    rows = []
    for item in parsed["items"]:
        duplicate = item["name"].casefold() in existing
        rows.append({key: item[key] for key in (
            "name", "type", "target", "credentialKeys", "warnings", "errors", "valid")})
        # This is discovery, not the post-import editor response. Arguments can
        # contain opaque credentials and invalid URLs can contain userinfo or
        # secret query values. Never echo either in this public projection.
        # Import still reparses the original upload without changing its values.
        source = item.get("row") if isinstance(item.get("row"), dict) else {}
        rows[-1]["config"] = {
            "url": item["target"] if item["type"] == "http" else "",
            "command": str(source.get("command", "")).replace(chr(92), "/").rsplit("/", 1)[-1],
            "args": [],
            "description": source.get("description", ""),
            "startupTimeoutSeconds": source.get("startupTimeoutSeconds", 10),
            "toolTimeoutSeconds": source.get("toolTimeoutSeconds", 60),
            "enabledTools": list(source.get("enabledTools") or []),
            "disabledTools": list(source.get("disabledTools") or []),
            "credentialKeys": list(item.get("credentialKeys") or []),
            "headerKeys": sorted(str(k) for k in (source.get("headers") or {})),
            "envKeys": sorted(str(k) for k in (source.get("env") or {})),
        }
        rows[-1]["duplicate"] = duplicate
        rows[-1]["importable"] = bool(item["valid"] and not duplicate)
    return {
        "ok": True, "filename": parsed["filename"], "source": parsed["source"],
        "checksum": parsed["checksum"], "servers": rows,
        "summary": {
            "total": len(rows), "importable": sum(x["importable"] for x in rows),
            "duplicates": sum(x["duplicate"] for x in rows),
            "invalid": sum(not x["valid"] for x in rows),
            "withCredentials": sum(bool(x["credentialKeys"]) for x in rows),
        },
    }


def import_rows(parsed: dict, existing_rows: list[dict], max_total: int = 200) -> dict:
    names = {str(item.get("name") or "").casefold() for item in existing_rows}
    imported: list[dict] = []
    skipped: list[dict] = []
    for item in parsed["items"]:
        duplicate = item["name"].casefold() in names
        if not item["valid"] or duplicate:
            skipped.append({"name": item["name"],
                            "reason": "同名连接已存在" if duplicate else "配置不受支持"})
            continue
        if len(existing_rows) + len(imported) >= max_total:
            skipped.append({"name": item["name"], "reason": "公司能力库已达到容量上限"})
            continue
        imported.append(item["row"])
        names.add(item["name"].casefold())
    return {"rows": [*existing_rows, *imported], "imported": imported, "skipped": skipped}
