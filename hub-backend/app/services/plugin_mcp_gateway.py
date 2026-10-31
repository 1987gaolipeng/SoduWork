"""Least-privilege MCP proxy for one ``@plugin`` conversation turn.

The signed ticket carries only binding ids and logical personal MCP names. This
module rechecks plugin/version/binding/audience state for every request, resolves
credentials on the Hub, and returns only tool metadata or tool results.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import time

from sqlalchemy import select

from .. import automation_models as am, models
from . import (mcp_http, mcp_servers, plugin_audience, plugin_builtin,
               plugin_mcp_limits, plugin_runtime, rbac, video_generation)

MAX_TOOLS = 200
MAX_SCHEMA_CHARS = 30_000
MAX_ARGUMENT_CHARS = 200_000
MAX_RESULT_CHARS = 500_000
# Tool discovery is metadata, not connector work.  A model may ask for the
# same list several times while recovering a malformed call; charging every
# repeated read against the turn budget makes an otherwise valid plugin fail
# intermittently.  Cache only within the signed ticket so one user's tools can
# never be reused by another user or another conversation.
MAX_LIST_CACHE = 1024
LIST_CACHE_TTL_SECONDS = 300
_LIST_CACHE: dict[tuple[str, str, str], tuple[float, list[dict]]] = {}


def _names(value, limit: int = 20) -> list[str]:
    return list(dict.fromkeys(
        str(item or "").strip()[:128] for item in (value or [])
        if str(item or "").strip()))[:limit]


def _ticket_key(claims: dict) -> str:
    """Return a non-secret cache partition for one signed plugin ticket."""
    raw = str((claims or {}).get("jti") or "").strip()
    if not raw:
        raw = "|".join(str((claims or {}).get(key) or "")
                       for key in ("cid", "uid", "ref", "exp"))
    return hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:48]


def _list_cache_key(claims: dict, server: str, spec: dict | None = None) -> tuple[str, str, str]:
    # Include the authorized spec so a binding/tool-policy change cannot reuse
    # a catalog created before the current authorization was evaluated.
    try:
        encoded = json.dumps(spec or {}, ensure_ascii=False, sort_keys=True,
                             default=str, separators=(",", ":"))
    except (TypeError, ValueError):
        encoded = repr(spec or {})
    fingerprint = hashlib.sha256(encoded.encode("utf-8", "replace")).hexdigest()[:32]
    return _ticket_key(claims), str(server or "")[:128], fingerprint


def _list_cache_ttl(claims: dict) -> float:
    try:
        remaining = float((claims or {}).get("exp") or 0) - time.time()
    except (TypeError, ValueError):
        remaining = LIST_CACHE_TTL_SECONDS
    if remaining <= 0:
        remaining = LIST_CACHE_TTL_SECONDS
    return max(1.0, min(float(LIST_CACHE_TTL_SECONDS), remaining))


def _list_cache_get(key: tuple[str, str, str]) -> list[dict] | None:
    now = time.monotonic()
    row = _LIST_CACHE.get(key)
    if row is None:
        return None
    expires_at, tools = row
    if expires_at <= now:
        _LIST_CACHE.pop(key, None)
        return None
    # The result is returned through a fresh object so a caller cannot mutate
    # the cached contract for the next retry in the same turn.
    return copy.deepcopy(tools)


def _list_cache_put(key: tuple[str, str, str], tools: list[dict], claims: dict) -> None:
    now = time.monotonic()
    for old_key, (expires_at, _) in list(_LIST_CACHE.items()):
        if expires_at <= now:
            _LIST_CACHE.pop(old_key, None)
    if len(_LIST_CACHE) >= MAX_LIST_CACHE and key not in _LIST_CACHE:
        oldest = min(_LIST_CACHE, key=lambda item: _LIST_CACHE[item][0])
        _LIST_CACHE.pop(oldest, None)
    _LIST_CACHE[key] = (now + _list_cache_ttl(claims), copy.deepcopy(tools))


def reset_list_cache_for_tests() -> None:
    _LIST_CACHE.clear()


def _schema(value) -> dict:
    schema = value if isinstance(value, dict) else {
        "type": "object", "properties": {}}
    try:
        encoded = json.dumps(schema, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        encoded = ""
    if len(encoded) <= MAX_SCHEMA_CHARS:
        return schema
    return {
        "type": "object",
        "description": "原工具参数结构过大，已安全收敛；请缩小 MCP 工具定义后重试",
        "properties": {},
    }


_HIGH_RISK = (
    "delete", "remove", "drop", "destroy", "publish", "deploy", "approve",
    "reject", "send", "pay", "refund", "transfer", "grant", "revoke",
    "apply", "commit", "merge", "close", "cancel", "disable", "enable",
)
_WRITE_RISK = (
    "create", "update", "write", "edit", "set", "post", "put", "patch",
    "upload", "execute", "run", "trigger", "submit",
)
_READ_RISK = (
    "get", "list", "search", "find", "query", "read", "fetch", "describe",
    "inspect", "lookup", "download", "preview", "status",
)


def tool_risk(name: str, description: str = "") -> str:
    text = (str(name or "") + " " + str(description or "")).lower()
    if any(mark in text for mark in _HIGH_RISK):
        return "high"
    if any(mark in text for mark in _WRITE_RISK):
        return "medium"
    if any(mark in text for mark in _READ_RISK):
        return "low"
    return "medium"


def _allowed(spec: dict, tool: str) -> bool:
    name = str(tool or "")
    if ("allowedTools" in spec
            and name not in {str(item) for item in spec.get("allowedTools") or []}):
        return False
    return mcp_servers.tool_allowed(spec, name)


def _tools(value, spec: dict | None = None) -> list[dict]:
    out: list[dict] = []
    for raw in value if isinstance(value, list) else []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()[:200]
        if not name or (spec is not None and not _allowed(spec, name)):
            continue
        description = str(raw.get("description") or "")[:1000]
        item = {
            "name": name,
            "description": description,
            "riskLevel": tool_risk(name, description),
            "inputSchema": _schema(raw.get("inputSchema")),
        }
        if raw.get("title"):
            item["title"] = str(raw.get("title"))[:300]
        if isinstance(raw.get("outputSchema"), dict):
            item["outputSchema"] = _schema(raw.get("outputSchema"))
        if isinstance(raw.get("annotations"), dict):
            item["annotations"] = dict(raw.get("annotations") or {})
        if isinstance(raw.get("icons"), list):
            item["icons"] = [dict(icon) for icon in raw.get("icons")[:8]
                             if isinstance(icon, dict)]
        if isinstance(raw.get("_meta"), dict):
            item["_meta"] = dict(raw.get("_meta") or {})
        out.append(item)
        if len(out) >= MAX_TOOLS:
            break
    return out


def _bounded_result(value, max_chars: int = MAX_RESULT_CHARS):
    try:
        encoded = json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        encoded = str(value)
    limit = min(MAX_RESULT_CHARS, max(1_000, int(max_chars or MAX_RESULT_CHARS)))
    if len(encoded) <= limit:
        return value
    return {
        "truncated": True,
        "preview": encoded[:limit],
        "message": "MCP 返回内容过大，已截断；请缩小查询范围或分页获取",
    }


async def _remote_grants(session, client: models.Client, claims: dict) -> dict[str, list[str]]:
    binding_ids = _names(claims.get("bids"), 3)
    if not binding_ids:
        return {}
    owner = await session.get(models.User, client.user_ref)
    if owner is None or not owner.is_active:
        raise ValueError("设备所属员工已经停用")
    visible_orgs = await rbac.company_org_ids(session, owner)
    bindings = list((await session.execute(select(am.PluginBinding).where(
        am.PluginBinding.id.in_(binding_ids)
    ))).scalars().all())
    by_id = {row.id: row for row in bindings}
    if set(binding_ids) != set(by_id):
        raise ValueError("本轮插件绑定已失效，请重新选择插件")
    versions = {row.id: row for row in (await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.id.in_({item.version_id for item in bindings})
    ))).scalars().all()}
    plugins = {row.id: row for row in (await session.execute(select(am.Plugin).where(
        am.Plugin.id.in_({item.plugin_id for item in bindings})
    ))).scalars().all()}
    allowed = await plugin_audience.allowed_version_ids(
        session, versions.keys(), owner.id)
    grants: dict[str, set[str]] = {}
    for binding_id in binding_ids:
        binding = by_id[binding_id]
        version = versions.get(binding.version_id)
        plugin = plugins.get(binding.plugin_id)
        if (not binding.enabled or version is None or plugin is None
                or not version.enabled or version.trust_state != "approved"
                or not plugin.enabled):
            raise ValueError("本轮插件版本已停用或撤销，请重新选择插件")
        if (visible_orgs is not None and binding.org_id is not None
                and binding.org_id not in visible_orgs):
            raise ValueError("本轮插件绑定不属于当前企业")
        if (visible_orgs is not None and plugin.org_id is not None
                and plugin.org_id not in visible_orgs):
            raise ValueError("本轮插件不属于当前企业")
        if not plugin_audience.visible(version, allowed):
            raise ValueError("本轮插件已经不再授权给当前员工")
        names = _names(dict(version.capability_report or {}).get("mcpServers"))
        try:
            selected = plugin_runtime.normalize_mcp_tools(
                dict(binding.config or {}).get("mcpTools"), names)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        missing = [name for name in names if not selected.get(name)]
        if missing:
            raise ValueError(
                "插件绑定尚未批准这些 MCP 的具体工具：" + "、".join(missing))
        for name, tools in selected.items():
            grants.setdefault(name, set()).update(tools)
    return {name: sorted(tools) for name, tools in sorted(grants.items())}


async def validate_bindings(session, client: models.Client, binding_ids: list[str]) -> None:
    await _remote_grants(session, client, {"bids": binding_ids})


async def _installed_names(session, client: models.Client, claims: dict) -> list[str]:
    """Revoke an in-flight ticket after uninstall, upgrade or audience removal."""
    from . import plugin_installed
    ids = _names(claims.get("pvids"), 3)
    application_mcp = claims.get("appmcp") or {}
    if (not isinstance(application_mcp, dict) or set(application_mcp) - set(ids)
            or any(not isinstance(names, list) or any(not isinstance(name, str) for name in names)
                   for names in application_mcp.values())):
        raise ValueError("本轮应用连接授权范围无效")
    if not ids:
        return []
    owner = await session.get(models.User, client.user_ref)
    if owner is None or not owner.is_active:
        raise ValueError("设备所属员工已经停用")
    rows = list((await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.id.in_(ids)))).scalars().all())
    if {row.id for row in rows} != set(ids):
        raise ValueError("本轮插件版本已失效")
    selected = await plugin_installed.resolve(
        session, owner.org_id, owner.id, [row.plugin_id for row in rows],
        provision_defaults=False)
    if {version.id for _, version, _ in selected} != set(ids):
        raise ValueError("插件安装版本已改变，请重新发送本轮")
    names = set()
    for _, version, _ in selected:
        declared = set(dict(version.capability_report or {}).get("mcpServers") or [])
        excluded = set(application_mcp.get(version.id, []))
        if not excluded <= declared:
            raise ValueError("本轮应用连接未在安装版本中声明")
        names.update(declared - excluded)
    return sorted(names)


async def validate_versions(session, client: models.Client, version_ids: list[str], *,
                            application_mcp: dict | None = None) -> None:
    names = await _installed_names(session, client, {"pvids": version_ids, "appmcp": application_mcp or {}})
    real_names = [name for name in names if not plugin_builtin.is_virtual_mcp(name)]
    if real_names:
        # Company/personal connector enablement and tool policy remain the
        # employee's current policy; no binding or connection is auto-created.
        await mcp_servers.runtime_for_dispatch(
            session, real_names, client=client, materialize=False)


async def authorized_servers(session, client: models.Client, claims: dict) -> dict[str, dict]:
    remote = await _remote_grants(session, client, claims)
    installed = await _installed_names(session, client, claims)
    personal = sorted(set(_names(claims.get("pmcp"))) | set(installed))
    merged: dict[str, dict] = {}
    virtual_names = {
        name for name in set(remote) | set(personal)
        if plugin_builtin.is_virtual_mcp(name)
    }
    for name in sorted(virtual_names):
        merged[name] = plugin_builtin.virtual_spec(name)
    real_remote = [name for name in remote if not plugin_builtin.is_virtual_mcp(name)]
    if real_remote:
        _, payload = await mcp_servers.runtime_for_dispatch(
            session, real_remote, scope="conversation-" + str(claims.get("ref") or ""),
            materialize=False)
        governed = dict(plugin_runtime.apply_mcp_tools(
            payload, {name: remote[name] for name in real_remote}).get("servers") or {})
        for name, spec in governed.items():
            item = dict(spec or {})
            # A stdio connector is a local process. Conversation calls must run
            # beside the employee, never accidentally on the shared Hub.
            if item.get("type") != "http":
                item["soduWorkRunOn"] = "runner"
            merged[name] = item
    real_personal = [name for name in personal if not plugin_builtin.is_virtual_mcp(name)]
    if real_personal:
        _, payload = await mcp_servers.runtime_for_dispatch(
            session, real_personal, client=client, materialize=False)
        company_names = {r["name"] for r in await mcp_servers.load(session)
                         if r.get("enabled")}
        for name, spec in dict(payload.get("servers") or {}).items():
            item = dict(spec or {})
            # Personal endpoints may address an employee LAN; company HTTP uses
            # the same Hub route as its administrator/client connection test.
            if name not in company_names or item.get("type") != "http":
                item["soduWorkRunOn"] = "runner"
            merged.setdefault(name, item)
    return merged


async def tool_definitions(session, client: models.Client, claims: dict) -> list[dict]:
    servers = await authorized_servers(session, client, claims)
    names = sorted(servers)
    if not names:
        return []
    server = {"type": "string", "enum": names,
              "description": "只能选择本轮插件已经声明并授权的连接"}
    return [
        {
            "name": "plugin_mcp_list",
            "description": "列出本轮插件获准使用的某个 MCP 连接中的真实工具与参数。调用工具前先用它。",
            "inputSchema": {"type": "object", "required": ["server"],
                            "properties": {"server": server}},
        },
        {
            "name": "plugin_mcp_call",
            "description": "调用本轮插件获准使用的 MCP 工具。server 必须来自 plugin_mcp_list，"
                           "tool 与 arguments 必须照它返回的真实结构填写。",
            "inputSchema": {
                "type": "object", "required": ["server", "tool"],
                "properties": {
                    "server": server,
                    "tool": {"type": "string", "description": "上一步列出的工具名"},
                    "arguments": {"type": "object", "description": "工具参数；没有参数就传空对象"},
                },
            },
        },
    ]


async def _server(session, client: models.Client, claims: dict, name: str) -> tuple[str, dict]:
    wanted = str(name or "").strip()
    servers = await authorized_servers(session, client, claims)
    if not wanted or wanted not in servers:
        raise ValueError("这个 MCP 不在本轮插件授权范围内")
    return wanted, servers[wanted]


async def _runner_connector(client: models.Client | None, operation: str,
                            name: str, spec: dict, timeout: int, **payload):
    from . import runner_hub
    runner = (runner_hub.for_client(str(client.id)) if client is not None
              else runner_hub.pick_for(""))
    if runner is None or not runner.alive():
        if client is None:
            raise ValueError("当前没有在线 Runner，无法读取本地 MCP 工具目录")
        raise ValueError(
            "这台电脑的 Runner 不在线，无法使用本机 MCP；请先启动 SoduWork")
    reply = await runner.call(operation, {
        "name": name,
        "spec": dict(spec or {}),
        "timeout": timeout,
        **payload,
    }, timeout=timeout + 5)
    if not reply.get("ok"):
        raise ValueError(str(reply.get("error") or "执行机上的 MCP 调用失败")[:600])
    return reply.get("data")


async def _connector_list(name: str, spec: dict, timeout: int,
                          client: models.Client | None = None):
    if plugin_builtin.is_virtual_mcp(name):
        return plugin_builtin.virtual_tools(name)
    if spec.get("soduWorkRunOn", spec.get("soduworkRunOn")) == "runner":
        data = await _runner_connector(client, "mcp.list", name, spec, timeout)
        return list((data or {}).get("tools") or [])
    if spec.get("type") == "http":
        pending = asyncio.to_thread(mcp_http.list_tools, spec, timeout)
    else:
        pending = asyncio.to_thread(
            mcp_servers.bridge_list_sync, name, spec, timeout=timeout)
    return await asyncio.wait_for(pending, timeout=timeout + 2)


async def _connector_call(name: str, spec: dict, tool: str,
                          arguments: dict, timeout: int,
                          client: models.Client | None = None,
                          session=None, claims: dict | None = None):
    if plugin_builtin.is_virtual_mcp(name):
        if tool not in {"generate_video", "generate_image"}:
            raise ValueError("当前 SoduWork 媒体能力不支持这个工具")
        from . import image_generation
        generate = image_generation.generate_image if tool == "generate_image" else video_generation.generate_video
        return await generate(
            session, client, arguments,
            conversation_id=str((claims or {}).get("ref") or ""),
            timeout_seconds=timeout,
        )
    if spec.get("soduWorkRunOn", spec.get("soduworkRunOn")) == "runner":
        data = await _runner_connector(
            client, "mcp.call", name, spec, timeout,
            tool=tool, arguments=arguments)
        return (data or {}).get("result")
    if spec.get("type") == "http":
        pending = asyncio.to_thread(
            mcp_http.call, spec, tool, arguments, timeout)
    else:
        pending = asyncio.to_thread(
            mcp_servers.bridge_call_sync, name, spec, tool, arguments,
            timeout=timeout)
    return await asyncio.wait_for(pending, timeout=timeout + 2)


async def list_tools(session, client: models.Client, claims: dict, server: str) -> dict:
    name, spec = await _server(session, client, claims, server)
    cache_key = _list_cache_key(claims, name, spec)
    cached = _list_cache_get(cache_key)
    if cached is not None:
        return {"server": name, "tools": cached}
    async with plugin_mcp_limits.governed(claims, name, "list") as limits:
        timeout = min(
            limits["timeoutSeconds"],
            int(spec.get("startupTimeoutSeconds") or 10))
        tools = await _connector_list(
            name, spec, timeout, client)
    normalized = _tools(tools, spec)
    _list_cache_put(cache_key, normalized, claims)
    return {"server": name, "tools": normalized}


async def call_tool(session, client: models.Client, claims: dict, server: str,
                    tool: str, arguments: dict | None = None):
    name, spec = await _server(session, client, claims, server)
    tool_name = str(tool or "").strip()[:200]
    if not tool_name:
        raise ValueError("MCP 工具名不能为空")
    if not _allowed(spec, tool_name):
        raise ValueError("这个工具没有被当前插件绑定批准")
    if arguments is not None and not isinstance(arguments, dict):
        raise ValueError("MCP 工具参数必须是对象")
    if len(json.dumps(arguments or {}, ensure_ascii=False, default=str)) > MAX_ARGUMENT_CHARS:
        raise ValueError("MCP 工具参数过大，请缩小输入或改用文件引用")
    async with plugin_mcp_limits.governed(claims, name, "call") as limits:
        timeout = min(
            limits["timeoutSeconds"],
            int(spec.get("toolTimeoutSeconds") or 60))
        result = await _connector_call(
            name, spec, tool_name, arguments or {}, timeout,
            client, session, claims)
    return {
        "server": name,
        "tool": tool_name,
        "result": _bounded_result(result, limits["maxResultChars"]),
    }


async def catalog(session, names: list[str]) -> list[dict]:
    """Read the live tool catalog for binding UI; credentials never leave the Hub."""
    wanted = _names(names)
    if not wanted:
        return []
    virtual = {name: plugin_builtin.virtual_spec(name) for name in wanted
               if plugin_builtin.is_virtual_mcp(name)}
    real = [name for name in wanted if not plugin_builtin.is_virtual_mcp(name)]
    servers = dict(virtual)
    if real:
        _, payload = await mcp_servers.runtime_for_dispatch(
            session, real, scope="plugin-tool-catalog", materialize=False)
        servers.update(dict(payload.get("servers") or {}))

    async def one(name: str) -> dict:
        spec = dict(servers.get(name) or {})
        # Admins author plugins on Hub, but stdio remains a desktop process.
        # Catalog discovery must exercise the same boundary as production calls.
        if spec.get("type") != "http":
            spec["soduWorkRunOn"] = "runner"
        try:
            timeout = min(20, int(spec.get("startupTimeoutSeconds") or 10))
            rows = await _connector_list(name, spec, timeout)
            return {"name": name, "ok": True, "tools": _tools(rows, spec)}
        except Exception as exc:  # noqa: BLE001
            return {"name": name, "ok": False, "tools": [],
                    "error": f"{type(exc).__name__}: {str(exc)[:300]}"}

    ordered = list(wanted)
    results = await asyncio.gather(*(one(name) for name in ordered),
                                   return_exceptions=True)
    out = []
    for name, result in zip(ordered, results):
        if isinstance(result, BaseException):
            # Record individual connection-probe failures without failing the complete tool catalog.
            out.append({"name": name, "ok": False, "tools": [],
                        "error": f"{type(result).__name__}: {str(result)[:300]}"})
        else:
            out.append(result)
    return out
