"""Read-only AI workbench combining direct dispatch events with workflow and node runs. Batch
database reads and defer terminal activity retrieval until a task is opened.
"""
from __future__ import annotations

from datetime import timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..models import Attachment, Client, Milestone, Task, TaskEvent
from . import agent_naming, ai_exec, ai_local, execution_sessions, resource_access
from . import task_execution_contract as execution_contract

def _iso(value) -> str:
    if value is None:
        return ""
    if getattr(value, "tzinfo", None) is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _newer(left, right) -> bool:
    """Compare row recency consistently across SQLite and PostgreSQL without mixing naive and aware
    datetimes.
    """
    if right is None:
        return True
    return (_iso(getattr(left, "created_at", None)), int(getattr(left, "attempt", 0))) > (
        _iso(getattr(right, "created_at", None)), int(getattr(right, "attempt", 0)))


def _node_name(node, fallback: str) -> str:
    return str((node or {}).get("name") or (node or {}).get("label") or fallback)


def _last_executor(latest: dict[str, am.NodeRun], current: am.NodeRun | None) -> dict:
    if current and current.executor:
        return dict(current.executor)
    rows = [x for x in latest.values() if x.executor]
    if not rows:
        return {}
    row = max(rows, key=lambda x: (_iso(x.started_at or x.created_at), int(x.attempt or 0)))
    return dict(row.executor or {})


def _agent_executor(latest: dict[str, am.NodeRun]) -> dict:
    """Identify the agent that performed the work for workstation attribution and executor labels.
    Use the last node actually dispatched to an agent, since a later internal quality gate may
    run elsewhere without an assignee. Stop and live-status controls still target the currently
    active node; execution ownership and control location are separate concepts."""
    rows = [x for x in latest.values()
            if (x.executor or {}).get("assignee") or (x.executor or {}).get("kind") == "ai"]
    if not rows:
        return {}
    row = max(rows, key=lambda x: (_iso(x.started_at or x.created_at), int(x.attempt or 0)))
    return dict(row.executor or {})


def _run_projection(run: am.WorkflowRun, latest: dict[str, am.NodeRun],
                    node_defs: list[dict]) -> dict:
    """Adapt the batch-loaded ORM rows to the same projection consumed by task_trace."""
    definitions = {str(item.get("key") or ""): item for item in node_defs}
    ordered_keys = list(definitions)
    ordered_keys.extend(key for key in latest if key not in ordered_keys)
    nodes = []
    for key in ordered_keys:
        row = latest.get(key)
        if row is None:
            continue
        definition = definitions.get(key, {})
        nodes.append({
            "id": row.id, "key": key,
            "name": _node_name(definition, key), "type": row.node_type,
            "attempt": int(row.attempt or 0), "state": row.state,
            "executor": dict(row.executor or {}), "output": dict(row.output or {}),
            "error": row.error or "", "createdAt": _iso(row.created_at),
            "startedAt": _iso(row.started_at), "finishedAt": _iso(row.finished_at),
        })
    return {
        "id": run.id, "state": run.state, "currentNodes": list(run.current_nodes or []),
        "workflow": node_defs, "nodes": nodes,
    }


