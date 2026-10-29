"""Explicit consent for the one supported local-to-cloud Agent fallback."""
from fastapi import HTTPException

from ..agent_catalog import AGENTS


def clean_fallback(value):
    if (not isinstance(value, dict)
            or set(value) != {"fromAgentId", "toAgentId", "accepted"}
            or type(value.get("accepted")) is not bool or value["accepted"] is not True
            or not isinstance(value.get("fromAgentId"), str)
            or value["fromAgentId"] not in AGENTS or value["fromAgentId"] == "pi"
            or value.get("toAgentId") != "pi"):
        raise HTTPException(400, "只有明确同意后，才能将当前 Agent 的会话转由云端 Pi 继续")
    return {"fromAgentId": value["fromAgentId"], "toAgentId": "pi", "accepted": True}


def validate(source, options, target_agent):
    """Validate every fresh request; keep already pinned legacy transfers usable.

    targetSnapshot is server-generated after validation and cannot be supplied
    by a prepare caller. It permits old, explicitly chosen cross-Agent receipts
    to commit without changing their original request hash or destination.
    """
    fallback = options.get("agentFallback")
    source_agent = (source or {}).get("adapterId")
    if fallback is not None:
        fallback = clean_fallback(fallback)
        if (source_agent != fallback["fromAgentId"] or target_agent != "pi"
                or (source or {}).get("entryKind") == "cloud"):
            raise HTTPException(409, "Agent 变更确认与当前会话或目标不一致，请重新预览")
        return True
    if source_agent and target_agent != source_agent and not options.get("targetSnapshot"):
        raise HTTPException(409, "云端必须使用当前会话的 Agent；改用 Pi 需要先明确确认")
    return False


def requested_agent(source, options):
    agent = (options.get("agentId") or
             (options.get("assigneeId") or "").rsplit(":", 1)[-1] or
             (options.get("agentFallback") or {}).get("toAgentId") or source["adapterId"])
    validate(source, options, agent)
    return agent
