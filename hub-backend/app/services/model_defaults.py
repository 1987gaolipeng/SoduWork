"""Credential-free defaults for the conversation model picker.

Project the same choice as ai-proxy/config without issuing a proxy ticket or
changing an Agent preference. Missing explicit preferences must remain errors.
"""
from __future__ import annotations

from .agent_execution_options import GATEWAY_MODEL_KINDS
from .model_catalog import agent_model


def public_defaults(available: list[dict], client=None) -> dict:
    names = [str(row.get("name") or "").strip() for row in available]
    names = [name for name in names if name]
    default = names[0] if names else ""
    usable = set(names)
    defaults: dict[str, str] = {}
    errors: dict[str, str] = {}
    for kind in sorted(GATEWAY_MODEL_KINDS):
        adapter = kind.removeprefix("local:")
        preferred = agent_model(client, adapter)
        if preferred and preferred not in usable:
            defaults[adapter] = ""
            errors[adapter] = "该底座配置的默认模型当前不可用，请重新选择"
        else:
            defaults[adapter] = preferred or default
            if not defaults[adapter]:
                errors[adapter] = "暂无可用模型，请检查模型服务授权"
    return {"defaultModel": default, "defaultModels": defaults,
            "defaultModelErrors": errors}
