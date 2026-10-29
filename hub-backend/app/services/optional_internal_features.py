"""Only installed internal components participate in optional capabilities."""
from importlib.util import find_spec
from .workflow_contracts import WorkflowConfigurationError

_MODULES = {"change_hygiene": ("change_hygiene",), "smart_route": ("smart_route",),
            "cicd": ("cicd_publish",)}
_LABELS = {"change_hygiene": "改动卫生检查", "smart_route": "关键词工程路由", "cicd": "企业 CICD 发布"}


class InternalFeatureUnavailable(WorkflowConfigurationError):
    """An explicit internal operation needs its corresponding installed module."""


def available(feature: str) -> bool:
    return all(find_spec(f"app.services.{name}") is not None for name in _MODULES[feature])


def missing_reason(feature: str) -> str:
    if available(feature):
        return ""
    return f"当前部署未包含{_LABELS[feature]}组件；请调整流程或使用包含该组件的内部部署"


def require(feature: str) -> None:
    reason = missing_reason(feature)
    if reason:
        raise InternalFeatureUnavailable(reason)


def hygiene_requested(config: dict | None) -> bool:
    config = dict(config or {})
    if "hygiene" not in config:
        return available("change_hygiene")
    requested = bool(config["hygiene"])
    if requested:
        require("change_hygiene")
    return requested


def workflow_missing_reason(nodes: list[dict]) -> str:
    for node in nodes:
        config = dict(node.get("config") or {})
        feature = ("change_hygiene" if node.get("type") == "quality" and config.get("hygiene")
                   else "cicd" if node.get("type") == "publish" and (
                       str(config.get("mode") or "").lower() == "cicd" or isinstance(config.get("cicd"), dict))
                   else "")
        if feature and (reason := missing_reason(feature)):
            return reason
    return ""
