# -*- coding: utf-8 -*-
"""Pure-function regressions for task execution options: filter workflows by project and scenario,
deduplicate the same CLI on one machine, and select execution backends by capability rather than
display name. Do not connect to a database, Hub, or Runner.
"""
import asyncio
import os
import sys
from types import SimpleNamespace

# ai_exec type imports load the database module, so configure an isolated database explicitly.
# Do not rely on the development machine's .env even when no connection is opened.
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

sys.path.insert(0, ".")

from app.services import (ai_exec, model_catalog, plugin_service,  # noqa: E402
                          task_execution_options as options, tasks as task_service)


ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


local = {
    "id": "local:pi", "cli": "pi", "cliName": "Pi",
    "host": "DESKTOP-ONE", "machineKey": "host:desktop-one",
    "machineLabel": "研发电脑",
}
runner = {
    "id": "runner:r-1:pi", "cli": "pi", "cliName": "Pi",
    "host": "DESKTOP-ONE", "runnerId": "r-1",
    "machineKey": "host:desktop-one", "machineLabel": "研发电脑",
    "capabilities": {"available": ["files", "terminal", "repository"]},
    "busy": False, "runnerBusy": 2,
}
other = {
    "id": "runner:r-2:pi", "cli": "pi", "cliName": "Pi",
    "host": "BUILD-ONE", "runnerId": "r-2",
    "machineKey": "host:build-one", "machineLabel": "构建机",
    "capabilities": {"available": ["files", "terminal"]},
}

deduped = ai_exec.dedupe_agents([local, runner, dict(runner), other])
chk("同一台机器同一 CLI 只保留一个席位", len(deduped) == 2, deduped)
chk("同席位优先保留可远程调度的 Runner", deduped[0]["id"] == "runner:r-1:pi", deduped)
chk("另一台机器上的同类 CLI 仍是独立席位",
    any(item["id"] == "runner:r-2:pi" for item in deduped), deduped)

flows = [
    {"bindingId": "global-office", "key": "ai-errand", "name": "AI 零活"},
    {"bindingId": "global-prototype", "key": "product-prototype", "name": "产品原型"},
    {"bindingId": "project-default", "key": "project-release", "name": "项目交付",
     "projectSpecific": True, "isDefault": True},
    {"bindingId": "project-fix", "key": "bug-fix", "name": "缺陷修复",
     "projectSpecific": True},
    {"bindingId": "project-blocked", "key": "blocked-fix", "name": "Blocked flow",
     "projectSpecific": True, "isDefault": True, "runnable": False,
     "readiness": {"blockers": ["not approved"]}},
]

project_flows = options.select_workflows(flows, "project-1", "product-prototype")
chk("选工程后保留该工程绑定并可附带语义匹配的组织流程",
    [item["bindingId"] for item in project_flows] ==
    ["project-default", "global-prototype", "project-fix", "project-blocked"], project_flows)
chk("工程默认流程排在第一并标记推荐",
    project_flows[0].get("recommended") is True, project_flows)

chk("blocked project defaults are never recommended",
    project_flows[-1]["bindingId"] == "project-blocked" and
    project_flows[-1].get("recommended") is False and
    project_flows[-1].get("runnable") is False, project_flows)

runnable_flows, blocked_flows = options.partition_workflows(project_flows)
chk("execution options expose only runnable workflows to selectors",
    all(item.get("runnable", True) for item in runnable_flows) and
    [item["bindingId"] for item in blocked_flows] == ["project-blocked"],
    {"workflows": runnable_flows, "blockedWorkflows": blocked_flows})

chk("managed work never falls back to a direct Agent",
    options.recommended_strategy(
        None, {"key": "local:codex"}, True, "project-validation-release") == "blocked")
chk("managed work selects a ready workflow",
    options.recommended_strategy(
        {"bindingId": "ready"}, {"key": "local:codex"}, True,
        "project-validation-release") == "workflow")
