"""Route managed project work into its approved workflow.

Project delivery must never silently fall back to a bare Agent session. Task
dispatch applies the project, repository, plugin and Runner readiness checks
here before starting the authoritative workflow for the same requirement.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import task_events


class ManagedWorkflowError(ValueError):
    """A managed task cannot safely continue outside its workflow."""


def direct_requested(body: dict) -> bool:
    """Honor an explicit no-workflow choice, never infer it for old clients."""
    context = body.get("executionContext")
    if not isinstance(context, dict):
        return False
    plugin = context.get("plugin")
    binding = plugin.get("bindingId") if isinstance(plugin, dict) else ""
    return (
        context.get("strategy") == "direct"
        and not body.get("bindingId")
        and not context.get("workflowBindingId")
        and not context.get("workflowId")
        and not binding
    )


def is_managed(task) -> bool:
    routing = dict(getattr(task, "work_routing", None) or {})
    contract = dict(routing.get("outputContract") or {})
    return bool(
        getattr(task, "project_id", None)
        or getattr(task, "repo_id", "")
        or contract.get("kind") == "repository-change"
    )


def execution_from_assignee(aid: str = "", model: str = "") -> dict:
    """Keep the chosen substrate/model, but never pin an arbitrary Runner id."""
    from .ai_exec_route import cli_of

    out: dict = {}
    cli = str(cli_of(str(aid or "")) or "").strip()
    if cli:
        out["agentKind"] = "local:" + cli
    if str(model or "").strip():
        out["model"] = str(model).strip()[:160]
    return out


def _workflow_requires_repo(version: am.PluginVersion) -> bool:
    types = {
        str(node.get("type") or "")
        for node in list(dict(version.workflow or {}).get("nodes") or [])
        if isinstance(node, dict)
    }
    return bool(types.intersection({"merge", "deploy", "deploy_chain"}))


def _task_requires_repo(task) -> bool:
    routing = dict(getattr(task, "work_routing", None) or {})
    contract = dict(routing.get("outputContract") or {})
    return contract.get("kind") == "repository-change"


async def _binding(session: AsyncSession, task, binding_id: str = ""):
    from . import plugin_service

    try:
        if binding_id or getattr(task, "project_id", None):
            row = await plugin_service.resolve_binding(
                session, task, binding_id=str(binding_id or ""))
            plugin = await session.get(am.Plugin, row.plugin_id)
            version = await session.get(am.PluginVersion, row.version_id)
            return row, plugin, version

        key = str(dict(getattr(task, "work_routing", None) or {})
                  .get("defaultPluginKey") or "").strip()
        if not key:
            raise ManagedWorkflowError("这条需求没有确定要使用的工作流")
        plugins = list((await session.execute(select(am.Plugin).where(
            am.Plugin.key == key, am.Plugin.enabled.is_(True)
        ).order_by(am.Plugin.org_id.is_(None).desc()))).scalars().all())
        for plugin in plugins:
            try:
                row = await plugin_service.resolve_binding(
                    session, task, plugin_id=plugin.id)
                version = await session.get(am.PluginVersion, row.version_id)
                return row, plugin, version
            except ValueError:
                continue
        raise ManagedWorkflowError(f"工作流“{key}”尚未审批、授权或绑定")
    except ManagedWorkflowError:
        raise
    except ValueError as exc:
        raise ManagedWorkflowError(str(exc)) from exc


async def _repository(session: AsyncSession, task, requested: str,
                      *, required: bool) -> str:
    repo_id = str(requested or getattr(task, "repo_id", "") or "").strip()
    project_id = str(getattr(task, "project_id", "") or "").strip()
    if repo_id:
        repo = await session.get(models.Repo, repo_id)
        if repo is None or not project_id or repo.project_id != project_id:
            raise ManagedWorkflowError("选择的工程不属于当前项目")
        return repo.id
    if not required:
        return ""
    if not project_id:
        raise ManagedWorkflowError("工程交付必须先选择所属项目和代码仓库")
    repos = list((await session.execute(select(models.Repo).where(
        models.Repo.project_id == project_id
    ).order_by(models.Repo.created_at, models.Repo.id).limit(2))).scalars().all())
    if not repos:
        raise ManagedWorkflowError("项目还没有配置代码仓库")
    if len(repos) > 1:
        raise ManagedWorkflowError("这个项目有多个代码仓库，请明确选择本次要修改的工程")
    return repos[0].id


async def prepare(session: AsyncSession, task, *, binding_id: str = "",
                  execution: dict | None = None, repo_id: str = "") -> dict:
    """Fail closed before starting the requirement's managed workflow."""
    from . import plugin_route_readiness, workflow_runs

    binding, plugin, version = await _binding(session, task, binding_id)
    if plugin is None or version is None:
        raise ManagedWorkflowError("工作流版本不存在或已经停用")
    execution = workflow_runs.execution_preferences(execution)
    selected_repo = await _repository(
        session, task, repo_id,
        required=_task_requires_repo(task) or _workflow_requires_repo(version))
    project_id = str(getattr(task, "project_id", "") or "")
    project = await session.get(models.Project, project_id) if project_id else None
    ctx = await plugin_route_readiness.context_for_task(session, task)
    result = await plugin_route_readiness.catalog_check(
        session, version, project, binding.org_id,
        secret_refs=binding.secret_refs, binding_config=binding.config,
        ctx=ctx, client_id=str(getattr(task, "owner_client_id", "") or ""),
        task=task, run_context={"execution": execution})
    if not result.get("ok"):
        detail = "；".join(str(x) for x in (result.get("blockers") or [])[:3])
        raise ManagedWorkflowError("工作流运行前检查未通过：" + (detail or "配置不完整"))
    return {
        "binding": binding, "plugin": plugin, "version": version,
        "repoId": selected_repo, "execution": execution,
    }


