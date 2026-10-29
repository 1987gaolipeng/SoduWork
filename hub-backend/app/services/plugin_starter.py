"""Deterministic starter package for enterprise workflow plugin authors."""
from __future__ import annotations

import io
import json
import zipfile


FILENAME = "soduwork-workflow-starter.soduwork-plugin"


def manifest() -> dict:
    """Return a valid multi-agent workflow that demonstrates every core contract."""
    return {
        "schemaVersion": 1,
        "key": "enterprise-workflow-starter",
        "version": "1.0.0",
        "name": "企业工作流起步模板",
        "description": "演示类型化交接、逐节点最小权限、独立 AI 审查与人工验收。",
        "locales": {
            "zh-CN": {"name": "企业工作流起步模板", "description": "演示类型化交接、逐节点最小权限、独立 AI 审查与人工验收。",
                      "inputs": {"goal": {"label": "业务目标", "description": "说明要解决的问题、完成标准与边界。"}}},
            "en-US": {"name": "Enterprise Workflow Starter", "description": "Typed handoffs, per-node permissions, independent AI review and human acceptance.",
                      "inputs": {"goal": {"label": "Business goal", "description": "Describe the problem, acceptance criteria and boundaries."}}},
        },
        "author": "你的团队",
        "inputs": [
            {
                "key": "goal",
                "type": "string",
                "label": "业务目标",
                "description": "说明要解决的问题、完成标准与边界。",
                "multiline": True,
            },
        ],
        "capabilities": {
            "skills": [],
            "mcpServers": [],
            "secrets": [],
            "network": False,
        },
        "workflow": {
            "nodes": [
                {
                    "key": "understand",
                    "type": "ai",
                    "name": "理解与规划",
                    "config": {
                        "prompt": (
                            "理解任务目标、现状和完成标准，形成可执行计划。"
                            "把计划写入 deliverables/plan.md，不要只在对话里描述。"
                        ),
                        "timeoutSeconds": 3600,
                    },
                    "capabilities": {
                        "skills": [], "mcpServers": [], "secrets": [], "network": False,
                    },
                    "outputs": [
                        {"key": "plan", "kind": "file", "path": "deliverables/plan.md",
                         "label": "执行计划", "required": True},
                    ],
                },
                {
                    "key": "implement",
                    "type": "ai",
                    "name": "实现与自测",
                    "dependsOn": ["understand"],
                    "inputs": [
                        {"key": "plan", "fromNode": "understand", "outputKey": "plan",
                         "label": "已确认计划", "required": True},
                    ],
                    "config": {
                        "prompt": (
                            "依据上游计划完成实现和自测。工程任务提交到工作分支；"
                            "不要返回替代仓库提交的压缩包。"
                        ),
                        "timeoutSeconds": 3600,
                    },
                    "capabilities": {
                        "skills": [], "mcpServers": [], "secrets": [], "network": False,
                    },
                    "outputs": [
                        {"key": "change", "kind": "git", "label": "代码提交",
                         "required": True},
                    ],
                    "retry": {"maxAttempts": 2},
                },
                {
                    "key": "review",
                    "type": "ai_review",
                    "name": "独立 AI 审查",
                    "dependsOn": ["implement"],
                    "inputs": [
                        {"key": "change", "fromNode": "implement", "outputKey": "change",
                         "label": "待审代码", "required": True},
                    ],
                    "config": {
                        "prompt": (
                            "独立审查正确性、安全性、可维护性和验收标准。"
                            "将结构化结论写入 code-review.json。"
                        ),
                        "timeoutSeconds": 3600,
                    },
                    "capabilities": {
                        "skills": [], "mcpServers": [], "secrets": [], "network": False,
                    },
                    "outputs": [
                        {"key": "verdict", "kind": "decision", "path": "code-review.json",
                         "label": "审查结论", "required": True},
                    ],
                },
                {
                    "key": "accept",
                    "type": "human_review",
                    "name": "业务验收",
                    "dependsOn": ["review"],
                    "inputs": [
                        {"key": "verdict", "fromNode": "review", "outputKey": "verdict",
                         "label": "AI 审查结论", "required": True},
                    ],
                    "config": {"action": "uat", "summary": "确认成果符合业务目标"},
                },
                {
                    "key": "publish",
                    "type": "publish",
                    "name": "交付回执",
                    "dependsOn": ["accept"],
                    "config": {"message": "工作流已完成，成果和证据已归档。"},
                },
            ],
        },
    }


def build() -> bytes:
    """Build a byte-stable archive so the same starter has one package identity."""
    files = {
        "plugin.json": json.dumps(manifest(), ensure_ascii=False, indent=2) + "\n",
        "README.md": (
            "# SoduWork 企业工作流起步模板\n\n"
            "1. 修改 key、version、name 与 prompt。\n"
            "2. 先在插件级 capabilities 声明能力，再为每个 AI 节点选择最小子集。\n"
            "3. 用 outputs + inputs 显式传递跨 Agent 上下文。\n"
            "4. Agent、模型、Runner 标签在 SoduWork 绑定页按企业环境配置，不写死在包里。\n"
            "5. 重新压缩为 .soduwork-plugin，先预检，再导入隔离区。\n"
        ),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, files[name].encode("utf-8"))
    return buf.getvalue()
