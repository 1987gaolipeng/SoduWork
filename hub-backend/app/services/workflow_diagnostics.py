"""Human-readable, actionable diagnostics for immutable workflow evidence."""
from __future__ import annotations

RETRYABLE_TYPES = {
    "quality", "human_review", "deploy", "deploy_chain", "ai", "ai_review",
    "merge", "script", "tool", "publish", "validate", "spec",
}

_COPY = {
    "configuration": ("配置尚未就绪", "补齐提示中的环境、仓库、密钥或发布配置，再重试本关。"),
    "authorization": ("权限或凭据被拒绝", "更新对应账号或授权并测通，再重试本关。"),
    "infrastructure": ("执行通道暂不可用", "确认 Runner、网络和依赖服务恢复后，重试本关。"),
    "contract": ("交付未满足节点契约", "查看缺失的输入或产出证据，补齐后从本关继续。"),
    "escalation": ("需要人工判断", "查看本关证据并完成必要的人审，不要盲目重跑。"),
    "quality": ("质量门禁未通过", "先处理门禁报告中的失败项，再重试本关。"),
    "review": ("AI 审查要求返修", "按审查意见回到实施环节修复；修完仍需重新通过质量门禁与 AI 审查。"),
    "execution": ("本关执行失败", "查看错误与执行证据；问题修复后只重试本关。"),
}


def _kind(row) -> str:
    output = dict(getattr(row, "output", {}) or {})
    review = dict(output.get("review") or {})
    if (str(getattr(row, "node_type", "") or "") == "ai_review"
            and str(review.get("verdict") or "") == "changes_requested"):
        return "review"
    kind = str(output.get("failureKind") or "").strip().lower()
    if kind:
        return kind
    text = str(getattr(row, "error", "") or "").lower()
    if any(word in text for word in ("密钥", "配置", "没有找到", "尚未开放", "未安装")):
        return "configuration"
    if any(word in text for word in ("403", "401", "permission denied", "unauthorized", "权限")):
        return "authorization"
    if any(word in text for word in (
            "runner 暂时离线", "timeout", "timed out", "connection reset",
            "network is unreachable", "无法连接")):
        return "infrastructure"
    if str(getattr(row, "node_type", "") or "") == "quality":
        return "quality"
    return "execution"


def diagnose(row, can_retry: bool) -> dict:
    if str(getattr(row, "state", "") or "") not in {"failed", "rework"}:
        return {}
    kind = _kind(row)
    title, action = _COPY.get(kind, _COPY["execution"])
    retryable = bool(can_retry) and kind != "escalation"
    return {
        "kind": kind,
        "title": title,
        "detail": str(getattr(row, "error", "") or "")[:1200],
        "retryable": retryable,
        "action": action,
        "actionKey": ("resume-rework" if retryable and kind == "review" else
                      "retry-gate" if retryable else ""),
        "requiresFix": kind in {"configuration", "authorization", "contract", "quality", "review"},
    }
