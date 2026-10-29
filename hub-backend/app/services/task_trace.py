"""Public module behavior and service contracts."""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from ..schemas import _ms, attachment_to_api
from . import task_code_targets
from . import gate_contract, resource_access, task_execution_contract as contract

log = logging.getLogger("uvicorn.error")

# Distinguish human and machine waiting gates so cards show who must act.
_WAITS_HUMAN = ("spec", "human_review", "approval")


def _node_label(node: dict) -> str:
    return str(node.get("name") or node.get("key") or "某一关")


async def _runs(session: AsyncSession, task_id: str) -> list[am.WorkflowRun]:
    return list((await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.task_id == task_id
    ).order_by(am.WorkflowRun.created_at.desc()))).scalars().all())


async def _ai_sessions(session: AsyncSession, task_id: str) -> list[dict]:
    """List AI sessions dispatched directly or through plugins from the shared task history."""
    from .ai_exec import EV_DISPATCHED
    rows = list((await session.execute(select(models.TaskEvent).where(
        models.TaskEvent.task_id == task_id,
        models.TaskEvent.kind == EV_DISPATCHED
    ).order_by(models.TaskEvent.at))).scalars().all())
    out = []
    for row in rows:
        d = dict(row.detail or {})
        out.append({
            "ref": str(d.get("ref") or d.get("issueId") or ""),
            "assignee": str(d.get("assigneeName") or d.get("assigneeId") or ""),
            "cli": str(d.get("assigneeCli") or ""), "provider": str(d.get("provider") or ""),
            "runnerId": str(d.get("runnerId") or ""), "host": str(d.get("host") or ""),
            "by": str(d.get("by") or row.actor or ""), "url": str(d.get("url") or ""),
            "plugin": dict(d.get("plugin") or {}), "at": _ms(row.at),
        })
    return out


async def _approvals(session: AsyncSession, task: models.Task, *,
                     attachment_rows: list | None = None,
                     deployment_rows: list | None = None) -> list[dict]:
    from . import release_control
    rows = list((await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.task_id == task.id
    ).order_by(am.ApprovalRequest.created_at))).scalars().all())
    if not rows:
        return []
    grouped = await release_control.decisions_bulk(session, [x.id for x in rows])
    env_ids = {x.environment_id for x in rows if x.environment_id}
    artifact_ids = {x.artifact_version_id for x in rows if x.artifact_version_id}
    environments = {x.id: x for x in (await session.execute(select(am.Environment).where(
        am.Environment.id.in_(env_ids or {"__none__"})
    ))).scalars().all()}
    artifacts = {x.id: x for x in (await session.execute(select(am.ArtifactVersion).where(
        am.ArtifactVersion.id.in_(artifact_ids or {"__none__"})
    ))).scalars().all()}
    out = []
    for row in rows:
        item = release_control.request_api(row, grouped.get(row.id) or [])
        env = environments.get(row.environment_id)
        item["environmentName"] = env.name if env else ""
        item["environmentTier"] = env.tier if env else ""
        artifact = artifacts.get(row.artifact_version_id)
        locked = release_control.artifact_api(artifact)
        policy, context = dict(item.get("policy") or {}), dict(item.get("context") or {})
        criteria = []
        for source in (context.get("acceptanceCriteria"), context.get("criteria"),
                       policy.get("acceptanceCriteria"), policy.get("criteria"), policy.get("checks")):
            if isinstance(source, list):
                criteria.extend(str(x.get("name") or x.get("label") or x) if isinstance(x, dict)
                                else str(x) for x in source if x)
        if not criteria:
            criteria = ["确认固定交付版本符合需求目标与验收边界"]
        live_gate = await gate_contract.packet(
            session, task, row, artifact, env,
            attachment_rows=attachment_rows, deployment_rows=deployment_rows)
        snapshots = [dict(decision.get("gateSnapshot") or {})
                     for decision in item.get("decisions") or []
                     if dict(decision.get("gateSnapshot") or {}).get("schemaVersion")]
        frozen = snapshots[-1] if row.status != "pending" and snapshots else {}
        gate = frozen or live_gate
        item["gate"] = gate
        item["gateIsSnapshot"] = bool(frozen)
        item["confirmation"] = {
            "title": {"baseline": "确认需求基线", "review": "验收交付结果",
                      "merge": "授权合并固定版本", "uat": "确认环境验收结果",
                      "deploy": "授权发布到目标环境"}.get(row.action, "确认当前关口"),
            "criteria": [str(x.get("label") or "") for x in gate.get("criteria") or []]
                        or criteria[:30],
            "gate": gate, "lockedArtifact": locked,
            "targetEnvironment": ({"id": env.id, "name": env.name, "tier": env.tier}
                                  if env else None),
            "required": row.required_count,
        }
        out.append(item)
    return out


