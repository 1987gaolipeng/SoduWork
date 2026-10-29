"""Auditable role and AI-workflow coverage for SoduWork's product tests."""
from __future__ import annotations

from pathlib import Path
from public_source import is_public_snapshot


ROLE_COVERAGE = {
    "solution_consultant": {"label": "方案顾问", "positive": ("smoke_work_catalog.py",),
                            "boundary": ("smoke_work_catalog.py",)},
    "product_manager": {"label": "产品经理", "positive": ("smoke_work_catalog.py",),
                        "boundary": ("smoke_work_catalog.py",)},
    "designer": {"label": "设计师", "positive": ("smoke_work_catalog.py",),
                 "boundary": ("smoke_work_catalog.py",)},
    "researcher": {"label": "研究员", "positive": ("smoke_work_catalog.py",),
                   "boundary": ("smoke_work_catalog.py",)},
    "data_analyst": {"label": "数据分析师", "positive": ("smoke_work_catalog.py",),
                     "boundary": ("smoke_work_catalog.py",)},
    "software_engineer": {"label": "软件工程师", "positive": ("smoke_work_catalog.py",),
                          "boundary": ("smoke_work_catalog.py",)},
    "quality_engineer": {"label": "质量工程师", "positive": ("smoke_work_catalog.py",),
                         "boundary": ("smoke_work_catalog.py",)},
    "delivery_operator": {"label": "交付运维", "positive": ("smoke_work_catalog.py",),
                          "boundary": ("smoke_work_catalog.py",)},
    "office_worker": {"label": "综合办公人员", "positive": ("smoke_work_catalog.py",),
                      "boundary": ("smoke_work_catalog.py",)},
    "requester": {"label": "需求提出人", "positive": ("smoke_golden_delivery.py",),
                  "boundary": ("smoke_golden_delivery.py",)},
    "task_owner": {"label": "任务创建/承接人",
                   "positive": ("../client/e2e/user-journeys.mjs", "smoke_task_transfer.py"),
                   "boundary": ("smoke_golden_delivery.py",)},
    "team_lead": {"label": "团队负责人", "positive": ("smoke_task_transfer.py",),
                  "boundary": ("smoke_task_transfer.py",)},
    "project_owner": {"label": "项目负责人", "positive": ("smoke_golden_delivery.py",),
                     "boundary": ("smoke_golden_delivery.py",)},
    "ai_executor": {"label": "AI 执行者", "positive": ("smoke_execution_sessions.py",),
                    "boundary": ("smoke_failure_exit.py", "smoke_noask.py")},
    "ai_reviewer": {"label": "独立 AI 审查者", "positive": ("smoke_ai_review.py",),
                    "boundary": ("smoke_ai_review.py",)},
    "workflow_engine": {"label": "工作流编排器", "positive": ("smoke_golden_delivery.py",),
                       "boundary": ("smoke_workflow_adoption.py", "smoke_rework_guard.py")},
    "runner_executor": {"label": "Runner 执行节点", "positive": ("smoke_execution_sessions.py",),
                       "boundary": ("smoke_runner_route.py", "smoke_stall_watch.py")},
    "release_authorizer": {"label": "发布授权人", "positive": ("smoke_golden_delivery.py",),
                           "boundary": ("smoke_golden_delivery.py",)},
    "business_acceptor": {"label": "业务验收人", "positive": ("smoke_golden_delivery.py",),
                          "boundary": ("smoke_golden_delivery.py", "smoke_rework_guard.py")},
    "org_identity_admin": {"label": "组织/身份管理员", "positive": ("smoke_identity.py",),
                           "boundary": ("smoke_admin_security.py",
                                        "smoke_identity.py")},
    "workflow_plugin_admin": {"label": "工作流/插件管理员",
                              "positive": ("smoke_plugins.py", "smoke_project_setup.py"),
                              "boundary": ("smoke_plugin_ready.py",)},
    "environment_admin": {"label": "环境管理员", "positive": ("smoke_environment_config.py",),
                          "boundary": ("smoke_deploy_assert.py", "smoke_environment_config.py")},
    "runner_admin": {"label": "Runner 管理员", "positive": ("smoke_runner_management.py",),
                     "boundary": ("smoke_runner_key.py",)},
    "auditor": {"label": "审计人员", "positive": ("smoke_audit_scope.py",),
                "boundary": ("smoke_audit_scope.py", "smoke_log_safety.py")},
    "super_admin": {"label": "超级管理员", "positive": ("smoke_audit_scope.py",),
                    "boundary": ("smoke_golden_delivery.py",)},
}


