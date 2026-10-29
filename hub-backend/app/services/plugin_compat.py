"""Compatibility analysis for immutable plugin versions."""
from __future__ import annotations

from . import plugin_ui_contracts


_LEVEL = {"safe": 0, "review": 1, "breaking": 2}


def _value(row, name, default=None):
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(name, default)
    return getattr(row, name, default)


def _nodes(row) -> dict[str, dict]:
    workflow = dict(_value(row, "workflow", {}) or {})
    return {str(item.get("key") or ""): dict(item)
            for item in workflow.get("nodes") or [] if isinstance(item, dict)}


def _manifest(row) -> dict:
    return dict(_value(row, "manifest", {}) or {})


def _capabilities(row) -> dict:
    return dict(_value(row, "capability_report",
                       _value(row, "capabilities", {})) or {})


def _outputs(node: dict) -> dict[str, dict]:
    return {str(item.get("key") or ""): dict(item)
            for item in node.get("outputs") or [] if isinstance(item, dict)}


def _inputs(node: dict) -> dict[str, dict]:
    return {str(item.get("key") or ""): dict(item)
            for item in node.get("inputs") or [] if isinstance(item, dict)}


def _workflow_inputs(row) -> dict[str, dict]:
    return {str(item.get("key") or ""): dict(item)
            for item in _manifest(row).get("inputs") or [] if isinstance(item, dict)}


def _entrypoints(row) -> dict[str, bool]:
    manifest = _manifest(row)
    capabilities = _capabilities(row)
    raw = dict(manifest.get("entrypoints") or capabilities.get("entrypoints") or {})
    has_workflow = bool(capabilities.get("hasWorkflow", True))
    return plugin_ui_contracts.effective_entrypoints(
        raw, manifest.get("ui"), has_workflow=has_workflow)


def _ui(row) -> dict[str, dict]:
    manifest = _manifest(row)
    return {str(item.get("id") or ""): dict(item)
            for item in dict(manifest.get("ui") or {}).get("contributions") or []
            if isinstance(item, dict) and item.get("id")}


def _change(changes: list[dict], level: str, code: str, message: str,
            node_key: str = "") -> None:
    changes.append({"level": level, "code": code, "message": message,
                    **({"nodeKey": node_key} if node_key else {})})