chk("ordinary office work may use a direct Agent",
    options.recommended_strategy(
        None, {"key": "local:pi"}, False, "ai-errand") == "direct")

office_flows = options.select_workflows(flows, "", "ai-errand")
chk("不选工程时只出现当前场景匹配的组织流程",
    [item["bindingId"] for item in office_flows] == ["global-office"], office_flows)
chk("没有匹配场景时不拿无关工作流兜底",
    options.select_workflows(flows, "", "research-analysis") == [])

substrates = options.substrate_options(deduped, ["repository"])
async def _parser_flow_choices():
    original = plugin_service.available_bindings

    async def _available(_session, _task):
        return [
            {"bindingId": "ready", "key": "ready-flow", "name": "Ready",
             "runnable": True},
            {"bindingId": "blocked", "key": "blocked-flow", "name": "Blocked",
             "runnable": False},
        ]

    plugin_service.available_bindings = _available
    try:
        return await task_service._flow_choices(
            None, SimpleNamespace(id="client-1"))
    finally:
        plugin_service.available_bindings = original


parser_flows = asyncio.run(_parser_flow_choices())
chk("task parser only sees bindings that can really run",
    [item["key"] for item in parser_flows] == ["ready-flow"], parser_flows)

pi = next(item for item in substrates if item["cli"] == "pi")
chk("底座按 CLI 类型聚合，不把具体 Runner id 写进任务", pi["key"] == "local:pi", pi)
chk("只要一个在线席位具备所需能力，该底座即可选", pi["available"] is True, pi)
chk("聚合结果保留真实在线机器数量", pi["onlineSeats"] == 2, pi)
chk("canonical CLI label is stable", pi["name"] == "Pi", pi)
chk("model selection support is exposed by CLI kind", pi["modelPick"] is True, pi)
chk("capability sets remain available for exact plugin matching",
    any("repository" in item for item in pi["capabilitySets"]), pi)
chk("machine-wide load does not mark every Agent kind busy",
    pi["busySeats"] == 0 and pi["runnerLoad"] == 2 and pi["available"] is True, pi)
chk("machine load is explained without blocking dispatch",
    "2" in pi["note"] and "仍可继续派发" in pi["note"], pi)

offline = dict(other)
offline.update({"id": "runner:r-off:pi", "runnerId": "r-off",
                "host": "OFFLINE", "machineKey": "host:offline",
                "machineLabel": "Offline machine", "online": False})
visible = options.substrate_options(deduped + [offline], [])
visible_pi = next(item for item in visible if item["cli"] == "pi")
chk("offline seats are excluded from execution choices",
    "Offline machine" not in visible_pi["machines"] and visible_pi["onlineSeats"] == 2, visible_pi)


browser = options.substrate_options(deduped, ["browser"])
chk("没有任何席位具备所需能力时明确不可选",
    browser and browser[0]["available"] is False, browser)


async def _catalog_choices():
    original = model_catalog.usable

    async def _usable(_session, _client=None):
        return [
            {"id": "company:real-default", "name": "real-default",
             "providerName": "共享模型服务", "keyFrom": "org"},
            {"id": "company:real-review", "name": "real-review",
             "providerName": "共享模型服务", "keyFrom": "org"},
        ]

    model_catalog.usable = _usable
    try:
        stale = await model_catalog.choices(None, None, "冒烟模型-A")
        valid = await model_catalog.choices(None, None, "real-review")
    finally:
        model_catalog.usable = original
    return stale, valid


stale_choices, valid_choices = asyncio.run(_catalog_choices())
chk("旧字符串候选不再混入派活器",
    stale_choices["default"] == "real-default" and
    stale_choices["list"] == ["real-review"] and
    "冒烟模型-A" not in str(stale_choices), stale_choices)
chk("仍然可用的管理员默认模型保持默认且不重复出现",
    valid_choices["default"] == "real-review" and
    valid_choices["list"] == ["real-default"], valid_choices)

print("\\ntask execution options smoke: %d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
