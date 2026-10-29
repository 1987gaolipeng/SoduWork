"""Active SCM execution and explicit handling of historical Gerrit records."""
from datetime import datetime, timezone

from .workflow_contracts import WorkflowConfigurationError, failure_output

GERRIT_RETIRED = "Gerrit 流程已停用，请改用 GitLab 或通用 Git，并重新确认仓库、分支和流程配置"


class RetiredScmError(WorkflowConfigurationError):
    """Old SCM settings require an explicit migration before execution."""


def require_active(value) -> None:
    if isinstance(value, dict):
        value = value.get("scm", "git")
    elif value is not None and not isinstance(value, str):
        value = getattr(value, "scm", "git")
    if str(value or "git").strip().lower() == "gerrit":
        raise RetiredScmError(GERRIT_RETIRED)


def workflow_reason(nodes: list[dict]) -> str:
    for node in nodes:
        config = dict(node.get("config") or {})
        if ((node.get("type") == "ai_review" and str(config.get("mode") or "").lower() == "auto")
                or any(str(config.get(key) or "").lower() == "gerrit" for key in ("scm", "provider"))):
            return GERRIT_RETIRED
    return ""


def require_workflow(nodes: list[dict]) -> None:
    reason = workflow_reason(nodes)
    if reason:
        raise RetiredScmError(reason)


def stop_legacy_watch(node_run) -> bool:
    if (node_run.state != "waiting_external"
            or str((node_run.output or {}).get("watch") or "") not in ("gerrit-review", "gerrit-merge")):
        return False
    node_run.state, node_run.error = "failed", GERRIT_RETIRED
    node_run.finished_at = datetime.now(timezone.utc)
    node_run.output = {**dict(node_run.output or {}), **failure_output("configuration")}
    return True