WORKFLOW_SCENE_COVERAGE = {
    "solution_design": {"label": "方案策划与专业材料",
                        "deterministic": ("smoke_work_catalog.py",), "live": ()},
    "product_prototype": {"label": "需求整理与可交互原型",
                          "deterministic": ("smoke_work_catalog.py",), "live": ()},
    "research_analysis": {"label": "证据型研究与分析",
                          "deterministic": ("smoke_work_catalog.py",), "live": ()},
    "professional_software_work": {"label": "职业驱动的软件研发工作",
                                   "deterministic": ("smoke_work_catalog.py",), "live": ()},
    "conversation": {"label": "临时对话与直接办公",
                     "deterministic": ("smoke_conversation_ui.py", "../client/e2e/user-journeys.mjs"),
                     "live": ("smoke_ai_proxy.py",)},
    "human_collaboration": {"label": "认领、派发与人际转交",
                            "deterministic": ("smoke_task_transfer.py", "smoke_handoff.py"),
                            "live": ()},
    "direct_ai": {"label": "任务直接交给任意 Agent 底座",
                  "deterministic": ("smoke_ai_errand.py", "smoke_task_ai.py"),
                  "live": ("smoke_execution_live.py", "smoke_runner_job.py")},
    "business_workflow": {"label": "非研发 AI 工作流",
                          "deterministic": ("smoke_plugins.py", "smoke_plugin_ready.py"),
                          "live": ("smoke_plugin_e2e.py",)},
    "software_delivery": {"label": "需求到环境交付",
                          "deterministic": ("smoke_golden_delivery.py",),
                          "live": ("smoke_live_push.py",)},
    "schedule_and_reports": {"label": "定时工作与团队简报",
                             "deterministic": ("smoke_schedules.py", "smoke_work_reports.py"),
                             "live": ()},
    "approval_rework": {"label": "审批、打回、撤回与返工",
                        "deterministic": ("smoke_approval_revoke.py", "smoke_rework_guard.py"),
                        "live": ("smoke_approvals.py",)},
    "environment_delivery": {"label": "任意环境链、健康检查与回滚",
                             "deterministic": ("smoke_environment_config.py", "smoke_rollback.py"),
                             "live": ("smoke_runner_management_live.py",)},
    "evaluation_evolution": {"label": "评价沉淀与受控进化",
                             "deterministic": ("smoke_task_evolution.py",), "live": ()},
    "platform_governance": {"label": "组织、插件、Runner 与审计治理",
                            "deterministic": ("smoke_identity.py", "smoke_runner_management.py",
                                              "smoke_audit_scope.py"),
                            "live": ("smoke_runner_management_live.py",)},
}


NODE_TYPE_COVERAGE = {
    "ai": ("smoke_ai_errand.py",),
    "ai_review": ("smoke_ai_review.py",),
    "validate": ("smoke_deploy_assert.py",),
    "human_review": ("smoke_rework_guard.py",),
    "approval": ("smoke_approval_revoke.py",),
    "condition": ("smoke_plugins.py",),
    "spec": ("smoke_golden_delivery.py",),
    "quality": ("smoke_quality.py",),
    "merge": ("smoke_merge_reauth.py",),
    "deploy": ("smoke_deploy.py",),
    "deploy_chain": ("smoke_golden_delivery.py", "smoke_environment_config.py"),
    "publish": ("smoke_golden_delivery.py",),
    "script": ("smoke_script_tool.py",),
    "tool": ("smoke_script_tool.py",),
}


APPROVAL_ACTION_COVERAGE = {
    "baseline": ("smoke_golden_delivery.py",),
    "review": ("smoke_approval_revoke.py", "smoke_ai_review.py"),
    "merge": ("smoke_approval_revoke.py", "smoke_merge_reauth.py"),
    "uat": ("smoke_golden_delivery.py",),
    "deploy": ("smoke_golden_delivery.py",),
}


if is_public_snapshot():
    WORKFLOW_SCENE_COVERAGE["environment_delivery"]["label"] = "环境链、健康检查与缺失私有适配器阻断"
    WORKFLOW_SCENE_COVERAGE["environment_delivery"]["deterministic"] = (
        "smoke_environment_config.py", "test_optional_services.py")


def _files(entry: dict) -> tuple[str, ...]:
    out = []
    for key in ("positive", "boundary", "deterministic", "live"):
        out.extend(entry.get(key, ()))
    return tuple(out)


def audit(root: Path, supported_node_types: set[str]) -> list[str]:
    errors: list[str] = []
    for role, entry in ROLE_COVERAGE.items():
        if not entry.get("positive") or not entry.get("boundary"):
            errors.append(f"role {role} needs positive and boundary evidence")
    for scene, entry in WORKFLOW_SCENE_COVERAGE.items():
        if not entry.get("deterministic"):
            errors.append(f"workflow scene {scene} has no deterministic evidence")
    if set(NODE_TYPE_COVERAGE) != set(supported_node_types):
        missing = set(supported_node_types) - set(NODE_TYPE_COVERAGE)
        stale = set(NODE_TYPE_COVERAGE) - set(supported_node_types)
        errors.append(f"workflow node coverage mismatch missing={sorted(missing)} stale={sorted(stale)}")
    required_actions = {"baseline", "review", "merge", "uat", "deploy"}
    if set(APPROVAL_ACTION_COVERAGE) != required_actions:
        errors.append("approval action coverage mismatch")
    references = []
    for entry in ROLE_COVERAGE.values():
        references.extend(_files(entry))
    for entry in WORKFLOW_SCENE_COVERAGE.values():
        references.extend(_files(entry))
    for rows in (*NODE_TYPE_COVERAGE.values(), *APPROVAL_ACTION_COVERAGE.values()):
        references.extend(rows)
    for name in sorted(set(references)):
        if not (root / name).resolve().is_file():
            errors.append(f"coverage evidence does not exist: {name}")
    return errors
