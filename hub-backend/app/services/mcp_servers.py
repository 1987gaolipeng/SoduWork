"""MCP server registry with administrator settings stored in app_setting and enabled runtime
configuration outside the repository. Pass its path through SODUWORK_MCP_SERVERS so credentials
cannot enter Git. Keep repository configuration as an empty example and expose immediate
connection probes.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import uuid
import ipaddress
from urllib.parse import urlsplit, parse_qsl

from .local_base import _data_root

log = logging.getLogger("uvicorn.error")

SETTING_KEY = "mcp_servers"
_MAX = 200
_PERSONAL_MAX = 20
_MASK = "••••"
_TOOL_MAX = 200
_STARTUP_TIMEOUT = 10
_TOOL_TIMEOUT = 60


def _names(value) -> list[str]:
    """Normalize a bounded tool selector without accepting wildcard grants."""
    if isinstance(value, str):
        value = re.split(r"[\r\n,]+", value)
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for raw in value:
        name = str(raw or "").strip()[:200]
        if name and name != "*" and name not in out:
            out.append(name)
        if len(out) >= _TOOL_MAX:
            break
    return out


def _seconds(value, default: int, low: int, high: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return min(high, max(low, parsed))


def validate_controls(raw: dict) -> None:
    """Reject ambiguous policy instead of silently widening or rewriting it."""
    for key, default, low, high, label in (
        ("startupTimeoutSeconds", _STARTUP_TIMEOUT, 3, 120, "启动超时"),
        ("toolTimeoutSeconds", _TOOL_TIMEOUT, 3, 300, "工具调用超时"),
    ):
        if key not in raw:
            continue
        try:
            value = int(raw.get(key))
        except (TypeError, ValueError) as exc:
            raise ValueError(label + "必须是整数秒") from exc
        if not low <= value <= high:
            raise ValueError(f"{label}必须在 {low} 到 {high} 秒之间")
    for key, label in (
        ("enabledTools", "启用工具清单"),
        ("disabledTools", "禁用工具清单"),
    ):
        value = raw.get(key)
        if value is not None and not isinstance(value, (list, str)):
            raise ValueError(label + "必须是工具名数组")
        raw_names = re.split(r"[\r\n,]+", value) if isinstance(value, str) else list(value or [])
        if len(raw_names) > _TOOL_MAX or any(len(str(name)) > 200 for name in raw_names):
            raise ValueError(label + " 超出容量，不能截断权限策略")
        if any("*" in str(item) for item in raw_names):
            raise ValueError(label + "不能使用通配符，请明确列出工具")
    overlap = set(_names(raw.get("enabledTools"))) & set(
        _names(raw.get("disabledTools")))
    if overlap:
        raise ValueError(
            "同一个工具不能同时启用和禁用：" +
            "、".join(sorted(overlap)[:10]))


def validate_size(raw: dict) -> None:
    """Reject lossy truncation at the write boundary; credential values stay opaque."""
    for field, limit in (("name", 60), ("command", 200), ("url", 400)):
        if len(str(raw.get(field) or "")) > limit:
            raise ValueError(field + " 超出长度上限")
    for field, count, size in (("args", 30, 400), ("env", 20, 16384), ("headers", 10, 16384)):
        value = raw.get(field)
        expected = list if field == "args" else dict
        if value is not None and not isinstance(value, expected):
            raise ValueError(field + " 格式不正确")
        if value is not None:
            entries = value.values() if isinstance(value, dict) else value
            if len(value) > count or any(len(str(v)) > size for v in entries):
                raise ValueError(field + " 超出容量，不能无损保存")
            if isinstance(value, dict) and any(len(str(k)) > 64 for k in value):
                raise ValueError(field + " 字段名称过长")
    if raw.get("oauth") and not isinstance(raw["oauth"], dict):
        raise ValueError("连接授权引用格式不正确")
    if raw.get("type") not in (None, "", "http", "stdio"):
        raise ValueError("只支持 stdio 和 Streamable HTTP")

def runtime_path() -> str:
    """Return the out-of-repository runtime configuration path used by SODUWORK_MCP_SERVERS."""
    return os.path.join(_data_root(), "mcp", "servers.json")


def _clean_one(d: dict) -> dict:
    env = d.get("env") if isinstance(d.get("env"), dict) else {}
    headers = d.get("headers") if isinstance(d.get("headers"), dict) else {}
    kc = d.get("keycloak") if isinstance(d.get("keycloak"), dict) else {}
    type_ = str(d.get("type") or "stdio").strip().lower()
    return {
        "id": str(d.get("id") or uuid.uuid4())[:36],
        **({"apiDefinition": d["apiDefinition"]} if isinstance(d.get("apiDefinition"), dict) else {}),
        **({"oauth": dict(d["oauth"])} if isinstance(d.get("oauth"), dict) and d["oauth"] else {}),
        "name": str(d.get("name") or "").strip()[:60],
        "templateKey": str(d.get("templateKey") or "").strip()[:80],
        # stdio starts command and args through the mcp.mjs bridge; http calls Streamable HTTP directly
        # with static authentication headers and optional dynamic Keycloak bearer authentication.
        "type": type_ if type_ in ("stdio", "http") else "stdio",
        "command": str(d.get("command") or "").strip()[:200],
        "args": [str(x)[:400] for x in (d.get("args") or [])][:30],
        "env": {str(k)[:64]: str(v)[:16384] for k, v in list(env.items())[:20]},
        "url": str(d.get("url") or "").strip()[:400],
        "headers": {str(k)[:64]: str(v)[:16384] for k, v in list(headers.items())[:10]},
        "keycloak": {k: str(kc.get(k) or "")[:400]
                     for k in ("tokenUrl", "clientId", "clientSecret",
                               "username", "password", "scope") if kc.get(k)},
        "description": str(d.get("description") or "").strip()[:200],
        "enabled": bool(d.get("enabled", True)),
        # OpenAI/Codex-compatible connection controls.  An empty enabled list
        # means "all discovered tools"; disabled tools always win.
        "startupTimeoutSeconds": _seconds(
            d.get("startupTimeoutSeconds"), _STARTUP_TIMEOUT, 3, 120),
        "toolTimeoutSeconds": _seconds(
            d.get("toolTimeoutSeconds"), _TOOL_TIMEOUT, 3, 300),
        "enabledTools": _names(d.get("enabledTools")),
        "disabledTools": _names(d.get("disabledTools")),
        "approved": bool(d.get("approved", False)),
        "approvedTarget": str(d.get("approvedTarget") or "").strip()[:400],
    }


def tool_allowed(spec: dict, name: str) -> bool:
    """Apply connection policy.  Deny lists have final precedence."""
    tool = str(name or "")
    enabled = set(_names(spec.get("enabledTools")))
    disabled = set(_names(spec.get("disabledTools")))
    return (not enabled or tool in enabled) and tool not in disabled


def tool_policy_result(names: list[str], spec: dict) -> dict:
    discovered = list(dict.fromkeys(str(name or "").strip()[:200]
                                     for name in names if str(name or "").strip()))[:_TOOL_MAX]
    enabled = set(_names(spec.get("enabledTools")))
    selected = [name for name in discovered if tool_allowed(spec, name)]
    return {
        "tools": selected,
        "discoveredTools": discovered,
        "blockedTools": [name for name in discovered if name not in selected],
        "missingEnabledTools": sorted(enabled - set(discovered)),
    }


def _usable(r: dict) -> bool:
    """Check required transport fields: command for stdio, URL for HTTP."""
    if r.get("type") == "http":
        return bool(str(r.get("url") or "").strip())
    return bool(str(r.get("command") or "").strip())


def mask(r: dict) -> dict:
    """Return a write-only credential view safe for browser/client APIs."""
    kc = dict(r.get("keycloak") or {})
    for key in ("clientSecret", "password"):
        if kc.get(key):
            kc[key] = _MASK
    from .capability_catalog import mcp_template
    template = mcp_template(str(r.get("templateKey") or "")) or {}
    public_fields = {f["key"] for f in template.get("connectionFields", []) if not f.get("secret")}
    if r.get("command") == "soduwork-api":
        from . import connector_api
        meta = connector_api.definition(r.get("apiDefinition"))
        public_fields = {f["key"] for f in meta["fields"] if not f.get("secret")}
    return {
        **r,
        "env": {key: value if key in public_fields else (_MASK if value else "")
                for key, value in (r.get("env") or {}).items()},
        "headers": {key: _MASK if value else "" for key, value in (r.get("headers") or {}).items()},
        "keycloak": kc,
    }


def restore(r: dict, previous: dict) -> dict:
    """Keep old write-only values when a masked form is saved unchanged."""
    def merge(current: dict, old: dict) -> dict:
        return {key: (old.get(key, "") if str(value) == _MASK else value)
                for key, value in (current or {}).items()}

    out = dict(r)
    out["env"] = merge(r.get("env") if isinstance(r.get("env"), dict) else {},
                       previous.get("env") or {})
    out["headers"] = merge(r.get("headers") if isinstance(r.get("headers"), dict) else {},
                           previous.get("headers") or {})
    keycloak = dict(r.get("keycloak") or {})
    old_keycloak = dict(previous.get("keycloak") or {})
    for key in ("clientSecret", "password"):
        if str(keycloak.get(key) or "") == _MASK:
            keycloak[key] = old_keycloak.get(key, "")
    out["keycloak"] = keycloak
    return out


def personal_load(client) -> list[dict]:
    out = []
    for item in (getattr(client, "mcp_servers", None) or []):
        if not isinstance(item, dict):
            continue
        try:
            out.append(personal_spec(item))
        except ValueError:
            continue
    return out


def _safe_http_url(value: str) -> str:
    url = str(value or "").strip()
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("个人 HTTP MCP 必须填写完整的 http/https 地址")
    if parsed.username or parsed.password:
        raise ValueError("不要把账号密码写进 URL，请使用鉴权头")
    if parsed.fragment or any(key.casefold() in (
            "access_token", "api_key", "apikey", "key", "password", "secret", "signature", "token")
            for key, _ in parse_qsl(parsed.query, keep_blank_values=True)):
        raise ValueError("URL 不允许片段或凭据参数，请使用只写鉴权头")
    host = parsed.hostname.lower()
    if host in ("169.254.169.254", "metadata.google.internal", "100.100.100.200"):
        raise ValueError("不能连接云主机元数据地址")
    try:
        address = ipaddress.ip_address(host)
        if address.is_link_local or address.is_multicast or address.is_unspecified:
            raise ValueError("不能连接链路本地、组播或未指定地址")
    except ValueError as exc:
        if "不能连接" in str(exc):
            raise
    return url


def personal_spec(raw: dict) -> dict:
    """Validate a personal MCP without creating an arbitrary-command boundary."""
    validate_controls(raw)
    validate_size(raw)
    item = _clean_one(raw)
    from . import connector_api
    if connector_api.handles(item):
        item = connector_api.spec(item, approved=True)
        if item.get("oauth"):
            binding = item["oauth"]
            if set(binding) != {"provider", "connectionId"} or binding.get("provider") != "api" or not isinstance(binding.get("connectionId"), str):
                raise ValueError("接口授权引用无效")
            schemes = [s for s in item["apiDefinition"]["securitySchemes"].values() if s.get("flow") == "authorizationCode"]
            if len(schemes) != 1:
                raise ValueError("接口授权方式不匹配")
            item["env"][schemes[0]["tokenKey"]] = ""
        return item
    if item.get("oauth"):
        from .connector_oauth_registry import definition
        binding = item["oauth"]
        if set(binding) != {"provider", "connectionId"} or not all(isinstance(v, str) for v in binding.values()):
            raise ValueError("连接授权引用无效")
        definition(binding["provider"])
    if item["type"] == "stdio":
        from . import capability_catalog, connector_catalog
        catalog = capability_catalog.mcp_template(item.get("templateKey", ""))
        if catalog is None:
            raise ValueError("个人本地 MCP 只能从可信目录选择；自定义命令请交管理员发布")
        target = item.get("templateKey", "")
        if not item.get("approved") or item.get("approvedTarget") != target:
            raise ValueError("请确认将启用可信目录中的「%s」" % catalog["name"])
        template = _clean_one(catalog["template"])
        item.update({
            "command": template["command"], "args": template["args"],
            "env": (connector_catalog.configuration(catalog, item["env"])
                    if connector_catalog.configurable(catalog) else template["env"]),
            "url": "", "headers": {}, "keycloak": {},
            "description": item.get("description") or template["description"],
        })
    else:
        item["url"] = _safe_http_url(item["url"])
        target = item["url"]
        if not item.get("approved") or item.get("approvedTarget") != target:
            raise ValueError("请确认将连接到 " + target)
        item["command"], item["args"], item["env"] = "", [], {}
        # Personal HTTP connections use explicit static headers only. Dynamic
        # identity flows are company integrations and require admin review.
        item["keycloak"] = {}
    if item.get("oauth"):
        from .connector_oauth_registry import definition
        meta = definition(item["oauth"]["provider"])
        if item["command"] != "soduwork-connector" or item["args"] != [item["oauth"]["provider"]]:
            raise ValueError("授权与连接器不匹配")
        item["env"].update({meta["tokenField"]: "", "ALLOW_WRITES": "false"})
    return item


def is_builtin(item: dict) -> bool:
    from .capability_catalog import mcp_template
    template = mcp_template(str(item.get("templateKey") or "").strip())
    return str(item.get("type") or "stdio").strip().lower() == "stdio" and bool(template) and not template.get("configurable")


def protect_builtin(previous: list[dict], following: list[dict]) -> None:
    """Derived from trusted template identity, never from a client-supplied flag."""
    by_id = {item["id"]: item for item in following}
    for old in previous:
        if not is_builtin(old):
            continue
        new = by_id.get(old["id"])
        if new is None or any(new.get(key) != value for key, value in old.items() if key != "enabled"):
            raise ValueError("SoduWork 内置 MCP 只能启用或停用，不能删除或修改")


async def personal_save(session, client, rows: list[dict]) -> list[dict]:
    """Save one device's MCP connections without allowing org-name shadowing."""
    org_names = {item["name"].casefold() for item in await load(session)}
    if len(rows or []) > _PERSONAL_MAX:
        raise ValueError("个人连接最多 20 个，不会截断已有配置")
    clean = [personal_spec(item) for item in (rows or [])
             if str(item.get("name") or "").strip()]
    from . import connector_oauth
    for item in clean:
        await connector_oauth.validate_binding(session, client, item)
    protect_builtin(personal_load(client), clean)
    names = [item["name"].casefold() for item in clean]
    duplicate = next((name for name in names if names.count(name) > 1), "")
    existing = {r["id"]: r["name"] for r in personal_load(client)}
    collision = next((r["name"] for r in clean if r["name"].casefold() in org_names
                      and existing.get(r["id"]) != r["name"]), "")
    if len({r["id"] for r in clean}) != len(clean):
        raise ValueError("连接标识重复，请刷新后重试")
    if duplicate:
        raise ValueError("个人 MCP 名称不能重复：" + duplicate)
    if collision:
        raise ValueError("公司能力库已经有同名 MCP，请直接使用公司发布的「%s」" % collision)
    await connector_oauth.release_removed(session, list(client.mcp_servers or []), clean)
    client.mcp_servers = clean
    return clean


