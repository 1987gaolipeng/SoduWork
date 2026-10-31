"""Normalize immutable plugin manifests, DAG contracts and capability reports.

Archive safety, package identity, signature envelopes and storage stay in
plugin_packages; this policy layer never opens an archive or installs files.
"""
from __future__ import annotations

import json
import os
import re

from . import (execution_capabilities, execution_policy, plugin_input_contracts,
               plugin_route_contracts, preflight_evidence, plugin_setup_contracts,
               plugin_ui_contracts, plugin_icons, workflow_contracts, plugin_platforms)
from .plugin_builtin import is_virtual_mcp
from . import plugin_app_contracts, plugin_covers, plugin_window_contracts


_KEY = re.compile(r"^[a-z][a-z0-9-]{1,62}$")
_NODE_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$")
NODE_TYPES = {
    "ai", "ai_review", "validate", "human_review", "approval", "condition",
    "spec", "quality", "merge", "deploy", "deploy_chain", "publish", "script", "tool",
}


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


_CAPABILITY_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$")
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_SECRET_FIELD = re.compile(r"password|passwd|token|secret|private.?key|api.?key", re.I)


def _capability_names(value, label: str, *, env_names: bool = False) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 50:
        raise ValueError(f"{label} 必须是至多 50 项的数组")
    pattern = _ENV_NAME if env_names else _CAPABILITY_NAME
    out: list[str] = []
    for raw in value:
        name = _text(raw, 128)
        if not pattern.fullmatch(name):
            raise ValueError(f"{label}包含不合法名称：{name or '（空）'}")
        if name not in out:
            out.append(name)
    return sorted(out)


def _manifest_capabilities(value) -> dict:
    raw = dict(value or {})
    runtime_raw = raw.get("runtime")
    if runtime_raw is None:
        # `execution` was used by a few early internal drafts. Accept it at the
        # package boundary, but persist one canonical field everywhere else.
        runtime_raw = raw.get("execution")
    return {
        **({"platforms": plugin_platforms.normalize(raw["platforms"])} if raw.get("platforms") is not None else {}),
        "skills": _capability_names(raw.get("skills"), "插件技能"),
        "mcpServers": _capability_names(raw.get("mcpServers"), "插件 MCP 服务"),
        "secrets": _capability_names(raw.get("secrets"), "插件密钥", env_names=True),
        "runtime": execution_capabilities.normalize(
            _capability_names(runtime_raw, "插件运行能力")),
        "network": bool(raw.get("network")),
    }


def _entrypoints(value, *, has_workflow: bool) -> dict:
    """Normalize the public ways a capability package may be invoked.

    A plugin is an enterprise capability package. Workflow is only one optional
    implementation. The execution engine may compile a direct task entrypoint to
    one internal node, but that node must not make the catalog claim the package
    contains a business workflow.
    """
    if value is not None and not isinstance(value, dict):
        raise ValueError("插件 entrypoints 必须是对象")
    raw = dict(value or {})
    out = {
        "conversation": bool(raw.get("conversation", True)),
        "task": bool(raw.get("task", True)),
        "automation": bool(raw.get("automation", has_workflow)),
    }
    if not any(out.values()):
        raise ValueError("插件至少要开放对话、任务或自动化中的一个入口")
    return out


def _node_capabilities(value, node_key: str, node_type: str, allowed: dict) -> dict | None:
    if value is None:
        return None
    if node_type not in {"ai", "ai_review"}:
        raise ValueError(f"节点 {node_key} 不是 AI 节点，不能声明 Agent 运行能力")
    raw = dict(value or {})
    normalized = {
        "skills": _capability_names(raw.get("skills"), f"节点 {node_key} 的技能"),
        "mcpServers": _capability_names(raw.get("mcpServers"), f"节点 {node_key} 的 MCP 服务"),
        "secrets": _capability_names(
            raw.get("secrets"), f"节点 {node_key} 的密钥", env_names=True),
        "runtime": execution_capabilities.normalize(
            _capability_names(raw.get("runtime"), f"节点 {node_key} 的运行能力")),
        "network": bool(raw.get("network")),
        "explicit": True,
    }
    for field, label in (("skills", "技能"), ("mcpServers", "MCP 服务"),
                         ("secrets", "密钥"), ("runtime", "运行能力")):
        unknown = set(normalized[field]) - set(allowed.get(field) or [])
        if unknown:
            raise ValueError(
                f"节点 {node_key} 使用了插件未声明的{label}：{'、'.join(sorted(unknown))}")
    if normalized["network"] and not allowed.get("network"):
        raise ValueError(f"节点 {node_key} 申请了插件未声明的网络能力")
    return normalized


