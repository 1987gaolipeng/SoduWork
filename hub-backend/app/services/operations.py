"""Commercial operations read model: Hub, DB, runners, executions and workflow health."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..config import get_settings
from ..log_safety import redact_log_text
from . import runner_registry, runtime_telemetry


async def _group_counts(session: AsyncSession, column) -> dict[str, int]:
    rows = (await session.execute(select(column, func.count()).group_by(column))).all()
    return {str(state or "unknown"): int(count or 0) for state, count in rows}


async def database_ready(session: AsyncSession) -> tuple[bool, str]:
    try:
        await session.execute(text("SELECT 1"))
        return True, "数据库连接正常"
    except Exception as exc:  # noqa: BLE001 - readiness must turn failures into facts
        return False, f"数据库不可用：{type(exc).__name__}"


def _stamp(value) -> int | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp() * 1000)


async def overview(session: AsyncSession) -> dict:
    from ..db import engine
    from . import database_telemetry
    settings = get_settings()
    db_ok, db_message = await database_ready(session)
    runners = await runner_registry.list_nodes(session, None)
    online = [row for row in runners if row.get("online")]
    accepting = [row for row in online if row.get("mode") == "accepting"]
    workflow = await _group_counts(session, am.WorkflowRun.state)
    executions = await _group_counts(session, am.ExecutionSession.state)
    deployments = await _group_counts(session, am.DeploymentRun.state)
    pending_approvals = int(await session.scalar(select(func.count(am.ApprovalRequest.id)).where(
        am.ApprovalRequest.status == "pending")) or 0)
    failed = list((await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.state == "failed").order_by(am.WorkflowRun.updated_at.desc()).limit(8)
    )).scalars().all())
    blockers: list[dict] = []
    if not db_ok:
        blockers.append({"level": "critical", "title": "数据库不可用", "detail": db_message})
    if not accepting:
        blockers.append({"level": "warning", "title": "没有可接活的 Runner",
                         "detail": "请检查节点在线状态或退出排空模式。"})
    if workflow.get("failed", 0):
        blockers.append({"level": "warning", "title": f"{workflow['failed']} 条流程失败",
                         "detail": "进入运行与交付查看失败节点和重试证据。"})
    from .cluster_bus import bus
    from . import cluster_control
    safe_runners = [{key: row.get(key) for key in (
        "runnerId", "host", "owner", "label", "os", "version", "tags", "agents",
        "busy", "online", "mode", "accepting", "lastSeen", "embedded", "shared")}
        for row in runners[:200]]
    return {
        "generatedAt": int(datetime.now(timezone.utc).timestamp() * 1000),
        "hub": {
            "nodeId": settings.hub_node_id, "version": settings.version,
            "service": settings.service_name, "publicUrl": settings.hub_public_url,
            "mode": "multi-instance" if bus.enabled else "single-control-plane",
            "ready": db_ok and bus.healthy,
            "modeLabel": "多实例控制面" if bus.enabled else "单 Hub 控制面",
            "clusterNote": "共享路由与事件总线" if bus.enabled else "本节点直接路由",
            "instances": len(bus.peers) if bus.enabled else 1,
            "supervisor": cluster_control.leader if bus.enabled else True,
            "transport": {"ready": bus.healthy, "sent": bus.sent, "received": bus.received},
        },
        "database": {"ready": db_ok, "message": db_message,
                     "performance": database_telemetry.summary(engine),
                     "dialect": "postgresql" if "postgresql" in settings.database_url.lower() else "sqlite"},
        "requests": runtime_telemetry.summary(),
        "runners": {"total": len(runners), "online": len(online),
                    "accepting": len(accepting), "busy": sum(int(x.get("busy") or 0) for x in online),
                    "items": safe_runners},
        "work": {"workflow": workflow, "executions": executions,
                 "deployments": deployments, "pendingApprovals": pending_approvals},
        "recentFailures": [{"id": row.id, "taskId": row.task_id,
                            # The zh-CN fallback label moved to the admin UI (operations copy catalog); send data only.
                            "error": redact_log_text(row.error or "")[:300],
                            "updatedAt": _stamp(row.updated_at)} for row in failed],
        "blockers": blockers,
    }