async def client_view(session, client) -> dict:
    org = [item for item in await load(session) if item.get("enabled") and _usable(item)]
    selected = {str(name) for name in (getattr(client, "mcp_enabled", None) or [])}
    personal = personal_load(client)
    return {
        "company": [{**mask(item), "selected": item["name"] in selected,
                     "builtIn": is_builtin(item), "canDelete": False, "canEdit": False}
                    for item in org],
        "personal": [{**mask(item), "builtIn": is_builtin(item),
                      "canDelete": not is_builtin(item), "canEdit": not is_builtin(item)} for item in personal],
        "enabledCompany": sorted(selected & {item["name"] for item in org}),
    }


def _expand(value: str, variables: dict[str, str]) -> str:
    out = str(value or "")
    for key in ("SODUWORK_WORK_ROOT", "SODUWORK_WORK_DIR"):
        out = out.replace("$" + "{" + key + "}", str(variables.get(key) or ""))
    return out


def expand_rows(rows: list[dict], variables: dict | None = None) -> list[dict]:
    """Expand only two documented workspace placeholders; never evaluate code."""
    values = {str(key): str(value or "") for key, value in (variables or {}).items()}
    out = []
    for raw in rows:
        item = dict(raw)
        if item.get("command") == "soduwork-api":
            out.append(item)
            continue
        item["command"] = _expand(item.get("command", ""), values)
        item["args"] = [_expand(value, values) for value in (item.get("args") or [])]
        item["url"] = _expand(item.get("url", ""), values)
        item["env"] = {key: _expand(value, values)
                       for key, value in (item.get("env") or {}).items()}
        out.append(item)
    return out


