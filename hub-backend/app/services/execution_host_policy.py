"""Deployment-owned host boundaries, separate from user permissions and scheduling.

These settings restrict new execution. They do not erase history, cancel accepted
jobs, revoke Runner credentials or affect explicitly routed deployment Runners.
The Hub facade applies the local gate; the shared ai_local adapter deliberately
does not, because independent and employee Runners execute through that adapter.
"""
from ..config import get_settings


def cloud_runner_allowed(runner_id: str, client_id: str = "") -> bool:
    """Restrict all independently enrolled cloud hosts by deployment allowlist.

    Embedded desktop runners still use their authenticated client path and are
    allowed by the legacy ``client_id`` compatibility rule. Personal external
    environments have no client_id and therefore obey the same explicit
    deployment allowlist as shared/operations runners.
    """
    if client_id:
        return True
    raw = get_settings().cloud_execution_runner_ids.strip()
    if not raw:
        return True
    # A nonempty but malformed list must not silently reopen every server.
    allowed = {item.strip() for item in raw.split(",") if item.strip()}
    return str(runner_id or "") in allowed


def hub_local_allowed() -> bool:
    return get_settings().hub_local_execution_enabled


def local_disabled_result() -> dict:
    return {"ok": False, "code": "HUB_LOCAL_EXECUTION_DISABLED",
            "error": "当前服务仅承载后台服务，请选择在线执行机，不能在服务主机上执行任务"}