def _flow_info(run: am.WorkflowRun, latest: dict[str, am.NodeRun], version, plugin) -> dict:
    node_defs = list(dict(getattr(version, "workflow", None) or {}).get("nodes") or [])
    projection = _run_projection(run, latest, node_defs)
    current_view = execution_contract.current_node(projection)
    current = latest.get(str(current_view.get("key") or ""))
    defs = {str(x.get("key") or ""): x for x in node_defs}
    node_def = defs.get(current.node_key, {}) if current else {}
    node_name = _node_name(node_def, current.node_key if current else "流程准备")
    phase = execution_contract.workflow_office_phase(
        run.state, current.state if current else "")
    if phase == "failed":
        action = str((current.error if current else "") or run.error or "流程执行失败")
    elif phase == "waiting":
        action = "等待人工处理 · " + node_name
    elif phase == "done":
        action = "工作流已完成"
    else:
        action = "正在执行 · " + node_name
    steps = []
    for definition in node_defs:
        key = str(definition.get("key") or "")
        if not key:
            continue
        row = latest.get(key)
        steps.append({
            "key": key,
            "name": _node_name(definition, key),
            "type": str(definition.get("type") or ""),
            "state": str(row.state if row else "pending"),
            "attempt": int(row.attempt or 0) if row else 0,
            "error": str(row.error or "") if row else "",
            "startedAt": _iso(row.started_at) if row else "",
            "finishedAt": _iso(row.finished_at) if row else "",
        })
    return {
        "runId": run.id,
        "state": run.state,
        "phase": phase,
        "pluginId": run.plugin_id,
        "pluginName": getattr(plugin, "name", "") or str((run.context or {}).get("pluginName") or ""),
        "currentNodes": list(run.current_nodes or []),
        "nodeKey": current.node_key if current else "",
        "nodeName": node_name,
        "nodeType": current.node_type if current else "",
        "nodeState": current.state if current else "",
        "attempt": int(current.attempt or 0) if current else 0,
        "startedAt": _iso((current.started_at if current else None) or run.started_at or run.created_at),
        "runStartedAt": _iso(run.started_at or run.created_at),
        "finishedAt": _iso(run.finished_at),
        "error": str((current.error if current else "") or run.error or ""),
        "lastAction": action,
        "progress": execution_contract.run_progress(projection),
        "steps": steps,
        "canRetryGate": bool(phase == "failed" and current and (
            current.node_type == "quality" or
            (current.node_type == "human_review"
             and not (current.output or {}).get("requestId")))),
        # executor identifies the current step for stopping and live activity.
        # agentExecutor identifies the last agent-assigned node for seat ownership and naming.
        "executor": _last_executor(latest, current),
        "agentExecutor": _agent_executor(latest),
    }


