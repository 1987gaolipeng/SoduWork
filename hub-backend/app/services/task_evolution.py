"""Task evaluation and controlled evolution.

The service keeps three boundaries explicit:

1. an evaluation is a human fact about one completed task;
2. a proposal is a reviewable suggestion derived from that fact and the task's execution context;
3. an accepted proposal cannot silently rewrite a live workflow.  It becomes ``applied`` only
   after an independently imported and approved immutable plugin version is linked to it.

That separation lets SoduWork learn from every kind of work without turning one person's feedback
into uncontrolled enterprise-wide behaviour.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from ..schemas import _ms
from . import task_events

OUTCOMES = {"achieved", "partial", "missed"}
DECISIONS = {"accepted", "rejected"}
_DEFAULT_SCORE = {"achieved": 5, "partial": 3, "missed": 1}


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def evaluation_api(row: am.TaskEvaluation | None) -> dict | None:
    if row is None:
        return None
    return {
        "id": row.id, "taskId": row.task_id,
        "evaluatorId": row.evaluator_id, "evaluatorName": row.evaluator_name,
        "outcome": row.outcome, "score": row.score, "summary": row.summary,
        "workedWell": row.worked_well, "improvement": row.improvement,
        "reusableLesson": row.reusable_lesson, "revision": row.revision,
        "createdAt": _ms(row.created_at), "updatedAt": _ms(row.updated_at),
    }


def proposal_api(row: am.EvolutionProposal | None) -> dict | None:
    if row is None:
        return None
    return {
        "id": row.id, "taskId": row.task_id, "evaluationId": row.evaluation_id,
        "projectId": row.project_id, "pluginId": row.plugin_id,
        "sourcePluginVersionId": row.source_plugin_version_id,
        "targetKind": row.target_kind, "title": row.title,
        "problem": row.problem, "proposal": row.proposal,
        "evidence": row.evidence or {}, "state": row.state,
        "proposedBy": row.proposed_by,
        "reviewedBy": row.reviewed_by, "reviewedByName": row.reviewed_by_name,
        "reviewNote": row.review_note, "reviewedAt": _ms(row.reviewed_at),
        "appliedPluginVersionId": row.applied_plugin_version_id,
        "appliedBy": row.applied_by, "appliedAt": _ms(row.applied_at),
        "createdAt": _ms(row.created_at), "updatedAt": _ms(row.updated_at),
    }


async def _run_context(session: AsyncSession, task: models.Task) -> dict:
    run = (await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.task_id == task.id
    ).order_by(am.WorkflowRun.created_at.desc()).limit(1))).scalar_one_or_none()
    if run is None:
        return {"run": None, "plugin": None}
    plugin = await session.get(am.Plugin, run.plugin_id)
    return {"run": run, "plugin": plugin}


def _proposal_copy(task: models.Task, evaluation: am.TaskEvaluation,
                   run: am.WorkflowRun | None, plugin: am.Plugin | None) -> dict:
    workflow = bool(run and plugin)
    subject = plugin.name if workflow else task.title
    improvement = evaluation.improvement or evaluation.summary
    lesson = evaluation.reusable_lesson or evaluation.worked_well
    if workflow:
        title = "优化「%s」的执行方法" % subject
        proposal = improvement or ("把本次有效做法补进「%s」的下一版本说明与检查项" % subject)
        target = "workflow"
    else:
        title = "沉淀「%s」的复用经验" % subject
        proposal = improvement or lesson or "把本次交付方法整理为下一次可复用的工作说明"
        target = "knowledge"
    problem = improvement or {
        "achieved": "本次结果已达成，值得把有效做法固化下来",
        "partial": "本次只部分达成，需要减少下一次的返工与等待",
        "missed": "本次未达成，需要在下一次执行前修正方法",
    }[evaluation.outcome]
    return {"title": title[:240], "problem": problem, "proposal": proposal,
            "target": target, "lesson": lesson}


async def evaluate(session: AsyncSession, task: models.Task, body: dict,
                   *, actor_id: str, actor_name: str) -> dict:
    """Create or update this actor's evaluation and optionally form a proposal."""
    if task.status != "done":
        raise ValueError("需求完成后才能评价；现在先把交付与验收走完")
    outcome = _text(body.get("outcome"), 16)
    if outcome not in OUTCOMES:
        raise ValueError("请选择本次结果是已达成、部分达成还是未达成")
    try:
        score = int(body.get("score") or _DEFAULT_SCORE[outcome])
    except (TypeError, ValueError):
        score = _DEFAULT_SCORE[outcome]
    if score < 1 or score > 5:
        raise ValueError("评分只能是 1 到 5")
    actor_id = _text(actor_id, 80)
    if not actor_id:
        raise ValueError("当前身份无法记录评价")
    values = {
        "evaluator_name": _text(actor_name, 80),
        "outcome": outcome, "score": score,
        "summary": _text(body.get("summary"), 2000),
        "worked_well": _text(body.get("workedWell"), 4000),
        "improvement": _text(body.get("improvement"), 4000),
        "reusable_lesson": _text(body.get("reusableLesson"), 4000),
    }
    row = (await session.execute(select(am.TaskEvaluation).where(
        am.TaskEvaluation.task_id == task.id,
        am.TaskEvaluation.evaluator_id == actor_id,
    ).limit(1))).scalar_one_or_none()
    if row is None:
        row = am.TaskEvaluation(task_id=task.id, evaluator_id=actor_id, revision=1, **values)
        session.add(row)
    else:
        for key, value in values.items():
            setattr(row, key, value)
        row.revision = int(row.revision or 0) + 1
    await session.flush()
    task_events.record(session, task.id, "task.evaluated", {
        "evaluationId": row.id, "outcome": outcome, "score": score,
        "revision": row.revision,
    }, actor=values["evaluator_name"] or actor_id)

    if bool(body.get("createProposal")):
        context = await _run_context(session, task)
        run, plugin = context["run"], context["plugin"]
        copy = _proposal_copy(task, row, run, plugin)
        proposal = (await session.execute(select(am.EvolutionProposal).where(
            am.EvolutionProposal.task_id == task.id,
            am.EvolutionProposal.state == "pending",
        ).order_by(am.EvolutionProposal.updated_at.desc()).limit(1))).scalar_one_or_none()
        created = proposal is None
        evidence = {
            "task": {"id": task.id, "title": task.title, "status": task.status,
                     "projectId": task.project_id or "", "repoId": task.repo_id or ""},
            "evaluation": {"id": row.id, "revision": row.revision,
                           "outcome": outcome, "score": score,
                           "summary": values["summary"], "workedWell": values["worked_well"],
                           "improvement": values["improvement"],
                           "reusableLesson": values["reusable_lesson"]},
            "workflow": {"runId": run.id if run else "",
                         "pluginId": run.plugin_id if run else "",
                         "pluginVersionId": run.plugin_version_id if run else ""},
        }
        fields = {
            "evaluation_id": row.id, "project_id": task.project_id or "",
            "plugin_id": run.plugin_id if run else "",
            "source_plugin_version_id": run.plugin_version_id if run else "",
            "target_kind": copy["target"], "title": copy["title"],
            "problem": copy["problem"], "proposal": copy["proposal"],
            "evidence": evidence, "proposed_by": actor_id,
        }
        if proposal is None:
            proposal = am.EvolutionProposal(task_id=task.id, **fields)
            session.add(proposal)
            await session.flush()
        else:
            for key, value in fields.items():
                setattr(proposal, key, value)
        if created:
            task_events.record(session, task.id, "evolution.proposed", {
                "proposalId": proposal.id, "title": proposal.title,
                "targetKind": proposal.target_kind,
            }, actor=values["evaluator_name"] or actor_id)
    await session.commit()
    return await view(session, task, access={
        "actorId": actor_id, "canEvaluate": True, "canReview": True, "canApply": False,
    })