_PERMISSIVE_LICENSES = {
    "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC",
}

# Expose workflow identity so users can distinguish development delivery from ordinary office methods.
# Also identify the configured delivery scope or environment.
_PROCESS_SCOPES = {"company", "department", "project"}


def _process(value) -> dict:
    if value in (None, ""):
        return {}
    if not isinstance(value, dict):
        raise ValueError("插件 process 必须是对象")
    out: dict = {"enterprise": bool(value.get("enterprise"))}
    label = _text(value.get("label"), 40)
    route = _text(value.get("route"), 200)
    if label:
        out["label"] = label
    if route:
        out["route"] = route
    raw_envs = value.get("environments")
    if raw_envs is not None:
        if not isinstance(raw_envs, list) or len(raw_envs) > 8:
            raise ValueError("插件 process.environments 必须是至多 8 项的数组")
        envs = []
        for item in raw_envs:
            if not isinstance(item, dict):
                raise ValueError("process.environments 每项必须是对象")
            env_label = _text(item.get("label"), 60)
            scope = _text(item.get("scope"), 20).lower()
            if not env_label:
                raise ValueError("process.environments 每项必须有 label")
            if scope and scope not in _PROCESS_SCOPES:
                raise ValueError(
                    f"process.environments 的 scope 只接受 {'、'.join(sorted(_PROCESS_SCOPES))}")
            env = {"label": env_label}
            if scope:
                env["scope"] = scope
            envs.append(env)
        if envs:
            out["environments"] = envs
    return out


def process_profile(manifest: dict, report: dict | None = None) -> dict:
    """Return workflow identity for serialization, preferring author declarations over legacy shape inference.
    
    Infer only from nodes that modify enterprise code or environments, such as merge and deploy,
    so installed legacy versions can display their enterprise-workflow identity without reimporting.
    """
    declared = dict((manifest or {}).get("process") or {})
    out = dict(declared) if declared else {"enterprise": bool(
        set((report or {}).get("nodeTypes") or [])
        & {"merge", "deploy", "deploy_chain"})}
    if out.get("enterprise") and not out.get("label"):
        out["label"] = "企业流程"
    return out


def _open_source(value) -> dict:
    if value in (None, ""):
        return {}
    if not isinstance(value, dict):
        raise ValueError("插件 openSource 必须是对象")
    license_id = _text(value.get("license"), 40)
    repository = _text(value.get("repository"), 500)
    if license_id not in _PERMISSIVE_LICENSES:
        raise ValueError("商业内置开源适配只接受 MIT、Apache-2.0、BSD 或 ISC 许可证")
    if not re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?/?",
                        repository):
        raise ValueError("开源插件必须声明可核验的 GitHub 仓库地址")
    out = {"license": license_id, "repository": repository.rstrip("/")}
    for source, target, limit in (
        ("upstreamVersion", "upstreamVersion", 80),
        ("adaptation", "adaptation", 500),
        ("notice", "notice", 800),
    ):
        text = _text(value.get(source), limit)
        if text:
            out[target] = text
    return out


def _has_secret_field(value) -> bool:
    if isinstance(value, dict):
        return any(_SECRET_FIELD.search(str(key)) or _has_secret_field(child)
                   for key, child in value.items())
    if isinstance(value, list):
        return any(_has_secret_field(child) for child in value)
    return False


