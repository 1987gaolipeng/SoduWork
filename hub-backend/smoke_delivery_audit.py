# -*- coding: utf-8 -*-
"""Contract tests for the read-only repository-delivery inspection plugin."""
import json
import os
import sys


BASE = os.path.dirname(os.path.abspath(__file__))
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./.smoke-delivery-audit.db"
sys.path.insert(0, BASE)

from app.services import plugin_packages, workflow_contracts  # noqa: E402


ok = fail = 0


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


path = os.path.join(BASE, "plugins", "delivery-audit.json")
with open(path, "r", encoding="utf-8") as stream:
    raw = json.load(stream)
with open(os.path.join(BASE, "app", "services", "plugin_bootstrap.py"),
          "r", encoding="utf-8") as stream:
    bootstrap_source = stream.read()

manifest, workflow, report = plugin_packages.normalize(raw)
nodes = workflow["nodes"]
by_key = {node["key"]: node for node in nodes}
inspect = by_key["inspect"]
validate = by_key["validate"]

chk("插件开放任务与自动化入口且不混入普通会话", manifest["entrypoints"] == {
    "conversation": False, "task": True, "automation": True,
}, manifest["entrypoints"])
chk("插件随 Hub 启动进入内置目录", '"delivery-audit.json"' in bootstrap_source)
chk("流程只有只读巡检、验货和交付", [node["type"] for node in nodes] == [
    "ai", "validate", "publish",
], nodes)
chk("不包含人工门禁、代码合并或环境部署", not ({
    "human_review", "spec", "merge", "deploy", "deploy_chain", "quality",
} & {node["type"] for node in nodes}), nodes)
chk("巡检使用 Codex 高能力模型", inspect["config"].get("agentKind") == "local:codex"
    and inspect["config"].get("model") == "gpt-5.6-sol"
    and inspect["config"].get("reasoningEffort") == "max", inspect["config"])
chk("插件与节点都只声明文件和终端能力", manifest["capabilities"].get("runtime") == [
    "files", "terminal",
] and inspect["capabilities"].get("runtime") == ["files", "terminal"],
    {"manifest": manifest["capabilities"], "node": inspect.get("capabilities")})
chk("仓库任务按文件交付触发 outputs-only 硬门禁",
    workflow_contracts.delivery_mode(inspect, True) == "files")

paths = [item.get("path") for item in inspect.get("outputs") or []]
chk("所有可写产出都收敛在 deliverables", paths == [
    "deliverables/delivery-audit.html", "deliverables/delivery-audit.json",
] and all(path.startswith("deliverables/") for path in paths), paths)
prompt = inspect["config"].get("prompt") or ""
chk("提示明确禁止工程副作用", all(text in prompt for text in (
    "禁止修改", "禁止提交", "禁止推送", "禁止合并", "禁止部署",
)), prompt)
chk("执行策略限制容器与验证次数",
    inspect["config"]["executionPolicy"]["containerOrchestration"] == "forbid"
    and inspect["config"]["executionPolicy"]["maxVerificationCommands"] == 4,
    inspect["config"]["executionPolicy"])

rules = validate["config"].get("rules") or []
chk("HTML 与 JSON 均有真实大小校验", {rule.get("nameEquals") for rule in rules
    if rule.get("type") == "file"} == set(paths), rules)
chk("HTML 还需通过离线自包含校验", any(
    rule.get("type") == "html-self-contained"
    and rule.get("file") == "deliverables/delivery-audit.html" for rule in rules), rules)
chk("声明两条发布评测", len(manifest.get("evaluations") or []) == 2
    and report["qualitySummary"]["state"] == "declared", report.get("qualitySummary"))
chk("评测结果只引用声明产出", all(set(case.get("expectedOutputs") or []) == {
    "inspect.report", "inspect.facts",
} for case in manifest.get("evaluations") or []), manifest.get("evaluations"))
chk("能力报告不含网络、密钥、MCP 或部署环境", not report.get("network")
    and report.get("secrets") == [] and report.get("mcpServers") == []
    and report.get("environments") == [], report)

print(f"\n{ok} passed, {fail} failed")
raise SystemExit(1 if fail else 0)
