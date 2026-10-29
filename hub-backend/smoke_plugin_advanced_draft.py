"""Advanced employee plugin draft: routing, handoff and enterprise package parity."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///.smoke-plugin-advanced-draft.db"

from app.services import plugin_drafts, plugin_packages  # noqa: E402


TOTAL = 0


def chk(label: str, condition, detail=None) -> None:
    global TOTAL
    TOTAL += 1
    if not condition:
        raise AssertionError(f"{label}: {detail!r}")


def body(workflow: dict) -> dict:
    return {
        "template": "workflow", "key": "delivery-studio", "name": "交付工作室",
        "version": "0.1.0", "description": "多 Agent 完成交付与审查",
        "instructions": "完成一项可直接验收的工作，并保留完整证据。",
        "inputs": [
            {"key": "goal", "type": "string", "multiline": True,
             "label": "目标", "required": True},
            {"key": "level", "type": "select", "label": "级别",
             "options": ["团队", {"value": "company", "label": "公司"}],
             "default": "company"},
            {"key": "threshold", "type": "number", "label": "阈值", "default": 80},
        ],
        "skills": ["browser-use", "delivery-check"],
        "mcpServers": ["knowledge-base"],
        "runtimeCapabilities": ["browser", "repository"], "workflow": workflow,
        "evaluationInstruction": "完成一份代表性交付",
        "evaluationCriteria": ["成果可直接验收"],
    }


def graph() -> dict:
    return {"nodes": [
        {
            "key": "plan", "type": "ai", "name": "规划", "dependsOn": [],
            "outputs": [{"key": "plan", "kind": "evidence", "label": "计划"}],
            "config": {"prompt": "形成计划", "agentKind": "local:pi",
                       "model": "plan-model", "fallbackMode": "strict"},
        },
        {
            "key": "build", "type": "ai", "name": "实施", "dependsOn": ["plan"],
            "inputs": [{"key": "plan", "fromNode": "plan", "outputKey": "plan"}],
            "outputs": [{"key": "site", "kind": "file", "path": "dist/index.html",
                         "label": "完整网站"}],
            "config": {"prompt": "完成并自测", "agentKind": "local:codex",
                       "model": "build-model", "fallbackMode": "best-effort",
                       "runnerTags": ["windows"]},
            "capabilities": {
                "skills": ["browser-use"],
                "mcpServers": ["knowledge-base"],
                "runtime": ["browser", "repository"],
            },
        },
        {
            "key": "review", "type": "ai_review", "name": "AI 审查",
            "dependsOn": ["build"],
            "inputs": [{"key": "site", "fromNode": "build", "outputKey": "site"}],
            "outputs": [{"key": "verdict", "kind": "evidence", "label": "审查结论"}],
            "config": {"prompt": "独立审查", "agentKind": "local:opencode",
                       "model": "review-model"},
        },
        {"key": "accept", "type": "human_review", "name": "人工验收",
         "dependsOn": ["review"], "config": {"action": "uat"}},
        {"key": "complete", "type": "publish", "name": "办结沉淀",
         "dependsOn": ["accept"], "config": {"message": "已办结"}},
    ]}


parsed = plugin_packages.parse(plugin_drafts.build(body(graph())))
chk("public inputs normalized", parsed["manifest"]["inputs"][0]["type"] == "textarea"
    and parsed["manifest"]["inputs"][1]["default"] == "company"
    and parsed["manifest"]["inputs"][2]["default"] == 80,
    parsed["manifest"]["inputs"])
nodes = parsed["workflow"]["nodes"]
chk("manifest declares own and external skills",
    parsed["manifest"]["capabilities"]["skills"] ==
    ["browser-use", "delivery-check", "delivery-studio"],
    parsed["manifest"]["capabilities"])
chk("preserves all advanced nodes", [node["key"] for node in nodes] ==
    ["plan", "build", "review", "accept", "complete"], nodes)
build_node = next(node for node in nodes if node["key"] == "build")
plan_node = next(node for node in nodes if node["key"] == "plan")
chk("default node receives all declared skills",
    plan_node["capabilities"]["skills"] ==
    ["browser-use", "delivery-check", "delivery-studio"],
    plan_node["capabilities"])
chk("node subset still receives own skill",
    build_node["capabilities"]["skills"] == ["browser-use", "delivery-studio"],
    build_node["capabilities"])
chk("preserves per-node agent", build_node["config"]["agentKind"] == "local:codex", build_node)
chk("preserves per-node model", build_node["config"]["model"] == "build-model", build_node)
chk("preserves runner tags", build_node["config"]["runnerTags"] == ["windows"], build_node)
chk("preserves typed handoff", build_node["inputs"][0]["fromNode"] == "plan" and
    build_node["outputs"][0]["path"] == "dist/index.html", build_node)
chk("evaluation follows actual contracts",
    parsed["manifest"]["evaluations"][0]["expectedOutputs"] ==
    ["build.site", "plan.plan", "review.verdict"], parsed["manifest"]["evaluations"])

preview = plugin_packages.public_summary(parsed)
personal = preview["personalDraft"]
chk("safe workflow remains editable on client", len(personal["workflow"]["nodes"]) == 5, personal)
chk("personal draft keeps route", personal["workflow"]["nodes"][1]["config"]["model"] ==
    "build-model", personal["workflow"])
chk("personal draft keeps public inputs",
    personal["inputs"] == parsed["manifest"]["inputs"], personal["inputs"])
chk("personal draft keeps external skill dependencies",
    personal["skills"] == ["browser-use", "delivery-check"], personal["skills"])

release_graph = {"nodes": [
    {"key": "readiness", "type": "ai", "name": "上线材料核对", "outputs": [
        {"key": "decision", "kind": "decision", "path": "release-decision.json"}],
     "config": {"prompt": "核对已合并固定版本和回滚依据"}},
    {"key": "approval", "type": "approval", "name": "发布审批",
     "dependsOn": ["readiness"], "config": {"action": "deploy"}},
    {"key": "release", "type": "deploy_chain", "name": "企业发布链",
     "dependsOn": ["approval"], "config": {}},
    {"key": "verify", "type": "validate", "name": "上线核对",
     "dependsOn": ["release"],
     "config": {"deployVerify": True, "shaCheck": True, "http": []}},
    {"key": "complete", "type": "publish", "name": "归档回执",
     "dependsOn": ["verify"], "config": {"message": "上线完成"}},
]}
release_body = body(release_graph)
release_body.update({
    "key": "standalone-release", "name": "独立上线",
    "distribution": "standalone",
    "entrypoints": {"conversation": False, "task": True, "automation": True},
})
release_parsed = plugin_packages.parse(plugin_drafts.build(release_body))
chk("personal publication preserves enterprise release nodes",
    [node["type"] for node in release_parsed["workflow"]["nodes"]] ==
    ["ai", "approval", "deploy_chain", "validate", "publish"], release_parsed["workflow"])
release_personal = plugin_packages.public_summary(release_parsed)["personalDraft"]
chk("cross-device personal import keeps the complete release workflow",
    [node["type"] for node in release_personal["workflow"]["nodes"]] ==
    ["ai", "approval", "deploy_chain", "validate", "publish"], release_personal)
release_roundtrip = plugin_packages.parse(plugin_drafts.build(release_personal))
chk("rebuilding an imported release plugin keeps enterprise nodes",
    [node["type"] for node in release_roundtrip["workflow"]["nodes"]] ==
    ["ai", "approval", "deploy_chain", "validate", "publish"], release_roundtrip["workflow"])
chk("standalone release remains a normal independently governed plugin",
    release_parsed["manifest"]["key"] == "standalone-release" and
    release_parsed["manifest"]["distribution"] == "standalone" and
    release_personal["distribution"] == "standalone" and
    release_parsed["manifest"]["entrypoints"]["task"], release_parsed["manifest"])

bad = graph()
bad["nodes"][1]["config"]["runnerId"] = "runner-trial"
try:
    plugin_drafts.build(body(bad))
except ValueError as exc:
    chk("concrete runner rejected", "不能绑定具体机器" in str(exc), str(exc))
else:
    raise AssertionError("concrete runner was accepted")

bad = graph()
bad["nodes"][1]["config"]["apiToken"] = "real-secret"
try:
    plugin_drafts.build(body(bad))
except ValueError as exc:
    chk("embedded secret rejected", "不能保存密码" in str(exc), str(exc))
else:
    raise AssertionError("embedded secret was accepted")
future = graph()
future["nodes"][1]["config"]["agentKind"] = "local:future-agent"
future_parsed = plugin_packages.parse(plugin_drafts.build(body(future)))
chk("portable future agent accepted",
    future_parsed["workflow"]["nodes"][1]["config"]["agentKind"] ==
    "local:future-agent")


bad = graph()
bad["nodes"][1]["config"]["agentKind"] = "runner:someone:pi"
try:
    plugin_packages.parse(plugin_drafts.build(body(bad)))
except ValueError as exc:
    chk("unsupported agent rejected", "不支持的 Agent" in str(exc) or
        "Agent 不受支持" in str(exc), str(exc))
else:
    raise AssertionError("unsupported agent was accepted")

bad_body = body(graph())
bad_body["inputs"] = [{"key": "apiToken", "type": "text", "label": "Token"}]
try:
    plugin_drafts.build(bad_body)
except ValueError as exc:
    chk("credential input rejected", "不能收集凭据" in str(exc), str(exc))
else:
    raise AssertionError("credential public input was accepted")

bad_body = body(graph())
bad_body["inputs"] = [{
    "key": "note", "type": "text", "label": "备注",
    "default": "token=very-secret-value",
}]
try:
    plugin_drafts.build(bad_body)
except ValueError as exc:
    chk("credential default rejected", "疑似包含凭据" in str(exc), str(exc))
else:
    raise AssertionError("credential default was accepted")

bad_body = body(graph())
bad_body["inputs"] = [{
    "key": "threshold", "type": "number", "label": "阈值",
    "default": float("nan"),
}]
try:
    plugin_drafts.build(bad_body)
except ValueError as exc:
    chk("non-finite number rejected", "必须是数字" in str(exc), str(exc))
else:
    raise AssertionError("non-finite public input was accepted")

print(f"advanced plugin draft smoke: {TOTAL}/{TOTAL} passed")