async def _deployment_rows(session: AsyncSession, task_id: str) -> list[am.DeploymentRun]:
    return list((await session.execute(select(am.DeploymentRun).where(
        am.DeploymentRun.task_id == task_id
    ).order_by(am.DeploymentRun.created_at))).scalars().all())


async def _deployments(session: AsyncSession, task_id: str,
                       rows: list[am.DeploymentRun] | None = None) -> list[dict]:
    from . import deployments, release_providers
    if rows is None:
        rows = await _deployment_rows(session, task_id)
    env_ids = {x.environment_id for x in rows if x.environment_id}
    target_ids = {x.target_id for x in rows if x.target_id}
    environments = {x.id: x for x in (await session.execute(select(am.Environment).where(
        am.Environment.id.in_(env_ids or {"__none__"})
    ))).scalars().all()}
    targets = {x.id: x for x in (await session.execute(select(am.DeploymentTarget).where(
        am.DeploymentTarget.id.in_(target_ids or {"__none__"})
    ))).scalars().all()}
    out = []
    for row in rows:
        env = environments.get(row.environment_id)
        target = targets.get(row.target_id)
        item = deployments.run_api(row, env, target)
        item["provider"] = release_providers.provider_of(target) if target else ""
        item["channel"] = release_providers.describe(target) if target else ""
        item["log"] = str(item.get("log") or "")[-4000:]      # Task details need only a bounded recent log excerpt.
        out.append(item)
    return out


async def _artifacts(session: AsyncSession, task_id: str) -> list[dict]:
    from . import release_control
    rows = list((await session.execute(select(am.ArtifactVersion).where(
        am.ArtifactVersion.task_id == task_id
    ).order_by(am.ArtifactVersion.seq))).scalars().all())
    out = []
    for row in rows:
        review = dict((row.manifest or {}).get("aiReview") or {})
        item = release_control.artifact_api(row) or {}
        item["aiReview"] = ({"verdict": review.get("verdict"), "summary": review.get("summary"),
                             "reportChecksum": review.get("reportChecksum"),
                             "attachmentId": review.get("attachmentId"),
                             "reviewedAt": review.get("reviewedAt")} if review else None)
        out.append(item)
    return out


def _evidence(node: dict, attachments: list[dict]) -> list[dict]:
    """Compatibility entry point; task_execution_contract owns the protocol."""
    return contract.node_evidence(node, attachments)


def _node_view(node: dict, attachments: list[dict]) -> dict:
    evidence = _evidence(node, attachments)
    return {**node, "evidence": evidence, "evidenceCount": len(evidence),
            "waitsHuman": str(node.get("type") or "") in _WAITS_HUMAN
            or node.get("state") == "waiting_human"}