def _evaluation_cases(value, result_contract: list[dict]) -> list[dict]:
    """Normalize portable, side-effect-free quality cases shipped with a version.

    Cases are immutable author intent. Actual run evidence is stored separately by
    the evaluation runner; package input must never contain credentials.
    """
    if value in (None, []):
        return []
    if not isinstance(value, list) or len(value) > 20:
        raise ValueError("插件发布评测必须是至多 20 项的数组")
    result_ids = {str(item.get("id") or "") for item in result_contract}
    required_ids = [str(item.get("id") or "") for item in result_contract
                    if item.get("required", True)]
    out, keys = [], set()
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise ValueError(f"第 {index + 1} 个发布评测不合法")
        key = _text(raw.get("key") or f"case-{index + 1}", 64).lower()
        if not _KEY.fullmatch(key) or key in keys:
            raise ValueError(f"发布评测 key 不合法或重复：{key}")
        name = _text(raw.get("name"), 120)
        instruction = _text(raw.get("instruction"), 2000)
        if not name or not instruction:
            raise ValueError(f"发布评测 {key} 必须写名称和代表性任务")
        criteria_raw = raw.get("criteria")
        if not isinstance(criteria_raw, list) or not (1 <= len(criteria_raw) <= 20):
            raise ValueError(f"发布评测 {key} 必须声明 1 到 20 条验收标准")
        criteria = []
        for criterion in criteria_raw:
            text = _text(criterion, 300)
            if not text:
                raise ValueError(f"发布评测 {key} 包含空验收标准")
            if text not in criteria:
                criteria.append(text)
        inputs = raw.get("inputs") or {}
        if not isinstance(inputs, dict) or _has_secret_field(inputs):
            raise ValueError(f"发布评测 {key} 的输入必须是无凭据对象")
        try:
            encoded = json.dumps(inputs, ensure_ascii=False, sort_keys=True)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"发布评测 {key} 的输入必须可序列化") from exc
        if len(encoded.encode("utf-8")) > 16 * 1024:
            raise ValueError(f"发布评测 {key} 的输入超过 16KB")
        expected_raw = raw.get("expectedOutputs")
        if expected_raw is None:
            expected = list(required_ids)
        else:
            expected = _capability_names(expected_raw, f"发布评测 {key} 的期望产出")
            unknown = set(expected) - result_ids
            if unknown:
                raise ValueError(
                    f"发布评测 {key} 引用了不存在的产出：{'、'.join(sorted(unknown))}")
        out.append({
            "key": key, "name": name, "instruction": instruction,
            "inputs": inputs, "criteria": criteria, "expectedOutputs": expected,
        })
        keys.add(key)
    return out


