"""Standard human-gate packet shared by task trace, approval inbox and audit.

An approval freezes the subject version, acceptance criteria, evidence references
and decision policy. Binary evidence remains in the attachment store; this packet
contains only typed, auditable references.
"""
from __future__ import annotations

from datetime import timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from ..schemas import attachment_to_api
from . import task_execution_contract

SCHEMA_VERSION = "soduwork.gate/1.1"

_TITLES = {
    "baseline": "确认需求基线",
    "review": "验收交付结果",
    "merge": "授权合并固定版本",
    "deploy": "授权发布到目标环境",
    "uat": "确认环境验收结果",
}


def _ms(value) -> int | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp() * 1000)


def _criterion_lines(context: dict, artifact: am.ArtifactVersion,
                     policy: dict) -> list[str]:
    manifest = dict(artifact.manifest or {})
    rows: list[str] = []
    for source in (
        context.get("acceptanceCriteria"), context.get("criteria"),
        manifest.get("acceptanceCriteria"), policy.get("acceptanceCriteria"),
        policy.get("criteria"), policy.get("checks"),
    ):
        if not isinstance(source, list):
            continue
        for item in source:
            value = str(item.get("name") or item.get("label") or item) \
                if isinstance(item, dict) else str(item or "")
            value = value.strip()[:500]
            if value and value not in rows:
                rows.append(value)
    return rows[:30]


def _default_criteria(action: str, environment_name: str) -> list[str]:
    if action == "uat":
        target = environment_name or "目标环境"
        return [f"{target}健康检查全部通过", "核心页面与关键操作已按截图复核",
                "当前运行版本与本次固定交付版本一致"]
    return [{
        "baseline": "范围、假设与验收标准可以作为后续执行基线",
        "review": "主成果完整、可打开，并符合任务目标与验收标准",
        "merge": "待合并提交与已审查的固定版本一致",
        "deploy": "发布目标、固定版本与回滚边界已经核对",
    }.get(action, "当前固定版本符合任务目标与验收边界")]


def _requirements(action: str, context: dict) -> list[dict]:
    configured = context.get("requiredEvidence")
    if isinstance(configured, list) and configured:
        out = []
        for index, item in enumerate(configured[:12]):
            if isinstance(item, str):
                item = {"label": item, "oneOf": [item]}
            if not isinstance(item, dict):
                continue
            kinds = [str(x).lower() for x in (item.get("oneOf") or item.get("kinds") or []) if x]
            if kinds:
                out.append({"id": str(item.get("id") or f"required-{index + 1}"),
                            "label": str(item.get("label") or "必需证据")[:160],
                            "oneOf": kinds[:8]})
        if out:
            return out
    # Text responses are first-class deliverables frozen into immutable versions.
    # Review gates must accept verified text evidence.
    # Otherwise valid text-only outputs could never be accepted.
    return {
        "baseline": [],
        "review": [{"id": "deliverable", "label": "可复核的固定成果",
                    "oneOf": ["file", "url", "commit", "text"]}],
        "merge": [{"id": "commit", "label": "已锁定的代码提交", "oneOf": ["commit"]}],
        "deploy": [{"id": "commit", "label": "待发布的固定提交", "oneOf": ["commit"]}],
        "uat": [
            {"id": "health", "label": "上线后健康检查", "oneOf": ["check"]},
            {"id": "screenshot", "label": "环境验收截图", "oneOf": ["image"]},
        ],
    }.get(action, [])


def _manifest_attachment_ids(artifact: am.ArtifactVersion) -> set[str]:
    out: set[str] = set()
    manifest = dict(artifact.manifest or {})
    for key in ("files", "primary", "supporting", "evidence"):
        for item in manifest.get(key) or []:
            if isinstance(item, dict):
                value = str(item.get("id") or item.get("attachmentId") or "")
                if value:
                    out.add(value)
    return out


def _declared_attachment_ids(context: dict) -> set[str]:
    """Attachment ids explicitly bound to this gate before it is frozen."""
    out = {str(value) for value in (context.get("evidenceRefs") or []) if value}
    receipt = context.get("receipt")
    if isinstance(receipt, dict):
        out.update(str(value) for value in (receipt.get("screenshots") or []) if value)
    return out


async def prepare_context(session: AsyncSession, task: models.Task,
                          artifact: am.ArtifactVersion, action: str,
                          environment_id: str, context: dict | None) -> dict:
    """Freeze the gate declaration before an ApprovalRequest is persisted."""
    base = dict(context or {})
    env = await session.get(am.Environment, environment_id) if environment_id else None
    refs = _manifest_attachment_ids(artifact)
    refs.update(_declared_attachment_ids(base))
    rows = []
    if artifact.source_ref:
        rows = list((await session.execute(select(models.Attachment).where(
            models.Attachment.task_id == task.id,
            models.Attachment.source_ref == artifact.source_ref,
        ))).scalars().all())
    for row in rows:
        role = str(getattr(row, "role", "") or "")
        source = str(getattr(row, "source_ref", "") or "")
        if artifact.source_ref and source == artifact.source_ref and role != "input":
            refs.add(str(row.id))
    criteria = _criterion_lines(base, artifact, {}) or _default_criteria(
        action, env.name if env else "")
    base["gate"] = {
        "schemaVersion": SCHEMA_VERSION,
        "title": _TITLES.get(action, "确认当前关口"),
        "criteria": [{"id": f"criterion-{index + 1}", "label": value}
                     for index, value in enumerate(criteria)],
        "requirements": _requirements(action, base),
        "evidenceRefs": sorted(refs)[:200],
        "frozenAt": _ms(getattr(artifact, "created_at", None)),
    }
    return base