def _merge_sessions(durable: list[dict], legacy: list[dict]) -> list[dict]:
    """Persisted sessions are authoritative; dispatch events supply names and legacy sessions
    missing rows.
    """
    legacy_by_ref = {str(x.get("ref") or ""): x for x in legacy if x.get("ref")}
    out, seen = [], set()
    for row in durable:
        ref = str(row.get("ref") or "")
        old = legacy_by_ref.get(ref) or {}
        item = {**old, **row}
        item["assignee"] = str(old.get("assignee") or row.get("engine") or row.get("runnerId") or "AI 执行器")
        item["cli"] = str(row.get("engine") or old.get("cli") or "")
        item["plugin"] = dict(old.get("plugin") or {})
        item["provider"] = str(old.get("provider") or ("runner" if row.get("runnerId") else "local"))
        out.append(item)
        if ref:
            seen.add(ref)
    for row in reversed(legacy):
        if not row.get("ref") or str(row.get("ref")) not in seen:
            out.append({"status": "", "items": [], "persisted": False, **row})
    return out


async def _card_from_views(session: AsyncSession, task: models.Task, runs: list[dict],
                           sessions: list[dict], delivery: dict | None = None) -> dict:
    active = next((x for x in runs if contract.is_active(x.get("state"))), None)
    run = active or (runs[0] if runs else None)
    stage: dict = {}
    progress = {"done": 0, "total": 0}
    executor: dict = {}
    pending: dict = {"kind": "none"}
    if run is not None:
        node = contract.current_node(run)
        progress = contract.run_progress(run)
        stage_state = contract.node_state(node)
        stage = {"key": node.get("key") or "", "name": _node_label(node),
                 "type": node.get("type") or "", "state": stage_state,
                 "attempt": node.get("attempt") or 0, "error": node.get("error") or "",
                 "diagnosis": dict(node.get("diagnosis") or {})}
        executor = dict(node.get("executor") or {})
        if node.get("state") == "waiting_human":
            pending = {"kind": str(node.get("type") or "human_review"),
                       "requestId": str(dict(node.get("output") or {}).get("requestId") or ""),
                       "node": node.get("key") or ""}
    current_session = contract.current_session(sessions)
    if not executor and current_session:
        last = current_session
        executor = {"assignee": last.get("assignee"), "provider": last.get("provider"),
                    "ref": last.get("ref"), "host": last.get("host")}
        if not stage:
            stage = {"key": "execute", "name": "AI 执行", "type": "ai",
                     "state": contract.session_state(sessions, "running"),
                     "attempt": 1, "error": last.get("error") or ""}
            progress = {"done": 1 if stage["state"] == "succeeded" else 0, "total": 1}
    repo = await task_code_targets.repo_view(session, task)
    project = await session.get(models.Project, task.project_id) if task.project_id else None
    return resource_access.decorate({
        "taskId": task.id, "title": task.title, "status": task.status,
        "priority": getattr(task, "priority", "") or "", "ownerClientId": task.owner_client_id,
        "projectName": project.name if project else "", "repoName": repo.name if repo else "",
        "codeTarget": task_code_targets.api(await task_code_targets.get(session, task.id)),
        "workScenario": {
            "key": getattr(task, "work_scenario_key", "") or "",
            "name": getattr(task, "work_scenario_name", "") or "",
            "routing": dict(getattr(task, "work_routing", None) or {}),
        },
        "runId": str(run.get("id") or "") if run else "",
        "runState": str(run.get("state") or "") if run else "",
        "pluginName": str(dict(run.get("plugin") or {}).get("name") or "") if run else "",
        "stage": stage, "progress": progress, "executor": executor, "pending": pending,
        "delivery": delivery or {},
        "aiSessions": len(sessions),
        # Expose stop for running workflows and retry for failed gates.
        # Gate retry requires the overall workflow to be failed.
        # Do not enable retry while another node is running if the engine would reject it.
        "canCancel": bool(active or contract.is_active(contract.session_state(sessions))),
        "canRetry": bool(run is not None and run.get("state") == "failed"
                         and stage.get("state") in ("failed", "blocked", "rework")
                         and dict(stage.get("diagnosis") or {}).get("retryable")),
        "updatedAt": _ms(getattr(task, "updated_at", None)) or _ms(task.created),
    })