async def decide(session: AsyncSession, task: models.Task, proposal_id: str, decision: str,
                 note: str, *, actor_id: str, actor_name: str) -> dict:
    decision = _text(decision, 20)
    if decision not in DECISIONS:
        raise ValueError("决定只能是采纳或驳回")
    row = await session.get(am.EvolutionProposal, proposal_id)
    if row is None or row.task_id != task.id:
        raise LookupError("改进建议不存在")
    if row.state == decision:
        return proposal_api(row) or {}
    if row.state != "pending":
        raise ValueError("这条建议已经处理，刷新后查看最新状态")
    row.state = decision
    row.reviewed_by = _text(actor_id, 80)
    row.reviewed_by_name = _text(actor_name, 80)
    row.review_note = _text(note, 4000)
    row.reviewed_at = datetime.now(timezone.utc)
    task_events.record(session, task.id, "evolution.%s" % decision, {
        "proposalId": row.id, "title": row.title, "note": row.review_note[:300],
    }, actor=row.reviewed_by_name or row.reviewed_by)
    await session.commit()
    await session.refresh(row)
    return proposal_api(row) or {}


async def mark_applied(session: AsyncSession, task: models.Task, proposal_id: str,
                       plugin_version_id: str, *, actor_id: str, actor_name: str) -> dict:
    """Link an accepted proposal to a separately approved immutable plugin version."""
    row = await session.get(am.EvolutionProposal, proposal_id)
    if row is None or row.task_id != task.id:
        raise LookupError("改进建议不存在")
    if row.state == "applied" and row.applied_plugin_version_id == plugin_version_id:
        return proposal_api(row) or {}
    if row.state != "accepted":
        raise ValueError("只有已经采纳的建议才能关联新版本")
    if not row.plugin_id:
        raise ValueError("这条建议是知识沉淀，不属于某个工作流插件版本")
    version = await session.get(am.PluginVersion, _text(plugin_version_id, 36))
    if version is None or version.plugin_id != row.plugin_id:
        raise ValueError("选择的新版本不属于原工作流插件")
    if version.id == row.source_plugin_version_id:
        raise ValueError("不能把建议标记到原版本；请先形成一个内容不同的新版本")
    if version.trust_state != "approved" or not version.enabled:
        raise ValueError("新版本还没有通过隔离审查并启用")
    row.state = "applied"
    row.applied_plugin_version_id = version.id
    row.applied_by = _text(actor_id, 80)
    row.applied_at = datetime.now(timezone.utc)
    task_events.record(session, task.id, "evolution.applied", {
        "proposalId": row.id, "pluginVersionId": version.id, "version": version.version,
    }, actor=_text(actor_name, 80) or row.applied_by)
    await session.commit()
    await session.refresh(row)
    return proposal_api(row) or {}