async def start(session: AsyncSession, task, *, binding_id: str = "",
                execution: dict | None = None, repo_id: str = "",
                instruction: str = "", actor_id: str = "",
                actor_name: str = "") -> dict:
    """Start or reuse the one authoritative workflow for a managed task."""
    from . import workflow_runs

    active = (await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.task_id == task.id,
        am.WorkflowRun.state.in_(tuple(workflow_runs._ACTIVE_RUN_STATES)),
    ).order_by(am.WorkflowRun.created_at.desc()).limit(1))).scalar_one_or_none()
    if active is not None:
        return {
            "ok": True, "identifier": active.id, "runId": active.id,
            "provider": "plugin", "reused": True,
            "assigneeName": "进行中的工作流",
        }

    plan = await prepare(
        session, task, binding_id=binding_id,
        execution=execution, repo_id=repo_id)
    try:
        run = await workflow_runs.start(
            session, task, plan["binding"], {}, actor_id=actor_id,
            execution=plan["execution"] or None,
            instruction=str(instruction or ""), repo_id=plan["repoId"],
            notify=False, entrypoint="task")
    except Exception as exc:  # noqa: BLE001 - managed work must fail closed
        # `workflow_runs.start` commits the durable run before scheduling its first
        # node. A scheduler exception must not be reported as "nothing started"
        # and tempt the caller to dispatch a second execution path.
        recovered = (await session.execute(select(am.WorkflowRun).where(
            am.WorkflowRun.task_id == task.id,
            am.WorkflowRun.state.in_(tuple(workflow_runs._ACTIVE_RUN_STATES)),
        ).order_by(am.WorkflowRun.created_at.desc()).limit(1))).scalar_one_or_none()
        if recovered is not None:
            return {
                "ok": True, "identifier": recovered.id, "runId": recovered.id,
                "provider": "plugin", "reused": True, "recovering": True,
                "assigneeName": "\u8fdb\u884c\u4e2d\u7684\u5de5\u4f5c\u6d41",
            }
        task_events.record(session, task.id, "plugin.route_blocked", {
            "bindingId": str(plan["binding"].id), "error": str(exc)[:500],
            "summary": "工程需求工作流没有启动，已阻止退回普通 AI 直派",
        }, actor=actor_name or "SoduWork")
        await session.commit()
        raise ManagedWorkflowError(str(exc)) from exc

    task_events.record(session, task.id, "plugin.auto_routed", {
        "pluginKey": str(plan["plugin"].key or ""), "runId": run.id,
        "bindingId": str(plan["binding"].id), "repoId": plan["repoId"],
        "summary": "需求已进入项目工作流，后续按门禁、合并、发布与验收推进",
        "by": actor_name or "SoduWork",
    }, actor=actor_name or "SoduWork")
    await session.commit()
    return {
        "ok": True, "identifier": run.id, "runId": run.id,
        "provider": "plugin", "routedPlugin": str(plan["plugin"].key or ""),
        "assigneeName": str(plan["plugin"].name or plan["plugin"].key or "工作流"),
    }


__all__ = [
    "ManagedWorkflowError", "execution_from_assignee", "is_managed",
    "prepare", "start",
]
