"""AI acceptance of fixed versions using read-only preparation, itemized report validation, and
shared approval writes.
"""
from __future__ import annotations

import asyncio
import weakref

from fastapi import HTTPException
from sqlalchemy import select

from .. import automation_models as am, models
from ..schemas import attachment_to_api
from . import approval_routing, delivery_bundle, gate_contract, release_control, task_access

_locks = weakref.WeakValueDictionary()


async def _identity(session, client, tid, *, lock=False):
    task = await session.get(models.Task, tid, with_for_update=lock,
                             populate_existing=lock)
    actor = await session.get(models.User, client.user_ref) if client.user_ref else None
    if task is None:
        raise HTTPException(404, "需求不存在")
    if actor is None or not actor.is_active:
        raise HTTPException(403, "请先登录有效账号再验收")
    return task, actor


async def _allowed(session, task, request, actor, artifact):
    """Read-only queries must not create assignments or notifications when opening acceptance
    options.
    """
    if request is None:
        if str(task.created_by or "") != str(actor.id):
            return False
        policy = await session.get(am.ApprovalPolicy, release_control.POLICY_REVIEW)
        request = am.ApprovalRequest(id="direct:" + task.id, action="review",
                                    policy_snapshot=dict(policy.rules or {}) if policy else {})
    return await approval_routing.preview_can_decide(session, task, request, actor, artifact)


async def _subject(session, task):
    artifact = await release_control.latest_artifact(session, task.id)
    if artifact is None:
        raise HTTPException(409, "当前还没有固定的交付版本，请先提交验收")
    rows = list((await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.task_id == task.id,
        am.ApprovalRequest.artifact_version_id == artifact.id,
        am.ApprovalRequest.action == "review",
    ).order_by(am.ApprovalRequest.created_at.desc()))).scalars().all())
    request = next((row for row in rows if row.status == "pending"), rows[0] if rows else None)
    other_pending = await session.scalar(select(am.ApprovalRequest.id).where(
        am.ApprovalRequest.task_id == task.id, am.ApprovalRequest.action == "review",
        am.ApprovalRequest.status == "pending",
        am.ApprovalRequest.artifact_version_id != artifact.id).limit(1))
    if other_pending:
        raise HTTPException(409, "尚有旧版本的验收票未结束，请刷新交付状态后重试")
    if request is None:
        from . import task_status
        if task.status != "done" or task.reviewed_at or await task_status.engine_owns(session, [task.id]):
            raise HTTPException(409, "当前需求没有待验收的交付审批")
    return artifact, request


def _criteria(task, request):
    context = dict(request.context or {}) if request else {}
    # Prefer business criteria frozen on the request; otherwise use the current requirements version.
    values = context.get("acceptanceCriteria") or context.get("criteria") or task.acceptance_criteria or []
    labels = []
    for value in values if isinstance(values, list) else []:
        label = str(value.get("label") or value.get("name") or "") if isinstance(value, dict) else str(value or "")
        if label.strip() and label.strip() not in labels:
            labels.append(label.strip())
    return [{"id": f"criterion-{index + 1}", "label": label} for index, label in enumerate(labels)]


async def _packet(session, task, artifact, request):
    if request is None:
        # Do not add preview objects to the session or implicitly create approval requests.
        request = am.ApprovalRequest(id="direct:" + task.id, task_id=task.id,
            artifact_version_id=artifact.id, action="review", environment_id="",
            policy_snapshot={}, context={"acceptanceCriteria": task.acceptance_criteria or []})
    return await gate_contract.packet(session, task, request, artifact)


async def context(session, client, tid):
    from . import tasks
    task, actor = await _identity(session, client, tid)
    artifact, request = await _subject(session, task)
    allowed = await _allowed(session, task, request, actor, artifact)
    if not allowed and not await task_access.can_view(session, client, task):
        raise HTTPException(403, "这项验收未分配给你")
    if task.status == "cancel" or task.archived_at:
        raise HTTPException(409, "已取消或归档的需求不能启动验收")
    gate = await _packet(session, task, artifact, request)
    rows = list((await session.execute(select(models.Attachment).where(
        models.Attachment.task_id == task.id))).scalars().all())
    # Gate evidence remains auditable, but only fixed deliverables are mandatory model inputs.
    selected = delivery_bundle.select_artifact(rows, artifact) if artifact.kind != "code" else []
    selected_ids = {row.id for row in selected}
    optional = [row for row in rows if row.id not in selected_ids and
                attachment_to_api(row)["role"] in {"input", "process", "verification", "output"}]
    bundle = None
    if len(selected) >= 2:
        safe = "".join(c for c in (task.title or "交付物") if c not in '\\/:*?"<>|').strip()[:40] or "交付物"
        bundle = {"filename": safe + ".zip", "artifactVersionId": artifact.id,
                  "attachmentIds": [row.id for row in selected], "fileCount": len(selected)}
    return {"task": await tasks.task_to_api_live(session, task),
            "approvalId": request.id if request else "direct:" + task.id,
            "artifactVersionId": artifact.id, "requirementVersion": task.requirement_version,
            "criteria": _criteria(task, request), "evidence": gate.get("evidence") or [],
            "readiness": gate.get("readiness") or {},
            "artifact": release_control.artifact_api(artifact),
            "attachments": [attachment_to_api(row) for row in selected],
            "optionalAttachments": [attachment_to_api(row) for row in optional],
            "attachmentIds": [row.id for row in selected],
            "deliveryBundle": bundle,
            "canDecide": allowed and (request is None or request.status == "pending"),
            "acceptanceOnly": True}