def between(previous, current) -> dict:
    """Describe whether existing bindings can move to the current version safely."""
    from_version = str(_value(previous, "version", "") or "")
    to_version = str(_value(current, "version", "") or "")
    if previous is None:
        return {"level": "initial", "fromVersion": "", "toVersion": to_version,
                "summary": "首个版本，需要完成能力审查后再启用", "changes": []}
    if _value(previous, "id", "") and _value(previous, "id", "") == _value(current, "id", ""):
        return {"level": "current", "fromVersion": from_version, "toVersion": to_version,
                "summary": "当前已绑定版本", "changes": []}

    changes: list[dict] = []
    old_nodes, new_nodes = _nodes(previous), _nodes(current)
    for key, old in old_nodes.items():
        new = new_nodes.get(key)
        if new is None:
            _change(changes, "breaking", "node.removed",
                    f"删除节点「{old.get('name') or key}」", key)
            continue
        if str(old.get("type") or "") != str(new.get("type") or ""):
            _change(changes, "breaking", "node.type_changed",
                    f"节点「{old.get('name') or key}」执行类型发生变化", key)
        if list(old.get("dependsOn") or []) != list(new.get("dependsOn") or []):
            _change(changes, "review", "node.dependencies_changed",
                    f"节点「{old.get('name') or key}」的上游关系发生变化", key)
        old_outputs, new_outputs = _outputs(old), _outputs(new)
        for output_key, old_output in old_outputs.items():
            new_output = new_outputs.get(output_key)
            if new_output is None:
                _change(changes, "breaking" if old_output.get("required", True) else "review",
                        "output.removed",
                        f"节点「{old.get('name') or key}」删除产出 {output_key}", key)
            elif any(old_output.get(field) != new_output.get(field)
                     for field in ("kind", "path")):
                _change(changes, "breaking", "output.contract_changed",
                        f"节点「{old.get('name') or key}」的产出 {output_key} 契约发生变化",
                        key)
        for output_key, new_output in new_outputs.items():
            if output_key not in old_outputs and new_output.get("required", True):
                _change(changes, "breaking", "output.required_added",
                        f"节点「{new.get('name') or key}」新增必交产出 {output_key}", key)
        old_inputs, new_inputs = _inputs(old), _inputs(new)
        for input_key, new_input in new_inputs.items():
            old_input = old_inputs.get(input_key)
            if old_input is None and new_input.get("required", True):
                _change(changes, "breaking", "input.required_added",
                        f"节点「{new.get('name') or key}」新增必需输入 {input_key}", key)
            elif old_input and any(old_input.get(field) != new_input.get(field)
                                   for field in ("fromNode", "outputKey", "required")):
                _change(changes, "breaking", "input.reference_changed",
                        f"节点「{new.get('name') or key}」的输入 {input_key} 引用发生变化",
                        key)
        old_node_cap = dict(old.get("capabilities") or {})
        new_node_cap = dict(new.get("capabilities") or {})
        for field, label in (("skills", "技能"), ("mcpServers", "MCP 服务"),
                             ("secrets", "密钥"), ("runtime", "运行能力")):
            added = sorted(set(new_node_cap.get(field) or [])
                           - set(old_node_cap.get(field) or []))
            if added:
                _change(changes, "review", f"node.capability.{field}_added",
                        f"节点「{new.get('name') or key}」新增{label}：{'、'.join(added[:8])}",
                        key)
        if not old_node_cap.get("network") and new_node_cap.get("network"):
            _change(changes, "review", "node.capability.network_added",
                    f"节点「{new.get('name') or key}」新增网络访问能力", key)
        if dict(old.get("config") or {}) != dict(new.get("config") or {}):
            _change(changes, "review", "node.config_changed",
                    f"节点「{new.get('name') or key}」的执行配置发生变化", key)
    for key, node in new_nodes.items():
        if key not in old_nodes:
            _change(changes, "safe", "node.added",
                    f"新增节点「{node.get('name') or key}」", key)

    old_public, new_public = _workflow_inputs(previous), _workflow_inputs(current)
    for key, item in new_public.items():
        if key not in old_public and item.get("required", False):
            _change(changes, "breaking", "workflow_input.required_added",
                    f"新增启动必填项「{item.get('label') or key}」")
    for key, item in old_public.items():
        if key not in new_public:
            _change(changes, "review", "workflow_input.removed",
                    f"移除启动输入「{item.get('label') or key}」")

    old_entrypoints, new_entrypoints = _entrypoints(previous), _entrypoints(current)
    entrypoint_labels = {"conversation": "对话", "task": "需求", "automation": "自动化"}
    for key, label in entrypoint_labels.items():
        if old_entrypoints[key] and not new_entrypoints[key]:
            _change(changes, "breaking", f"entrypoint.{key}_disabled",
                    f"关闭已有的「{label}」调用入口")
        elif not old_entrypoints[key] and new_entrypoints[key]:
            _change(changes, "review", f"entrypoint.{key}_enabled",
                    f"新开放「{label}」调用入口")

    old_ui, new_ui = _ui(previous), _ui(current)
    for key, item in old_ui.items():
        if key not in new_ui:
            _change(changes, "review", "ui.removed",
                    f"移除员工界面「{item.get('title') or key}」")
        elif item != new_ui[key]:
            _change(changes, "review", "ui.changed",
                    f"员工界面「{new_ui[key].get('title') or key}」的位置或内容发生变化")
    for key, item in new_ui.items():
        if key not in old_ui:
            _change(changes, "review", "ui.added",
                    f"新增员工界面「{item.get('title') or key}」")

    old_evals = {str(item.get("key") or ""): dict(item)
                 for item in _manifest(previous).get("evaluations") or []
                 if isinstance(item, dict)}
    new_evals = {str(item.get("key") or ""): dict(item)
                 for item in _manifest(current).get("evaluations") or []
                 if isinstance(item, dict)}
    for key, item in new_evals.items():
        if key not in old_evals:
            _change(changes, "review", "evaluation.added",
                    f"新增发布评测「{item.get('name') or key}」")
        elif item != old_evals[key]:
            _change(changes, "review", "evaluation.changed",
                    f"发布评测「{item.get('name') or key}」的需求或验收标准发生变化")
    for key, item in old_evals.items():
        if key not in new_evals:
            _change(changes, "review", "evaluation.removed",
                    f"移除发布评测「{item.get('name') or key}」")

    old_cap, new_cap = _capabilities(previous), _capabilities(current)
    for field, label in (("skills", "技能"), ("mcpServers", "MCP 服务"),
                         ("secrets", "密钥"), ("runtime", "运行能力")):
        added = sorted(set(new_cap.get(field) or []) - set(old_cap.get(field) or []))
        if added:
            _change(changes, "review", f"capability.{field}_added",
                    f"新增{label}：{'、'.join(added[:8])}")
    if not old_cap.get("network") and new_cap.get("network"):
        _change(changes, "review", "capability.network_added", "新增外部网络访问能力")
    if not old_cap.get("hasScript") and new_cap.get("hasScript"):
        _change(changes, "review", "capability.script_added", "新增受控脚本执行能力")

    level = max((item["level"] for item in changes), key=lambda x: _LEVEL[x]) \
        if changes else "safe"
    summaries = {
        "safe": "兼容升级，可在预检通过后启用",
        "review": "能力或流程有变化，需要重新审查并模拟",
        "breaking": "包含破坏性变化，必须明确确认后升级",
    }
    return {"level": level, "fromVersion": from_version, "toVersion": to_version,
            "summary": summaries[level], "changes": changes[:100]}
