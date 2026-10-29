"""Derived delivery facts shared by client views and completion gates. Interpret existing task,
execution, artifact, approval, workflow, and deployment records without creating another
authoritative final-state table.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from . import delivery_manifest


SCHEMA_VERSION = "1.0"
_ACTIVE_RUN = {"queued", "running", "waiting_human", "waiting_external"}
_DONE_NODE = {"succeeded", "skipped"}
_HUMAN_NODE = {"spec", "human_review", "approval"}
_ACTIVE_SESSION = {"queued", "dispatching", "running"}
_FAILED_SESSION = {"failed", "stopped", "interrupted", "cancelled", "canceled"}


def _dt(value) -> datetime:
    if value is None:
        return datetime.min.replace(tzinfo=timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _block(code: str, title: str, detail: str, action: str = "") -> dict:
    return {"code": code, "title": title, "detail": detail, "action": action}


def _latest_nodes(rows: list[am.NodeRun]) -> dict[str, am.NodeRun]:
    latest: dict[str, am.NodeRun] = {}
    for row in rows:
        old = latest.get(row.node_key)
        if old is None or int(row.attempt or 0) >= int(old.attempt or 0):
            latest[row.node_key] = row
    return latest


def _workflow_nodes(version: am.PluginVersion | None) -> list[dict]:
    workflow = dict(getattr(version, "workflow", None) or {})
    return [dict(item) for item in (workflow.get("nodes") or []) if isinstance(item, dict)]


def artifact_manifest(artifact: am.ArtifactVersion | None) -> dict:
    if artifact is None:
        return delivery_manifest.build([])
    if artifact.kind == "code":
        valid = bool(artifact.commit_sha and artifact.checksum)
        item = {
            "id": artifact.id, "name": artifact.commit_sha or artifact.branch or "代码版本",
            "size": 0, "contentType": "application/x-git", "role": "output",
            "category": "primary", "sourceRef": artifact.source_ref,
            "url": artifact.url or "", "validation": {
                "state": "passed" if valid else "failed",
                **({} if valid else {"reason": "代码版本缺少提交指纹"}),
            },
        }
        return {
            "schemaVersion": delivery_manifest.SCHEMA_VERSION, "complete": valid,
            "url": artifact.url or "", "files": [item], "primary": [item],
            "supporting": [], "evidence": [], "internal": [],
            "problems": [] if valid else [{"code": "invalid_output", "name": item["name"],
                                               "detail": "代码版本缺少提交指纹"}],
            "counts": {"primary": 1, "supporting": 0, "evidence": 0, "internal": 0},
        }
    manifest = dict(artifact.manifest or {})
    if manifest.get("schemaVersion") and all(key in manifest for key in ("primary", "problems")):
        return manifest
    # Legacy candidates without classification and validation metadata are not presumed verified.
    files = []
    for raw in manifest.get("files") or []:
        if not isinstance(raw, dict):
            continue
        name = delivery_manifest.normalize_name(raw.get("name") or raw.get("filename"))
        category = delivery_manifest.classify_name(name)
        if category == "internal":
            continue
        files.append({
            "id": str(raw.get("id") or ""), "name": name,
            "size": int(raw.get("size") or 0),
            "contentType": str(raw.get("contentType") or "application/octet-stream"),
            "role": "output", "category": category, "sourceRef": artifact.source_ref,
            "url": "/attachments/" + str(raw.get("id") or ""),
            "validation": {"state": "unverified", "reason": "旧版本尚未经过结构校验"},
        })
    groups = {key: [x for x in files if x["category"] == key]
              for key in ("primary", "supporting", "evidence", "internal")}
    url = str(artifact.url or manifest.get("url") or "").strip()
    problems = [{"code": "unverified_output", "name": x["name"],
                 "detail": "旧版本尚未经过结构校验"}
                for x in groups["primary"] + groups["supporting"]]
    return {
        "schemaVersion": delivery_manifest.SCHEMA_VERSION,
        "complete": bool((groups["primary"] or url) and not problems),
        "url": url, "files": groups["primary"] + groups["supporting"], **groups,
        "problems": problems,
        "counts": {key: len(value) for key, value in groups.items()},
    }


async def _facts(session: AsyncSession, task: models.Task) -> dict:
    runs = list((await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.task_id == task.id
    ).order_by(am.WorkflowRun.created_at.desc()))).scalars().all())
    direct = list((await session.execute(select(am.ExecutionSession).where(
        am.ExecutionSession.task_id == task.id,
        or_(am.ExecutionSession.workflow_run_id == "",
            am.ExecutionSession.workflow_run_id.is_(None)),
    ).order_by(am.ExecutionSession.created_at.desc()))).scalars().all())
    artifact = (await session.execute(select(am.ArtifactVersion).where(
        am.ArtifactVersion.task_id == task.id,
        am.ArtifactVersion.kind.not_in(("requirement",)),
    ).order_by(am.ArtifactVersion.seq.desc(),
               am.ArtifactVersion.created_at.desc()).limit(1))).scalar_one_or_none()
    task_approvals = list((await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.task_id == task.id
    ).order_by(am.ApprovalRequest.created_at))).scalars().all())
    approvals = []
    if artifact is not None:
        approvals = [row for row in task_approvals if row.artifact_version_id == artifact.id]
    return {"runs": runs, "direct": direct, "artifact": artifact,
            "approvals": approvals, "taskApprovals": task_approvals}


def _authority(facts: dict) -> tuple[str, object | None]:
    runs, direct = facts["runs"], facts["direct"]
    # Created timestamps may have only second precision in SQLite or migrated databases.
    # A failed attempt and its successful continuation may share that timestamp.
    # Order terminal attempts by finished_at, with created_at and ID as stable tie-breakers.
    run_key = lambda row: (
        _dt(row.finished_at or row.created_at), _dt(row.created_at), str(row.id or ""))
    active_rows = [row for row in runs if row.state in _ACTIVE_RUN]
    active = max(active_rows, key=run_key) if active_rows else None
    if active is not None:
        return "workflow", active
    latest_run = max(runs, key=run_key) if runs else None
    direct_key = lambda row: (
        _dt(row.started_at or row.created_at), _dt(row.created_at), str(row.id or ""))
    latest_direct = max(direct, key=direct_key) if direct else None
    if latest_direct is not None and (
            latest_run is None
            or _dt(latest_direct.started_at or latest_direct.created_at)
            > _dt(latest_run.finished_at or latest_run.created_at)):
        return "direct_ai", latest_direct
    if latest_run is not None:
        return "workflow", latest_run
    if latest_direct is not None:
        return "direct_ai", latest_direct
    return "manual", None


async def _workflow_truth(session: AsyncSession, task: models.Task,
                          run: am.WorkflowRun, facts: dict,
                          manifest: dict) -> tuple[bool, str, list[dict], dict]:
    blockers: list[dict] = []
    rows = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == run.id
    ).order_by(am.NodeRun.created_at, am.NodeRun.attempt))).scalars().all())
    latest = _latest_nodes(rows)
    version = await session.get(am.PluginVersion, run.plugin_version_id)
    declared = _workflow_nodes(version)
    current = next((row for row in latest.values()
                    if row.state in {"queued", "dispatching", "running", "waiting_human", "waiting_external"}), None)
    if run.state in _ACTIVE_RUN:
        state = ("waiting_human" if run.state == "waiting_human"
                 else "waiting_external" if run.state == "waiting_external" else "running")
        return False, state, blockers, {
            "runId": run.id, "nodeId": current.id if current else "",
            "nodeKey": current.node_key if current else "", "state": run.state,
        }
    if run.state != "succeeded":
        blockers.append(_block("workflow_failed", "流程没有完成",
                               run.error or "自动化流程已失败或结束，请从失败阶段重试。", "retry"))
        return False, "failed", blockers, {"runId": run.id, "state": run.state}
    missing_nodes = [str(node.get("name") or node.get("key") or "未命名阶段")
                     for node in declared
                     if latest.get(str(node.get("key") or "")) is None
                     or latest[str(node.get("key") or "")].state not in _DONE_NODE]
    if missing_nodes:
        blockers.append(_block("workflow_incomplete", "流程阶段不完整",
                               "尚未成功的阶段：" + "、".join(missing_nodes[:8]), "inspect"))
    approval_by_id = {row.id: row for row in facts["taskApprovals"]}
    artifact: am.ArtifactVersion | None = facts["artifact"]
    for definition in declared:
        row = latest.get(str(definition.get("key") or ""))
        if row is None:
            continue
        output = dict(row.output or {})
        expected = [x for x in (definition.get("outputs") or [])
                    if isinstance(x, dict) and bool(x.get("required", True))]
        receipt = dict(output.get("outputReceipt") or {})
        # Generic AI nodes require standard receipts; typed quality, merge, and deployment adapters provide their own success contracts.
        # Gerrit reviews use commit-bound report fingerprints rather than synthetic file receipts.
        needs_receipt = not output.get("adoptedFrom") and (
            row.node_type == "ai" or (
                row.node_type == "ai_review"
                and not (output.get("reportChecksum") or output.get("attestation"))))
        if expected and needs_receipt and not receipt:
            blockers.append(_block("missing_receipt", "阶段缺少交付回执",
                                   f"{definition.get('name') or row.node_key} 没有留下可核对的成果清单。",
                                   "inspect"))
        elif receipt.get("missing"):
            blockers.append(_block("contract_failed", "阶段成果不满足约定",
                                   "缺少：" + "、".join(str(x) for x in receipt["missing"][:8]),
                                   "retry"))
        if row.node_type in _HUMAN_NODE:
            request_id = str(output.get("requestId") or "")
            request = approval_by_id.get(request_id)
            if not request_id or request is None or request.status != "approved":
                blockers.append(_block("approval_missing", "人工决定没有形成有效记录",
                                       f"{definition.get('name') or row.node_key} 未绑定已批准的审批票。",
                                       "approval"))
                continue
            bound_version = str(output.get("artifactVersionId") or "")
            if not bound_version or request.artifact_version_id != bound_version:
                blockers.append(_block(
                    "approval_binding_invalid", "审批与阶段成果不一致",
                    f"{definition.get('name') or row.node_key} 的审批票没有绑定该阶段声明的成果版本。",
                    "inspect"))
                continue
            # Requirements approvals bind to requirements versions; delivery reviews and authorizations bind to the latest output candidate.
            # Approval of an earlier version must not authorize completion after rework.
            if row.node_type != "spec" and artifact is not None and bound_version != artifact.id:
                blockers.append(_block(
                    "approval_artifact_stale", "审批对应的成果版本已经过期",
                    f"{definition.get('name') or row.node_key} 批准的是旧版本，请对当前成果重新审阅。",
                    "approval"))
    if artifact is not None and not manifest.get("complete"):
        problems = list(manifest.get("problems") or [])
        detail = str((problems[0] if problems else {}).get("detail") or
                     "当前主成果尚未通过结构校验。")
        blockers.append(_block("output_invalid", "主成果尚未通过校验", detail, "recover"))
    # Workflow plugins define their own trusted delivery orchestration contracts.
    # External adapters may retain release evidence in node outputs without platform DeploymentRun rows.
    # Validate the declared nodes rather than imposing direct-task deployment-table requirements.
    can_complete = not blockers
    return can_complete, "ready" if can_complete else "blocked", blockers, {
        "runId": run.id, "state": run.state,
        "nodes": len(declared), "completedNodes": len(declared) - len(missing_nodes),
    }


async def _direct_truth(session: AsyncSession, task: models.Task,
                        execution: am.ExecutionSession, facts: dict,
                        manifest: dict) -> tuple[bool, str, list[dict], dict]:
    from . import execution_sessions

    blockers: list[dict] = []
    meta = dict(execution.metadata_ or {})
    state = execution_sessions.canonical_state(execution.state)
    current = {"sessionId": execution.id, "ref": execution.ref, "state": state,
               "runnerId": execution.runner_id, "host": execution.host}
    # Verified immutable code and later release evidence can supersede an earlier process-exit failure.
    # An idle watchdog may finish after the agent has already pushed or merged its changes.
    artifact: am.ArtifactVersion | None = facts["artifact"]
    code_result = bool(
        artifact is not None and artifact.kind == "code" and manifest.get("complete")
        and artifact.state not in {"rejected", "superseded"}
        and (not artifact.source_ref or artifact.source_ref == execution.ref))
    if state in _ACTIVE_SESSION:
        return False, "running", blockers, current
    if (state in _FAILED_SESSION or meta.get("error")) and not code_result:
        blockers.append(_block("execution_failed", "AI 执行没有成功",
                               str(meta.get("error") or "执行会话已失败或中断。")[:500], "retry"))
        return False, "failed", blockers, current
    if state != "done" and not code_result:
        blockers.append(_block("execution_unknown", "执行结果还不能确认",
                               "执行会话没有形成明确的成功终态。", "inspect"))
    if artifact is None:
        blockers.append(_block("artifact_missing", "还没有固定成果版本",
                               "AI 会话结束了，但没有形成可审阅、可追溯的成果版本。", "recover"))
    elif artifact.kind != "code" and artifact.source_ref and artifact.source_ref != execution.ref:
        blockers.append(_block("artifact_stale", "成果不属于当前执行",
                               "当前固定版本来自更早的会话，不能替这次执行通过验收。", "recover"))
    if artifact is not None and artifact.kind == "code":
        from . import deployments
        if not await deployments.delivery_complete(session, task):
            blockers.append(_block("delivery_pending", "代码尚未交付到目标环境",
                                   "代码提交不是终点；还需完成合并及项目配置的交付边界。",
                                   "delivery"))
    else:
        if not manifest.get("complete"):
            problems = list(manifest.get("problems") or [])
            detail = (str(problems[0].get("detail") or "") if problems else
                      "没有有效主成果；日志、截图和运行库不能代替交付物。")
            blockers.append(_block("output_invalid", "主成果尚未通过校验", detail, "recover"))
        review = [row for row in facts["approvals"] if row.action == "review"]
        current_review = review[-1] if review else None
        if current_review is None:
            blockers.append(_block("review_unassigned", "成果尚未进入验收",
                                   "请配置验收职责并为当前版本创建审阅请求。", "approval"))
        elif current_review.status == "pending":
            blockers.append(_block("review_pending", "等待人工验收",
                                   "当前固定版本需要由有权限的人确认后才能办结。", "approval"))
        elif current_review.status != "approved":
            blockers.append(_block("review_rejected", "当前成果未通过验收",
                                   "请按验收意见返修并生成新版本。", "retry"))
    can_complete = not blockers
    if can_complete:
        view_state = "ready"
    elif any(x["code"] == "review_pending" for x in blockers):
        view_state = "waiting_human"
    else:
        view_state = "blocked"
    return can_complete, view_state, blockers, current


async def evaluate(session: AsyncSession, task: models.Task) -> dict:
    """Return the shared delivery facts consumed by clients and write-time completion gates."""
    facts = await _facts(session, task)
    authority, owner = _authority(facts)
    artifact: am.ArtifactVersion | None = facts["artifact"]
    manifest = artifact_manifest(artifact)
    blockers: list[dict] = []
    if authority == "workflow":
        can_complete, state, blockers, current = await _workflow_truth(
            session, task, owner, facts, manifest)
    elif authority == "direct_ai":
        can_complete, state, blockers, current = await _direct_truth(
            session, task, owner, facts, manifest)
    else:
        # Ordinary tasks outside automatic execution remain manually completable.
        can_complete, state, current = True, "manual", {}
    from . import managed_work_route
    explicit_direct = managed_work_route.direct_requested({
        "executionContext": dict(task.work_routing or {}).get("executionContext"),
    })
    # Mandatory project workflows apply only to tasks with an actual code repository.
    # A mistakenly assigned repository-change contract alone must not block completion.
    # New tasks normalize that contract when stored.
    # This guard also protects historical and alternate creation paths.
    has_engineering = bool(getattr(task, "project_id", None)
                           or str(getattr(task, "repo_id", "") or "").strip())
    if (managed_work_route.is_managed(task) and has_engineering
            and authority != "workflow" and not explicit_direct):
        # A pushed branch, uploaded archive or manually toggled status cannot
        # substitute for the project's review, merge, deployment and acceptance chain.
        can_complete = False
        blockers.insert(0, _block(
            "managed_workflow_required", "\u5fc5\u987b\u8d70\u9879\u76ee\u5de5\u4f5c\u6d41",
            "\u8fd9\u662f\u9879\u76ee\u5de5\u4f5c\u4ea4\u4ed8需求\uff0c\u4e0d\u80fd\u7528\u76f4\u6d3e AI\u3001\u624b\u5de5\u6539\u72b6\u6001\u6216\u53ea\u63d0\u4ea4\u5206\u652f\u6765\u4ee3\u66ff"
            "\u5ba1\u67e5\u3001\u5408\u5e76\u3001\u53d1\u5e03\u3001\u5065\u5eb7\u68c0\u67e5\u548c\u9a8c\u6536\u3002",
            "workflow"))
        if state not in {"running", "waiting_human", "waiting_external", "failed"}:
            state = "blocked"
    complete = bool(task.status == "done" and can_complete)
    if complete:
        state = "complete"
    elif task.status == "cancel":
        state = "cancelled"
    expected = ("cancel" if task.status == "cancel" else "done" if can_complete
                else task.status if authority == "manual" else "doing")
    consistent = bool(authority == "manual" or task.status == expected)
    if task.status == "done" and not can_complete:
        consistent = False
        blockers.insert(0, _block(
            "status_ahead", "需求状态早于交付事实",
            "需求被标成已完成，但当前成果、审批或发布事实还不支持办结。", "inspect"))
    return {
        "schemaVersion": SCHEMA_VERSION, "authority": authority, "state": state,
        "canComplete": bool(can_complete), "complete": complete,
        "expectedTaskStatus": expected, "statusConsistent": consistent,
        "blockers": blockers, "current": current,
        "artifact": ({"id": artifact.id, "seq": artifact.seq, "kind": artifact.kind,
                      "state": artifact.state, "checksum": artifact.checksum,
                      "sourceRef": artifact.source_ref} if artifact else None),
        "manifest": manifest,
    }


def blocked_summary(task: models.Task, blockers: list[dict] | None) -> dict:
    """Explain accepted-but-incomplete tasks, distinguishing valid waiting workflow steps from
    blockers requiring intervention.
    """
    codes = [str(x.get("code") or "") for x in blockers or []]
    has_engineering = bool(getattr(task, "project_id", None)
                           or str(getattr(task, "repo_id", "") or "").strip())
    if has_engineering and codes and set(codes) == {"managed_workflow_required"}:
        return {
            "awaitingWorkflow": True,
            "reason": "验收已通过，任务等待项目工作流的下一步（合并/发布），由对应节点审批人推进",
            "blockers": blockers or [],
        }
    return {
        "awaitingWorkflow": False,
        "reason": "验收已通过，但成果还满足不了办结门禁，任务暂不办结",
        "blockers": blockers or [],
    }