def validate_report(body, criteria):
    report = body.get("report")
    if not isinstance(report, dict):
        raise HTTPException(422, "自动验收需要 Agent 实际核验后的逐项报告，不能仅按附件存在批准")
    verdict, summary = report.get("verdict"), report.get("summary")
    checks = report.get("checks")
    if verdict not in {"approve", "reject"} or not isinstance(summary, str) or not summary.strip() or len(summary) > 4000:
        raise HTTPException(422, "验收报告缺少有效结论或复核摘要")
    if not criteria:
        raise HTTPException(422, "需求尚未填写验收标准，请先补充标准或改用人工验收")
    if not isinstance(checks, list) or len(checks) != len(criteria):
        raise HTTPException(422, "验收报告必须逐项覆盖全部验收标准")
    labels = {item["id"]: item for item in criteria}
    labels.update({item["label"]: item for item in criteria})
    seen, normalized = set(), []
    for check in checks:
        if not isinstance(check, dict):
            raise HTTPException(422, "验收报告检查项格式不正确")
        item = labels.get(str(check.get("criterion") or ""))
        evidence = check.get("evidence")
        if not item or item["id"] in seen or check.get("result") not in {"pass", "fail"}:
            raise HTTPException(422, "验收报告包含重复、未知标准或无效判断")
        if not isinstance(evidence, str) or not evidence.strip() or len(evidence) > 8000:
            raise HTTPException(422, "每项验收结论都必须附上实际核验依据")
        seen.add(item["id"])
        normalized.append({"criterion": item["id"], "label": item["label"],
                           "result": check["result"], "evidence": evidence.strip()})
    failed = any(item["result"] == "fail" for item in normalized)
    if (verdict == "approve") == failed:
        raise HTTPException(422, "验收总论与逐项核验结果不一致")
    return {"verdict": verdict, "summary": summary.strip(), "checks": normalized}


async def apply(session, client, tid, body):
    # Serialize same-process decisions for SQLite, which lacks row-level locking.
    # Production task and approval row locks also protect decisions across processes.
    lock = _locks.setdefault(tid, asyncio.Lock())
    async with lock:
        return await _apply(session, client, tid, body)


