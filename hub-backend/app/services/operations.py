"""Commercial operations read model: Hub, DB, runners, executions and workflow health."""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, load_only

from .. import automation_models as am
from ..config import get_settings
from ..log_safety import redact_log_text
from ..models import Task
from . import workflow_diagnostics
from . import operations_approvals, runner_registry, runtime_telemetry


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


async def _recent_failures(session: AsyncSession, visible_client_ids: set[str] | None,
                           can_view_failures: bool) -> list:
    run, node = am.WorkflowRun, am.NodeRun
    newer = aliased(node)
    # A failed attempt that was later retried is historical evidence.
    current_failure = select(node.id).where(
        node.run_id == run.id, node.state.in_(("failed", "rework")),
        ~select(newer.id).where(newer.run_id == node.run_id, newer.node_key == node.node_key,
                                newer.attempt > node.attempt).exists()
    ).order_by(node.created_at.desc(), node.attempt.desc(), node.id).limit(1).correlate(run)
    query = (select(run, Task.title, node)
             .outerjoin(Task, Task.id == run.task_id)
             .outerjoin(node, node.id == current_failure.scalar_subquery())
             .options(load_only(run.id, run.task_id, run.error, run.state, run.updated_at),
                      load_only(node.state, node.node_type, node.error, node.output))
             .where(run.state == "failed").order_by(run.updated_at.desc(), run.id).limit(8))
    if visible_client_ids is not None:
        query = query.where(Task.owner_client_id.in_(visible_client_ids))
    items = []
    for row, title, failed_node in (await session.execute(query)).all():
        diagnosis = workflow_diagnostics.diagnose(
            failed_node or SimpleNamespace(state=row.state, error=row.error), False)
        items.append({"id": row.id, "taskId": row.task_id if can_view_failures else "",
                      "taskTitle": title if can_view_failures else "", "taskAvailable": title is not None,
                      "diagnosis": diagnosis["title"], "error": redact_log_text(row.error or "")[:300]
                      if can_view_failures else "",
                      "updatedAt": _stamp(row.updated_at)})
    return items


async def overview(session: AsyncSession, visible_client_ids=None, *, can_view_failures=True) -> dict:
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
    pending_approvals, overdue_approvals = await operations_approvals.counts(session, visible_client_ids)
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
                 "deployments": deployments, "pendingApprovals": pending_approvals,
                 "overdueApprovals": overdue_approvals},
        "recentFailures": await _recent_failures(session, visible_client_ids, can_view_failures),
        "blockers": blockers,
    }
