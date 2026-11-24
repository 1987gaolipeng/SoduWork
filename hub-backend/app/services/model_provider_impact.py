"""Preview the current catalog and saved shared-model selections before provider deletion."""
from sqlalchemy import select

from ..automation_models import ExecutionSession, PluginVersion, WorkflowRun
from ..conversation_handoff_models import ConversationHandoff
from ..deps import has_perm
from ..models import Client, Milestone, ModelDef, Task, User
from . import model_catalog, model_config_guard, rbac
from .agent_execution_options import GATEWAY_MODEL_KINDS
from .ai_exec_route import cli_of
from .model_reference_privacy import is_local_model_reference
from .model_runtime import fingerprint
from .workflow_route_policy import execution_route


def _object(value):
    return value if isinstance(value, dict) else {}


def _matches(names, agent, model, *, provider_id=None):
    if provider_id is not None and isinstance(model, dict):
        if model.get("providerId") != provider_id:
            return False
        model = model.get("name")
    if not isinstance(model, str) or is_local_model_reference(model):
        return False
    agent = str(agent or "").strip().lower()
    kind = "local:" + (cli_of(agent) or agent)
    return kind in GATEWAY_MODEL_KINDS and model_catalog.canonical_model_name(model) in names


async def _members(session, provider_id, names, scope):
    query = (select(User.id, User.display_name, User.username, Client.agent_models)
             .join(Client, Client.user_ref == User.id)
             .where(User.is_active.is_(True), Client.auth_state == "active"))
    if scope is not None:
        query = query.where(User.org_id.in_(scope))
    members = {}
    for uid, display, username, prefs in await session.execute(query):
        if any(_matches(names, agent, model, provider_id=provider_id) for agent, model in _object(prefs).items()):
            members[uid] = display or username
    return [{"id": uid, "name": members[uid]} for uid in sorted(members)]


async def _tasks(session, names, visible_clients):
    query = select(Task.id, Task.title).where(
        Task.archived_at.is_(None), Task.status.notin_(("done", "cancel", "cancelled", "canceled")),
    )
    if visible_clients is not None:
        query = query.where(Task.owner_client_id.in_(visible_clients))
    affected = {}
    # Current task selection. Cloud continuations use the last accepted choice
    # instead of the original handoff snapshot after a user switches models.
    current = (query.add_columns(Task.work_routing, ConversationHandoff.options, ConversationHandoff.receipt)
               .outerjoin(ConversationHandoff, (ConversationHandoff.task_id == Task.id)
                          & (ConversationHandoff.phase == "committed")))
    task_agents = {}
    for tid, title, routing, options, receipt in await session.execute(current):
        routing = _object(routing)
        ctx = _object(routing.get("executionContext"))
        selection = _object(ctx.get("execution"))
        agent = selection.get("agentKind") or _object(ctx.get("agent")).get("cli") or routing.get("selectedAgentKind")
        model = selection.get("model") or ctx.get("model") or routing.get("selectedModel")
        if options is not None:
            options = _object(options)
            chosen = _object(_object(receipt).get("activeExecutionSelection"))
            agent = (chosen.get("agentId") or options.get("agentId")
                     or _object(options.get("targetSnapshot")).get("agentId") or options.get("assigneeId"))
            model = chosen.get("modelName") if chosen else options.get("model")
        task_agents[tid] = agent
        if _matches(names, agent, model):
            affected[tid] = title

    stages = (query.add_columns(Milestone.agent_id, Milestone.model)
              .join(Milestone, Milestone.task_id == Task.id)
              .where(Milestone.status.notin_(("done", "skipped")), Milestone.model != ""))
    for tid, title, agent, model in await session.execute(stages):
        if _matches(names, agent or task_agents.get(tid), model):
            affected[tid] = title
    sessions = (query.add_columns(ExecutionSession.engine, ExecutionSession.model)
                .join(ExecutionSession, ExecutionSession.task_id == Task.id)
                .where(ExecutionSession.state.in_(("queued", "dispatching", "running")), ExecutionSession.model != ""))
    for tid, title, agent, model in await session.execute(sessions):
        if _matches(names, agent, model):
            affected[tid] = title
    workflows = (query.add_columns(WorkflowRun.context, WorkflowRun.current_nodes, PluginVersion.workflow)
                 .join(WorkflowRun, WorkflowRun.task_id == Task.id)
                 .join(PluginVersion, PluginVersion.id == WorkflowRun.plugin_version_id)
                 .where(WorkflowRun.state.in_(("queued", "running", "waiting_human", "waiting_external"))))
    for tid, title, context, current_nodes, workflow in await session.execute(workflows):
        context = _object(context)
        for node in _object(workflow).get("nodes") or []:
            node = _object(node)
            if node.get("type") not in ("ai", "ai_review") or node.get("key") not in (current_nodes or []):
                continue
            try:
                route = execution_route(context, context.get("bindingConfig"), node.get("config"), node["key"])
            except (TypeError, ValueError):
                continue  # The workflow cannot dispatch an invalid saved route.
            if _matches(names, route["agentKind"], route["model"]):
                affected[tid] = title
                break
    return [{"id": tid, "title": affected[tid]} for tid in sorted(affected)]


async def preview(session, user, provider, visible_clients):
    definitions = (await session.scalars(select(ModelDef).where(ModelDef.provider_id == provider.id)
                                         .order_by(ModelDef.id))).all()
    names = {m.name for m in definitions if m.modality == "chat"}
    show_members = user.is_super or has_perm(user, "user.manage")
    show_tasks = user.is_super or has_perm(user, "task.view")
    members = (await _members(session, provider.id, names, await rbac.scope_org_ids(session, user))
               if names and show_members else [])
    tasks = await _tasks(session, names, visible_clients) if names and show_tasks else []
    result = {
        "providerId": provider.id, "providerName": provider.name,
        "providerRevision": model_config_guard.revision(provider),
        "models": [{"id": m.id, "name": m.name, "label": m.label or m.name} for m in definitions],
        "members": members, "tasks": tasks, "canListMembers": show_members, "canListTasks": show_tasks,
        "scoped": not user.is_super,
    }
    result["impactRevision"] = fingerprint([user.id, result, [model_config_guard.revision(m) for m in definitions]])
    return result