def _capability_report(report: dict, adapter: dict,
                       manifest: dict | None = None,
                       workflow: dict | None = None) -> dict:
    bundled = list(adapter.get("bundledSkills") or [])
    bundled_names = {str(x.get("name") or "") for x in bundled} - {""}
    declared = {str(x) for x in (report.get("skills") or [])} - {""}
    merged = {
        **report,
        "skills": sorted(declared | bundled_names),
        "externalSkills": sorted(declared - bundled_names),
        "bundledSkills": bundled,
        "adapterWarnings": list(adapter.get("warnings") or []),
        "adapterBlockers": list(adapter.get("blockers") or []),
        "unsupportedComponents": list(adapter.get("unsupportedComponents") or []),
    }
    manifest = dict(manifest or {})
    nodes = list(dict(workflow or {}).get("nodes") or [])
    skills = list(merged.get("skills") or [])
    mcp_servers = list(merged.get("mcpServers") or [])
    external_mcp = [name for name in mcp_servers if not is_virtual_mcp(name)]
    runtime = execution_capabilities.normalize(merged.get("runtime") or [])
    unsupported = list(merged.get("unsupportedComponents") or [])
    components = []
    if manifest.get("instructions"):
        components.append({
            "kind": "instructions", "label": "工作说明",
            "count": 1, "state": "ready",
        })
    if skills:
        components.append({
            "kind": "skills", "label": "Skill",
            "count": len(skills), "state": "ready", "items": skills[:50],
        })
    if mcp_servers:
        components.append({
            "kind": "mcp", "label": "MCP 连接",
            "count": len(mcp_servers),
            "state": "needs-binding" if external_mcp else "ready",
            "items": mcp_servers[:50],
        })
    if runtime:
        components.append({
            "kind": "runtime", "label": "执行能力",
            "count": len(runtime), "state": "needs-runner",
            "items": runtime[:50],
        })
    if merged.get("hasWorkflow"):
        components.append({
            "kind": "workflow", "label": "自动化流程",
            "count": len(nodes), "state": "ready",
        })
    if unsupported:
        components.append({
            "kind": "unsupported", "label": "暂不支持",
            "count": len(unsupported), "state": "blocked", "items": unsupported[:50],
        })
    result_contract = list(merged.get("resultContract") or [])
    evaluations = list(merged.get("evaluationCases") or [])
    ui_contributions = list(dict(manifest.get("ui") or {}).get("contributions") or [])
    if result_contract:
        components.append({
            "kind": "contract", "label": "结果契约",
            "count": len(result_contract), "state": "ready",
        })
    if evaluations:
        components.append({
            "kind": "evaluation", "label": "发布评测",
            "count": len(evaluations), "state": "ready",
            "items": [str(item.get("name") or "") for item in evaluations[:20]],
        })
    if ui_contributions:
        components.append({
            "kind": "ui", "label": "员工界面",
            "count": len(ui_contributions), "state": "ready",
            "items": [str(item.get("title") or "") for item in ui_contributions[:12]],
        })

    reasons = []
    if external_mcp:
        reasons.append(f"需要配置 {len(external_mcp)} 个企业 MCP 连接")
    if merged.get("network"):
        reasons.append("运行时需要网络访问")
    if runtime:
        reasons.append("需要执行机提供：" + "、".join(
            execution_capabilities.label(x) for x in runtime[:8]))
    secret_count = len(merged.get("secrets") or [])
    if secret_count:
        reasons.append(f"需要映射 {secret_count} 个逻辑密钥")
    if merged.get("hasScript"):
        reasons.append("包含受控脚本或命令执行")
    if unsupported:
        reasons.append("包含当前不会自动执行的第三方组件")
    external_ui = plugin_ui_contracts.external_count(manifest.get("ui"))
    if external_ui:
        reasons.append(f"提供 {external_ui} 个受控外部系统页面")
    risk_level = (
        "high" if secret_count or merged.get("hasScript") or unsupported
        or "computer" in runtime
        else "medium" if merged.get("network") or mcp_servers or runtime or external_ui
        else "low"
    )
    merged["uiContributions"] = ui_contributions[:12]
    merged["components"] = components
    merged["componentCount"] = sum(
        int(item.get("count") or 0) for item in components
        if item.get("state") != "blocked")
    merged["permissionSummary"] = {
        "riskLevel": risk_level,
        "network": bool(merged.get("network")),
        "runtime": runtime,
        "script": bool(merged.get("hasScript")),
        "externalUiCount": external_ui,
        "secretCount": secret_count,
        "reasons": reasons,
    }
    merged["dependencies"] = {
        "skills": skills[:50],
        "mcpServers": mcp_servers[:50],
        "runtime": runtime[:50],
        "secrets": list(merged.get("secrets") or [])[:50],
        "environments": list(merged.get("environments") or [])[:30],
    }
    merged["qualitySummary"] = {
        "state": "declared" if evaluations else "contract-only",
        "caseCount": len(evaluations),
        "resultCount": len(result_contract),
        "message": (f"已声明 {len(evaluations)} 个发布评测"
                    if evaluations else "已有结果契约，尚未声明代表性发布评测"),
    }
    return merged


def _dag(nodes: list[dict]) -> None:
    keys = {n["key"] for n in nodes}
    deps = {n["key"]: set(n.get("dependsOn") or []) for n in nodes}
    for key, values in deps.items():
        missing = values - keys
        if missing:
            raise ValueError(f"节点 {key} 依赖不存在的节点：{', '.join(sorted(missing))}")
        if key in values:
            raise ValueError(f"节点 {key} 不能依赖自己")
    ready = [key for key, values in deps.items() if not values]
    seen = []
    while ready:
        key = ready.pop(0)
        seen.append(key)
        for other, values in deps.items():
            values.discard(key)
            if not values and other not in seen and other not in ready:
                ready.append(other)
    if len(seen) != len(nodes):
        raise ValueError("首版插件工作流必须是无环图；返工请用节点 retry 策略表达")


