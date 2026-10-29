# -*- coding: utf-8 -*-
"""Verify direct capabilities remain direct calls while complex plugin orchestration retains DAG
semantics.
"""
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./.smoke-plugin-capability-package.db"
sys.path.insert(0, BASE)

from app.services import plugin_compat, plugin_drafts, plugin_packages, plugin_runtime  # noqa: E402

ok = fail = 0


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:260] if extra else ""))


def direct_manifest(**changes):
    value = {
        "schemaVersion": 1,
        "key": "weekly-brief",
        "version": "1.0.0",
        "name": "团队周报整理",
        "instructions": "依据真实工作事实整理周报，不得虚构。",
        "capabilities": {"skills": ["weekly-report"], "mcpServers": []},
    }
    value.update(changes)
    return value


manifest, workflow, report = plugin_packages.normalize(direct_manifest())
chk("直接能力包保留作者 Instructions", manifest["instructions"].startswith("依据真实"))
chk("直接能力包默认开放对话和任务", manifest["entrypoints"] == {
    "conversation": True, "task": True, "automation": False})
chk("能力报告明确 direct，不冒充工作流",
    report["hasWorkflow"] is False and report["executionMode"] == "direct", report)
chk("运行时只在内部降级为一个可恢复执行单元",
    len(workflow["nodes"]) == 1 and workflow["nodes"][0]["key"] == "execute", workflow)
chk("内部执行单元保留最小能力",
    workflow["nodes"][0]["capabilities"]["skills"] == ["weekly-report"], workflow)
chk("内部执行单元声明可验证结果",
    workflow["nodes"][0]["outputs"][0]["kind"] == "evidence", workflow)
chk("能力包报告列出真实组件而不暴露内部执行单元",
    [item["kind"] for item in report["components"]] == [
        "instructions", "skills", "contract"],
    report["components"])
chk("无外部连接的直接能力包为低风险",
    report["permissionSummary"]["riskLevel"] == "low"
    and report["permissionSummary"]["reasons"] == [], report["permissionSummary"])

skill_only = direct_manifest(instructions="", capabilities={
    "skills": ["requirements-analysis"], "mcpServers": []})
_, _, skill_report = plugin_packages.normalize(skill_only)
chk("只有 Skill 的能力包也可直接安装", skill_report["executionMode"] == "direct")

runtime_only = direct_manifest(instructions="", capabilities={
    "runtime": ["browser-use", "computer"], "mcpServers": []})
runtime_manifest, runtime_workflow, runtime_report = plugin_packages.normalize(runtime_only)
chk("基础执行能力使用稳定标识并规范别名",
    runtime_manifest["capabilities"]["runtime"] == ["browser", "computer"],
    runtime_manifest["capabilities"])
chk("运行能力进入组件和 Runner 依赖摘要",
    any(x["kind"] == "runtime" and x["count"] == 2
        for x in runtime_report["components"])
    and runtime_report["dependencies"]["runtime"] == ["browser", "computer"],
    runtime_report)
chk("操作电脑能力进入高风险审查",
    runtime_report["permissionSummary"]["riskLevel"] == "high",
    runtime_report["permissionSummary"])
chk("直接能力内部执行单元保留运行能力子集",
    plugin_runtime.node_capabilities(
        runtime_workflow["nodes"][0], runtime_report)["runtime"] == ["browser", "computer"])

try:
    plugin_packages.normalize(direct_manifest(instructions="", capabilities={}))
    chk("空能力包必须拒绝", False)
except ValueError as exc:
    chk("空能力包必须拒绝", "必须声明" in str(exc), exc)

try:
    plugin_packages.normalize(direct_manifest(entrypoints={
        "conversation": False, "task": False, "automation": False}))
    chk("没有任何入口的能力包必须拒绝", False)
except ValueError as exc:
    chk("没有任何入口的能力包必须拒绝", "至少要开放" in str(exc), exc)

try:
    plugin_packages.normalize(direct_manifest(
        key="bad-runtime",
        capabilities={"runtime": ["browser"]},
        workflow={"nodes": [{
            "key": "work", "type": "ai",
            "config": {"prompt": "完成工作"},
            "capabilities": {"runtime": ["computer"]},
        }]}))
    chk("节点不能越权申请插件未声明的运行能力", False)
except ValueError as exc:
    chk("节点不能越权申请插件未声明的运行能力",
        "运行能力" in str(exc) and "computer" in str(exc), exc)

workflow_manifest = direct_manifest(
    key="delivery-flow",
    entrypoints={"conversation": True, "task": True, "automation": True},
    workflow={"nodes": [{
        "key": "implement", "type": "ai", "name": "实现",
        "config": {"prompt": "完成实现并自测", "timeoutSeconds": 600},
    }]})
