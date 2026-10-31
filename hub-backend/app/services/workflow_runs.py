"""Create and query plugin runs and execution preferences; workflow_engine retains DAG scheduling
responsibility.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from .task_access import publish_owner
from . import (release_control, resource_leases, task_code_targets, task_events,
               workflow_context, workflow_contracts, workflow_diagnostics,
               plugin_ui_contracts)
from .workflow_route_policy import (
    execution_preferences, _execution_layer, normalize_binding_execution, execution_route,
)


def _now():
    return datetime.now(timezone.utc)


def _ms(dt):
    return release_control._ms(dt)


def node_api(n: am.NodeRun, definition: dict | None = None,
             can_retry: bool | None = None) -> dict:
    definition = dict(definition or {})
    return {"id": n.id, "runId": n.run_id, "key": n.node_key, "type": n.node_type,
            "name": str(definition.get("name") or n.node_key),
            "dependsOn": list(definition.get("dependsOn") or []),
            "inputs": list(definition.get("inputs") or []),
            "outputs": list(definition.get("outputs") or []),
            "capabilities": dict(definition.get("capabilities") or {}),
            "attempt": n.attempt, "state": n.state,
            "input": workflow_context.public_handoff(n.input),
            "output": n.output or {}, "executor": n.executor or {}, "error": n.error,
            "diagnosis": workflow_diagnostics.diagnose(
                n, (n.node_type in workflow_diagnostics.RETRYABLE_TYPES)
                if can_retry is None else can_retry),
            "createdAt": _ms(n.created_at), "startedAt": _ms(n.started_at),
            "finishedAt": _ms(n.finished_at)}


def run_summary(run: am.WorkflowRun) -> dict:
    return {"id": run.id, "taskId": run.task_id, "pluginId": run.plugin_id,
            "pluginVersionId": run.plugin_version_id, "bindingId": run.binding_id,
            "state": run.state, "currentNodes": run.current_nodes or [],
            "input": run.input or {}, "output": run.output or {}, "error": run.error,
            "createdAt": _ms(run.created_at), "startedAt": _ms(run.started_at),
            "finishedAt": _ms(run.finished_at)}


def _event(session: AsyncSession, run_id: str, kind: str, *, node_id: str = "",
           detail: dict | None = None, actor: str = "system") -> None:
    session.add(am.WorkflowEvent(
        run_id=run_id, node_run_id=node_id, kind=kind,
        detail=detail or {}, actor=actor))


async def run_api(session: AsyncSession, run: am.WorkflowRun) -> dict:
    version = await session.get(am.PluginVersion, run.plugin_version_id)
    plugin = await session.get(am.Plugin, run.plugin_id)
    definitions = {str(x.get("key") or ""): dict(x)
                   for x in (dict((version.workflow if version else {}) or {}).get("nodes") or [])}
    workflow = [{"key": key, "name": str(item.get("name") or key),
                 "type": str(item.get("type") or ""),
                 "dependsOn": list(item.get("dependsOn") or []),
                 "inputs": list(item.get("inputs") or []),
                 "outputs": list(item.get("outputs") or []),
                 "capabilities": dict(item.get("capabilities") or {})}
                for key, item in definitions.items()]
    nodes = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == run.id
    ).order_by(am.NodeRun.created_at))).scalars().all())
    latest_ids = {}
    for node in nodes:
        latest_ids[node.node_key] = node.id
    retryable_ids = set()
    if run.state == "failed":
        latest_rows = {row.node_key: row for row in nodes
                       if latest_ids.get(row.node_key) == row.id}
        for row in latest_rows.values():
            if row.state not in {"failed", "rework"} \
                    or row.node_type not in workflow_diagnostics.RETRYABLE_TYPES:
                continue
            diagnosis = workflow_diagnostics.diagnose(row, True)
            if not diagnosis.get("retryable"):
                continue
            request_id = str(dict(row.output or {}).get("requestId") or "")
            if row.node_type == "human_review" and request_id:
                request = await session.get(am.ApprovalRequest, request_id)
                definition = definitions.get(row.node_key) or {}
                retry_from = str(dict(dict(definition.get("config") or {}).get(
                    "onReject") or {}).get("retryFrom") or "")
                if not (request and request.status == "rejected"
                        and row.state == "rework" and retry_from):
                    continue
            retryable_ids.add(row.id)
    events = list((await session.execute(select(am.WorkflowEvent).where(
        am.WorkflowEvent.run_id == run.id
    ).order_by(am.WorkflowEvent.at.desc()).limit(200))).scalars().all())
    code_target = await task_code_targets.get(session, run.task_id)
    return {**run_summary(run),
            "codeTarget": task_code_targets.api(code_target),
            "plugin": {"id": plugin.id, "name": plugin.name,
                       "version": version.version if version else ""} if plugin else {},
            "workflow": workflow,
            "nodes": [node_api(
                x, definitions.get(x.node_key),
                can_retry=x.id in retryable_ids) for x in nodes],
            "events": [{"id": x.id, "nodeRunId": x.node_run_id, "kind": x.kind,
                        "detail": x.detail or {}, "actor": x.actor, "at": _ms(x.at)}
                       for x in reversed(events)]}


async def list_runs(session: AsyncSession, task_id: str = "", limit: int = 100,
                    task_ids: set[str] | None = None) -> list[dict]:
    q = select(am.WorkflowRun).order_by(am.WorkflowRun.created_at.desc()).limit(
        min(300, max(1, int(limit))))
    if task_id:
        q = q.where(am.WorkflowRun.task_id == task_id)
    elif task_ids is not None:
        q = q.where(am.WorkflowRun.task_id.in_(task_ids or {"__none__"}))
    rows = list((await session.execute(q)).scalars().all())
    # Return summaries for frequent list polling; load full nodes and events only when opening a run.
    return [run_summary(row) for row in rows]


async def _recover_code_candidate(session: AsyncSession, run: am.WorkflowRun,
                                  task: models.Task, rows: list[am.NodeRun]) -> None:
    """Recover the exact branch from the completed AI session before review retry."""
    if await release_control.latest_artifact(session, task.id) is not None:
        return
    from . import ai_exec, ai_remote, code_delivery

    sources = sorted((row for row in rows
                      if row.node_type == "ai" and row.state in {"succeeded", "rework"}),
                     key=lambda row: (row.attempt, row.created_at), reverse=True)
    errors = []
    for source in sources:
        output, executor = dict(source.output or {}), dict(source.executor or {})
        branch = str(output.get("gitBranch") or "")
        head = str(output.get("gitHead") or "")
        ref = str(executor.get("ref") or output.get("ref") or "")
        if not branch and ref:
            runner_id = str(executor.get("runnerId") or "")
            if executor.get("provider") == "runner" and runner_id:
                ai_remote.remember(ref, runner_id)
            ctx = await ai_exec.load(session)
            status = await asyncio.to_thread(ai_exec.status_sync, ctx, ref)
            if status.get("ok") and status.get("done") and not status.get("error"):
                branch = str(status.get("gitBranch") or "")
                head = str(status.get("gitHead") or "")
        if not branch:
            errors.append("已完成的 AI 会话没有返回代码分支")
            continue
        found = await code_delivery.check(
            session, task, who="SoduWork", force=True,
            branch_hint=branch, head_hint=head,
            scm_hint={"provider": str(executor.get("provider") or ""),
                      "runnerId": str(executor.get("runnerId") or ""),
                      "ref": ref})
        if found.get("stage") in {"candidate", "committed", "merged"} \
                and await release_control.latest_artifact(session, task.id) is not None:
            return
        if found.get("error"):
            errors.append(str(found["error"]))
    detail = errors[-1] if errors else "没有可用的开发会话"
    raise ValueError("仍未从已完成的开发会话中找到可审阅的远端代码版本：" + detail[:500])


def _matches_code_evidence(row: am.NodeRun, artifact: am.ArtifactVersion) -> bool:
    if row.state not in {"succeeded", "rework"}:
        return False
    output = dict(row.output or {})
    delivery = dict(output.get("gitDelivery") or {})
    artifact_id = str(delivery.get("artifactVersionId") or "")
    commit = str(delivery.get("commit") or output.get("gitHead") or "").lower()
    return bool((artifact_id and artifact_id == artifact.id)
                or (commit and commit == str(artifact.commit_sha or "").lower()))


async def _recover_quality_dependencies(
        session: AsyncSession, run: am.WorkflowRun, task: models.Task,
        dependency_keys: list[str], latest: dict[str, am.NodeRun],
        rows: list[am.NodeRun], actor: str) -> tuple[list[am.NodeRun | None], list[dict]]:
    """Adopt previously verified Git evidence without rerunning an AI dependency.

    Older engine versions could wrongly mark a successful implementation as
    rework after a Runner infrastructure failure, then start a doomed extra AI
    attempt. A manual quality retry preserves those historical facts and creates
    an explicit successful evidence-adoption row instead of mutating history.
    """
    artifact = await release_control.latest_artifact(session, task.id, stream="delivery")
    if artifact is None or artifact.kind != "code" or not artifact.commit_sha:
        return [latest.get(key) for key in dependency_keys], []
    recovered: list[dict] = []
    dependencies: list[am.NodeRun | None] = []
    for key in dependency_keys:
        current = latest.get(key)
        if current is not None and current.state in {"succeeded", "skipped"}:
            dependencies.append(current)
            continue
        candidates = sorted(
            (row for row in rows if row.node_key == key
             and _matches_code_evidence(row, artifact)),
            key=lambda row: (row.attempt, row.created_at), reverse=True)
        if not candidates:
            dependencies.append(current)
            continue
        source = candidates[0]
        attempt = max((row.attempt for row in rows if row.node_key == key), default=0) + 1
        recovery = am.NodeRun(
            run_id=run.id, node_key=key, node_type=source.node_type,
            attempt=attempt, state="succeeded",
            input={"evidenceRecovery": {"sourceNodeId": source.id, "actor": actor}},
            output={**dict(source.output or {}),
                    "evidenceRecovery": {"sourceNodeId": source.id,
                                         "artifactVersionId": artifact.id,
                                         "commit": artifact.commit_sha,
                                         "actor": actor}},
            executor=dict(source.executor or {}),
            idempotency_key=f"{run.id}:{key}:evidence:{attempt}",
            started_at=_now(), finished_at=_now())
        session.add(recovery)
        await session.flush()
        latest[key] = recovery
        rows.append(recovery)
        info = {"node": key, "nodeId": recovery.id, "sourceNodeId": source.id,
                "artifactVersionId": artifact.id, "commit": artifact.commit_sha}
        recovered.append(info)
        dependencies.append(recovery)
        _event(session, run.id, "node.evidence_recovered", node_id=recovery.id,
               actor=actor, detail=info)
        task_events.record(session, run.task_id, "plugin.evidence_recovered",
                           {"runId": run.id, **info}, actor=actor)
    return dependencies, recovered


async def _retry_failed_gate(session: AsyncSession, run: am.WorkflowRun, actor: str,
                             allowed: set[str], node_key: str = "",
                             execution: dict | None = None,
                             resume_rework: bool = False) -> am.NodeRun:
    """Retry a technical gate without modifying previous evidence. Optional agentKind/model
    overrides apply only to that AI node and persist for its later retries, leaving other nodes
    unchanged.
    """
    if run.state != "failed":
        raise ValueError("只有失败的插件流程可以重试当前关卡")
    # A retry must serialize with archive/delete just like a fresh start.
    retry_task = await session.get(models.Task, run.task_id, with_for_update=True, populate_existing=True)
    if retry_task is None:
        raise ValueError("需求已不存在，不能重新启动流程")
    from .task_requirements import ensure_executable
    ensure_executable(retry_task)
    from . import plugin_access
    await plugin_access.assert_run_use(session, run)
    rows = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == run.id
    ).order_by(am.NodeRun.attempt, am.NodeRun.created_at))).scalars().all())
    latest = {}
    for item in rows:
        latest[item.node_key] = item
    active = {"queued", "dispatching", "running", "waiting_human", "waiting_external"}
    if any(row.state in active for row in latest.values()):
        raise ValueError("流程仍有节点在运行，暂时不能重试")
    failed = [row for row in latest.values()
              if row.node_type in allowed and row.state in {"failed", "rework"}]
    requested = str(node_key or "").strip()
    if requested:
        failed = [row for row in failed if row.node_key == requested]
    elif len({row.node_key for row in failed}) > 1:
        raise ValueError("当前有多个可重试关卡，请明确选择要重试的阶段")
    if not failed:
        raise ValueError("指定的失败关卡不存在，或不允许从这里重试")
    source = max(failed, key=lambda row: (row.attempt, row.created_at))
    version = await session.get(am.PluginVersion, run.plugin_version_id)
    definition = next((node for node in dict(version.workflow or {}).get("nodes") or []
                       if node.get("key") == source.node_key
                       and node.get("type") == source.node_type), None) if version else None
    if definition is None:
        raise ValueError("插件版本中已找不到这个失败关卡")
    if resume_rework:
        from . import workflow_engine
        if source.node_type != "ai_review":
            raise ValueError("只有明确提出修改意见的 AI 审查关可以继续返修")
        review = dict(dict(source.output or {}).get("review") or {})
        if str(review.get("verdict") or "") != "changes_requested":
            raise ValueError("这次 AI 审查没有可恢复的返修结论")
        policy = dict(dict(definition.get("config") or {}).get("onFailure") or {})
        retry_from = str(policy.get("retryFrom") or "")
        if not retry_from:
            raise ValueError("当前插件没有为 AI 审查配置返修入口")
        context = dict(run.context or {})
        rounds = dict(context.get("reworkRounds") or {})
        current_rounds = max(0, int(rounds.get(source.node_key) or 0))
        if current_rounds >= workflow_engine.MANUAL_REWORK_MAX_ROUNDS:
            raise ValueError(
                "这次流程已经达到人工确认后的安全返修上限，请开新流程")
        # A manual rework grant adds an attempt without changing the immutable plugin definition.
        # Preserve the review decision and return through the same DAG recovery path.
        # Require quality and AI review again after implementation; automatic rounds remain bounded.
        # Each administrator action adds one round within the overall run limit.
        configured = min(5, max(1, int(policy.get("maxRounds") or 2)))
        explicit_policy = {**policy, "maxRounds": min(5, max(configured,
                                                               current_rounds + 1))}
        if execution:
            route = execution_preferences(execution)
            if route:
                overrides = dict(context.get("executionOverrides") or {})
                overrides[retry_from] = route
                context["executionOverrides"] = overrides
                run.context = context
        if not await workflow_engine._begin_rework(
                session, run, source, explicit_policy,
                source.error or str(review.get("summary") or "AI 审查要求返修"),
                manual_max_rounds=current_rounds + 1):
            raise ValueError("当前审查结论不能恢复到实施环节，请查看失败诊断")
        context = dict(run.context or {})
        manual_grants = dict(context.get("manualReworkGrants") or {})
        manual_grants[source.node_key] = int(
            manual_grants.get(source.node_key) or 0) + 1
        context["manualReworkGrants"] = manual_grants
        run.context = context
        run.current_nodes = []
        retry_task = await session.get(models.Task, run.task_id)
        if retry_task is not None and retry_task.status == "todo":
            from . import task_status
            await task_status.mark(
                session, retry_task, "doing", engine=True, why="run.rework_resume")
        _event(session, run.id, "run.rework_resumed", node_id=source.id, actor=actor,
               detail={"from": source.node_key, "retryFrom": retry_from,
                       "round": current_rounds + 1, "explicit": True,
                       "manualGrant": manual_grants[source.node_key]})
        task_events.record(session, run.task_id, "plugin.rework_resumed", {
            "runId": run.id, "from": source.node_key, "retryFrom": retry_from,
            "round": current_rounds + 1, "explicit": True,
            "manualGrant": manual_grants[source.node_key],
        }, actor=actor)
        await session.commit()
        return source
    if source.node_type == "human_review" and (source.output or {}).get("requestId"):
        request = await session.get(
            am.ApprovalRequest, str((source.output or {}).get("requestId") or ""))
        on_reject = dict(dict(definition.get("config") or {}).get("onReject") or {})
        retry_from = str(on_reject.get("retryFrom") or "")
        # Recover older rejections blocked by historical retry counters.
        # Resume the requested rework node without reopening or changing the human decision.
        if request and request.status == "rejected" and source.state == "rework" and retry_from:
            nodes = list(dict(version.workflow or {}).get("nodes") or [])
            affected, changed = {retry_from}, True
            while changed:
                changed = False
                for item in nodes:
                    key = str(item.get("key") or "")
                    if key and key not in affected \
                            and affected.intersection(item.get("dependsOn") or []):
                        affected.add(key)
                        changed = True
            context = dict(run.context or {})
            budget = dict(context.get("reworkAttemptBudget") or {})
            for key in affected:
                if latest.get(key) is not None:
                    budget[key] = max(1, int(budget.get(key) or 0))
            context["reworkAttemptBudget"] = budget
            run.context, run.state, run.error, run.finished_at = context, "running", "", None
            run.current_nodes = []
            retry_task = await session.get(models.Task, run.task_id)
            if retry_task is not None and retry_task.status == "todo":
                from . import task_status
                await task_status.mark(
                    session, retry_task, "doing", engine=True, why="run.retry")
            _event(session, run.id, "run.rework_resumed", node_id=source.id, actor=actor,
                   detail={"from": source.node_key, "retryFrom": retry_from})
            task_events.record(session, run.task_id, "plugin.rework_resumed", {
                "runId": run.id, "from": source.node_key, "retryFrom": retry_from,
            }, actor=actor)
            await session.commit()
            return source
        raise ValueError("人工审阅已经产生处理记录，不能用重试绕过人的决定")
    dependency_keys = [str(key) for key in (definition.get("dependsOn") or [])]
    deps = [latest.get(key) for key in dependency_keys]
    recovered_dependencies: list[dict] = []
    # Restore fixed commits only for code gates.
    # Document and prototype workflows still use upstream files even when repository context exists.
    if source.node_type in ("human_review", "quality"):
        task = await session.get(models.Task, run.task_id)
        if task is None:
            raise ValueError("需求已经不存在")
        needs_code = source.node_type == "quality" or workflow_contracts.review_requires_code(
            version.workflow, definition)
        if task.repo_id and needs_code:
            await _recover_code_candidate(session, run, task, rows)
        if source.node_type == "quality":
            deps, recovered_dependencies = await _recover_quality_dependencies(
                session, run, task, dependency_keys, latest, rows, actor)
    if any(row is None or row.state not in {"succeeded", "skipped"} for row in deps):
        raise ValueError("当前关卡的上游交付尚未成功，不能跳过重试")
    manual_route = execution_preferences(execution) if execution else {}
    if manual_route:
        if source.node_type not in ("ai", "ai_review"):
            raise ValueError("只有 AI 执行的关卡可以换底座重跑")
        context = dict(run.context or {})
        overrides = dict(context.get("executionOverrides") or {})
        overrides[source.node_key] = manual_route
        context["executionOverrides"] = overrides
        run.context = context
    # A manual retry of an AI rework must retain the exact review/conflict
    # brief.  Previously the new NodeRun only carried ``manualRetry`` and the
    # agent silently fell back to the original task, which made conflict repair
    # look successful while producing the same remote commit again.
    context_feedback = dict(dict(run.context or {}).get("reworkFeedback") or {})
    rework_feedback = str(
        dict(source.input or {}).get("reworkFeedback")
        or context_feedback.get(source.node_key) or "").strip()
    if rework_feedback:
        from . import workflow_engine
        rework_feedback = (
            workflow_engine._merge_conflict_rework_feedback(
                source.output, rework_feedback) or rework_feedback)
    attempt = source.attempt + 1
    node = am.NodeRun(
        run_id=run.id, node_key=source.node_key, node_type=source.node_type,
        attempt=attempt, state="queued", input={
            "workflowInput": run.input or {},
            "dependencies": {dep.node_key: dep.output or {} for dep in deps},
            "manualRetry": {"sourceNodeId": source.id, "actor": actor,
                            "recoveredDependencies": recovered_dependencies},
            **({"reworkFeedback": rework_feedback} if rework_feedback else {}),
        }, idempotency_key=f"{run.id}:{source.node_key}:manual:{attempt}")
    session.add(node)
    await session.flush()
    session.add(am.WorkflowOutbox(
        run_id=run.id, node_run_id=node.id, topic="node.execute",
        payload={"nodeKey": node.node_key, "attempt": attempt, "manual": True}))
    run.state, run.error, run.finished_at = "running", "", None
    run.current_nodes = [node.node_key]
    retry_task = await session.get(models.Task, run.task_id)
    if retry_task is not None and retry_task.status == "todo":
        from . import task_status
        await task_status.mark(
            session, retry_task, "doing", engine=True, why="run.retry")
    _event(session, run.id, "node.manual_retry", node_id=node.id, actor=actor,
           detail={"node": node.node_key, "attempt": attempt,
                   "sourceNodeId": source.id,
                   **({"executionOverride": manual_route} if manual_route else {}),
                   "recoveredDependencies": recovered_dependencies})
    task_events.record(session, run.task_id, "plugin.gate_retry", {
        "runId": run.id, "node": node.node_key, "attempt": attempt,
        "sourceNodeId": source.id, "nodeType": source.node_type,
    }, actor=actor)
    await session.commit()
    return node


async def retry_failed_quality(
        session: AsyncSession, run: am.WorkflowRun, actor: str = "system") -> am.NodeRun:
    """Compatibility entry point for retrying only an exhausted quality gate."""
    return await _retry_failed_gate(session, run, actor, {"quality"})


# Single source of truth for retry eligibility; the engine also uses it to calculate canRetry on failure.
# Include ai and ai_review so failed AI gates retain a direct retry path.
# recover-artifacts has stricter requirements: exhausted retries, no active nodes, clean historical sessions, and a valid contract.

# A retry creates only one new attempt, allowing interrupted work to continue
# without replaying successful upstream deliveries; dependencies must already have succeeded.
RETRYABLE_GATE_TYPES = workflow_diagnostics.RETRYABLE_TYPES


async def retry_failed_gate(
        session: AsyncSession, run: am.WorkflowRun, actor: str = "system",
        node_key: str = "", execution: dict | None = None,
        resume_rework: bool = False) -> am.NodeRun:
    """Retry the failed technical gate in place; never replay audited ancestors."""
    return await _retry_failed_gate(session, run, actor, RETRYABLE_GATE_TYPES,
                                    node_key, execution, resume_rework)


async def redispatch_running_gate(
        session: AsyncSession, run: am.WorkflowRun, actor: str = "system",
        node_key: str = "", execution: dict | None = None) -> am.NodeRun:
    """Technical contract for redispatch running gate."""
    if run.state not in ("running", "queued"):
        raise ValueError("只有正在运行的流程可以重新派发当前关卡")
    from . import plugin_access
    await plugin_access.assert_run_use(session, run)
    rows = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == run.id
    ).order_by(am.NodeRun.attempt, am.NodeRun.created_at))).scalars().all())
    latest: dict[str, am.NodeRun] = {}
    for item in rows:
        latest[item.node_key] = item
    active_states = {"queued", "dispatching", "running"}
    candidates = [row for row in latest.values()
                  if row.node_type in ("ai", "ai_review") and row.state in active_states]
    requested = str(node_key or "").strip()
    if requested:
        candidates = [row for row in candidates if row.node_key == requested]
    if not candidates:
        raise ValueError("当前没有正在执行的 AI 关卡可以重新派发")
    if len({row.node_key for row in candidates}) > 1:
        raise ValueError("有多个 AI 关卡在执行，请明确选择要重派的阶段")
    source = max(candidates, key=lambda row: (row.attempt, row.created_at))
    # Check for other active nodes before changing the source attempt's state.
    # Otherwise retry could reject after the original execution was already marked failed.
    waiting = {"queued", "dispatching", "running", "waiting_human", "waiting_external"}
    if any(row.node_key != source.node_key and row.state in waiting
           for row in latest.values()):
        raise ValueError("流程还有其它关卡在运行，暂时不能重派这一关")

    # Attempt cancellation of the previous execution.
    # Late receipts for its terminal node must not reactivate it.
    stopped = False
    try:
        from . import ai_exec
        ev_row = await ai_exec.last_dispatch_event(session, run.task_id)
        ref = str(((ev_row.detail or {}).get("ref") or "")) if ev_row is not None else ""
        if ref:
            ctx = await ai_exec.load(session)
            result = await asyncio.to_thread(ai_exec.stop_sync, ctx, ref)
            stopped = bool(result.get("ok"))
    except Exception:  # noqa: BLE001 - Failed cancellation does not block explicitly requested redispatch to a new session.
        stopped = False

    source.state = "failed"
    source.error = ("人工重新派发：当前执行已被叫停" if stopped
                    else "人工重新派发：原执行未能远程叫停，其迟到回执会被忽略")
    source.finished_at = _now()
    output = dict(source.output or {})
    output["failureKind"] = "manual_redispatch"
    source.output = output
    run.state = "failed"
    run.current_nodes = []
    _event(session, run.id, "node.manual_redispatch", node_id=source.id, actor=actor,
           detail={"node": source.node_key, "attempt": source.attempt, "stopped": stopped})
    task_events.record(session, run.task_id, "plugin.gate_redispatched", {
        "runId": run.id, "node": source.node_key, "attempt": source.attempt,
        "stopped": stopped,
    }, actor=actor)
    await session.flush()
    return await _retry_failed_gate(session, run, actor, {"ai", "ai_review"},
                                    source.node_key, execution)


async def _bind_single_project_repo(session: AsyncSession, task: models.Task,
                                    repo_id: str = "") -> models.Repo | None:
    """Inherit a repository only when the project has exactly one; require explicit selection for
    multiple repositories.
    """
    if repo_id:
        repo = await session.get(models.Repo, str(repo_id))
        if repo is None or not task.project_id or repo.project_id != task.project_id:
            raise ValueError("选择的工程不属于这条需求所在项目")
        task.repo_id = repo.id
        await session.flush()
        return repo
    if task.repo_id:
        repo = await session.get(models.Repo, task.repo_id)
        return repo if repo is not None and (
            not task.project_id or repo.project_id == task.project_id) else None
    if not task.project_id:
        return None
    repos = list((await session.execute(select(models.Repo).where(
        models.Repo.project_id == task.project_id
    ).order_by(models.Repo.created_at, models.Repo.id).limit(2))).scalars().all())
    if len(repos) != 1:
        return None
    task.repo_id = repos[0].id
    await session.flush()
    return repos[0]


def _validate_workflow_inputs(manifest: dict, inputs: dict) -> dict:
    """Apply the immutable public input contract before a run is persisted."""
    from . import plugin_service

    fields = plugin_service.public_inputs(manifest or {})
    source = dict(inputs or {})
    declared = {field["key"] for field in fields}
    unknown = sorted(str(key) for key in source if str(key) not in declared)
    if unknown:
        raise ValueError("插件收到未声明的输入：" + "、".join(unknown[:10]))
    values = {}
    for field in fields:
        key, label, kind = field["key"], field["label"], field["type"]
        if key in source:
            value = source[key]
        elif "default" in field:
            value = field["default"]
        else:
            value = None
        if value is not None and value != "":
            if kind == "boolean":
                if not isinstance(value, bool):
                    raise ValueError("插件输入必须是布尔值：" + label)
            elif kind == "number":
                if isinstance(value, bool):
                    raise ValueError("插件输入必须是数字：" + label)
                try:
                    value = float(value)
                except (TypeError, ValueError) as exc:
                    raise ValueError("插件输入必须是数字：" + label) from exc
            elif kind == "select":
                options = {str(item.get("value")) for item in field.get("options") or []}
                value = str(value)
                if value not in options:
                    raise ValueError("插件输入选项已失效：" + label)
            else:
                if isinstance(value, (dict, list)):
                    raise ValueError("插件输入必须是文本：" + label)
                value = str(value)
                if len(value) > 8000:
                    raise ValueError("插件输入内容过长：" + label)
            values[key] = value
        elif field["required"]:
            raise ValueError("请填写插件必填项：" + label)
    return values


async def _ensure_start_ready(session: AsyncSession, task: models.Task,
                              binding: am.PluginBinding, version: am.PluginVersion,
                              execution: dict | None,
                              node_keys: set[str] | None = None, *, repo=None) -> dict:
    from . import plugin_route_readiness, plugin_readiness, code_delivery

    needs_repo = plugin_readiness.repository_nodes(version.workflow or {}, node_keys)
    if needs_repo:
        if repo is None:
            raise ValueError("这些节点需要明确的工程仓库（%s），请先选择所属项目和工程" % "、".join(needs_repo[:5]))
        if not code_delivery._delivery_ready(repo):
            raise ValueError("所选工程的仓库地址或合并分支尚未配置，不能启动代码流程")

    project = await session.get(models.Project, task.project_id) if task.project_id else None
    ctx = await plugin_route_readiness.context_for_task(session, task)
    result = await plugin_route_readiness.catalog_check(
        session, version, project, binding.org_id,
        secret_refs=binding.secret_refs, binding_config=binding.config,
        ctx=ctx, client_id=str(task.owner_client_id or ""), task=task,
        run_context={"execution": execution_preferences(execution)},
        node_keys=node_keys)
    if not result["ok"]:
        raise ValueError("插件运行前检查未通过：" + "；".join(result["blockers"][:3]))
    return result


async def _start_unlocked(session: AsyncSession, task: models.Task, binding: am.PluginBinding,
                inputs: dict, actor_id: str = "", execution: dict | None = None,
                instruction: str = "", repo_id: str = "", *,
                notify: bool = True, entrypoint: str = "task", conversation_turn: dict | None = None) -> am.WorkflowRun:
    from .conversation_turns import execution_instruction
    instruction = execution_instruction(instruction, conversation_turn)
    if not binding.enabled:
        raise ValueError("插件绑定已停用")
    version = await session.get(am.PluginVersion, binding.version_id)
    plugin = await session.get(am.Plugin, binding.plugin_id)
    if not version or not plugin or not plugin.enabled or not version.enabled \
            or version.trust_state != "approved":
        raise ValueError("插件版本尚未审批启用")
    from . import plugin_access
    await plugin_access.assert_task_use(session, plugin.id, task)
    capability = dict(version.capability_report or {})
    manifest = dict(version.manifest or {})
    ui = plugin_ui_contracts.public(manifest.get("ui"), manifest.get("setup"))
    entrypoints = plugin_ui_contracts.effective_entrypoints(
        manifest.get("entrypoints") or capability.get("entrypoints") or {}, ui,
        has_workflow=bool(capability.get("hasWorkflow", True)), jiyong=manifest.get("jiyong"))
    entrypoint = entrypoint if entrypoint in {"task", "automation"} else "task"
    default = bool(capability.get("hasWorkflow", True)) if entrypoint == "automation" else True
    if entrypoint == "automation":
        plugin_ui_contracts.require_unattended(ui, jiyong=manifest.get("jiyong"))
    if entrypoints.get(entrypoint, default) is False:
        label = "自动化" if entrypoint == "automation" else "需求"
        raise ValueError(f"这个能力包没有开放{label}入口")
    inputs = _validate_workflow_inputs(version.manifest or {}, inputs or {})
    active = (await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.task_id == task.id,
        am.WorkflowRun.state.in_(("queued", "running", "waiting_human", "waiting_external"))
    ).limit(1))).scalar_one_or_none()
    if active is not None:
        raise ValueError("这条需求已经有一个插件流程在运行")
    repo = await _bind_single_project_repo(session, task, repo_id)
    await _ensure_start_ready(session, task, binding, version, execution, repo=repo)
    from . import managed_delivery_context
    delivery_readiness = await managed_delivery_context.capture(
        session, task, binding, plugin)
    run_context = {"pluginKey": plugin.key, "pluginName": plugin.name,
                   "bindingConfig": binding.config or {},
                   "execution": execution_preferences(execution),
                   "entrypoint": entrypoint,
                   "instruction": instruction}
    if delivery_readiness:
        run_context["deliveryReadiness"] = delivery_readiness
    run = am.WorkflowRun(
        task_id=task.id, plugin_id=plugin.id, plugin_version_id=version.id,
        binding_id=binding.id, state="running", input=inputs,
        context=run_context, initiated_by=actor_id,
        started_at=_now())
    session.add(run)
    if task.status == "todo":   # Retrying release stages must not reactivate done or cancelled tasks.
        from . import task_status
        await task_status.mark(session, task, "doing", engine=True, why="run.started")
    await session.flush()
    code_target = await task_code_targets.freeze(session, task, repo)
    if code_target is not None:
        run.context = {**dict(run.context or {}),
                       "codeTargetId": code_target.id,
                       "codeTargetFingerprint": code_target.fingerprint}
    _event(session, run.id, "run.started", detail={
        "pluginId": plugin.id, "pluginVersionId": version.id,
        "entrypoint": entrypoint}, actor=actor_id or "system")
    task_events.record(session, task.id, "plugin.started",
                       {"runId": run.id, "pluginId": plugin.id,
                        "versionId": version.id, "plugin": plugin.name}, actor="SoduWork")
    await session.commit()
    if notify and task.owner_client_id:
        from ..realtime import hub
        from .tasks import task_to_api_live
        await publish_owner(session, task, {
            "type": "task.updated", "task": await task_to_api_live(session, task),
        })
    # Defer imports to avoid the workflow_engine/workflow_runs cycle.
    from . import workflow_engine
    await workflow_engine._schedule(session, run)
    return run


async def start(session: AsyncSession, task: models.Task, binding: am.PluginBinding,
                inputs: dict, actor_id: str = "", execution: dict | None = None,
                instruction: str = "", repo_id: str = "", *,
                notify: bool = True, entrypoint: str = "task", conversation_turn: dict | None = None) -> am.WorkflowRun:
    from .task_requirements import ensure_executable
    ensure_executable(task)
    expected_owner = task.owner_client_id
    try:
        lease = await resource_leases.acquire(
            session, "workflow-start", str(task.id), ttl_seconds=120,
            detail={"taskId": str(task.id), "bindingId": str(binding.id)})
    except resource_leases.LeaseBusy as exc:
        raise ValueError("This task is already starting a workflow") from exc
    try:
        # Serialize against the conversation receipt as well as other workflows.
        # prepare checks this existing start lease; no second scheduler is added.
        from .conversation_turns import ensure_available
        await session.refresh(task, with_for_update=True)
        if task.owner_client_id != expected_owner:
            raise ValueError("需求执行归属已变化，请刷新后重新安排")
        ensure_available(task, conversation_turn, "workflow")
        return await _start_unlocked(
            session, task, binding, inputs, actor_id, execution, instruction,
            repo_id, notify=notify, entrypoint=entrypoint, conversation_turn=conversation_turn)
    except Exception:
        await session.rollback()
        # Rollback expires ORM objects in the caller's session.
        # Even accessing a primary-key attribute can trigger an invalid async lazy load.
        # Keep the original actionable error from being replaced by that secondary failure.
        # Refresh the caller's task and run objects immediately.
        # The lease acquisition already committed their rows before preflight.
        for row in (task, binding):
            try:
                await session.refresh(row)
            except Exception:  # noqa: BLE001 - Preserve the original exception if a row no longer exists.
                pass
        raise
    finally:
        await resource_leases.release(session, lease)

_ADOPTABLE_NODE_TYPES = {
    "ai", "validate", "spec", "quality", "human_review", "approval", "merge", "condition",
}
_ACTIVE_RUN_STATES = {"queued", "running", "waiting_human", "waiting_external"}


def _ancestor_keys(nodes: list[dict], target_key: str) -> set[str]:
    """Return the complete dependency closure before ``target_key``.

    Adoption is intentionally prefix-only: callers cannot cherry-pick a green-looking node while
    omitting one of its upstream gates.  The target itself always executes in the new version.
    """
    by_key = {str(node.get("key") or ""): node for node in nodes}
    if target_key not in by_key:
        raise ValueError("新版插件里没有这个续接节点")
    ancestors: set[str] = set()

    def visit(key: str, stack: set[str]) -> None:
        if key in stack:
            raise ValueError("新版插件的依赖关系存在循环")
        for dependency in by_key[key].get("dependsOn") or []:
            dependency = str(dependency or "")
            if dependency not in by_key:
                raise ValueError("新版插件的依赖节点不完整")
            if dependency in ancestors:
                continue
            visit(dependency, stack | {key})
            ancestors.add(dependency)

    visit(target_key, set())
    if not ancestors:
        raise ValueError("起始节点没有上游证据，不需要使用续接")
    return ancestors


async def _approved_request(session: AsyncSession, task_id: str, source: am.NodeRun) -> None:
    output = dict(source.output or {})
    request_id = str(output.get("requestId") or "")
    request = await session.get(am.ApprovalRequest, request_id) if request_id else None
    if request is None or request.task_id != task_id or request.status != "approved":
        raise ValueError(f"历史节点“{source.node_key}”没有可复用的已批准人工决定")
    artifact_id = str(output.get("artifactVersionId") or "")
    if artifact_id and request.artifact_version_id != artifact_id:
        raise ValueError(f"历史节点“{source.node_key}”的审批与产出版本不一致")


def _continuation_rework_feedback(
        nodes: list[dict], source_latest: dict[str, am.NodeRun],
        target_key: str) -> str:
    """Carry the authoritative review evidence into a history continuation.

    A continuation is a fresh WorkflowRun, so it cannot rely on the in-memory
    rework context of the source run. Find the latest failed/rework gate whose
    declared policy rewinds to the selected target and rebuild the same bounded,
    structured feedback used by an in-run automatic rework.
    """
    target = str(target_key or "").strip()
    if not target:
        return ""
    # Local import avoids the workflow_engine -> workflow_runs import cycle.
    from . import workflow_engine

    for definition in reversed(nodes):
        policy = dict(dict(definition.get("config") or {}).get("onFailure") or {})
        if str(policy.get("retryFrom") or "").strip() != target:
            continue
        source = source_latest.get(str(definition.get("key") or ""))
        if source is None or source.state not in {"failed", "rework"}:
            continue
        feedback = workflow_engine._rework_evidence(source)
        if feedback:
            return feedback
    return ""


async def _start_from_evidence_unlocked(
        session: AsyncSession, task: models.Task, binding: am.PluginBinding, inputs: dict,
        source_run: am.WorkflowRun, target_key: str,
        actor_id: str = "", execution: dict | None = None,
        instruction: str = "", repo_id: str = "") -> am.WorkflowRun:
    """Start a newer workflow at one node by adopting a complete, audited prefix.

    This is used when a workflow definition evolves after expensive development has already passed
    its human and technical gates.  It never edits the old run, never invents evidence and never
    adopts deployment/publish nodes: environment execution must be observed again by the new chain.
    """
    from .conversation_turns import execution_instruction
    instruction = execution_instruction(instruction)
    if not binding.enabled:
        raise ValueError("插件绑定已停用")
    version = await session.get(am.PluginVersion, binding.version_id)
    plugin = await session.get(am.Plugin, binding.plugin_id)
    if not version or not plugin or not plugin.enabled or not version.enabled \
            or version.trust_state != "approved":
        raise ValueError("插件版本尚未审批启用")
    inputs = _validate_workflow_inputs(version.manifest or {}, inputs or {})
    from . import plugin_access
    await plugin_access.assert_task_use(session, plugin.id, task)
    if source_run.task_id != task.id or source_run.plugin_id != plugin.id:
        raise ValueError("只能续接这条需求同一个插件的历史运行")
    if source_run.state in _ACTIVE_RUN_STATES:
        raise ValueError("来源流程仍在运行，不能把未完成结果当作历史证据")
    active = (await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.task_id == task.id,
        am.WorkflowRun.state.in_(tuple(_ACTIVE_RUN_STATES))
    ).limit(1))).scalar_one_or_none()
    if active is not None:
        raise ValueError("这条需求已经有一个插件流程在运行")
    repo = await _bind_single_project_repo(session, task, repo_id)

    nodes = list(dict(version.workflow or {}).get("nodes") or [])
    ancestors = _ancestor_keys(nodes, str(target_key or ""))
    await _ensure_start_ready(
        session, task, binding, version, execution,
        {str(node.get("key") or "") for node in nodes} - ancestors, repo=repo)
    source_rows = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == source_run.id
    ).order_by(am.NodeRun.attempt, am.NodeRun.created_at))).scalars().all())
    source_latest: dict[str, am.NodeRun] = {}
    for row in source_rows:
        source_latest[row.node_key] = row
    continuation_feedback = _continuation_rework_feedback(
        nodes, source_latest, str(target_key or ""))

    adopted: list[tuple[dict, am.NodeRun]] = []
    for definition in nodes:
        key = str(definition.get("key") or "")
        if key not in ancestors:
            continue
        source = source_latest.get(key)
        if source is None or source.node_type != definition.get("type") \
                or source.state not in {"succeeded", "skipped"}:
            raise ValueError(f"历史流程的“{definition.get('name') or key}”没有完整成功证据")
        if source.node_type not in _ADOPTABLE_NODE_TYPES:
            raise ValueError(f"“{definition.get('name') or key}”必须在新版流程里重新执行")
        if source.state == "skipped" and not dict(definition.get("config") or {}).get("when"):
            raise ValueError(f"历史节点“{definition.get('name') or key}”不能无条件跳过")
        if source.node_type in {"spec", "human_review", "approval"}:
            await _approved_request(session, task.id, source)
        if source.node_type == "quality":
            checks = list(dict(source.output or {}).get("checks") or [])
            if not checks or any(not item.get("ok") for item in checks):
                raise ValueError("历史质量门禁没有完整的逐项通过证据")
        adopted.append((definition, source))

    artifact = await release_control.latest_artifact(session, task.id)
    merge_sources = [source for definition, source in adopted
                     if definition.get("type") == "merge"]
    if merge_sources:
        merge_output = dict(merge_sources[-1].output or {})
        merged_commit = str(merge_output.get("commit") or "")
        if artifact is None or artifact.kind != "code" or not artifact.commit_sha \
                or artifact.state not in {"merged", "tested", "accepted", "released"}:
            raise ValueError("当前需求没有仍然有效的已合并代码版本")
        if merged_commit and not artifact.commit_sha.lower().startswith(merged_commit.lower()) \
                and not merged_commit.lower().startswith(artifact.commit_sha.lower()):
            raise ValueError("当前代码版本与历史合并证据不一致")

    manifest = {
        "sourceRunId": source_run.id,
        "sourcePluginVersionId": source_run.plugin_version_id,
        "targetNode": target_key,
        "artifactVersionId": artifact.id if artifact else "",
        "commit": artifact.commit_sha if artifact else "",
        "nodes": [{"key": source.node_key, "type": source.node_type,
                   "sourceNodeId": source.id, "sourceAttempt": source.attempt,
                   "state": source.state}
                  for _, source in adopted],
    }
    run = am.WorkflowRun(
        task_id=task.id, plugin_id=plugin.id, plugin_version_id=version.id,
        binding_id=binding.id, state="running", input=inputs,
        context={"pluginKey": plugin.key, "pluginName": plugin.name,
                 "bindingConfig": binding.config or {},
                 "execution": execution_preferences(execution),
                 "instruction": instruction,
                 "reworkFeedback": ({str(target_key): continuation_feedback}
                                    if continuation_feedback else {}),
                 "adoption": manifest}, initiated_by=actor_id, started_at=_now())
    session.add(run)
    if task.status == "todo":   # Retrying release stages must not reactivate done or cancelled tasks.
        from . import task_status
        await task_status.mark(session, task, "doing", engine=True, why="run.started")
    await session.flush()
    code_target = await task_code_targets.freeze(session, task, repo)
    if code_target is not None:
        run.context = {**dict(run.context or {}),
                       "codeTargetId": code_target.id,
                       "codeTargetFingerprint": code_target.fingerprint}
    _event(session, run.id, "run.started", detail={
        "pluginId": plugin.id, "pluginVersionId": version.id,
        "adoptedFromRunId": source_run.id, "startAtNode": target_key,
    }, actor=actor_id or "system")
    for definition, source in adopted:
        output = {**dict(source.output or {}), "adoptedFrom": {
            "runId": source_run.id, "nodeId": source.id, "attempt": source.attempt,
        }}
        row = am.NodeRun(
            run_id=run.id, node_key=source.node_key, node_type=source.node_type,
            attempt=1, state=source.state,
            input={"adoption": {"sourceRunId": source_run.id,
                                 "sourceNodeId": source.id,
                                 "sourceAttempt": source.attempt}},
            output=output, executor=dict(source.executor or {}),
            idempotency_key=f"{run.id}:{source.node_key}:adopted:{source.id}"[:180],
            started_at=_now(), finished_at=_now())
        session.add(row)
        await session.flush()
        _event(session, run.id, "node.adopted", node_id=row.id,
               detail={"node": source.node_key, "sourceRunId": source_run.id,
                       "sourceNodeId": source.id, "sourceAttempt": source.attempt,
                       "sourceState": source.state}, actor=actor_id or "system")
    task_events.record(session, task.id, "plugin.resumed_from_evidence", {
        "runId": run.id, "sourceRunId": source_run.id,
        "versionId": version.id, "startAtNode": target_key,
        "artifactVersionId": manifest["artifactVersionId"],
        "commit": manifest["commit"], "adoptedNodes": len(adopted),
    }, actor="SoduWork")
    await session.commit()
    if task.owner_client_id:
        from ..realtime import hub
        from .tasks import task_to_api_live
        await publish_owner(session, task, {
            "type": "task.updated", "task": await task_to_api_live(session, task),
        })
    from . import workflow_engine
    await workflow_engine._schedule(session, run)
    return run

async def start_from_evidence(
        session: AsyncSession, task: models.Task, binding: am.PluginBinding, inputs: dict,
        source_run: am.WorkflowRun, target_key: str,
        actor_id: str = "", execution: dict | None = None,
        instruction: str = "", repo_id: str = "") -> am.WorkflowRun:
    from .task_requirements import ensure_executable
    ensure_executable(task)
    expected_owner = task.owner_client_id
    try:
        lease = await resource_leases.acquire(
            session, "workflow-start", str(task.id), ttl_seconds=120,
            detail={"taskId": str(task.id), "bindingId": str(binding.id),
                    "sourceRunId": str(source_run.id)})
    except resource_leases.LeaseBusy as exc:
        raise ValueError("This task is already starting a workflow") from exc
    try:
        task = await session.scalar(select(models.Task).where(
            models.Task.id == task.id,
        ).with_for_update().execution_options(populate_existing=True))
        if task is None:
            raise ValueError("需求已不存在，不能重新启动流程")
        if task.owner_client_id != expected_owner:
            raise ValueError("需求执行归属已变化，请刷新后重新安排")
        ensure_executable(task)
        return await _start_from_evidence_unlocked(
            session, task, binding, inputs, source_run, target_key,
            actor_id, execution, instruction, repo_id)
    except Exception:
        await session.rollback()
        raise
    finally:
        await resource_leases.release(session, lease)