async def load(session) -> list[dict]:
    from .. import models
    row = await session.get(models.AppSetting, SETTING_KEY)
    if row is None or not (row.value or "").strip():
        return []
    try:
        return [_clean_one(x) for x in json.loads(row.value) if isinstance(x, dict)]
    except Exception:                       # noqa: BLE001 - Invalid stored configuration must not fail dispatch.
        return []


async def save(session, rows: list[dict]) -> list[dict]:
    from .. import models
    clean = []
    for raw in (rows or [])[:_MAX]:
        if not str(raw.get("name") or "").strip():
            continue
        validate_controls(raw)
        validate_size(raw)
        if raw.get("oauth"):
            raise ValueError("个人账号授权不能发布为公司共享连接")
        if raw.get("type") == "http":
            _safe_http_url(raw.get("url", ""))
        from . import connector_api
        if connector_api.handles(raw):
            raw = connector_api.spec(raw)
        clean.append(_clean_one(raw))
    if len(rows or []) > _MAX:
        raise ValueError("公司连接最多 200 个，不会截断已有配置")
    names = [r["name"].casefold() for r in clean]
    if len(names) != len(set(names)) or len({r["id"] for r in clean}) != len(clean):
        raise ValueError("MCP 名称或标识重复")
    from sqlalchemy import update
    from sqlalchemy.exc import IntegrityError
    row = await session.get(models.AppSetting, SETTING_KEY)
    encoded = json.dumps(clean, ensure_ascii=False)
    if row is None:
        session.add(models.AppSetting(key=SETTING_KEY, value=encoded))
        try:
            await session.flush()
        except IntegrityError as exc:
            await session.rollback()
            raise ValueError("连接目录刚被更新，请刷新后重试") from exc
    else:
        changed = await session.execute(update(models.AppSetting).where(
            models.AppSetting.key == SETTING_KEY, models.AppSetting.value == row.value
        ).values(value=encoded).execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            raise ValueError("连接目录刚被更新，请刷新后重试")
        session.expire(row)
    # Dispatch materializes committed policy; never write credentials before commit.
    return clean


def _write_runtime(rows: list[dict], path: str = "") -> str:
    """Write only enabled servers to runtime configuration outside the repository so disabled
    connections cannot still be invoked.
    """
    p = path or runtime_path()
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        data = runtime_payload(rows)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    except Exception as e:                  # noqa: BLE001 - Record runtime-file failures without failing configuration persistence.
        log.warning("MCP 运行时配置写不出去（%s）：%s", p, type(e).__name__)
    return p


def runtime_payload(rows: list[dict]) -> dict:
    """Build per-dispatch MCP configuration without database-only fields. Resolve dynamic bearer
    authentication at dispatch time and send supported transport shapes to each runtime without
    persisting another credential file on the Runner.
    """
    servers: dict = {}
    for r in rows:
        if not (r.get("enabled") and _usable(r)):
            continue
        controls = {
            "startupTimeoutSeconds": _seconds(
                r.get("startupTimeoutSeconds"), _STARTUP_TIMEOUT, 3, 120),
            "toolTimeoutSeconds": _seconds(
                r.get("toolTimeoutSeconds"), _TOOL_TIMEOUT, 3, 300),
            "enabledTools": _names(r.get("enabledTools")),
            "disabledTools": _names(r.get("disabledTools")),
        }
        if r.get("type") == "http":
            headers = dict(r.get("headers") or {})
            kc = r.get("keycloak") or {}
            if kc.get("tokenUrl"):
                try:
                    from . import mcp_http
                    headers["Authorization"] = "Bearer " + mcp_http.keycloak_token(kc)
                except Exception as e:  # noqa: BLE001 - Omit unresolved authentication and let the server reject unauthorized access.
                    log.warning("MCP %s 的 Keycloak 令牌没换到:%s",
                                r.get("name"), type(e).__name__)
            servers[r["name"]] = {"type": "http", "url": r["url"],
                                  "headers": headers,
                                  "description": r.get("description", ""),
                                  **controls}
        else:
            servers[r["name"]] = {
                **{k: r[k] for k in ("command", "args", "env", "description")},
                **({"apiDefinition": r["apiDefinition"]} if r.get("apiDefinition") else {}),
                **controls,
            }
    return {"servers": servers}


async def probe_requirements(session, names: list[str] | None,
                             client=None, timeout: int = 25) -> dict:
    """Really test every MCP required by an installation.

    HTTP connectors run on Hub. A stdio connector is machine-local, so an
    employee installation is tested only on that employee's client Runner.
    Returning one bounded result per connection keeps the setup UI actionable
    without exposing URLs, headers, environment variables or credentials.
    """
    wanted = list(dict.fromkeys(
        str(name or "").strip() for name in (names or [])
        if str(name or "").strip()))[:20]
    rows = {
        item["name"]: item for item in await load(session)
        if item.get("enabled") and _usable(item)}
    missing = [name for name in wanted if name not in rows]
    if missing:
        return {
            "ok": False,
            "missing": missing,
            "connections": [{
                "name": name, "ok": False,
                "error": "企业尚未配置或启用该连接",
            } for name in missing],
        }
    preferred = None
    if client is not None:
        from . import runner_hub
        preferred = runner_hub.for_client(str(getattr(client, "id", "") or ""))

    from . import connector_health

    async def check(name: str) -> dict:
        spec = rows[name]
        if spec.get("type") == "stdio" and client is not None and preferred is None:
            return {
                "name": name, "ok": False, "runOn": "runner",
                "error": "请先启动当前电脑上的 Runner，再测试这个本地连接",
                **connector_health.result("offline"),
            }
        result = await probe_managed(
            spec, timeout=timeout,
            preferred_runner=(preferred if spec.get("type") == "stdio" else None))
        return {
            "name": name,
            **connector_health.metadata(result),
            "ok": bool(result.get("ok")),
            "runOn": str(result.get("runOn") or ""),
            "target": str(
                result.get("runnerHost") or result.get("target") or "")[:120],
            "toolCount": len(result.get("tools") or []),
            "tools": [
                str(tool)[:200] for tool in (result.get("tools") or [])[:20]],
            **({"error": str(result.get("error") or "连接测试失败")[:600]}
               if not result.get("ok") else {}),
        }

    ordered = list(wanted)
    results = await asyncio.gather(*(check(name) for name in ordered),
                                   return_exceptions=True)
    connections = []
    for name, result in zip(ordered, results):
        if isinstance(result, BaseException):
            # Record connection-specific probe exceptions as failures without failing the entire connection test.
            log.warning("连接测试 %s 失败: %s", name, type(result).__name__)
            connections.append({"name": name, "ok": False,
                                "error": str(result)[:600] or type(result).__name__})
        else:
            connections.append(result)
    return {
        "ok": all(item.get("ok") for item in connections),
        "missing": [],
        "connections": connections,
    }


async def readiness(session, names: list[str] | None = None) -> dict:
    """Read-only dependency check for plugin preflight; never writes runtime files."""
    wanted = {str(name).strip() for name in (names or []) if str(name).strip()}
    from .plugin_builtin import is_virtual_mcp
    rows = await load(session)
    enabled = {str(item.get("name") or "") for item in rows
               if item.get("enabled") and _usable(item)}
    # SoduWork-owned capabilities are available through the signed plugin gateway
    # and intentionally do not appear in the administrator connector registry.
    virtual = {name for name in wanted if is_virtual_mcp(name)}
    missing = sorted(wanted - enabled - virtual)
    return {
        "ok": not missing,
        "required": sorted(wanted),
        "available": sorted((wanted & enabled) | virtual),
        "missing": missing,
    }


async def runtime_for_dispatch(session, names: list[str] | None = None,
                               scope: str = "", client=None,
                               variables: dict | None = None,
                               materialize: bool = True) -> tuple[str, dict]:
    """Return only MCP servers declared by the plugin's names allowlist in both local files and
    remote payloads. Organization configuration does not grant every plugin every credential.
    """
    rows = await load(session)
    if client is not None:
        selected_names = {str(name) for name in (getattr(client, "mcp_enabled", None) or [])}
        rows = [item for item in rows if item.get("name") in selected_names]
        # An opted-in company integration must never be shadowed by a private
        # connector with the same name on another device.
        company_keys = {r["name"].casefold() for r in rows}
        rows = rows + [r for r in personal_load(client) if r["name"].casefold() not in company_keys]
    rows = expand_rows(rows, variables)
    enabled = {x["name"]: x for x in rows if x.get("enabled") and _usable(x)}
    if names is None:
        selected = list(enabled.values())
        if client is None and materialize:
            path = runtime_path()
        else:
            # Personal credentials stay in the per-dispatch JSON environment;
            # do not create another plaintext credential file on the Hub.
            path = ""
    else:
        wanted = {str(x) for x in names if str(x)}
        missing = wanted - set(enabled)
        if missing:
            raise ValueError("插件需要但组织尚未启用的 MCP：" + "、".join(sorted(missing)))
        selected = [enabled[x] for x in sorted(wanted)]
        safe_scope = re.sub(r"[^a-zA-Z0-9_.-]", "_", str(scope or "plugin"))[:80]
        path = (os.path.join(_data_root(), "mcp", "scopes", safe_scope + ".json")
                if client is None and materialize else "")
    from . import connector_oauth
    selected = [await connector_oauth.resolve(session, client, item) for item in selected]
    if path:
        _write_runtime(selected, path)
    return path, runtime_payload(selected)


def redact_diagnostic(text: str, spec: dict) -> str:
    """Remove configured credentials from a process or network diagnostic."""
    secrets: list[str] = []
    for field in ("env", "headers"):
        for value in (spec.get(field) or {}).values():
            if len(str(value or "")) >= 4:
                secrets.append(str(value))
    for key, value in (spec.get("keycloak") or {}).items():
        if key in ("clientSecret", "password") and len(str(value or "")) >= 4:
            secrets.append(str(value))
    args = [str(value or "") for value in (spec.get("args") or [])]
    for index, raw in enumerate(args):
        lowered = raw.lower()
        sensitive_flag = any(mark in lowered for mark in
                             ("token", "secret", "password", "passwd", "api-key", "apikey"))
        if len(raw) >= 8 and sensitive_flag:
            secrets.append(raw)
        if sensitive_flag and index + 1 < len(args) and len(args[index + 1]) >= 4:
            secrets.append(args[index + 1])
        if "=" in raw and sensitive_flag and len(raw.split("=", 1)[1]) >= 4:
            secrets.append(raw.split("=", 1)[1])
    out = str(text or "")
    for secret in sorted(set(secrets), key=len, reverse=True):
        out = out.replace(secret, "***")
    return out


# Keep existing service callers compatible while external modules use the public name.
_bridge_redact = redact_diagnostic

def _bridge_sync(name: str, spec: dict, action: str, tool: str = "",
                 arguments: dict | None = None, timeout: int = 35) -> str:
    """Call one stdio MCP through the bundled bridge without writing credentials.

    Tool arguments travel over stdin rather than argv so business data does not
    appear in the host process list.
    """
    from . import connector_database
    if connector_database.handles(spec):
        return connector_database.execute(spec, action, tool, arguments, timeout)
    import shutil

    from . import skills as _sk

    node = shutil.which("node") or shutil.which("node.exe")
    bridge = os.path.join(_sk.bundled_root(), "mcp-tools", "scripts", "mcp.mjs")
    if not node:
        raise ValueError("\u5f53\u524d\u6267\u884c\u73af\u5883\u6ca1\u6709 Node.js\uff0c\u65e0\u6cd5\u4ee3\u7406\u8fd9\u4e2a stdio MCP")
    if not os.path.isfile(bridge):
        raise ValueError("\u5f53\u524d\u6267\u884c\u73af\u5883\u7f3a\u5c11 MCP \u6865\u63a5\u811a\u672c")
    safe_name = str(name or "").strip()
    if not safe_name:
        raise ValueError("MCP 名称不能为空")
    env = dict(os.environ)
    env.pop("SODUWORK_MCP_SERVERS", None)
    env["SODUWORK_MCP_SERVERS_JSON"] = json.dumps(
        {"servers": {safe_name: dict(spec or {})}}, ensure_ascii=False)
    env["SODUWORK_MCP_JSON"] = "1"
    argv = [node, bridge, action, safe_name]
    stdin = None
    if action == "call":
        argv.append(str(tool or ""))
        env["SODUWORK_MCP_ARGS_STDIN"] = "1"
        stdin = json.dumps(arguments or {}, ensure_ascii=False)
    try:
        proc = subprocess.run(
            argv, input=stdin, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=max(3, min(120, timeout)),
            env=env, check=False)
    except subprocess.TimeoutExpired:
        raise ValueError(f"MCP「{safe_name}」调用超时") from None
    output = str(proc.stdout or "").strip()
    if proc.returncode != 0:
        detail = redact_diagnostic(proc.stderr or output or "调用失败", spec)[:600]
        raise ValueError(f"MCP「{safe_name}」调用失败：{detail}")
    return output[:2_000_000]


def bridge_list_sync(name: str, spec: dict, timeout: int = 35) -> list[dict]:
    raw = _bridge_sync(name, spec, "list", timeout=timeout)
    try:
        payload = json.loads(raw)
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        from . import mcp_http
        return [mcp_http._clean_tool(tool) for tool in (payload.get("tools") or [])
                if isinstance(tool, dict) and str(tool.get("name") or "").strip()][:500]

    # Compatibility with bridge output produced by old packaged Runners. New
    # Runners use the structured branch above so required/oneOf/outputSchema
    # and annotations are not lost.
    tools: list[dict] = []
    blocks = [part.strip() for part in raw.split("\n\n") if part.strip()]
    for block in blocks:
        lines = block.splitlines()
        if not lines or not lines[0].startswith("## "):
            continue
        schema: dict = {}
        for line in lines[1:]:
            if line.startswith("入参："):
                try:
                    schema = json.loads(line[3:])
                except ValueError:
                    schema = {}
        description = "\n".join(
            line for line in lines[1:] if not line.startswith("入参："))[:1000]
        tools.append({
            "name": lines[0][3:].strip()[:200],
            "description": description,
            "inputSchema": {"type": "object", "properties": schema},
        })
    return tools[:500]


def bridge_call_sync(name: str, spec: dict, tool: str,
                     arguments: dict | None = None, timeout: int = 35) -> str:
    raw = _bridge_sync(name, spec, "call", tool, arguments, timeout)
    try:
        payload = json.loads(raw)
    except ValueError:
        return raw
    if not isinstance(payload, dict):
        return raw
    from . import mcp_http
    return mcp_http.normalize_tool_result(payload)

# Compatibility exports for existing Runners, tests, and callers; probe implementation lives separately.
from .connector_probes import probe_sync, probe_managed
