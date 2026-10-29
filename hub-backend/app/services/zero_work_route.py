"""Public module behavior and service contracts."""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import task_events

log = logging.getLogger("uvicorn.error")

SETTING_KEY = "zero_work_plugin_route"
DEFAULT_PLUGIN_KEY = "ai-errand"


async def _enabled(session: AsyncSession) -> bool:
    row = await session.get(models.AppSetting, SETTING_KEY)
    return str(getattr(row, "value", "") or "").strip().lower() != "off"


async def _active_run(session: AsyncSession, task_id: str) -> am.WorkflowRun | None:
    from .workflow_runs import _ACTIVE_RUN_STATES
    return (await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.task_id == task_id,
        am.WorkflowRun.state.in_(tuple(_ACTIVE_RUN_STATES)),
    ).order_by(am.WorkflowRun.created_at.desc()).limit(1))).scalar_one_or_none()


def _execution(aid: str, model: str) -> dict:
    from .ai_exec_route import cli_of
    out: dict = {}
    cli = str(cli_of(str(aid or "")) or "").strip()
    if cli:
        out["agentKind"] = "local:" + cli
    if str(model or "").strip():
        out["model"] = str(model).strip()
    return out


async def try_route(session: AsyncSession, task, *, aid: str = "", atype: str = "",
                    model: str = "", brief: str = "", actor_id: str = "",
                    actor_name: str = "") -> dict | None:
    """Return a successful dispatch-shaped response when plugin routing succeeds, otherwise None
    for direct fallback.
    """
    if str(getattr(task, "repo_id", "") or "") or str(getattr(task, "project_id", "") or ""):
        return None                     # Leave project and repository tasks to their own workflows.
    if atype == "squad":
        return None                     # Keep squad execution on the direct-dispatch path.
    if not await _enabled(session):
        return None

    running = await _active_run(session, task.id)
    if running is not None:
        # Reuse an active workflow rather than creating a duplicate.
        # Explain that state before the workflow-start lease rejects the request.
        return {"ok": True, "identifier": running.id, "runId": running.id,
                "provider": "plugin", "reused": True,
                "assigneeName": "进行中的插件流程"}

    key = str(dict(getattr(task, "work_routing", None) or {})
              .get("defaultPluginKey") or DEFAULT_PLUGIN_KEY).strip()
    plugins = list((await session.execute(select(am.Plugin).where(
        am.Plugin.key == key, am.Plugin.enabled.is_(True)
    ).order_by(am.Plugin.org_id.is_(None).desc()))).scalars().all())
    if not plugins:
        return None                     # Do not route through a plugin the organization has not enabled.

    from . import plugin_service, workflow_runs
    binding = plugin = None
    for candidate in plugins:
        try:
            binding = await plugin_service.resolve_binding(
                session, task, plugin_id=candidate.id)
            plugin = candidate
            break
        except Exception:  # noqa: BLE001 - Try the next matching plugin when binding or authorization is unavailable.
            binding = plugin = None
    if binding is None:
        return None

    try:
        run = await workflow_runs.start(
            session, task, binding, {}, actor_id=actor_id,
            execution=_execution(aid, model) or None,
            instruction=str(brief or ""), entrypoint="task")
    except Exception as exc:  # noqa: BLE001 - Routing failure must not block direct dispatch.
        task_events.record(session, task.id, "plugin.route_fallback", {
            "pluginKey": key, "error": str(exc)[:300],
            "summary": "零活默认流程没起来，已退回直派"}, actor="SoduWork")
        await session.commit()
        log.info("零活路由退回直派 task=%s key=%s: %s", task.id, key, type(exc).__name__)
        return None

    task_events.record(session, task.id, "plugin.auto_routed", {
        "pluginKey": key, "runId": run.id, "requestedId": str(aid or "")[:180],
        "summary": "零活按默认流程执行（带验收关与交付证据）",
        "by": actor_name or "SoduWork"}, actor=actor_name or "SoduWork")
    await session.commit()
    return {"ok": True, "identifier": run.id, "runId": run.id,
            "provider": "plugin", "routedPlugin": key,
            "assigneeName": str(getattr(plugin, "name", "") or key)}