async def _apply(session, client, tid, body):
    from . import audit, receipts, task_events, task_rework, task_status, tasks
    if not isinstance(body.get("report"), dict):
        raise HTTPException(422, "自动验收需要 Agent 实际核验后的逐项报告，不能仅按附件存在批准")
    task, actor = await _identity(session, client, tid, lock=True)
    artifact, request = await _subject(session, task)
    if not await _allowed(session, task, request, actor, artifact):
        raise HTTPException(403, "这项验收未分配给你")
    if task.status == "cancel" or task.archived_at:
        raise HTTPException(409, "已取消或归档的需求不能自动验收")
    expected = request.id if request else "direct:" + tid
    saved = dict(dict(dict(request.context or {}).get("aiAcceptanceReports") or {}).get(actor.id) or {}) if request else {}
    direct_retry = (body.get("approvalId") == "direct:" + tid and
                    saved.get("sourceApprovalId") == body.get("approvalId") and
                    saved.get("artifactVersionId") == artifact.id and
                    saved.get("requirementVersion") == task.requirement_version)
    if (body.get("artifactVersionId") != artifact.id or
            body.get("requirementVersion") != task.requirement_version or
            (body.get("approvalId") != expected and not direct_retry)):
        raise HTTPException(409, "需求、交付版本或验收票已经变化，请重新发起验收")
    report = validate_report(body, _criteria(task, request))
    if report["verdict"] == "approve" and gate_contract.requires_manual_confirmation(artifact):
        raise HTTPException(422, "本轮没有可自动核验的交付物，请使用手动验收确认实际结果")
    if direct_retry and saved.get("report") != report:
        raise HTTPException(409, "本次直验已有其他结论，请刷新后查看")
    if request is not None:
        prior = (await session.execute(select(am.ApprovalDecision).where(
            am.ApprovalDecision.request_id == request.id,
            am.ApprovalDecision.user_id == actor.id))).scalars().first()
        if prior is not None:
            return {"ok": True, "already": True, "verdict":
                    "pending" if request.status == "pending" else request.status,
                    "task": await tasks.task_to_api_live(session, task),
                    "request": release_control.request_api(request),
                    "closed": request.status == "approved" and bool(task.reviewed_at) and task.status == "done"}
        if request.status != "pending":
            raise HTTPException(409, "这项验收已由其他人处理，请刷新")
    else:
        # Reuse the manual acceptance policy without letting creator identity bypass separation of duties.
        request = await release_control.ensure_request(session, task, artifact, "review",
            context={"acceptanceCriteria": task.acceptance_criteria or []})
    who = actor.display_name or actor.username
    execution = body.get("execution") if isinstance(body.get("execution"), dict) else {}
    origin = {key: str(execution[key])[:200] for key in ("agent", "pluginId", "conversationId") if execution.get(key)}
    reports = dict(dict(request.context or {}).get("aiAcceptanceReports") or {})
    reports[actor.id] = {"report": report, "execution": origin,
                         "sourceApprovalId": body.get("approvalId"),
                         "requirementVersion": task.requirement_version, "artifactVersionId": artifact.id}
    request.context = {**dict(request.context or {}), "aiAcceptanceReports": reports}
    note = "AI 验收：" + report["summary"][:600]
    failures = [item for item in report["checks"] if item["result"] == "fail"]
    if failures:
        note += "\n未通过项：" + "；".join(item["label"] + "：" + item["evidence"] for item in failures)[:500]
    was_reviewed = bool(task.reviewed_at)
    result = await release_control.decide(session, task, actor, action="review",
        decision=report["verdict"], note=note, artifact_version_id=artifact.id)
    if not result.get("ok"):
        raise HTTPException(403 if result.get("reason") == "forbidden" else 409,
                            result.get("detail") or "验收版本或证据已经变化，请重新核验")
    rework, blocked, closed = None, None, False
    if report["verdict"] == "reject":
        # Automatic rejection defaults to returning itemized feedback to the original AI for rework.
        # Return to the unstarted requirement pool only when a human explicitly selects that option.
        rework = await task_rework.resume_after_rejection(
            session, task, note, artifact_version_id=artifact.id,
            request_id=request.id, actor=who, fallback_on_missing_ref=True)
    elif request.status == "approved":
        applied = await task_status.mark(session, task, "done", why="AI 逐项验收通过")
        # Support legacy done-before-review projections, but never treat done alone as approval evidence.
        closed = bool(task.reviewed_at) and task.status == "done"
        if not applied and task.status != "done":
            from . import delivery_truth
            truth = await delivery_truth.evaluate(session, task)
            blocked = delivery_truth.blocked_summary(task, truth.get("blockers"))
    verdict = request.status
    task_events.record(session, tid, "artifact.auto_reviewed", {
        "by": who, "requestId": request.id, "versionId": artifact.id,
        "requirementVersion": task.requirement_version, "verdict": verdict,
        "report": report, "execution": origin, "taskClosed": closed}, actor=who)
    await audit.log(session, actor, "task.artifact_auto_review", "task", tid,
                    task.title, {"verdict": verdict, "requestId": request.id})
    await session.commit()
    if closed and not was_reviewed:
        await receipts.notify_on_close(session, task, task.owner_client_id)
    api = await tasks.task_to_api_live(session, task)
    await task_access.publish_task(session, task, "task.updated", api)
    owner = await session.get(models.Client, task.owner_client_id) if task.owner_client_id else None
    if owner and task_access.is_owner(task, owner) and owner.id != client.id:
        from ..realtime import hub
        outcome = ("AI 验收通过" if verdict == "approved" else
                   "AI 验收未通过，已记录退回意见" if verdict == "rejected" else
                   "已完成本人的 AI 验收，仍待其他验收人确认")
        await task_access.publish_owner(session, task, {"type": "notice", "taskId": tid,
            "text": f"{who} 对「{task.title}」{outcome}"})
    return {"ok": True, "verdict": verdict, "closed": closed, "taskBlocked": blocked,
            "rework": rework, "request": release_control.request_api(request), "task": api}