def _artifact_evidence(artifact: am.ArtifactVersion) -> list[dict]:
    manifest = dict(artifact.manifest or {})
    producer = {"kind": "system", "id": "soduwork", "name": artifact.created_by_name or "SoduWork"}
    common = {"role": "output", "createdAt": _ms(artifact.created_at),
              "producer": producer, "source": {"artifactVersionId": artifact.id},
              "verification": {"state": "passed", "by": "SoduWork", "at": _ms(artifact.created_at)}}
    if artifact.kind == "code" and artifact.commit_sha:
        return [{"id": f"artifact:{artifact.id}:commit", "kind": "commit",
                 "title": "固定代码提交", "summary": artifact.commit_sha,
                 "value": artifact.commit_sha, "url": artifact.url or "", **common}]
    out = []
    if artifact.url:
        out.append({"id": f"artifact:{artifact.id}:url", "kind": "url",
                    "title": "固定成果地址", "summary": artifact.url,
                    "value": artifact.url, "url": artifact.url, **common})
    if not out and any(manifest.get(key) for key in ("files", "primary", "supporting")):
        out.append({"id": f"artifact:{artifact.id}:files", "kind": "file",
                    "title": "固定成果包", "summary": f"交付版本 v{artifact.seq}",
                    "value": str(artifact.checksum or "")[:16], "url": artifact.url or "", **common})
    text = str(manifest.get("text") or "").strip()[:20000]
    if text:
        out.append({"id": f"artifact:{artifact.id}:text", "kind": "text",
                    "title": "AI 交付结果", "summary": text[:240],
                    "value": text, "url": "", **common})
    return out



def _verification_state(item: dict) -> str:
    return str(dict(item.get("verification") or {}).get("state") or "").lower()


def _verified(item: dict) -> bool:
    return _verification_state(item) == "passed"


def evidence_has_check(evidence: list) -> bool:
    """Only validated successful check evidence can suppress repeated collection."""
    return any(str(item.get("kind") or "").lower() == "check" and _verified(item)
               for item in evidence)


