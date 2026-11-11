"""Static contract regression tests for the built-in agent product-design plugin."""
from __future__ import annotations

import json
import os
from pathlib import Path

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./.smoke-agent-product-design.db"

from app.services import plugin_packages


ROOT = Path(__file__).resolve().parent.parent.parent
PLUGIN = ROOT / "hub-backend" / "plugins" / "product-prototype.json"
SKILL = ROOT / "skills" / "agent-product-design" / "SKILL.md"

passed = 0
failed = 0


def check(name: str, ok: bool, detail=None) -> None:
    global passed, failed
    if ok:
        passed += 1
        print("[PASS]", name)
    else:
        failed += 1
        print("[FAIL]", name, detail if detail is not None else "")


raw = json.loads(PLUGIN.read_text(encoding="utf-8"))
manifest, workflow, report = plugin_packages.normalize(raw)
nodes = {node["key"]: node for node in workflow["nodes"]}

check("插件以智能体产品设计对外呈现",
      manifest["key"] == "product-prototype"
      and manifest["name"] == "智能体产品设计"
      and manifest["version"] == "2.0.2", manifest)
check("插件使用项目自有产品设计方法",
      set(report["skills"]) == {"agent-product-design"},
      report.get("skills"))
check("插件声明浏览器与文件运行能力",
      set(report["runtime"]) == {"browser", "files"}, report.get("runtime"))
check("流程包含定义、原型、独立审查和人工验收",
      [nodes[key]["type"] for key in
       ("define", "prototype", "experience-review", "review", "publish")]
      == ["ai", "ai", "ai_review", "human_review", "publish"])

for key in ("define", "prototype", "experience-review"):
    config = nodes[key]["config"]
    check(f"{key} 使用 Codex 高能力模型",
          config.get("agentKind") == "local:codex"
          and config.get("model") == "gpt-5.6-sol", config)

check("产品定义同时交付需求与智能体契约",
      {item["path"] for item in nodes["define"]["outputs"]}
      == {"requirements.md", "agent-design.md"})
check("原型节点交付固定单文件",
      nodes["prototype"]["outputs"][0]["path"] == "prototype.html")
check("独立审查交付可追踪结论",
      nodes["experience-review"]["outputs"][0]["path"]
      == "reviews/agent-product-review.md")

prototype_prompt = nodes["prototype"]["config"]["prompt"]
for phrase in ("目标与完成标准", "权限或人审门禁", "失败后重试", "人工接管"):
    check(f"原型提示包含 {phrase}", phrase in prototype_prompt, prototype_prompt)

rules = nodes["validate"]["config"]["rules"]
check("自动检查三类核心文件和离线性",
      {item.get("nameEquals") or item.get("file") for item in rules}
      == {"requirements.md", "agent-design.md", "prototype.html"}
      and any(item["type"] == "html-self-contained" for item in rules), rules)

skill_text = SKILL.read_text(encoding="utf-8")
check("Skill 无模板占位符", "TODO" not in skill_text, skill_text[:300])
for phrase in ("permissions", "human gates", "evidence", "retry", "prototype.html"):
    check(f"Skill 覆盖 {phrase}", phrase in skill_text, phrase)

print(f"\nagent product design smoke: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
