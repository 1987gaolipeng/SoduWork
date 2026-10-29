"""Portable execution-route declarations embedded in immutable plugin versions."""
from __future__ import annotations

import re


_LOCAL_AGENT_KIND = re.compile(r"local:[a-z0-9][a-z0-9-]{0,31}")
_FALLBACK_MODES = {"", "strict", "best-effort"}
_CONCRETE_FIELDS = {"runnerId", "hostId", "clientId", "machineId", "endpoint"}
_TAG = re.compile(r"[a-z0-9][a-z0-9._-]{0,39}")


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]

def valid_agent_kind(value) -> bool:
    """Accept portable agent types; concrete machines remain forbidden."""
    kind = _text(value, 40).lower()
    return kind in {"", "hosted"} or bool(_LOCAL_AGENT_KIND.fullmatch(kind))



def normalize(config: dict | None, node_key: str) -> dict:
    """Validate one AI node without binding a portable package to infrastructure."""
    clean = dict(config or {})
    nested = clean.get("execution") if isinstance(clean.get("execution"), dict) else {}
    concrete = sorted(_CONCRETE_FIELDS.intersection(clean) | _CONCRETE_FIELDS.intersection(nested))
    if concrete:
        raise ValueError(f"节点 {node_key} 不能绑定具体机器：{'、'.join(concrete)}")

    agent = _text(nested.get("agentKind") or clean.get("agentKind"), 40).lower()
    fallback = _text(nested.get("fallbackMode") or clean.get("fallbackMode"), 20).lower()
    if not valid_agent_kind(agent):
        raise ValueError(f"节点 {node_key} 的 Agent 不受支持：{agent}")
    if fallback not in _FALLBACK_MODES:
        raise ValueError(f"节点 {node_key} 的降级策略不受支持：{fallback}")
    if clean.get("model") is not None:
        clean["model"] = _text(clean.get("model"), 160)

    if "runnerTags" in clean:
        raw_tags = clean.get("runnerTags")
        if not isinstance(raw_tags, list) or len(raw_tags) > 12:
            raise ValueError(f"节点 {node_key} 的 runnerTags 必须是至多 12 项的数组")
        tags = []
        for raw in raw_tags:
            tag = _text(raw, 40).lower()
            if not _TAG.fullmatch(tag):
                raise ValueError(f"节点 {node_key} 的 Runner 标签不合法：{tag or '（空）'}")
            if tag not in tags:
                tags.append(tag)
        clean["runnerTags"] = tags
    return clean
