"""Credential-free portable personal MCP configurations, never runtime exports.

Rebuild from an explicit allowlist. No network, credential lookup, process launch,
or settings mutation occurs here. Exported configurations always remain disabled.
"""
from __future__ import annotations

import ipaddress
import json
import re
from urllib.parse import unquote, urlsplit, urlunsplit

from . import capability_catalog, mcp_import, mcp_servers


class ExportError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _secrets(rows: list[dict]) -> set[str]:
    values = set()
    for row in rows:
        template = capability_catalog.mcp_template(str(row.get("templateKey") or "")) or {}
        public_env = {field["key"] for field in template.get("connectionFields", []) if not field.get("secret")}
        if row.get("command") == "soduwork-api":
            from . import connector_api
            public_env = {f["key"] for f in connector_api.definition(row.get("apiDefinition"))["fields"] if not f.get("secret")}
        for field in ("headers", "env", "keycloak"):
            entries = (row.get(field) or {}).items() if isinstance(row.get(field), dict) else ()
            for key, value in entries:
                if field == "env" and key in public_env:
                    continue
                if not isinstance(value, str) or not value:
                    continue
                values.add(value)
                if re.match(r"^(?:Bearer|Basic) ", value, re.I):
                    values.add(value.split(" ", 1)[1])
    return values


def _unsafe(value: str, secrets: set[str]) -> bool:
    text = str(value)
    for _ in range(3):
        decoded = unquote(text)
        if decoded == text:
            break
        text = decoded
    if any(secret == text or len(secret) >= 4 and secret.casefold() in text.casefold()
           for secret in secrets):
        return True
    return bool(re.search(
        r"[\x00-\x1f\x7f]|[A-Za-z]:[\\/]|\\\\|(?:file|smb)://|"
        r"/(?:Users|home|private|root|Volumes|tmp)/|"
        r"(?:sk-|pk-|ghp_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{8,}|"
        r"eyJ[A-Za-z0-9_-]{10,}\.|(?:token|password|secret|api.?key)\s*[:=/]", text, re.I))


def _credential_names(raw, secrets: set[str], env: bool = False) -> dict:
    if not isinstance(raw, dict):
        return {}
    pattern = r"[A-Za-z_][A-Za-z0-9_]{0,63}" if env else r"[A-Za-z_][A-Za-z0-9_-]{0,63}"
    if any(not isinstance(key, str) or not re.fullmatch(pattern, key) or _unsafe(key, secrets)
           for key in raw):
        raise ValueError("凭据字段名无法安全迁移，请在目标设备重新配置")
    return {key: "" for key in raw}


def _target(raw, secrets: set[str], warnings: list[str]) -> str:
    if not isinstance(raw, str) or len(raw) > 400:
        raise ValueError("连接地址无效，无法导出")
    try:
        value = urlsplit(raw.strip())
        host = value.hostname or ""
        port = value.port
    except ValueError:
        raise ValueError("连接地址无效，无法导出") from None
    if value.scheme not in ("http", "https") or not host:
        raise ValueError("连接地址无效，无法导出")
    if host.lower() == "localhost" or host.lower().endswith(".localhost"):
        raise ValueError("本机代理地址不能迁移，请在目标设备重新连接")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address and (address.is_loopback or address.is_link_local or address.is_unspecified):
        raise ValueError("本机或临时代理地址不能迁移，请在目标设备重新连接")
    # Query values are opaque: unknown provider parameter names can carry keys too.
    # Do not guess which query values are harmless or silently imply lossless export.
    if value.query or value.fragment or value.username is not None or value.password is not None:
        warnings.append("已移除地址中的登录信息、查询参数或片段；导入后需核对并补充无凭据连接地址")
    if _unsafe(host + value.path, secrets) or re.search(r"[A-Za-z0-9_-]{40,}", value.path):
        raise ValueError("连接地址可能包含密钥或本机路径，无法安全导出")
    netloc = "[" + host + "]" if ":" in host else host
    if port is not None:
        netloc += ":" + str(port)
    target = urlunsplit((value.scheme, netloc, value.path, "", ""))
    try:
        return mcp_servers._safe_http_url(target)
    except ValueError:
        raise ValueError("连接目标不允许迁移，请重新配置") from None


def _unsafe_api_definition(value, secrets):
    if isinstance(value, dict):
        return any(_unsafe_api_definition(k, secrets) or _unsafe_api_definition(v, secrets) for k, v in value.items())
    if isinstance(value, list):
        return any(_unsafe_api_definition(v, secrets) for v in value)
    if isinstance(value, str):
        # Strip only the scheme to preserve Windows drive letters; still inspect userinfo, query, and fragment fields.
        if value.startswith(("http://", "https://")):
            value = value.split("://", 1)[1]
        return _unsafe(value, secrets)
    return False


