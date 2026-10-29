"""Read model for the enterprise plugin governance workspace."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..models import Task
from . import mcp_servers, plugin_service


_ACTIVE_RUNS = {"queued", "dispatching", "running", "waiting_human",
                "waiting_external", "rework"}
_FAILED_RUNS = {"failed"}


def _ms(value) -> int | None:
    if value is None:
        return None
    return int(value.timestamp() * 1000)


def _queue_item(kind: str, plugin: dict, version=None, **extra) -> dict:
    row = {
        "id": str(extra.pop("id", "") or f"{kind}:{getattr(version, 'id', plugin['id'])}"),
        "kind": kind,
        "pluginId": plugin["id"],
        "pluginName": plugin["name"],
        "versionId": str(getattr(version, "id", "") or ""),
        "version": str(getattr(version, "version", "") or ""),
        "at": _ms(getattr(version, "created_at", None)) or plugin.get("updatedAt"),
    }
    row.update(extra)
    return row


async def overview(session: AsyncSession, org_ids: set[str] | None = None,
                   task_ids: set[str] | None = None) -> dict:
    """Build one bounded, organization-scoped control-plane read model."""
    items = await plugin_service.list_plugins(session, org_ids)
    plugin_ids = [item["id"] for item in items]
    if not plugin_ids:
        return {
            "generatedAt": _ms(datetime.now(timezone.utc)),
            "summary": {
                "total": 0, "available": 0, "pendingReview": 0,
                "activeRuns": 0, "successRate": None, "attention": 0,
            },
            "counts": {key: 0 for key in (
                "review", "quality", "dependency", "runtime", "revoked")},
            "queues": {key: [] for key in (
                "review", "quality", "dependency", "runtime", "revoked")},
            "items": [],
        }

    plugin_by_id = {item["id"]: item for item in items}
    versions = list((await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id.in_(plugin_ids)
    ).order_by(am.PluginVersion.created_at.desc(), am.PluginVersion.id.desc()))).scalars().all())
    versions.sort(key=plugin_service._submitted_version_key, reverse=True)
    version_by_id = {row.id: row for row in versions}
    latest_by_plugin = {}
    for row in versions:
        latest_by_plugin.setdefault(row.plugin_id, row)

    binding_query = select(am.PluginBinding).where(
        am.PluginBinding.plugin_id.in_(plugin_ids))
    evaluation_query = select(am.PluginEvaluationRun).where(
        am.PluginEvaluationRun.plugin_id.in_(plugin_ids))
    if org_ids is not None:
        scope = org_ids or {"__none__"}
        binding_query = binding_query.where(or_(
            am.PluginBinding.org_id.in_(scope), am.PluginBinding.org_id.is_(None)))
        evaluation_query = evaluation_query.where(or_(
            am.PluginEvaluationRun.org_id.in_(scope),
            am.PluginEvaluationRun.org_id.is_(None)))
    bindings = list((await session.execute(binding_query)).scalars().all())
    evaluations = list((await session.execute(
        evaluation_query.order_by(am.PluginEvaluationRun.created_at.desc()).limit(1000)
    )).scalars().all())

    since = datetime.now(timezone.utc) - timedelta(days=30)
    run_query = select(am.WorkflowRun).where(
        am.WorkflowRun.plugin_id.in_(plugin_ids),
        am.WorkflowRun.created_at >= since,
    )
    if task_ids is not None:
        run_query = run_query.where(
            am.WorkflowRun.task_id.in_(task_ids or {"__none__"}))
    runs = list((await session.execute(
        run_query.order_by(am.WorkflowRun.created_at.desc()).limit(500)
    )).scalars().all())
    task_keys = {row.task_id for row in runs if row.task_id}
    task_titles = {}
    if task_keys:
        task_titles = dict((await session.execute(select(
            Task.id, Task.title).where(Task.id.in_(task_keys)))).all())

    bindings_by_plugin: dict[str, list[am.PluginBinding]] = {}
    for row in bindings:
        bindings_by_plugin.setdefault(row.plugin_id, []).append(row)

    required_mcp = set()
    for row in latest_by_plugin.values():
        required_mcp.update(str(name) for name in
                            (row.capability_report or {}).get("mcpServers") or [])
    missing_mcp = set()
    mcp_status_known = True
    if required_mcp:
        try:
            readiness = await mcp_servers.readiness(session, sorted(required_mcp))
            missing_mcp = set(readiness.get("missing") or [])
        except Exception:
            mcp_status_known = False

    queues = {key: [] for key in (
        "review", "quality", "dependency", "runtime", "revoked")}

    for version in versions:
        plugin = plugin_by_id.get(version.plugin_id)
        if not plugin:
            continue
        if version.trust_state == "quarantined":
            provenance = dict(version.provenance or {})
            queues["review"].append(_queue_item(
                "review", plugin, version,
                title=f"{plugin['name']} v{version.version} 等待审核",
                detail=("发布者未登记，需先核对签名身份"
                        if provenance.get("signatureState") == "unknown-key"
                        else "导入已完成，尚未信任和开放"),
                severity="high", target="versions",
            ))
        elif version is latest_by_plugin.get(version.plugin_id) and (
                version.trust_state == "revoked"):
            queues["revoked"].append(_queue_item(
                "revoked", plugin, version,
                title=f"{plugin['name']} v{version.version} 已撤销",
                detail="检查现有绑定和替代版本，避免后续需求无法执行",
                severity="medium", target="versions",
            ))

    latest_evaluation = {}
    for row in evaluations:
        latest_evaluation.setdefault((row.version_id, row.case_key), row)
    for row in latest_evaluation.values():
        if row.state != "failed" and row.verdict != "failed":
            continue
        version = version_by_id.get(row.version_id)
        plugin = plugin_by_id.get(row.plugin_id)
        if (not plugin or not version or
                version is not latest_by_plugin.get(row.plugin_id)):
            continue
        case_name = str((row.case_snapshot or {}).get("name") or row.case_key)
        queues["quality"].append(_queue_item(
            "quality", plugin, version, id=f"quality:{row.id}",
            title=f"{plugin['name']} 发布评测未通过",
            detail=case_name + (f"：{row.error[:120]}" if row.error else ""),
            severity="high", target="versions", evaluationId=row.id,
        ))

    for plugin_id, version in latest_by_plugin.items():
        plugin = plugin_by_id.get(plugin_id)
        if not plugin or version.trust_state != "approved" or not version.enabled:
            continue
        report = dict(version.capability_report or {})
        blockers = [str(item) for item in report.get("adapterBlockers") or []]
        wanted_mcp = {str(name) for name in report.get("mcpServers") or []}
        missing = sorted(wanted_mcp & missing_mcp)
        if missing:
            blockers.append("企业尚未启用 MCP：" + "、".join(missing))
        if blockers:
            queues["dependency"].append(_queue_item(
                "dependency", plugin, version,
                title=f"{plugin['name']} 依赖未就绪",
                detail="；".join(blockers)[:240],
                severity="high", target="bindings",
            ))
        has_workflow = report.get("hasWorkflow", True) and bool(
            (version.workflow or {}).get("nodes"))
        active_bindings = [
            row for row in bindings_by_plugin.get(plugin_id, []) if row.enabled]
        if has_workflow and not active_bindings:
            queues["dependency"].append(_queue_item(
                "dependency", plugin, version,
                id=f"binding:{version.id}",
                title=f"{plugin['name']} 尚未绑定生效范围",
                detail="版本已发布，但还没有组织或项目绑定",
                severity="medium", target="bindings",
            ))
        if wanted_mcp and not mcp_status_known:
            queues["dependency"].append(_queue_item(
                "dependency", plugin, version,
                id=f"mcp-state:{version.id}",
                title=f"{plugin['name']} 依赖状态暂不可用",
                detail="无法读取 MCP 连接目录，请检查系统集成服务",
                severity="medium", target="bindings",
            ))

    for run in runs:
        if run.state not in _FAILED_RUNS:
            continue
        plugin = plugin_by_id.get(run.plugin_id)
        version = version_by_id.get(run.plugin_version_id)
        if not plugin:
            continue
        queues["runtime"].append(_queue_item(
            "runtime", plugin, version, id=f"runtime:{run.id}",
            title=task_titles.get(run.task_id) or f"{plugin['name']} 运行失败",
            detail=(run.error or "执行链路未返回可读原因")[:240],
            severity="high", target="runs", runId=run.id,
            at=_ms(run.finished_at or run.updated_at or run.created_at),
        ))

    for key in queues:
        queues[key].sort(
            key=lambda item: (item.get("severity") == "high", item.get("at") or 0),
            reverse=True)
        queues[key] = queues[key][:30]

    available = sum(1 for item in items if item.get("enabled") and
                    item.get("latestVersion") and
                    item["latestVersion"].get("trustState") == "approved" and
                    item["latestVersion"].get("enabled"))
    active_runs = sum(1 for row in runs if row.state in _ACTIVE_RUNS)
    decided = [row for row in runs if row.state in {"succeeded", "failed"}]
    success_rate = (round(sum(row.state == "succeeded" for row in decided) * 100 /
                          len(decided), 1) if decided else None)
    counts = {key: len(value) for key, value in queues.items()}
    return {
        "generatedAt": _ms(datetime.now(timezone.utc)),
        "summary": {
            "total": len(items), "available": available,
            "pendingReview": counts["review"], "activeRuns": active_runs,
            "successRate": success_rate, "attention": sum(counts.values()),
        },
        "counts": counts,
        "queues": queues,
        "items": items,
    }
