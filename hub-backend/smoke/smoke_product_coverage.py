"""Require executable coverage for roles, workflow scenarios, node types, and approval actions."""
from pathlib import Path

from app.services.plugin_packages import NODE_TYPES
from product_coverage_manifest import (
    APPROVAL_ACTION_COVERAGE,
    NODE_TYPE_COVERAGE,
    ROLE_COVERAGE,
    WORKFLOW_SCENE_COVERAGE,
    audit,
)


root = Path(__file__).resolve().parent.parent
errors = audit(root, set(NODE_TYPES))
checks = [
    ("每个业务角色都有成功与边界证据", len(ROLE_COVERAGE) >= 16),
    ("AI 原生核心流程族全部登记", len(WORKFLOW_SCENE_COVERAGE) >= 10),
    ("工作流引擎每种节点都有测试", set(NODE_TYPE_COVERAGE) == set(NODE_TYPES)),
    ("五类人工决策场景全部覆盖",
     set(APPROVAL_ACTION_COVERAGE) == {"baseline", "review", "merge", "uat", "deploy"}),
    ("覆盖矩阵引用的测试文件真实存在", not errors),
]
failed = 0
for name, ok in checks:
    if ok:
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + ("  << " + "; ".join(errors) if errors else ""))

print(f"\nproduct coverage: {len(checks) - failed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