def _one(raw: dict, secrets: set[str]) -> tuple[str, dict, list[str]]:
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 60 or _unsafe(name, secrets):
        raise ValueError("连接名称无效或包含敏感内容，无法安全导出")
    if str(raw.get("id", "")).startswith("soduwork-feishu-"):
        raise ValueError("平台扫码账号不能导出，请在目标设备重新连接")
    if raw.get("keycloak") or (raw.get("oauth") and raw.get("command") != "soduwork-api") or raw.get("headersHelper"):
        raise ValueError("此连接使用专属鉴权流程，不能作为静态个人配置导出")
    try:
        mcp_servers.validate_controls(raw)
        mcp_servers.validate_size(raw)
        normal = mcp_servers._clean_one(raw)
    except (ValueError, TypeError):
        raise ValueError("连接配置或权限范围无效，请先在编辑页修正") from None
    controls = {key: normal[key] for key in (
        "startupTimeoutSeconds", "toolTimeoutSeconds", "enabledTools", "disabledTools")}
    if any(_unsafe(tool, secrets) for field in ("enabledTools", "disabledTools") for tool in controls[field]):
        raise ValueError("工具范围包含敏感内容，不能在导出时删除或扩大权限")
    warnings = []
    if normal.get("command") == "soduwork-api":
        from . import connector_api
        meta = connector_api.definition(raw.get("apiDefinition"))
        if _unsafe_api_definition(meta, secrets):
            raise ValueError("接口文档可能包含凭据或本机路径，请移除后导出")
        result = {"type": "stdio", "command": connector_api.COMMAND, "args": [],
                  "apiDefinition": meta, "env": {f["key"]: "" for f in meta["fields"]}}
        warnings.append("接口定义已保留；目标设备需重新填写凭据或登录，不迁移账号授权")
    elif normal["type"] == "http":
        result = {"type": "http", "url": _target(raw.get("url"), secrets, warnings),
                  "headers": _credential_names(raw.get("headers"), secrets)}
    else:
        template = capability_catalog.mcp_template(normal["templateKey"])
        if not template:
            raise ValueError("自定义本地命令不能导出，需使用已审核的可信模板")
        trusted = template.get("template", {})
        if any((trusted.get("env") or {}).values()):
            raise ValueError("本地模板包含环境值，需要管理员提供可迁移版本")
        result = {"type": "stdio", "command": trusted["command"],
                  "args": list(trusted.get("args") or []),
                  "env": _credential_names(trusted.get("env") or {}, secrets, env=True)}
        warnings.append("本地连接使用可信模板；目标设备仍需安装依赖并确认工作目录权限")
    return name.strip(), {**result, **controls, "enabled": False}, warnings


def personal(rows: list[dict], body: dict) -> dict:
    """Export only explicitly selected IDs already owned by the authenticated device."""
    if not isinstance(body, dict) or set(body) - {"ids", "format"}:
        raise ExportError("导出请求仅接受个人连接标识和格式")
    if body.get("format", "json") != "json":
        raise ExportError("当前支持导出 JSON 连接配置")
    ids = body.get("ids")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 20 or any(
            not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", value) for value in ids):
        raise ExportError("请选择 1–20 个个人连接导出")
    if len(set(ids)) != len(ids):
        raise ExportError("导出连接标识重复，请重新选择")
    current = [row for row in rows if isinstance(row, dict)]
    selected = []
    for id_ in ids:
        matches = [row for row in current if row.get("id") == id_]
        if len(matches) != 1:
            raise ExportError("所选个人连接不存在、已变化或不属于当前账号，请刷新后重试", 404)
        selected.append(matches[0])
    # Cross-check against every selected credential so secrets cannot leak via
    # another connection's name, URL or tool selector in the same export.
    secrets = _secrets(selected)
    servers, skipped, warnings = {}, [], []
    for row in selected:
        try:
            name, config, notices = _one(row, secrets)
            if any(existing.casefold() == name.casefold() for existing in servers):
                raise ValueError("连接名称重复，无法无损导出")
            servers[name] = config
            warnings.extend(notices)
        except ValueError as exc:
            skipped.append({"id": row["id"], "reason": str(exc)})
    if not servers:
        reasons = "；".join(dict.fromkeys(row["reason"] for row in skipped))
        raise ExportError("所选连接没有可安全导出的配置：" + reasons, 422)
    warnings.insert(0, "不包含账号凭据；导入后保持停用，请补充凭据、检查目标并测试后启用")
    content = json.dumps({"mcpServers": servers}, ensure_ascii=False, indent=2) + "\n"
    if len(content.encode("utf-8")) > mcp_import._MAX_BYTES:
        raise ExportError("导出配置超过 1MB，请减少选择的连接")
    return {"ok": True, "filename": "soduwork-connectors.json", "content": content,
            "warnings": list(dict.fromkeys(warnings)), "exported": list(servers), "skipped": skipped}


def shared_spec(raw: dict, name: str) -> dict:
    """Share only credential-free destinations; never silently rewrite an address before publishing
    it to other users.
    """
    secrets = _secrets([raw])
    if _unsafe(name, secrets):
        raise ValueError("公司连接名称可能包含敏感内容，请修改后共享")
    try:
        normal = mcp_servers.personal_spec(raw)
    except (ValueError, TypeError):
        raise ValueError("连接配置无效，请重新编辑后再共享") from None
    if str(normal.get("id") or "").startswith("soduwork-feishu-"):
        raise ValueError("平台扫码账号不能共享，请由其他用户在本机连接")
    if normal.get("command") == "soduwork-api":
        from . import connector_api
        meta = connector_api.definition(raw.get("apiDefinition"))
        if _unsafe_api_definition(meta, secrets):
            raise ValueError("接口文档可能包含凭据或本机路径，请移除后共享")
        normal["apiDefinition"] = meta
    if normal["type"] == "http":
        target = urlsplit(normal["url"])
        if target.query or target.fragment or _unsafe((target.hostname or "") + target.path, secrets) or re.search(r"[A-Za-z0-9_-]{40,}", target.path):
            raise ValueError("连接地址可能包含个人凭据或专属参数，请改用无凭据地址和鉴权头后再共享")
    if any(_unsafe(tool, secrets) for field in ("enabledTools", "disabledTools") for tool in normal[field]):
        raise ValueError("工具范围包含敏感内容，请修改后再共享")
    description = normal["description"]
    if _unsafe(description, secrets):
        description = ""
    return {**normal, "id": "", "name": name, "enabled": False, "approved": False, "approvedTarget": "",
            "description": description, "keycloak": {},
            "oauth": {},
            "headers": _credential_names(normal["headers"], secrets),
            "env": _credential_names(normal["env"], secrets, env=True)}