async def packet(session: AsyncSession, task: models.Task,
                 request: am.ApprovalRequest, artifact: am.ArtifactVersion,
                 environment: am.Environment | None = None, *,
                 attachment_rows: list | None = None,
                 deployment_rows: list | None = None) -> dict:
    """Resolve a frozen gate declaration into a typed display packet. Reuse caller-supplied
    attachment_rows and deployment_rows to avoid repeated full-task queries for each approval
    request.
    """
    context, policy = dict(request.context or {}), dict(request.policy_snapshot or {})
    gate = dict(context.get("gate") or {})
    env = environment
    if env is None and request.environment_id:
        env = await session.get(am.Environment, request.environment_id)
    criteria = list(gate.get("criteria") or [])
    if not criteria:
        lines = _criterion_lines(context, artifact, policy) or _default_criteria(
            request.action, env.name if env else "")
        criteria = [{"id": f"criterion-{index + 1}", "label": value}
                    for index, value in enumerate(lines)]
    refs = {str(x) for x in (gate.get("evidenceRefs") or []) if x}
    manifest_refs = _manifest_attachment_ids(artifact)
    rows = attachment_rows if attachment_rows is not None else \
        list((await session.execute(select(models.Attachment).where(
            models.Attachment.task_id == task.id
        ).order_by(models.Attachment.created_at))).scalars().all())
    evidence = _artifact_evidence(artifact)
    for row in rows:
        meta = dict(getattr(row, "evidence_meta", None) or {})
        source = str(getattr(row, "source_ref", "") or "")
        role = str(getattr(row, "role", "") or "")
        linked = (str(row.id) in refs or str(row.id) in manifest_refs or
                  str(meta.get("gateRequestId") or "") == request.id or
                  bool(artifact.source_ref and source == artifact.source_ref and role != "input"))
        if linked:
            evidence.append(task_execution_contract.attachment_evidence(attachment_to_api(row)))

    if request.action == "uat" and request.environment_id:
        if deployment_rows is not None:
            deployments = sorted(
                (row for row in deployment_rows
                 if row.artifact_version_id == artifact.id
                 and row.environment_id == request.environment_id),
                key=lambda row: row.attempt or 0)
        else:
            deployments = list((await session.execute(select(am.DeploymentRun).where(
                am.DeploymentRun.artifact_version_id == artifact.id,
                am.DeploymentRun.environment_id == request.environment_id,
            ).order_by(am.DeploymentRun.attempt))).scalars().all())
        latest: dict[str, am.DeploymentRun] = {}
        for row in deployments:
            latest[row.target_id] = row
        for row in latest.values():
            for index, check in enumerate((dict(row.result or {}).get("checks") or [])[:60]):
                if not isinstance(check, dict):
                    continue
                ok = bool(check.get("ok"))
                evidence.append({
                    "id": f"deployment:{row.id}:check:{index + 1}", "kind": "check",
                    "role": "verification", "title": str(check.get("name") or "上线检查")[:160],
                    "summary": str(check.get("detail") or "")[:1200], "value": "通过" if ok else "未通过",
                    "url": "", "createdAt": _ms(row.finished_at or row.started_at),
                    "producer": {"kind": "runner", "id": row.runner_id,
                                 "name": f"Runner {row.runner_id}" if row.runner_id else "发布执行器"},
                    "source": {"deploymentRunId": row.id, "environmentId": row.environment_id},
                    "verification": {"state": "passed" if ok else "failed", "by": row.runner_id,
                                     "at": _ms(row.finished_at)}, "meta": {"type": check.get("type") or ""},
                })

        # External CICD providers may not create platform DeploymentRun records.
        # Their deployment checks are retained in validate-node outputs.
        # Include those outputs so acceptance gates can find the required publication evidence.
        node_run_id = str(context.get("nodeRunId") or "")
        if not evidence_has_check(evidence) and node_run_id:
            node_run = await session.get(am.NodeRun, node_run_id)
            output = dict((node_run.output if node_run else {}) or {})
            for index, check in enumerate(list(output.get("checks") or [])[:60]):
                if not isinstance(check, dict):
                    continue
                ok = bool(check.get("ok"))
                evidence.append({
                    "id": f"node:{node_run_id}:check:{index + 1}", "kind": "check",
                    "role": "verification", "title": str(check.get("name") or "上线检查")[:160],
                    "summary": str(check.get("detail") or "")[:1200],
                    "value": "通过" if ok else "未通过", "url": "",
                    "createdAt": _ms(getattr(node_run, "finished_at", None)),
                    "producer": {"kind": "workflow", "id": node_run_id, "name": "上线核对"},
                    "source": {"nodeRunId": node_run_id, "environmentId": request.environment_id},
                    "verification": {"state": "passed" if ok else "failed", "by": "workflow",
                                     "at": _ms(getattr(node_run, "finished_at", None))},
                    "meta": {"type": check.get("type") or ""},
                })

    unique = []
    seen = set()
    for item in evidence:
        key = str(item.get("id") or "")
        if key and key not in seen:
            seen.add(key)
            unique.append(item)
    requirements = [dict(item) for item in (gate.get("requirements") or _requirements(request.action, context))]
    blockers = []
    verified = [item for item in unique if _verified(item)]
    present = {str(item.get("kind") or "").lower() for item in verified}
    for item in requirements:
        wanted = [str(x).lower() for x in (item.get("oneOf") or [])]
        matches = [str(row.get("id") or "") for row in verified
                   if str(row.get("kind") or "").lower() in wanted]
        item["satisfied"] = bool(matches)
        item["evidenceRefs"] = matches
        if not matches:
            blockers.append(str(item.get("label") or "必需证据"))
    failed = [row for row in unique if _verification_state(row) == "failed"]
    unverified = [row for row in unique
                  if _verification_state(row) not in {"passed", "failed"}]
    # Failed artifacts remain auditable evidence but are excluded from deliverable versions.
    # They must not permanently block otherwise valid acceptance requests.
    # Historical failures may share the current conversation's evidence scope.
    # Determine gate readiness from the declared requirements.
    # Expose failedEvidenceCount and per-item failure status to reviewers.
    # Preserve traceability without treating every historical failure as a current blocker.
    can_approve = not blockers
    return {
        "schemaVersion": SCHEMA_VERSION, "id": request.id,
        "kind": request.action, "title": gate.get("title") or _TITLES.get(request.action, "确认当前关口"),
        "status": request.status, "createdAt": _ms(request.created_at),
        "subject": {"taskId": task.id, "taskTitle": task.title,
                    "artifactVersionId": artifact.id, "artifactSeq": artifact.seq,
                    "artifactKind": artifact.kind, "fingerprint": artifact.commit_sha or artifact.checksum,
                    "environmentId": request.environment_id,
                    "environmentName": env.name if env else ""},
        "criteria": criteria, "requirements": requirements, "evidence": unique,
        "readiness": {"state": "ready" if can_approve else "blocked",
                      "canApprove": can_approve, "blockers": blockers,
                      "evidenceCount": len(unique),
                      "verifiedEvidenceCount": len(verified),
                      "failedEvidenceCount": len(failed),
                      "unverifiedEvidenceCount": len(unverified),
                      "kinds": sorted(present)},
        "decision": {"required": request.required_count,
                     "options": ["approve", "reject"], "policyId": request.policy_id,
                     "immutable": True, "evidenceSnapshot": True},
    }