def normalize(manifest: dict, workflow: dict | None = None) -> tuple[dict, dict, dict]:
    """Return the normalized manifest, workflow, and capability report."""
    raw = dict(manifest or {})
    distribution = _text(raw.get("distribution"), 24).lower()
    if distribution and distribution != "standalone":
        raise ValueError("plugin distribution must be standalone when provided")
    schema = int(raw.get("schemaVersion") or 0)
    if schema != 1:
        raise ValueError("只支持 schemaVersion=1 的 SoduWork 插件")
    key, version = _text(raw.get("key"), 64).lower(), _text(raw.get("version"), 40)
    if not _KEY.fullmatch(key):
        raise ValueError("插件 key 只允许小写字母、数字和短横线")
    if not _VERSION.fullmatch(version):
        raise ValueError("插件 version 必须是 SemVer，例如 1.0.0")
    name = _text(raw.get("name"), 120)
    if not name:
        raise ValueError("插件必须有名称")
    declared_capabilities = dict(raw.get("capabilities") or {})
    # Personal/desktop exports also declare MCP names at the package top level.
    # Normalize that supported shape at import; never silently drop its grants
    # or union conflicting declarations across desktop and Hub consumers.
    if "mcpServers" in raw:
        package_mcp = _capability_names(raw["mcpServers"], "插件 MCP 服务")
        if "mcpServers" in declared_capabilities and package_mcp != _capability_names(
                declared_capabilities["mcpServers"], "插件 MCP 服务"):
            raise ValueError("插件顶层 mcpServers 与 capabilities.mcpServers 声明不一致")
        declared_capabilities["mcpServers"] = package_mcp
    manifest_capabilities = _manifest_capabilities(declared_capabilities)
    instructions = _text(raw.get("instructions"), 12000)
    wf = dict(workflow or raw.get("workflow") or {})
    raw_nodes = wf.get("nodes") or []
    if not isinstance(raw_nodes, list) or len(raw_nodes) > 100:
        raise ValueError("工作流节点数不能超过 100")
    has_workflow = bool(raw_nodes)
    entrypoints = _entrypoints(raw.get("entrypoints"), has_workflow=has_workflow)
    if not has_workflow:
        declared = (manifest_capabilities.get("skills") or []) + \
            (manifest_capabilities.get("mcpServers") or []) + \
            (manifest_capabilities.get("runtime") or [])
        if not instructions and not declared:
            raise ValueError("能力包没有工作流时，必须声明 instructions、Skill 或 MCP")
        prompt = instructions or (
            "使用本插件声明的 Skill 与 MCP 完成当前任务。先读取可用 Skill 的说明，"
            "只调用已授权连接，交付可验证结果并说明实际使用的依据。")
        # Internal lowering target for the existing durable DAG engine. Public APIs use
        # capability_report.hasWorkflow to keep this implementation detail out of the UI.
        raw_nodes = [{
            "key": "execute", "type": "ai", "name": "使用插件能力",
            "capabilities": manifest_capabilities,
            "outputs": [{"key": "result", "kind": "evidence",
                         "label": "交付结果", "required": True}],
            "config": {"prompt": prompt, "timeoutSeconds": 3600},
            "retry": {"maxAttempts": 2},
        }]
    nodes, keys = [], set()
    for item in raw_nodes:
        if not isinstance(item, dict):
            raise ValueError("每个工作流节点都必须是对象")
        node_key = _text(item.get("key"), 64)
        node_type = _text(item.get("type"), 32).lower()
        if not _NODE_KEY.fullmatch(node_key) or node_key in keys:
            raise ValueError(f"节点 key 不合法或重复：{node_key}")
        if node_type not in NODE_TYPES:
            raise ValueError(f"节点 {node_key} 的类型不受支持：{node_type}")
        config = dict(item.get("config") or {})
        if node_type in ("ai", "ai_review") and not _text(config.get("prompt"), 12000):
            raise ValueError(f"AI 节点 {node_key} 缺少 prompt")
        if node_type in ("ai", "ai_review"):
            config = plugin_route_contracts.normalize(config, node_key)
        if node_type in ("ai", "ai_review") and "timeoutSeconds" in config:
            try:
                timeout_seconds = int(config.get("timeoutSeconds"))
            except (TypeError, ValueError) as exc:
                raise ValueError(f"AI 节点 {node_key} 的 timeoutSeconds 必须是整数") from exc
            if timeout_seconds < 60 or timeout_seconds > 86400:
                raise ValueError(
                    f"AI 节点 {node_key} 的 timeoutSeconds 必须在 60 到 86400 秒之间")
            config = {**config, "timeoutSeconds": timeout_seconds}
        if node_type in ("ai", "ai_review") and "executionPolicy" in config:
            try:
                policy = execution_policy.normalize(config.get("executionPolicy"), node_key)
            except ValueError as exc:
                raise ValueError(f"节点 {node_key} 的 executionPolicy 不合法：{exc}") from exc
            config = {**config, "executionPolicy": policy}
        if node_type in ("ai", "ai_review") and "preflightEvidenceMode" in config:
            try:
                mode = preflight_evidence.normalize_mode(
                    config.get("preflightEvidenceMode"), node_key)
            except ValueError as exc:
                raise ValueError(
                    f"node {node_key} has invalid preflightEvidenceMode: {exc}") from exc
            config = {**config, "preflightEvidenceMode": mode}
        if node_type == "script":
            # Normalize script and quality nodes to the same commands array contract.
            # Both execute through the same isolated Runner channel.
            # Convert legacy single-command config.argv into commands.
            # Imported declarations must match the runtime's command shape.
            if not config.get("commands") and isinstance(config.get("argv"), list) \
                    and config.get("argv"):
                config = {**config, "commands": [{"name": node_key, "argv": config["argv"],
                                                  **({"timeoutSeconds": config["timeoutSeconds"]}
                                                     if config.get("timeoutSeconds") else {})}]}
        if node_type in ("quality", "script"):
            commands = config.get("commands")
            if not isinstance(commands, list) or not commands:
                raise ValueError(
                    f"{'质量' if node_type == 'quality' else '脚本'}节点 {node_key} "
                    f"必须配置 commands（每条是 {{name, argv, timeoutSeconds?}}）")
            for command in commands:
                if not isinstance(command, dict) or not isinstance(command.get("argv"), list) \
                        or not command.get("argv"):
                    raise ValueError(f"节点 {node_key} 的每条命令都必须使用 argv 数组")
                working_dir = _text(command.get("workingDir"), 300)
                parts = working_dir.replace("\\", "/").strip("/").split("/") \
                    if working_dir else []
                if working_dir and (os.path.isabs(working_dir) or ".." in parts):
                    raise ValueError(f"节点 {node_key} 的工作目录必须位于工程内")
        if node_type == "tool":
            # Validate tool names against the trusted registry before runtime execution.
            from . import workflow_tools
            tool_name = _text(config.get("tool"), 64)
            if tool_name not in workflow_tools.known_tools():
                raise ValueError(
                    f"工具节点 {node_key} 声明的工具「{tool_name or '（空）'}」不在受信名单里"
                    f"（当前可用：{'、'.join(workflow_tools.known_tools())}）")
        if node_type == "deploy" and not (config.get("environmentKey") or config.get("environmentId")):
            raise ValueError(f"部署节点 {node_key} 没指定环境")
        depends = [_text(x, 64) for x in (item.get("dependsOn") or [])]
        outputs = workflow_contracts.normalize_outputs(item.get("outputs"), node_key)
        node_capabilities = _node_capabilities(
            item.get("capabilities"), node_key, node_type, manifest_capabilities)
        normalized_node = {"key": node_key, "type": node_type,
                           "name": _text(item.get("name"), 100) or node_key,
                           "dependsOn": list(dict.fromkeys(depends)),
                           "config": config,
                           "outputs": outputs, "_inputRefs": item.get("inputs"),
                           "retry": {"maxAttempts": min(5, max(1, int(
                               dict(item.get("retry") or {}).get("maxAttempts") or 1)))}}
        if node_capabilities is not None:
            normalized_node["capabilities"] = node_capabilities
        nodes.append(normalized_node)
        keys.add(node_key)
    _dag(nodes)
    outputs_by_node = {node["key"]: list(node.get("outputs") or []) for node in nodes}
    for node in nodes:
        node["inputs"] = workflow_contracts.normalize_inputs(
            node.pop("_inputRefs", None), node["key"],
            list(node.get("dependsOn") or []), outputs_by_node)
    result_contract = [{
        "id": f"{node['key']}.{output['key']}",
        "nodeKey": node["key"], "nodeName": node["name"],
        **dict(output),
    } for node in nodes for output in (node.get("outputs") or [])]
    evaluations = _evaluation_cases(raw.get("evaluations"), result_contract)
    inputs = plugin_input_contracts.normalize(raw.get("inputs"))
    setup = plugin_setup_contracts.normalize(raw.get("setup"))
    ui = plugin_ui_contracts.normalize(raw.get("ui"), setup)
    plugin_app_contracts.validate(raw.get('template'), ui)
    entrypoints = plugin_ui_contracts.effective_entrypoints(
        entrypoints, ui, has_workflow=has_workflow)
    if not any(entrypoints.values()):
        raise ValueError("带页面的交互插件至少要开放会话或任务入口，不能只用于后台自动化")
    outputs = list(raw.get("outputs") or [])[:50]
    normalized = {
        "schemaVersion": 1, "key": key, "name": name, "version": version,
        # Purpose categories are author-declared or inferred from capabilities: development delivery, office documents,

        "category": (str(raw.get("category") or "").strip()
                     if str(raw.get("category") or "").strip() in
                     ("dev", "office", "research", "errand") else ""),
        "description": _text(raw.get("description"), 600),
        **({"distribution": distribution} if distribution else {}),
        "author": _text(raw.get("author"), 120),
        "openSource": _open_source(raw.get("openSource")),
        "process": _process(raw.get("process")),
        "inputs": inputs, "setup": setup, "ui": ui, "outputs": outputs,
        "instructions": instructions,
        "entrypoints": entrypoints,
        "evaluations": evaluations,
        "capabilities": manifest_capabilities,
    }
    from . import plugin_locales
    locales = plugin_locales.normalize(raw.get('locales'))
    if locales is not None:
        normalized['locales'] = locales
    cover = plugin_covers.normalize(raw.get('coverUrl'))
    if cover:
        normalized['coverUrl'] = cover
    icon = plugin_icons.normalize(raw.get('icon'))
    if raw.get('template') == 'app':
        normalized['template'] = 'app'
    app_window = plugin_window_contracts.normalize(raw.get('appWindow'))
    if app_window is not None:
        normalized['appWindow'] = app_window
    if icon:
        normalized['icon'] = icon
    normalized_wf = {"nodes": nodes}
    capabilities = {
        **({"platforms": manifest_capabilities["platforms"]} if manifest_capabilities.get("platforms") else {}),
        "nodeTypes": sorted({n["type"] for n in nodes}),
        "agentKinds": sorted({str(n["config"].get("agentKind")) for n in nodes
                              if n["type"] in {"ai", "ai_review"}
                              and n["config"].get("agentKind")}),
        "skills": sorted({str(x) for x in normalized["capabilities"].get("skills") or []}),
        "mcpServers": sorted({str(x) for x in normalized["capabilities"].get("mcpServers") or []}),
        "secrets": sorted({str(x) for x in normalized["capabilities"].get("secrets") or []}),
        "runtime": execution_capabilities.normalize(
            normalized["capabilities"].get("runtime") or []),
        "environments": sorted({str(n["config"].get("environmentKey") or
                                    n["config"].get("environmentId")) for n in nodes
                                if n["type"] == "deploy"}),
        "network": bool(normalized["capabilities"].get("network")),
        "hasScript": any(n["type"] == "script" for n in nodes),
        "hasWorkflow": has_workflow,
        "executionMode": "workflow" if has_workflow else "direct",
        "entrypoints": entrypoints,
        "resultContract": result_contract,
        "evaluationCases": evaluations,
    }
    capabilities = _capability_report(
        capabilities, {}, normalized, normalized_wf)
    return normalized, normalized_wf, capabilities
