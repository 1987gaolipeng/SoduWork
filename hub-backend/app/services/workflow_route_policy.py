"""Portable per-run/project/node execution preferences and route precedence.

Pure policy: no sessions, workflow lifecycle, credentials or concrete Runner ownership.
"""
from __future__ import annotations

import re


def execution_preferences(raw) -> dict:
    """Allow per-run runtime and model preferences without permitting arbitrary Runner selection or
    configuration injection.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("执行偏好必须是对象")
    out = {}
    kind = str(raw.get("agentKind") or "").strip().lower()
    if kind:
        if kind != "hosted" and not re.fullmatch(r"local:[a-z][a-z0-9-]{0,31}", kind):
            raise ValueError("执行底座不合法")
        out["agentKind"] = kind
    model = str(raw.get("model") or "").strip()
    if model:
        out["model"] = model[:160]
    reasoning = str(raw.get("reasoningEffort") or "").strip()
    if reasoning:
        from . import agent_execution_options
        out["reasoningEffort"] = agent_execution_options.normalize_reasoning_effort(
            reasoning, allow_empty=False)
    fallback = str(raw.get("fallbackMode") or "").strip().lower()
    if fallback:
        if fallback not in {"strict", "best-effort"}:
            raise ValueError("执行降级策略不合法")
        out["fallbackMode"] = fallback
    tags = raw.get("runnerTags") or []
    if tags:
        if not isinstance(tags, list):
            raise ValueError("执行机标签必须是数组")
        out["runnerTags"] = [str(x).strip()[:60] for x in tags[:20] if str(x).strip()]
    return out


def _execution_layer(raw: dict | None) -> dict:
    raw = dict(raw or {})
    nested = dict(raw.get("execution") or {})
    for key in ("agentKind", "model", "reasoningEffort", "fallbackMode", "runnerTags"):
        if key not in nested and key in raw:
            nested[key] = raw[key]
    return execution_preferences(nested)


def normalize_binding_execution(config: dict | None, workflow: dict | None) -> dict:
    """Validate and canonicalize project-level execution defaults and node overrides."""
    clean = dict(config or {})
    defaults = _execution_layer(clean)
    for key in ("agentKind", "model", "reasoningEffort", "fallbackMode", "runnerTags", "execution"):
        clean.pop(key, None)
    clean.update(defaults)

    definitions = {str(row.get("key") or ""): row
                   for row in list(dict(workflow or {}).get("nodes") or [])}
    raw_overrides = clean.pop("nodeOverrides", {}) or {}
    if not isinstance(raw_overrides, dict):
        raise ValueError("节点执行覆盖必须是对象")
    overrides = {}
    for node_key, raw in list(raw_overrides.items())[:100]:
        key = str(node_key or "").strip()
        definition = definitions.get(key)
        if definition is None:
            raise ValueError(f"节点执行覆盖引用了不存在的节点：{key or '（空）'}")
        if str(definition.get("type") or "") not in {"ai", "ai_review"}:
            raise ValueError(f"节点「{key}」不是 AI 节点，不能配置 Agent 或模型")
        if not isinstance(raw, dict):
            raise ValueError(f"节点「{key}」执行覆盖必须是对象")
        preference = _execution_layer(raw)
        if preference:
            overrides[key] = {"execution": preference}
    if overrides:
        clean["nodeOverrides"] = overrides
    return clean


def execution_route(run_context: dict, binding_config: dict, node_config: dict,
                    node_key: str = "") -> dict:
    """Resolve node execution precedence: manual retry override, project override, plugin node,
    then run/binding defaults. Explicit failed-gate overrides must outrank the original node
    declaration.
    """
    context = dict(run_context or {})
    manual = _execution_layer(dict(context.get("executionOverrides") or {}).get(str(node_key or "")))
    runtime = execution_preferences(context.get("execution"))
    binding = _execution_layer(binding_config)
    node = _execution_layer(node_config)
    overrides = dict(dict(binding_config or {}).get("nodeOverrides") or {})
    override = _execution_layer(overrides.get(str(node_key or "")))

    def pick(key, default=""):
        return (manual.get(key) or override.get(key) or node.get(key)
                or runtime.get(key) or binding.get(key) or default)

    agent_kind = str(pick("agentKind", "local:pi"))
    reasoning_effort = str(pick("reasoningEffort"))
    # reasoningEffort is a native Codex-only control.  A manual or project
    # override may switch an existing Codex node to Pi/OpenCode; inheriting the
    # lower layer's Codex effort makes that valid switch fail before dispatch.
    if agent_kind.strip().lower() != "local:codex":
        reasoning_effort = ""
    return {
        "agentKind": agent_kind,
        "model": str(pick("model")),
        "fallbackMode": str(pick("fallbackMode", "best-effort")),
        "reasoningEffort": reasoning_effort,
        "runnerTags": list(pick("runnerTags", []) or []),
        "manual": bool(manual),
    }
