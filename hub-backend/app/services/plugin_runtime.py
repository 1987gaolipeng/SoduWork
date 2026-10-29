"""Node-scoped plugin capabilities and secret reference resolution."""
from __future__ import annotations

import re

from . import execution_capabilities, workflow_contracts

_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_TOOL_NAME = re.compile(r"^[^\x00-\x1f\x7f]{1,200}$")
MAX_MCP_TOOLS_PER_SERVER = 200
DEFAULT_MCP_POLICY = {
    "timeoutSeconds": 25,
    "maxResultChars": 500_000,
}


def node_capabilities(node: dict, report: dict) -> dict:
    """Resolve an immutable node capability set; old versions inherit package scope."""
    declared = node.get("capabilities")
    source = dict(declared) if isinstance(declared, dict) and declared.get("explicit") \
        else dict(report or {})
    return {
        "skills": list(dict.fromkeys(str(x) for x in source.get("skills") or [])),
        "mcpServers": list(dict.fromkeys(str(x) for x in source.get("mcpServers") or [])),
        "secrets": list(dict.fromkeys(str(x) for x in source.get("secrets") or [])),
        "runtime": execution_capabilities.normalize(source.get("runtime") or []),
        "network": bool(source.get("network")),
    }


def normalize_mcp_tools(value, server_names: list[str]) -> dict[str, list[str]]:
    """Canonical binding-level MCP grants without ever broadening package scope."""
    servers = list(dict.fromkeys(str(x).strip() for x in server_names if str(x).strip()))
    if value in (None, {}):
        return {}
    if not isinstance(value, dict):
        raise ValueError("MCP 工具授权必须是按连接分组的对象")
    unknown = sorted(str(key) for key in value if str(key) not in servers)
    if unknown:
        raise ValueError("MCP 工具授权引用了插件未声明的连接：" + "、".join(unknown[:10]))
    out: dict[str, list[str]] = {}
    for server in servers:
        raw = value.get(server)
        if raw in (None, []):
            continue
        if not isinstance(raw, list) or len(raw) > MAX_MCP_TOOLS_PER_SERVER:
            raise ValueError(
                f"MCP 连接「{server}」最多允许 {MAX_MCP_TOOLS_PER_SERVER} 个工具")
        tools: list[str] = []
        for item in raw:
            name = str(item or "").strip()
            if not _TOOL_NAME.fullmatch(name) or name == "*":
                raise ValueError(f"MCP 连接「{server}」包含不合法工具名：{name or '（空）'}")
            if name not in tools:
                tools.append(name)
        if tools:
            out[server] = sorted(tools)
    return out


def required_mcp_tools(binding, server_names: list[str]) -> dict[str, list[str]]:
    """Resolve the exact tools one workflow node may see; missing grants fail closed."""
    if binding is None:
        raise workflow_contracts.WorkflowConfigurationError("插件绑定不存在，无法解析 MCP 工具授权")
    servers = list(dict.fromkeys(str(x).strip() for x in server_names if str(x).strip()))
    configured = dict(dict(binding.config or {}).get("mcpTools") or {})
    selected = {name: configured.get(name) for name in servers if name in configured}
    try:
        grants = normalize_mcp_tools(selected, servers)
    except ValueError as exc:
        raise workflow_contracts.WorkflowConfigurationError(str(exc)) from exc
    missing = [name for name in servers if not grants.get(name)]
    if missing:
        raise workflow_contracts.WorkflowConfigurationError(
            "插件绑定尚未批准这些 MCP 的具体工具：" + "、".join(missing))
    return {name: grants[name] for name in servers}


def normalize_mcp_policy(value=None) -> dict:
    raw = dict(value or {}) if isinstance(value, dict) else {}
    try:
        timeout = int(raw.get("timeoutSeconds") or DEFAULT_MCP_POLICY["timeoutSeconds"])
        result_chars = int(raw.get("maxResultChars") or DEFAULT_MCP_POLICY["maxResultChars"])
    except (TypeError, ValueError) as exc:
        raise ValueError("MCP 运行预算必须使用整数") from exc
    return {
        "timeoutSeconds": min(60, max(3, timeout)),
        "maxResultChars": min(500_000, max(1_000, result_chars)),
    }


def apply_mcp_tools(payload: dict, grants: dict[str, list[str]],
                    runtime_policy: dict | None = None) -> dict:
    """Attach grants to per-dispatch specs so the Runner bridge can enforce them."""
    source = dict(dict(payload or {}).get("servers") or {})
    servers = {}
    policy = normalize_mcp_policy(runtime_policy)
    for name, tools in grants.items():
        if name not in source:
            continue
        servers[name] = {
            **dict(source[name] or {}),
            "allowedTools": list(tools),
            "soduWorkPolicy": dict(policy),
            # Wire contracts outlive branding; older installed Runners read this key.
            "soduworkPolicy": dict(policy),
        }
    return {"servers": servers}


async def resolve_secret_sources(session, binding, names: list[str]) -> dict[str, str]:
    """Return target-env -> runner-env names; secret values never leave the Runner."""
    wanted = [str(x) for x in names if _ENV_NAME.fullmatch(str(x))]
    if not wanted:
        return {}
    if binding is None:
        raise workflow_contracts.WorkflowConfigurationError("插件绑定不存在，无法解析运行密钥")
    mapping = {str(k): str(v) for k, v in dict(binding.secret_refs or {}).items()}
    missing = set(wanted) - set(mapping)
    if missing:
        raise workflow_contracts.WorkflowConfigurationError(
            "插件绑定缺少密钥引用：" + "、".join(sorted(missing)))
    from .. import automation_models as am
    refs = {}
    for name in wanted:
        ref = await session.get(am.SecretReference, mapping[name])
        if (ref is None or not ref.enabled or ref.provider != "runner-env"
                or not _ENV_NAME.fullmatch(str(ref.locator or ""))
                or (ref.org_id is not None and ref.org_id != binding.org_id)):
            raise workflow_contracts.WorkflowConfigurationError(
                f"插件密钥「{name}」的引用不可用")
        refs[name] = str(ref.locator)
    return refs
