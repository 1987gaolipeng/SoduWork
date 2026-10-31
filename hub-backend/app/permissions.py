"""RBAC permission catalog. Roles select known keys; super administrators bypass checks. Frontend
groups derive from this catalog.
"""

PERMISSIONS = [
    {"key": "org.manage", "label": "管理组织架构", "group": "组织与用户"},
    {"key": "user.manage", "label": "管理用户", "group": "组织与用户"},
    {"key": "quota.manage", "label": "管理套餐与额度", "group": "平台治理"},
    {"key": "work.catalog.manage", "label": "管理职业画像与工作场景", "group": "组织与用户"},
    {"key": "role.manage", "label": "管理角色权限", "group": "组织与用户"},
    {"key": "client.view", "label": "查看 SoduWork 终端", "group": "SoduWork 终端"},
    {"key": "client.assign", "label": "分配 SoduWork 归属", "group": "SoduWork 终端"},
    {"key": "client.control", "label": "远程管理 SoduWork（通知/提醒/皮肤/刷新）", "group": "SoduWork 终端"},
    {"key": "client.update", "label": "管理客户端升级", "group": "SoduWork 终端"},
    {"key": "runner.manage", "label": "管理 Runner 执行节点", "group": "SoduWork 终端"},
    {"key": "operations.view", "label": "查看平台运行治理", "group": "平台治理"},
    {"key": "identity.manage", "label": "管理企业身份接入", "group": "组织与用户"},
    {"key": "task.view", "label": "查看需求", "group": "需求"},
    {"key": "task.dispatch", "label": "下发需求", "group": "需求"},
    {"key": "flow.manage", "label": "配置需求流程模板", "group": "需求"},
    {"key": "delivery.review", "label": "审阅交付产出", "group": "交付与发布"},
    {"key": "delivery.merge", "label": "授权代码合并", "group": "交付与发布"},
    {"key": "delivery.accept", "label": "确认环境验收", "group": "交付与发布"},
    {"key": "delivery.deploy", "label": "授权环境发布", "group": "交付与发布"},
    {"key": "release.approve", "label": "管理全部交付审批（兼容）", "group": "交付与发布"},
    {"key": "environment.manage", "label": "管理环境与部署目标", "group": "交付与发布"},
    {"key": "plugin.manage", "label": "管理插件及其版本", "group": "插件"},
    {"key": "plugin.run", "label": "使用插件执行需求", "group": "插件"},
    {"key": "integration.manage", "label": "管理集成源", "group": "集成"},
    {"key": "binding.manage", "label": "管理绑定 / 未分配", "group": "集成"},
    {"key": "audit.view", "label": "查看审计日志", "group": "审计"},
]

ALL_KEYS = [p["key"] for p in PERMISSIONS]


def valid_keys(keys) -> list[str]:
    """Return known permission keys, discarding unknown entries."""
    s = set(ALL_KEYS)
    return [k for k in (keys or []) if k in s]
