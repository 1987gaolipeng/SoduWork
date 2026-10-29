"""Remote-start choices reuse the Runner inventory and the owner's model catalog."""
from fastapi import HTTPException

from ..agent_catalog import AGENTS
from . import model_catalog, runner_hub


async def models(session, client):
    return [{"name": item["name"], "label": item.get("label") or item["name"]}
            for item in await model_catalog.usable(session, client)]


def agents(client, runner, choices):
    live = runner_hub.get(runner.id)
    inventory = getattr(live, "agents", None) if live else runner.agents
    result, seen = [], set()
    for item in runner_hub.clean_agent_inventory(inventory):
        key = str(item.get("key") or item.get("id") or "").split(":")[-1]
        declaration = AGENTS.get(key)
        if (not declaration or key in seen or item.get("installed") is False
                or str(item.get("auth") or "").lower() == "unauthed"):
            continue
        managed = declaration["modelMode"] == "managed"
        if managed and not choices:
            continue
        seen.add(key)
        selected = model_catalog.agent_model(client, key)
        effective = selected if any(row["name"] == selected for row in choices) else (choices[0]["name"] if choices else "")
        result.append({"id": key, "name": declaration["displayName"], "modelPick": managed,
                       "models": choices if managed else [], "modelEffective": effective if managed else ""})
    return result


async def validate_start(session, client, task, runner, options):
    from . import managed_work_route
    if managed_work_route.is_managed(task):
        raise HTTPException(409, "工程任务请先在 SoduWork 按审批流程启动")
    if runner.client_id != client.id or runner_hub.CLIENT_TAG not in (runner.tags or []):
        raise HTTPException(409, "首次远程启动仅支持当前账号设备内置的桌面执行机")
    available = agents(client, runner, await models(session, client))
    selected = next((item for item in available if item["id"] == options.get("agentId")), None)
    if not selected:
        raise HTTPException(409, "所选执行底座尚未就绪，请先在 SoduWork 检查安装与模型配置")
    model = options.get("model", "")
    if selected["modelPick"] and not any(item["name"] == model for item in selected["models"]):
        raise HTTPException(409, "请明确选择当前可用的执行模型")
    if not selected["modelPick"] and model:
        raise HTTPException(400, "此执行底座使用自身账号的默认模型")