async def card(session: AsyncSession, task: models.Task) -> dict:
    """Build the shared task card using the same projection as the full trace."""
    from . import delivery_truth, execution_sessions, workflow_engine
    runs = [await workflow_engine.run_api(session, row) for row in await _runs(session, task.id)]
    execution = await execution_sessions.list_task(session, task.id, limit=12, event_limit=0)
    sessions = _merge_sessions(list(execution.get("sessions") or []),
                               await _ai_sessions(session, task.id))
    delivery = await delivery_truth.evaluate(session, task)
    return await _card_from_views(session, task, runs, sessions, delivery)


async def trace(session: AsyncSession, task: models.Task,
                evolution_access: dict | None = None) -> dict:
    """Return the versioned task trace with legacy fields. Read attachments and deployments once,
    reuse approval evidence packets, and bound session events. Run independent read branches
    concurrently with separate AsyncSessions and no cross-session lazy ORM reads.
    """
    import asyncio

    from ..db import SessionLocal
    from . import (delivery_truth, execution_sessions, project_context,
                   task_events, task_evolution, workflow_engine)
    from .tasks import task_to_api_live

    task_id = task.id
    rows = list((await session.execute(select(models.Attachment).where(
        models.Attachment.task_id == task_id
    ).order_by(models.Attachment.created_at))).scalars().all())
    attachments = [attachment_to_api(x) for x in rows]

    async def _branch(loader):
        async with SessionLocal() as s:
            branch_task = await s.get(models.Task, task_id)
            return await loader(s, branch_task)

    async def _load_runs(s: AsyncSession, t: models.Task):
        views = []
        for run in await _runs(s, task_id):
            view = await workflow_engine.run_api(s, run)
            view["nodes"] = [_node_view(x, attachments) for x in (view.get("nodes") or [])]
            view["progress"] = contract.run_progress(view)
            views.append(view)
        return views, await _artifacts(s, task_id)

    async def _load_sessions(s: AsyncSession, t: models.Task):
        execution = await execution_sessions.list_task(s, task_id, event_limit=48)
        legacy_ai = await _ai_sessions(s, task_id)
        deployment_rows = await _deployment_rows(s, task_id)
        approvals = await _approvals(s, t, attachment_rows=rows,
                                     deployment_rows=deployment_rows)
        deployments = await _deployments(s, task_id, deployment_rows)
        return execution, legacy_ai, approvals, deployments

    async def _load_views(s: AsyncSession, t: models.Task):
        timeline = await task_events.timeline(s, task_id)
        evolution = await task_evolution.view(s, t, access=evolution_access)
        task_view = await task_to_api_live(s, t)
        delivery = await delivery_truth.evaluate(s, t)
        context_view = await project_context.task_view(s, t)
        return timeline, evolution, task_view, delivery, context_view

    (runs, artifacts), (execution, legacy_ai, approvals, deployments), \
        (timeline, evolution, task_view, delivery, context_view) = await asyncio.gather(
            _branch(_load_runs), _branch(_load_sessions), _branch(_load_views))
    sessions = _merge_sessions(list(execution.get("sessions") or []), legacy_ai)
    card_view = await _card_from_views(session, task, runs, sessions, delivery)
    stages = contract.build_stages(
        task_view, runs, sessions, approvals, deployments, artifacts, attachments, timeline=timeline)
    phases = contract.build_phases(task_view, stages, timeline, evolution)
    return resource_access.decorate({
        "schemaVersion": contract.SCHEMA_VERSION,
        "summary": contract.summary(
            stages, phases, sessions, approvals, deployments, artifacts, attachments,
            task=task_view, timeline=timeline),
        "phases": phases, "stages": stages,
        "task": task_view,
        "card": card_view,
        "delivery": delivery,
        "projectContext": context_view,
        "runs": runs,
        "approvals": approvals,
        "ai": sessions,
        "execution": {**execution, "sessions": sessions},
        "deployments": deployments,
        "artifacts": artifacts,
        "attachments": attachments,
        "evolution": evolution,
        "timeline": timeline,
    })