async def view(session: AsyncSession, task: models.Task, access: dict | None = None) -> dict:
    evaluations = list((await session.execute(select(am.TaskEvaluation).where(
        am.TaskEvaluation.task_id == task.id
    ).order_by(am.TaskEvaluation.updated_at.desc()).limit(30))).scalars().all())
    proposals = list((await session.execute(select(am.EvolutionProposal).where(
        am.EvolutionProposal.task_id == task.id
    ).order_by(am.EvolutionProposal.updated_at.desc()).limit(30))).scalars().all())
    actor_id = str(dict(access or {}).get("actorId") or "")
    mine = next((row for row in evaluations if row.evaluator_id == actor_id), None)
    latest = mine or (evaluations[0] if evaluations else None)
    current = (next((row for row in proposals if row.state == "pending"), None)
               or next((row for row in proposals if row.state == "accepted"), None)
               or next((row for row in proposals if row.state == "applied"), None)
               or (proposals[0] if proposals else None))
    if task.status != "done":
        state = "not_ready"
    elif not evaluations:
        state = "awaiting_evaluation"
    elif any(row.state == "pending" for row in proposals):
        state = "awaiting_decision"
    elif any(row.state == "applied" for row in proposals):
        state = "applied"
    elif any(row.state == "accepted" for row in proposals):
        state = "adopted"
    else:
        state = "evaluated"
    rights = dict(access or {})
    rights.pop("actorId", None)
    return {
        "state": state, "available": task.status == "done",
        "evaluation": evaluation_api(latest), "myEvaluation": evaluation_api(mine),
        "evaluations": [evaluation_api(row) for row in evaluations],
        "proposal": proposal_api(current),
        "proposals": [proposal_api(row) for row in proposals],
        "counts": {"evaluations": len(evaluations), "proposals": len(proposals),
                   "pending": sum(1 for row in proposals if row.state == "pending"),
                   "applied": sum(1 for row in proposals if row.state == "applied")},
        "access": {"canEvaluate": bool(rights.get("canEvaluate")),
                   "canReview": bool(rights.get("canReview")),
                   "canApply": bool(rights.get("canApply"))},
        "guardrail": "采纳只进入受控改进队列，不会修改当前流程；形成、预检并审批新版本后才算应用。",
    }