async def build(session: AsyncSession, client: Client, ctx: dict,
                roster: dict | None = None, reason: str = "") -> dict:
    """Build the AI execution overview using only batched local queries."""
    roster = roster or {"agents": [], "squads": []}
    # Cancelled tasks remain in the task center and its audit trail, but they
    # are no longer actionable work for the live AI team board.  This also lets
    # the one-click exceptional-task cleanup hide a failed workflow without
    # deleting its execution evidence.
    from . import task_access
    rows = [x for x in list((await session.execute(
        select(Task).where(task_access.owner_clause(client)))).scalars().all())
            if x.status != "cancel"]
    by_id = {x.id: x for x in rows}
    tids = list(by_id) or ["__none__"]

    milestone_rows = list((await session.execute(select(Milestone).where(
        Milestone.task_id.in_(tids)))).scalars().all())
    ms_by_task: dict[str, list] = {}
    for row in milestone_rows:
        ms_by_task.setdefault(row.task_id, []).append(row)

    attachment_rows = list((await session.execute(select(Attachment).where(
        Attachment.task_id.in_(tids)))).scalars().all())
    art_n: dict[str, int] = {}
    art_list: dict[str, list] = {}
    for row in attachment_rows:
        if not str(row.uploaded_by or "").startswith("agent:"):
            continue
        art_n[row.task_id] = art_n.get(row.task_id, 0) + 1
        art_list.setdefault(row.task_id, []).append({
            "id": row.id, "filename": row.filename, "size": row.size,
            "contentType": row.content_type, "url": resource_access.attachment_url(row.id),
        })

    event_rows = list((await session.execute(select(TaskEvent).where(
        TaskEvent.task_id.in_(tids), TaskEvent.kind.in_(ai_exec.KINDS_DISPATCH_STATE)
    ).order_by(TaskEvent.at, TaskEvent.id))).scalars().all())
    dispatch_by_task: dict[str, TaskEvent] = {}
    dispatch_detail_by_task: dict[str, dict] = {}
    dispatch_attempt_by_task: dict[str, str] = {}
    for row in event_rows:
        incoming = dict(row.detail or {})
        attempt_id = str(incoming.get("attemptId") or "")
        if attempt_id and attempt_id != dispatch_attempt_by_task.get(row.task_id, ""):
            dispatch_detail_by_task[row.task_id] = {}
            dispatch_attempt_by_task[row.task_id] = attempt_id
        merged = dispatch_detail_by_task.setdefault(row.task_id, {})
        for key, value in incoming.items():
            if value not in (None, "", [], {}):
                merged[key] = value
        dispatch_by_task[row.task_id] = row

    # Read execution facts in batches; retain historical attempts while deriving current state from the latest valid attempt.
    ranked_executions = select(
        am.ExecutionSession.id.label("id"),
        func.row_number().over(
            partition_by=am.ExecutionSession.task_id,
            order_by=(am.ExecutionSession.started_at.desc().nullslast(),
                      am.ExecutionSession.created_at.desc()),
        ).label("position"),
    ).where(am.ExecutionSession.task_id.in_(tids)).subquery()
    execution_rows = list((await session.execute(
        select(am.ExecutionSession).join(
            ranked_executions, ranked_executions.c.id == am.ExecutionSession.id
        ).where(ranked_executions.c.position == 1)
    )).scalars().all())
    execution_by_task: dict[str, list[dict]] = {}
    for row in execution_rows:
        execution_by_task.setdefault(row.task_id, []).append(execution_sessions.session_api(row))

    flow_rows = list((await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.task_id.in_(tids)).order_by(am.WorkflowRun.created_at))).scalars().all())
    flow_by_task: dict[str, am.WorkflowRun] = {}
    for row in flow_rows:
        flow_by_task[row.task_id] = row
    run_ids = [x.id for x in flow_by_task.values()] or ["__none__"]

    node_rows = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id.in_(run_ids)))).scalars().all())
    latest_by_run: dict[str, dict[str, am.NodeRun]] = {}
    for row in node_rows:
        current = latest_by_run.setdefault(row.run_id, {}).get(row.node_key)
        if _newer(row, current):
            latest_by_run[row.run_id][row.node_key] = row

    version_ids = {x.plugin_version_id for x in flow_by_task.values()}
    versions = {x.id: x for x in list((await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.id.in_(version_ids or {"__none__"})))).scalars().all())}
    plugin_ids = {x.plugin_id for x in flow_by_task.values()}
    plugins = {x.id: x for x in list((await session.execute(select(am.Plugin).where(
        am.Plugin.id.in_(plugin_ids or {"__none__"})))).scalars().all())}

    # Resolve waiting gates and their assignments together.
    # Avoid one query per waiting workflow, especially with a remote PostgreSQL server.
    flow_views: dict[str, dict] = {}
    waiting_request_ids: set[str] = set()
    for task_id, run in flow_by_task.items():
        flow = _flow_info(run, latest_by_run.get(run.id, {}),
                          versions.get(run.plugin_version_id), plugins.get(run.plugin_id))
        flow_views[task_id] = flow
        if flow.get("phase") != "waiting":
            continue
        node = latest_by_run.get(run.id, {}).get(flow.get("nodeKey") or "")
        request_id = str(((node.output if node else None) or {}).get("requestId") or "")
        if request_id:
            waiting_request_ids.add(request_id)
    assignments_by_request: dict[str, list] = {}
    if waiting_request_ids:
        assignment_rows = (await session.execute(select(am.ApprovalAssignment).where(
            am.ApprovalAssignment.request_id.in_(waiting_request_ids)))).scalars().all()
        for assignment in assignment_rows:
            assignments_by_request.setdefault(assignment.request_id, []).append(assignment)

    desks: dict[str, dict] = {}
    all_tasks: list[dict] = []


    here = ai_local.local_host()
    for task in rows:
        event = dispatch_by_task.get(task.id)
        run = flow_by_task.get(task.id)
        if event is None and run is None:
            continue
        detail = dict(dispatch_detail_by_task.get(task.id) or {})
        task_sessions = execution_by_task.get(task.id) or []
        current_execution = execution_contract.current_session(task_sessions)
        flow = flow_views.get(task.id)
        executor = {}
        if run is not None:
            executor = dict(flow.get("executor") or {})
            if flow.get("phase") == "waiting":
                cur_node = latest_by_run.get(run.id, {}).get(flow.get("nodeKey") or "")
                rid = str(((cur_node.output if cur_node else None) or {}).get("requestId") or "")
                if rid:
                    assignment_rows = assignments_by_request.get(rid) or []
                    flow["waitingOn"] = [x.user_name or "审批人" for x in assignment_rows]
                    my_uid = str(getattr(client, "user_ref", "") or "")
                    flow["waitingMine"] = any(str(x.user_id) == my_uid for x in assignment_rows)
                    flow["waitingRequestId"] = rid

        # Attribute workflow work to the last node actually dispatched to an agent, not the current node.
        # A final internal quality gate may have no assignee or may run on another machine.
        # Using that gate's location would misattribute the workstation that performed the work.
        who = dict((flow or {}).get("agentExecutor") or {}) or executor
        name = str(who.get("assignee") or detail.get("assigneeName") or "").strip()
        if not name:
            name = str((flow or {}).get("pluginName") or "工作流自动化").strip()
        cli = str(who.get("cli") or detail.get("assigneeCli") or "")
        # Infer an omitted runtime from the workstation label suffix when available.
        # Historical dispatch records may omit assigneeCli; normalize them before grouping.
        # Otherwise the same runtime could appear again under an empty runtime identity.
        if not cli:
            cli = agent_naming.cli_from_name(name)
        ref = str(executor.get("ref") or current_execution.get("ref") or
                  detail.get("ref") or detail.get("issueId") or "")
        expected_ref = str(detail.get("expectedRef") or ref)
        live = [x for x in ms_by_task.get(task.id, []) if x.status != "skipped"]
        live.sort(key=lambda x: x.seq)
        current_ms = next((x for x in live if x.status == "doing"), None) or next(
            (x for x in live if x.status in ("planned", "failed")), None)
        delivered = bool((task.artifact_url or "").strip()) or art_n.get(task.id, 0) > 0
        if flow:
            phase = flow["phase"]
        else:
            phase = execution_contract.direct_office_phase(
                task.status, task_sessions, delivered=delivered,
                reviewed=bool(getattr(task, "reviewed_at", None)))
            if phase != "done" and event is not None:
                if event.kind == ai_exec.EV_DISPATCH_FAILED:
                    phase = "failed"
                elif event.kind in (ai_exec.EV_DISPATCH_STARTED,
                                    ai_exec.EV_DISPATCH_UNCERTAIN):
                    phase = "dispatching"
        # Do not synchronously query each Runner while building this frequently polled overview.
        # That would cause N+1 network calls and could deadlock the event loop.
        # Derive stop availability from persisted execution provenance and workflow state.
        # The stop endpoint rechecks whether the remote session is still running.
        requested_id = str(detail.get("requestedId") or "")
        provider_kind = str(executor.get("provider") or detail.get("provider") or "")
        if not provider_kind and requested_id.startswith(ai_exec.REMOTE_PREFIX):
            provider_kind = "runner"
        can_stop = bool(ref and phase == "running" and (
            provider_kind in ("local", "runner") or ai_exec.local_workdir(ref)))
        at = (flow or {}).get("startedAt") or _iso(getattr(event, "at", None))
        # Use the machine belonging to the agent, not necessarily the final workflow step.
        requested_runner = ""
        if requested_id.startswith(ai_exec.REMOTE_PREFIX):
            requested_runner = requested_id[len(ai_exec.REMOTE_PREFIX):].split(":", 1)[0]
        runner = {
            "id": str(who.get("runnerId") or current_execution.get("runnerId") or
                      detail.get("runnerId") or requested_runner),
            "host": str(who.get("host") or current_execution.get("host") or
                        detail.get("host") or ""),
            "provider": str(who.get("provider") or detail.get("provider") or "") or provider_kind,
        }
        mkey = agent_naming.machine_key_for(provider=runner["provider"], host=runner["host"],
                                            runner_id=runner["id"], local_host=here)
        key = agent_naming.desk_key(machine=mkey, cli=cli, name=name)
        item = {
            "id": task.id, "title": task.title, "status": task.status,
            "ref": ref, "expectedRef": expected_ref,
            "identifier": detail.get("identifier", ""), "at": at,
            "phase": phase, "attention": phase in ("waiting", "failed") or bool(detail.get("attentionRaised")),
            "dispatchState": str(event.kind if event else ""),
            "confirmationPending": bool(
                event and event.kind == ai_exec.EV_DISPATCH_UNCERTAIN),
            "ms": {"done": len([x for x in live if x.status == "done"]), "total": len(live),
                   "cur": current_ms.title if current_ms else "",
                   "curStatus": current_ms.status if current_ms else ""},
            "delivered": delivered, "canStop": can_stop,
            "running": phase == "running",
            "reviewed": bool(getattr(task, "reviewed_at", None)),
            "reviewedBy": getattr(task, "reviewed_by_name", "") or "",
            "artifacts": art_n.get(task.id, 0),
            "artifactList": art_list.get(task.id, [])[:12],
            "artifactUrl": task.artifact_url or "",
            "workDir": str(current_execution.get("workDir") or
                           (ai_exec.local_workdir(ref) if ref else "")),
            "agent": name, "cli": cli, "runner": runner, "workflow": flow,
            # Stable seat identity for frontend grouping, independent of display names.
            "deskKey": key,
            "lastAction": (flow or {}).get("lastAction") or (
                (str(detail.get("summary") or detail.get("phaseName") or "正在确认执行机回执")
                 if phase == "dispatching" else
                 {"done": "需求已完成", "waiting": "等待验收",
                  "failed": str(detail.get("summary") or "执行需要处理"),
                  "running": "正在处理"}.get(phase, "查看执行状态")) +
                ((" · " + current_ms.title) if current_ms else "")),
        }
        # Group by physical machine and runtime, not provider or display name.
        # Local and Runner transports may execute the same runtime on the same host.
        # They represent one user-visible seat.
        # Keep that identity stable across transport changes.
        desk = desks.setdefault(key, {"name": name, "cli": cli, "type": "agent", "tasks": [],
                                      "key": key, "runnerId": runner["id"],
                                      "machineKey": mkey, "cliKey": agent_naming.cli_key(cli),
                                      "host": runner["host"]})
        desk["cli"] = desk.get("cli") or cli
        desk["host"] = desk.get("host") or runner["host"]
        if runner["host"]:
            desk["device"] = runner["host"]
        desk["tasks"].append(item)
        all_tasks.append(item)

    # Include idle online seats using the same keys as historical execution groups.
    # Read aliases from the context already loaded by ai_exec.
    # Avoid repeated database queries in the polling path.
    from . import execution_aliases
    aliases = ai_exec.execution_names(ctx)
    known: set[str] = set()
    for agent in (roster.get("agents") or []) + (roster.get("squads") or []):
        name = str(agent.get("name") or "")
        if not name:
            continue
        cli = agent.get("cli") or ""
        mkey = str(agent.get("machineKey") or "") or agent_naming.machine_key(
            host=str(agent.get("host") or ""), runner_id=str(agent.get("runnerId") or ""))
        key = agent_naming.desk_key(machine=mkey, cli=cli, name=name)
        known.add(key)
        desk = desks.setdefault(key, {"name": name, "cli": agent.get("cliName") or cli,
                                      "type": agent.get("type") or "agent", "tasks": [],
                                      "key": key, "runnerId": str(agent.get("runnerId") or ""),
                                      "machineKey": mkey, "cliKey": agent_naming.cli_key(cli),
                                      "host": str(agent.get("host") or "")})
        desk["online"] = bool(agent.get("online", True))
        # Use canonical runtime names from the current roster.
        # Historical events may contain lowercase runtime keys instead of display names.
        # Normalize those names for consistent presentation.
        desk["cli"] = agent.get("cliName") or cli or desk.get("cli")
        desk["cliKey"] = agent_naming.cli_key(cli) or desk.get("cliKey")
        desk["machineKey"] = mkey
        # Merge backend-local and embedded Runner seats on the same physical machine.
        # A local adapter may have created the seat before its Runner was processed.
        # Fill in the online Runner's exact route for session and terminal access.
        if agent.get("runnerId"):
            desk["runnerId"] = str(agent.get("runnerId") or "")
        # Use the current roster's display names rather than dispatch-time snapshots.
        # setdefault alone would retain the old name.
        # Refresh names after merging seat identities.
        desk["name"] = name
        # Include machine names explicitly for frontend machine grouping.
        desk["machineLabel"] = str(agent.get("machineLabel") or "")
        if agent.get("host"):
            desk["device"] = agent.get("host")
            desk["host"] = agent.get("host")

    # Apply current machine aliases to historical-only seats.
    # Fall back to the recorded name when no current alias exists.
    for desk in desks.values():
        desk.setdefault("machineKey", agent_naming.LOCAL)
        desk.setdefault("cliKey", agent_naming.cli_key(desk.get("cli") or ""))
        if desk["key"] in known:
            continue
        label = execution_aliases.machine_name(aliases, desk["machineKey"])
        own = execution_aliases.agent_name(aliases, desk["key"])
        if own:
            desk["name"] = own
        elif label and desk.get("cli"):
            desk["name"] = agent_naming.display_name(desk["cli"], label)

    for desk in desks.values():
        done = [x for x in desk["tasks"] if x["phase"] == "done"]
        active = [x for x in desk["tasks"] if x["phase"] != "done"]
        active.sort(key=lambda x: x.get("at") or "", reverse=True)
        active.sort(key=lambda x: _phase_rank(x["phase"]))
        desk["doneCount"] = len(done)
        desk["tasks"] = active
        desk["busy"] = any(x["phase"] == "running" for x in active)
        desk["attention"] = len([x for x in active if x["attention"]])
        # A historical-only seat is absent from the current roster.
        # The frontend groups retired runtimes and removed machines under historical executors.
        desk["historyOnly"] = bool(desk["key"] not in known and not active)
        desk["alias"] = execution_aliases.agent_name(aliases, desk["key"])
        desk["machineAlias"] = execution_aliases.machine_name(aliases, desk["machineKey"])
        # Choose the machine label from an alias, current roster, then hostname.
        # Use the seat's own name when a retired provider has no machine identity.
        desk["machineLabel"] = (desk.get("machineAlias") or desk.get("machineLabel")
                                or desk.get("host") or ("历史记录" if desk["historyOnly"] else ""))

    # Task cards use the seat's current executor name too.
    # Do not retain an old dispatch-time name after the seat is renamed.
    # Keep task and seat labels consistent.
    for item in all_tasks:
        desk = desks.get(item.get("deskKey") or "")
        if desk:
            item["agent"] = desk["name"]
            item["cli"] = desk.get("cli") or item.get("cli") or ""
            item["machineLabel"] = desk.get("machineLabel") or ""

    out = [x for x in desks.values() if x["key"] in known or x["tasks"] or x.get("doneCount")]
    out.sort(key=lambda x: (bool(x.get("historyOnly")), not x.get("busy"),
                            not x.get("attention"), x["name"]))
    all_tasks.sort(key=lambda x: x.get("at") or "", reverse=True)
    all_tasks.sort(key=lambda x: _phase_rank(x["phase"]))
    summary = {key: len([x for x in all_tasks if x["phase"] == key])
               for key in ("dispatching", "running", "waiting", "failed", "done")}
    return {"desks": out, "tasks": all_tasks, "summary": summary, "roster": len(known),
            "reason": reason, "provider": ai_exec.provider_name(ctx) if ai_exec.configured(ctx) else ""}


def _phase_rank(phase: str) -> int:
    return {"dispatching": 0, "running": 1, "failed": 2,
            "waiting": 3, "done": 4}.get(phase, 5)
