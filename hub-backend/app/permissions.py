"""RBAC permission catalog. Roles select known keys; super administrators bypass checks. Frontend
groups derive from this catalog.
"""

PERMISSIONS = [
    {"key": "org.manage", "label": "管理组织架构", "group": "组织与用户",
     "description": "创建、调整和删除管辖范围内的部门。", "risk": "high"},
    {"key": "user.manage", "label": "管理用户", "group": "组织与用户",
     "description": "创建和停用账号，调整成员资料及其角色。", "risk": "high"},
    {"key": "quota.manage", "label": "管理成员额度", "group": "平台治理",
     "description": "查看套餐并为管辖范围内的成员分配或调整额度。", "risk": "high"},
    {"key": "work.catalog.manage", "label": "管理职业画像与工作场景", "group": "组织与用户",
     "description": "维护职业画像及其可用的工作场景。", "risk": "medium"},
    {"key": "role.manage", "label": "管理角色权限", "group": "组织与用户",
     "description": "创建自定义角色并决定成员可获授的权限。", "risk": "high"},
    {"key": "client.view", "label": "查看 SoduWork 终端", "group": "SoduWork 终端",
     "description": "查看管辖范围内的终端资料及在线状态。", "risk": "low"},
    {"key": "client.assign", "label": "分配 SoduWork 归属", "group": "SoduWork 终端",
     "description": "更改终端的使用者及组织归属。", "risk": "medium"},
    {"key": "client.control", "label": "远程管理 SoduWork（通知/提醒/皮肤/刷新）", "group": "SoduWork 终端",
     "description": "向终端发送通知、提醒、外观和刷新指令。", "risk": "high"},
    {"key": "client.update", "label": "管理客户端升级", "group": "SoduWork 终端",
     "description": "为客户端安排升级并管理版本分发。", "risk": "high"},
    {"key": "runner.manage", "label": "管理 Runner 执行节点", "group": "SoduWork 终端",
     "description": "注册或调整承载自动化任务的执行节点。", "risk": "high"},
    {"key": "operations.view", "label": "查看平台运行治理", "group": "平台治理",
     "description": "查看平台运行情况、治理指标和待处理事项。", "risk": "low"},
    {"key": "identity.manage", "label": "管理企业身份接入", "group": "组织与用户",
     "description": "配置企业身份提供方和账号接入规则。", "risk": "high"},
    {"key": "task.view", "label": "查看需求", "group": "需求",
     "description": "读取可见需求的内容、进度与状态。", "risk": "low"},
    {"key": "task.dispatch", "label": "下发需求", "group": "需求",
     "description": "向执行终端下发需求并分派工作。", "risk": "high"},
    {"key": "flow.manage", "label": "配置需求流程模板", "group": "需求",
     "description": "配置需求流转阶段与流程模板。", "risk": "medium"},
    {"key": "delivery.review", "label": "审阅交付产出", "group": "交付与发布",
     "description": "对交付产出作出审查决定。", "risk": "medium"},
    {"key": "delivery.merge", "label": "授权代码合并", "group": "交付与发布",
     "description": "批准或驳回交付流程中的代码合并。", "risk": "high"},
    {"key": "delivery.accept", "label": "确认环境验收", "group": "交付与发布",
     "description": "确认交付环境的验收结果。", "risk": "high"},
    {"key": "delivery.deploy", "label": "授权环境发布", "group": "交付与发布",
     "description": "批准或驳回向目标环境发布的请求。", "risk": "high"},
    {"key": "release.approve", "label": "管理全部交付审批（兼容）", "group": "交付与发布",
     "description": "通过兼容权限处理多种交付审批。", "risk": "high"},
    {"key": "environment.manage", "label": "管理环境与部署目标", "group": "交付与发布",
     "description": "配置环境、部署目标及其密钥引用。", "risk": "high"},
    {"key": "plugin.manage", "label": "管理插件及其版本", "group": "插件",
     "description": "管理插件包、版本信任状态与项目绑定。", "risk": "high"},
    {"key": "plugin.run", "label": "使用插件执行需求", "group": "插件",
     "description": "使用获准的插件版本为需求启动执行。", "risk": "medium"},
    {"key": "integration.manage", "label": "管理集成源", "group": "集成",
     "description": "配置外部集成源及其连接信息。", "risk": "high"},
    {"key": "binding.manage", "label": "管理绑定 / 未分配", "group": "集成",
     "description": "处理集成绑定及尚未分配的记录。", "risk": "medium"},
    {"key": "audit.view", "label": "查看审计日志", "group": "审计",
     "description": "读取可见范围内的操作记录与审计详情。", "risk": "low"},
]

ALL_KEYS = [p["key"] for p in PERMISSIONS]


def valid_keys(keys) -> list[str]:
    """Return known permission keys, discarding unknown entries."""
    s = set(ALL_KEYS)
    return [k for k in (keys or []) if k in s]
