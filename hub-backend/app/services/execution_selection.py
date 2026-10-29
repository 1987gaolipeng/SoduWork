"""Credential-free, explicit per-turn Agent/model selection."""
from __future__ import annotations

from ..agent_catalog import AGENTS
from . import agent_execution_options


class SelectionError(ValueError):
    def __init__(self, message, code="EXECUTION_SELECTION_INVALID"):
        super().__init__(message)
        self.code = code


def normalize(value):
    if not isinstance(value, dict) or set(value) - {"agentId", "modelName", "reasoningEffort"}:
        raise SelectionError("执行选择格式不正确")
    out = {}
    for key, limit in (("agentId", 80), ("modelName", 160), ("reasoningEffort", 24)):
        item = value.get(key, "")
        if not isinstance(item, str) or len(item) > limit or any(ord(c) < 32 for c in item):
            raise SelectionError("执行选择字段不正确：" + key)
        out[key] = item.strip()
    if out["agentId"] not in AGENTS:
        raise SelectionError("此 Agent 尚不受支持")
    try:
        native = agent_execution_options.runtime_options(
            "local:" + out["agentId"], out["modelName"], out["reasoningEffort"])
    except ValueError as exc:
        raise SelectionError(str(exc)) from exc
    out["reasoningEffort"] = native.get("reasoningEffort", "")
    return out


def current(run):
    return {"agentId": str(run.get("cli") or ""), "modelName": str(run.get("model") or ""),
            "reasoningEffort": str(run.get("reasoningEffort") or "")}


def busy(run):
    return bool(run.get("state") in {"running", "recovering", "starting", "queued", "dispatching"}
                or run.get("queue") or run.get("stopping") or run.get("detached")
                or run.get("permissionWaiting") or run.get("pendingPermissions")
                or run.get("_accessTransition") or run.get("contextCompacting"))


def require_idle(run):
    if busy(run):
        raise SelectionError("请等待当前轮次及排队消息完成，或停止后再切换 Agent 和模型", "EXECUTION_SWITCH_BUSY")