_, real_workflow, real_report = plugin_packages.normalize(workflow_manifest)
chk("真实工作流仍按 workflow 模式发布",
    real_report["hasWorkflow"] is True and real_report["executionMode"] == "workflow")
chk("真实工作流不被直接能力降级逻辑替换",
    real_workflow["nodes"][0]["key"] == "implement", real_workflow)

base_version = {
    "version": "1.0.0", "manifest": manifest,
    "workflow": workflow, "capabilities": report,
}
closed_task = {
    "version": "2.0.0",
    "manifest": {**manifest, "entrypoints": {
        "conversation": True, "task": False, "automation": False,
    }},
    "workflow": workflow, "capabilities": report,
}
compatibility = plugin_compat.between(base_version, closed_task)
chk("关闭已有任务入口被判定为破坏性升级",
    compatibility["level"] == "breaking"
    and any(item["code"] == "entrypoint.task_disabled"
            for item in compatibility["changes"]), compatibility)

runtime_upgrade = {
    "version": "1.1.0", "manifest": {
        **manifest, "capabilities": {
            **dict(manifest.get("capabilities") or {}), "runtime": ["browser"],
        },
    },
    "workflow": workflow,
    "capabilities": {**report, "runtime": ["browser"]},
}
runtime_compat = plugin_compat.between(base_version, runtime_upgrade)
chk("新增基础执行能力要求重新审查",
    runtime_compat["level"] == "review"
    and any(item["code"] == "capability.runtime_added"
            for item in runtime_compat["changes"]), runtime_compat)

evaluated = direct_manifest(evaluations=[{
    "key": "weekly-case", "name": "真实周报样例",
    "instruction": "根据提供的工作事实整理本周团队周报",
    "inputs": {"period": "2026-W33"},
    "criteria": ["不得虚构事实", "包含风险和下一步"],
    "expectedOutputs": ["execute.result"],
}])
eval_manifest, _, eval_report = plugin_packages.normalize(evaluated)
chk("发布评测与结果契约进入不可变版本",
    eval_manifest["evaluations"][0]["key"] == "weekly-case"
    and eval_report["qualitySummary"]["state"] == "declared"
    and eval_report["qualitySummary"]["caseCount"] == 1
    and eval_report["resultContract"][0]["id"] == "execute.result",
    eval_report.get("qualitySummary"))

try:
    plugin_packages.normalize(direct_manifest(evaluations=[{
        "key": "leak-case", "name": "错误样例", "instruction": "执行",
        "inputs": {"apiToken": "never-store-this"},
        "criteria": ["完成"],
    }]))
    chk("发布评测输入不能携带凭据字段", False)
except ValueError as exc:
    chk("发布评测输入不能携带凭据字段", "无凭据对象" in str(exc), exc)

published = plugin_packages.parse(plugin_drafts.build({
    "template": "method", "name": "网页巡检", "version": "0.1.0",
    "description": "巡检指定页面并交付证据",
    "instructions": "使用浏览器检查页面关键状态。",
    "runtimeCapabilities": ["browser-use"],
    "evaluationInstruction": "检查示例页面并形成结论",
    "evaluationCriteria": ["结论包含页面依据", "说明异常状态"],
}))
chk("个人插件上传企业不丢运行能力与评测",
    published["manifest"]["capabilities"]["runtime"] == ["browser"]
    and published["capabilities"]["qualitySummary"]["caseCount"] == 1,
    published["capabilities"])

workflow_draft = plugin_packages.parse(plugin_drafts.build({
    "template": "workflow", "name": "持续研发", "version": "0.1.0",
    "description": "把复杂研发工作按受控流程持续推进",
    "instructions": "理解、实施、验证、验收并沉淀证据。",
}))
chk("复杂工作流草稿默认不混入普通会话",
    workflow_draft["manifest"]["entrypoints"] == {
        "conversation": False, "task": True, "automation": True,
    }, workflow_draft["manifest"]["entrypoints"])

conversation_workflow = plugin_packages.parse(plugin_drafts.build({
    "template": "workflow", "name": "会话工作流", "version": "0.1.0",
    "description": "明确允许从普通会话启动的流程",
    "instructions": "在会话内容区收集输入后执行。",
    "entrypoints": {
        "conversation": True, "task": True, "automation": False,
    },
}))
chk("作者明确声明时保留普通会话入口",
    conversation_workflow["manifest"]["entrypoints"]["conversation"] is True,
    conversation_workflow["manifest"]["entrypoints"])

print(f"\n{ok} passed, {fail} failed")
raise SystemExit(1 if fail else 0)
