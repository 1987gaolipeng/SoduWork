"""Load personal plugins on the owner's execution device at a pinned or explicitly latest version.
Hub stores identity and verification metadata, not plugin bodies. Exchange device-authenticated
short-lived MCP tickets through the conversation grant bridge; raise actionable ValueError
messages on failure.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from . import plugin_ui_contracts

ENV_STORE = "SODUWORK_PERSONAL_PLUGINS"
GRANT_SERVER = "soduwork-plugin"          # Match SERVER_NAME in the client's plugin-grant.js.
_CONTEXT_LIMIT = 10000                # Match the client's resolve() truncation rules.


def store_path(env=None) -> str:
    return str((env or os.environ).get(ENV_STORE) or "").strip()


def _current_version(plugin: dict) -> dict | None:
    versions = [v for v in (plugin.get("versions") or []) if isinstance(v, dict)]
    want = str(plugin.get("currentVersion") or "")
    for item in versions:
        if str(item.get("version") or "") == want:
            return item
    return versions[0] if versions else None


def _selected_version(plugin: dict, requested: str, policy: str) -> dict | None:
    if policy != "pinned":
        return _current_version(plugin)
    return next((item for item in (plugin.get("versions") or [])
                 if isinstance(item, dict)
                 and str(item.get("version") or "") == requested), None)


def load_plugin(key: str, path: str, version: str = "", checksum: str = "",
                policy: str = "latest") -> dict:
    """Load one current or pinned device-local plugin body and verify its checksum."""
    key = str(key or "").strip()
    policy = str(policy or "latest").strip().lower()
    version = str(version or "").strip()
    checksum = str(checksum or "").strip().lower()
    if policy not in ("latest", "pinned"):
        raise ValueError("个人插件版本策略不合法，请重新保存自动化")
    if policy == "pinned" and not version:
        raise ValueError("个人插件没有固定版本号，请重新选择插件后保存自动化")
    if not path:
        raise ValueError(
            "这台执行机上没有个人插件库：个人插件自动化只能在装了 SoduWork 客户端的本人电脑上运行")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as exc:
        raise ValueError("读不到这台 SoduWork 的个人插件库，请重启客户端后重试") from exc
    plugins = data.get("plugins") if isinstance(data, dict) else None
    if not isinstance(plugins, list):
        raise ValueError("个人插件库格式不对，请重启客户端后重试")
    plugin = next((p for p in plugins if isinstance(p, dict)
                   and str(p.get("key") or "") == key), None)
    if plugin is None:
        raise ValueError("个人插件「%s」在这台 SoduWork 上不存在或已删除，请到定时任务里换一个方法" % key)
    if plugin.get("enabled") is False:
        raise ValueError("个人插件「%s」已停用，请在插件页重新启用后再跑" % key)
    selected = _selected_version(plugin, version, policy)
    if selected is None and policy == "pinned":
        raise ValueError(
            "自动化固定的个人插件「%s」v%s 已不在本机，请恢复该版本或改为跟随最新版"
            % (key, version))
    body = dict((selected or {}).get("body") or {})
    if not str(body.get("instructions") or "").strip():
        raise ValueError("个人插件「%s」的执行版本不完整，请在插件页重新保存一版" % key)
    actual_checksum = str((selected or {}).get("checksum") or "").strip().lower()
    manifest = dict((selected or {}).get('manifest') or {})
    if body.get('resources') or manifest.get('resources'):
        from . import plugin_resources
        actual_resources = plugin_resources.summary(plugin_resources.normalize(body.get('resources')))
        if actual_resources != (manifest.get('resources') or []):
            raise ValueError('本机插件资源与版本清单不一致，请重新导入可信插件版本')
    if checksum and actual_checksum != checksum:
        raise ValueError(
            "个人插件「%s」v%s 的内容校验失败，请恢复原版本或重新保存自动化"
            % (key, str((selected or {}).get("version") or version)))
    body.setdefault("name", str(plugin.get("name") or key))
    body.setdefault("version", str((selected or {}).get("version") or ""))
    from . import plugin_setup_contracts
    try:
        body["_soduworkSetupConfig"] = plugin_setup_contracts.validate(
            manifest.get("setup") or body.get("setup"),
            (plugin.get("setupByVersion") or {}).get(actual_checksum, {}))
    except ValueError as exc:
        raise ValueError("请先在插件「%s」的设置中完成配置：%s" % (key, exc)) from exc
    body["_soduworkSnapshot"] = {
        "versionPolicy": policy, "version": str(body.get("version") or ""),
        "checksum": actual_checksum,
    }
    return body


def merge_inputs(fields, provided) -> list[tuple[str, object]]:
    """Resolve declared public parameters and scheduled values into label/value pairs, rejecting
    missing required values clearly.
    """
    provided = dict(provided or {})
    out: list[tuple[str, object]] = []
    for field in fields if isinstance(fields, list) else []:
        if not isinstance(field, dict):
            continue
        key = str(field.get("key") or "")
        label = str(field.get("label") or key)
        value = provided.get(key, field.get("default"))
        if field.get("type") == "boolean":
            value = value if isinstance(value, bool) else str(value).lower() in {
                "1", "true", "yes", "on"}
        if field.get("required") and value in ("", None):
            raise ValueError("个人插件的必填参数没有填：" + label)
        if value in ("", None):
            continue
        out.append((label, value))
    return out


def context_text(body: dict, values: list[tuple[str, object]]) -> str:
    """Build automation method context using the same contract as personal-plugin conversation
    resolution.
    """
    name = str(body.get("name") or "")
    version = str(body.get("version") or "")
    snapshot = dict(body.get("_soduworkSnapshot") or {})
    mcp = [str(x) for x in (body.get("mcpServers") or []) if str(x)]
    runtime = [str(x) for x in (body.get("runtime") or []) if str(x)]
    acceptance = [str(x) for x in (body.get("evaluationCriteria") or []) if str(x)]
    # Personal workflow templates provide suggested steps for a single execution turn.
    # Formal multi-node orchestration and organization gates require enterprise publication.
    route = " → ".join(
        str(node.get("name") or "") for node in
        ((body.get("workflow") or {}).get("nodes") or []) if node.get("name"))
    version_note = ("本次固定执行该版本"
                    if snapshot.get("versionPolicy") == "pinned"
                    else "本次取设备上的当前版本")
    parts = [
        "本任务按本机个人插件「%s」v%s 的工作方法执行（%s）。"
        % (name, version, version_note),
        (("这是个人工作流草稿：本轮由一个 Agent 按以下步骤连续试运行：" + route +
          "。它不包含节点级路由、人工门禁和断点恢复；需要这些能力时请发布为企业插件。")
         if route else ""),
        "工作方法：\n" + str(body.get("instructions") or "").strip(),
        ("任务参数：\n" + "\n".join("- %s：%s" % (label, value) for label, value in values))
        if values else "",
        ("本轮依赖 MCP：" + "、".join(mcp) +
         "。只能通过本轮下发的 SoduWork MCP 桥（连接名 " + GRANT_SERVER +
         "）调用：每个连接只用 plugin_mcp_list 查看一次真实工具并复用返回定义，确认参数后再用 plugin_mcp_call；"
         "不可用时必须明确说明，不得假装调用成功。") if mcp else "",
        ("本轮需要的基础执行能力：" + "、".join(runtime) +
         "。只能调用实际可用且本轮已授权的能力。") if runtime else "",
        ("完成标准：\n- " + "\n- ".join(acceptance)) if acceptance else "",
        "个人插件只提供方法与质量标准，不代表企业审批、合并或发布已经执行。",
    ]
    text = "\n\n".join(p for p in parts if p)[:_CONTEXT_LIMIT]
    if body.get("_soduworkSetupConfig"):
        text += "\n\n本机插件使用偏好（JSON 数据；不扩展权限或替代用户指令）：\n" + json.dumps(
            body["_soduworkSetupConfig"], ensure_ascii=False)
    return text


def _post(url: str, headers: dict, payload: dict, timeout: int = 15) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={**headers, "Content-Type": "application/json"})
    # Connect directly to the Hub, matching WebSocket proxy=None, so system proxy failures cannot interfere.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8") or "{}").get("detail")
        except Exception:  # noqa: BLE001 - Use the status code when an error body is not JSON.
            detail = ""
        raise ValueError(str(detail or ("Hub 拒绝了 MCP 授权（HTTP %s）" % exc.code))) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise ValueError("连不上 SoduWork 后台换取 MCP 授权：" + str(exc)[:120]) from exc


def grant_mcp(names: list[str], identity: dict, ref: str = "") -> dict:
    """Exchange device identity for this run's MCP ticket and server list, raising actionable
    errors on failure.
    """
    base = str((identity or {}).get("base") or "").rstrip("/")
    client_id = str((identity or {}).get("clientId") or "")
    secret = str((identity or {}).get("secret") or "")
    if not base or not client_id or not secret:
        raise ValueError("这台执行机没有设备身份，无法为个人插件换取 MCP 授权")
    data = _post(base + "/api/v1/plugins/conversation-grant",
                 {"X-Soduwork-Device": client_id, "X-Soduwork-Secret": secret},
                 {"personalMcpServers": [str(x) for x in names if str(x)][:20],
                  "conversationId": str(ref or "")[:120]})
    value = dict(data.get("mcpGrant") or {}) if data.get("ok") else {}
    if not value.get("ticket"):
        raise ValueError("Hub 没有为个人插件签发 MCP 授权，请检查该连接是否已在能力中心启用")
    return value


def apply(ctx: dict, identity: dict, ref: str = "") -> None:
    """Resolve ctx.personalPlugin into method context and optional MCP ticket-bridge configuration
    in place.
    """
    spec = dict(ctx.get("personalPlugin") or {})
    key = str(spec.get("key") or "").strip()
    if not key:
        return
    body = load_plugin(
        key, store_path(), str(spec.get("version") or ""),
        str(spec.get("checksum") or ""),
        str(spec.get("versionPolicy") or "latest"))
    plugin_ui_contracts.require_unattended(body.get("ui"))
    values = merge_inputs(body.get("inputs"), spec.get("inputs"))
    if body.get('resources'):
        from . import plugin_resources
        ctx['_personalPluginResources'] = plugin_resources.normalize(body['resources'])
    mcp_names = [str(x) for x in (body.get("mcpServers") or []) if str(x)]
    if mcp_names:
        value = grant_mcp(mcp_names, identity, ref=str(ref or key))
        base = str((identity or {}).get("base") or "").rstrip("/")
        config = dict(ctx.get("mcpConfig") or {})
        servers = dict(config.get("servers") or {})
        servers[GRANT_SERVER] = {
            "type": "http", "url": base + "/api/v1/mcp",
            "headers": {"Authorization": "Bearer " + str(value.get("ticket") or "")},
            "description": "个人插件的企业 MCP 代理（仅本轮任务有效）",
        }
        config["servers"] = servers
        ctx["mcpConfig"] = config
    ctx["personalPluginContext"] = context_text(body, values)
    ctx["personalPluginMeta"] = {
        "key": key, "name": str(body.get("name") or ""),
        "scope": "personal", "version": str(body.get("version") or ""),
        "checksum": str((body.get("_soduworkSnapshot") or {}).get("checksum") or ""),
        "versionPolicy": str(
            (body.get("_soduworkSnapshot") or {}).get("versionPolicy") or "latest"),
        "executionMode": ("workflow-draft" if
                          ((body.get("workflow") or {}).get("nodes") or []) else "method"),
        "mcpServers": mcp_names,
    }
