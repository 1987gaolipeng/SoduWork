"""Immutable delivery versions, AI review evidence, and human business gates. Every review binds to
an ArtifactVersion; new versions invalidate old authorization. AI review authorizes only its
fixed commit, while requirements and environment acceptance remain human decisions.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from . import approval_routing, task_events

ENV_TEST = "env-system-test"
ENV_PRODUCTION = "env-system-production"
POLICY_REVIEW = "policy-system-review"
POLICY_BASELINE = "policy-system-baseline"
POLICY_MERGE = "policy-system-merge"
POLICY_UAT = "policy-system-uat"
POLICY_PRODUCTION = "policy-system-production"

_ACTIVE_ARTIFACT = {
    "candidate", "baselined", "reviewed", "approved", "merged", "tested",
    "accepted", "released",
}
_SPEC_KINDS = {"requirement"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _checksum(payload: dict) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def bootstrap(session: AsyncSession) -> None:
    """Seed editable approval policies and migrate legacy implicit environment behavior into
    explicit configuration once.
    """
    policies = [
        am.ApprovalPolicy(
            id=POLICY_BASELINE, key="requirement-baseline", name="需求基线确认",
            description="由需求提出人确认范围、假设和逐条验收标准",
            rules=approval_routing.default_rules("baseline"), is_system=True),
        am.ApprovalPolicy(
            id=POLICY_REVIEW, key="artifact-review", name="产出审阅",
            description="由需求创建人判断交付产出是否达到要求",
            rules=approval_routing.default_rules("review"), is_system=True),
        am.ApprovalPolicy(
            id=POLICY_UAT, key="test-acceptance", name="测试验收",
            description="由需求提出人根据测试环境和证据包确认业务目标",
            rules=approval_routing.default_rules("uat"), is_system=True),
        am.ApprovalPolicy(
            id=POLICY_MERGE, key="code-merge", name="代码合并审批",
            description="审阅通过后，由项目负责人或具备代码合并职责的人员授权合并",
            rules=approval_routing.default_rules("merge"), is_system=True),
        am.ApprovalPolicy(
            id=POLICY_PRODUCTION, key="controlled-release", name="受控环境发布审批",
            description="人授权，Runner 执行；职责分离时 AI 或需求执行人不能审批自己的变更",
            rules=approval_routing.default_rules("deploy"), is_system=True),
    ]
    # Separate delivery review, code merge, business acceptance, and environment deployment responsibilities.
    # Migrate built-in policies while preserving custom policies.
    routing_upgrade = await session.get(models.AppSetting, "approval_routing_v4")
    for row in policies:
        current = await session.get(am.ApprovalPolicy, row.id)
        if current is None:
            session.add(row)
        elif routing_upgrade is None:
            current.rules = row.rules
            current.description = row.description
    if routing_upgrade is None:
        session.add(models.AppSetting(key="approval_routing_v4", value="1"))
    environment_upgrade = await session.get(models.AppSetting, "environment_promotion_v2")
    if environment_upgrade is None:
        # Convert legacy tier-based progression once; runtime behavior no longer depends on environment names.
        envs = list((await session.execute(select(am.Environment))).scalars().all())
        for row in envs:
            if row.promotion_policy:
                continue
            if row.tier == "test":
                row.promotion_policy = {
                    "autoStart": True, "requires": [], "requiresApproval": False,
                    "requiresAcceptance": False, "marksDelivery": False,
                }
            elif row.tier == "production":
                row.promotion_policy = {
                    "autoStart": True, "requires": ["test"], "requiresApproval": True,
                    "requiresAcceptance": False, "marksDelivery": True,
                }
            else:
                row.promotion_policy = {
                    "autoStart": False, "requires": [],
                    "requiresApproval": bool(row.approval_policy_id),
                    "requiresAcceptance": False, "marksDelivery": False,
                }
            # Former built-in environments are ordinary removable entries when no deployment targets depend on them.
            row.is_system = False
        session.add(models.AppSetting(key="environment_promotion_v2", value="1"))
    await session.commit()
    await approval_routing.materialize_pending(session)


def artifact_api(a: am.ArtifactVersion | None) -> dict | None:
    if a is None:
        return None
    from . import resource_access

    return resource_access.decorate({
        "id": a.id, "taskId": a.task_id, "seq": a.seq, "kind": a.kind,
        "sourceRef": a.source_ref, "commit": a.commit_sha, "branch": a.branch,
        "target": a.target, "checksum": a.checksum, "url": a.url,
        "manifest": a.manifest or {}, "state": a.state,
        "createdBy": a.created_by_name, "createdAt": _ms(a.created_at),
    })


def request_api(r: am.ApprovalRequest, decisions: list[am.ApprovalDecision] | None = None) -> dict:
    from . import resource_access

    return {
        "id": r.id, "taskId": r.task_id, "artifactVersionId": r.artifact_version_id,
        "action": r.action, "environmentId": r.environment_id, "policyId": r.policy_id,
        "status": r.status, "required": r.required_count,
        "policy": r.policy_snapshot or {}, "context": r.context or {},
        "createdAt": _ms(r.created_at), "resolvedAt": _ms(r.resolved_at),
        "decisions": [{"id": d.id, "userId": d.user_id, "userName": d.user_name,
                       "decision": d.decision, "note": d.note, "at": _ms(d.created_at),
                       "gateSnapshot": resource_access.decorate(
                           dict(getattr(d, "gate_snapshot", None) or {}))}
                      for d in (decisions or [])],
    }


def environment_api(e: am.Environment) -> dict:
    return {
        "id": e.id, "orgId": e.org_id, "key": e.key, "name": e.name, "tier": e.tier,
        "description": e.description, "runnerSelector": e.runner_selector or {},
        "approvalPolicyId": e.approval_policy_id,
        "acceptancePolicyId": e.acceptance_policy_id,
        "healthChecks": e.health_checks or [],
        "promotionPolicy": e.promotion_policy or {},
        "rollback": e.rollback or {}, "enabled": e.enabled, "isSystem": e.is_system,
        "sort": e.sort,
    }


def target_api(t: am.DeploymentTarget) -> dict:
    from . import release_providers
    return {
        "id": t.id, "repoId": t.repo_id, "environmentId": t.environment_id,
        "name": t.name, "provider": t.provider, "config": t.config or {},
        # Use one destination description across lists, preflight checks, and task traces.
        "channel": release_providers.describe(t),
        "secretRefs": t.secret_refs or {}, "runnerSelector": t.runner_selector or {},
        "healthChecks": t.health_checks or [], "rollback": t.rollback or {},
        "enabled": t.enabled,
    }


def _ms(dt) -> int | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _stream(kind: str) -> str:
    """Requirements and deliverables evolve in separate version streams and must not overwrite each
    other's approvals.
    """
    return "spec" if kind in _SPEC_KINDS else "delivery"


async def latest_artifact(session: AsyncSession, task_id: str, *,
                          stream: str = "delivery") -> am.ArtifactVersion | None:
    q = select(am.ArtifactVersion).where(am.ArtifactVersion.task_id == task_id)
    if stream == "spec":
        q = q.where(am.ArtifactVersion.kind.in_(_SPEC_KINDS))
    elif stream == "delivery":
        q = q.where(am.ArtifactVersion.kind.not_in(_SPEC_KINDS))
    return (await session.execute(
        q
        .order_by(am.ArtifactVersion.seq.desc(), am.ArtifactVersion.created_at.desc()).limit(1)
    )).scalar_one_or_none()


async def latest_requirement(session: AsyncSession, task_id: str) -> am.ArtifactVersion | None:
    return await latest_artifact(session, task_id, stream="spec")


async def _cancel_old(session: AsyncSession, task_id: str, stream: str) -> None:
    rows = (await session.execute(
        select(am.ArtifactVersion).where(am.ArtifactVersion.task_id == task_id)
    )).scalars().all()
    old_ids = []
    for row in rows:
        if _stream(row.kind) != stream:
            continue
        if row.state in _ACTIVE_ARTIFACT:
            row.state = "superseded"
            old_ids.append(row.id)
    if old_ids:
        reqs = (await session.execute(select(am.ApprovalRequest).where(
            am.ApprovalRequest.artifact_version_id.in_(old_ids),
            am.ApprovalRequest.status == "pending"))).scalars().all()
        for req in reqs:
            req.status = "cancelled"
            req.resolved_at = _now()


async def _new_artifact(session: AsyncSession, task: models.Task, *, kind: str,
                        payload: dict, source_ref: str = "", commit: str = "",
                        branch: str = "", target: str = "", url: str = "",
                        who: str = "SoduWork") -> tuple[am.ArtifactVersion, bool]:
    digest = _checksum({"kind": kind, **payload})
    existing = (await session.execute(select(am.ArtifactVersion).where(
        am.ArtifactVersion.task_id == task.id,
        am.ArtifactVersion.checksum == digest)
        .order_by(am.ArtifactVersion.seq.desc()).limit(1))).scalar_one_or_none()
    stream = _stream(kind)
    latest = await latest_artifact(session, task.id, stream=stream)
    # Idempotency applies only to repeated current content; reverting after an intervening version creates a new sequence number.
    # Thus v1 content after v2 becomes v3, keeping latest and approval bindings accurate.
    if existing is not None and latest is not None and existing.id == latest.id:
        return existing, False
    await _cancel_old(session, task.id, stream)
    seq = int((await session.scalar(select(func.max(am.ArtifactVersion.seq)).where(
        am.ArtifactVersion.task_id == task.id))) or 0) + 1
    row = am.ArtifactVersion(
        task_id=task.id, seq=seq, kind=kind, source_ref=source_ref,
        commit_sha=commit, branch=branch, target=target, checksum=digest,
        url=url, manifest=payload, state="candidate", created_by_name=who)
    session.add(row)
    await session.flush()
    # Only a new delivery version clears legacy delivery-review markers; requirements versions evolve separately.
    action = "baseline" if stream == "spec" else "review"
    if stream == "delivery":
        task.reviewed_at = None
        task.reviewed_by = None
        task.reviewed_by_name = ""
    managed_workflow = bool(await session.scalar(select(am.WorkflowRun.id).where(
        am.WorkflowRun.task_id == task.id,
        am.WorkflowRun.state.in_(("queued", "running", "waiting_human", "waiting_external")),
    ).limit(1)))
    try:
        # Plugin-owned workflows create gates at explicit nodes. Do not leak a
        # context-free duplicate while materialising code or office output.
        if not managed_workflow:
            await ensure_request(session, task, row, action, context={
                "summary": "需求基线待确认" if stream == "spec" else
                           ("代码待审阅" if kind == "code" else "产出待审阅"),
                "version": seq, "checksum": digest,
            })
    except ValueError as exc:
        # Do not roll back a valid candidate merely because an independent reviewer is not configured.
        # The review node's ensure_request reports the correct actionable configuration blocker.
        task_events.record(session, task.id, "release.approval_blocked", {
            "versionId": row.id, "action": action, "error": str(exc)[:500],
        }, actor="SoduWork")
    task_events.record(session, task.id, "release.candidate",
                       {"versionId": row.id, "seq": seq, "kind": kind,
                        "commit": commit, "branch": branch}, actor=who)
    return row, True


async def ensure_code_candidate(session: AsyncSession, task: models.Task, state: dict,
                                who: str = "SoduWork") -> tuple[am.ArtifactVersion, bool]:
    commits = state.get("commits") or []
    commit = str((commits[0] or {}).get("sha") if commits else "")
    payload = {
        "commits": commits[:20], "files": (state.get("files") or [])[:200],
        "branch": state.get("branch") or "", "target": state.get("target") or "",
        # Retain Gerrit change identity with the artifact for merge tracking and audit.
        **({"gerrit": state["gerrit"]} if state.get("gerrit") else {}),
    }
    return await _new_artifact(
        session, task, kind="code", payload=payload, commit=commit,
        branch=payload["branch"], target=payload["target"], who=who)


async def ensure_output_candidate(session: AsyncSession, task: models.Task, manifest: dict,
                                  source_ref: str = "", who: str = "SoduWork") -> tuple[am.ArtifactVersion, bool]:
    url = (task.artifact_url or "").strip()
    text = str((manifest or {}).get("text") or "").strip()[:20000]
    kind = ("manual" if (manifest or {}).get("manual") else
            "files" if (manifest or {}).get("files") else
            "url" if url else "text" if text else "files")
    payload = {**(manifest or {}), "url": url, **({"text": text} if text else {})}
    return await _new_artifact(session, task, kind=kind, payload=payload,
                               source_ref=source_ref, url=payload["url"], who=who)


async def ensure_requirement_candidate(
    session: AsyncSession, task: models.Task, manifest: dict,
    source_ref: str = "", who: str = "SoduWork",
) -> tuple[am.ArtifactVersion, bool]:
    """Freeze requirements using body, attachments, and acceptance criteria in the fingerprint so
    approval binds to the exact baseline.
    """
    payload = {
        "title": task.title,
        "description": task.note or "",
        "files": list((manifest or {}).get("files") or []),
        "acceptanceCriteria": list((manifest or {}).get("acceptanceCriteria") or []),
        "assumptions": list((manifest or {}).get("assumptions") or []),
        "risks": list((manifest or {}).get("risks") or []),
    }
    return await _new_artifact(
        session, task, kind="requirement", payload=payload,
        source_ref=source_ref, who=who)


async def output_manifest(session: AsyncSession, task: models.Task, *,
                          source_ref: str = "", workflow_run_id: str = "",
                          source_refs: list[str] | None = None) -> dict:
    """Build the current execution's reviewable deliverable and evidence manifest, excluding input
    materials.
    """
    from . import delivery_manifest

    refs = [str(value or "").strip() for value in (source_refs or []) if value]
    query = select(models.Attachment).where(models.Attachment.task_id == task.id)
    if workflow_run_id:
        query = query.where(models.Attachment.workflow_run_id == workflow_run_id)
    elif refs:
        query = query.where(models.Attachment.source_ref.in_(refs))
    rows = list((await session.execute(
        query.order_by(models.Attachment.created_at, models.Attachment.id)
    )).scalars().all())
    if workflow_run_id and not rows:
        fallback = select(models.Attachment).where(
            models.Attachment.task_id == task.id)
        if refs:
            fallback = fallback.where(models.Attachment.source_ref.in_(refs))
        else:
            # Old/manual workflows may intentionally review a task-level output
            # that predates execution lineage.  Accept only explicitly unscoped
            # output/evidence; never mix files belonging to another run.
            fallback = fallback.where(
                models.Attachment.role.in_(("output", "verification")),
                or_(models.Attachment.workflow_run_id == "",
                    models.Attachment.workflow_run_id.is_(None)),
                or_(models.Attachment.source_ref == "",
                    models.Attachment.source_ref.is_(None)),
            )
        rows = list((await session.execute(
            fallback.order_by(models.Attachment.created_at, models.Attachment.id)
        )).scalars().all())
    url = (task.artifact_url or "").strip()
    event_refs = set(refs)
    if source_ref and source_ref != workflow_run_id:
        event_refs.add(source_ref)
    if event_refs:
        # task.artifact_url is a legacy current-value field without execution provenance.
        # Freeze URLs from the matching execution receipt so a previous turn cannot supply the current primary output.
        url = ""
        events = list((await session.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == task.id,
            models.TaskEvent.kind.in_(("ai.artifacts", "multica.artifacts")),
        ).order_by(models.TaskEvent.at.desc(), models.TaskEvent.id.desc()))).scalars().all())
        for event in events:
            detail = dict(event.detail or {})
            if str(detail.get("ref") or "") in event_refs:
                url = str(detail.get("artifactUrl") or "").strip()
                break
    scoped_ref = source_ref if source_ref and not workflow_run_id and not refs else ""
    return delivery_manifest.build(rows, source_ref=scoped_ref, url=url)


async def ensure_current_output(session: AsyncSession, task: models.Task, *, source_ref: str = "",
                                workflow_run_id: str = "",
                                source_refs: list[str] | None = None,
                                text: str = "", who: str = "SoduWork"
                                ) -> tuple[am.ArtifactVersion, bool]:
    manifest = await output_manifest(
        session, task, source_ref=source_ref,
        workflow_run_id=workflow_run_id, source_refs=source_refs)
    text = str(text or "").strip()[:20000]
    if text:
        # A concise assistant answer is a first-class office deliverable.  It is
        # versioned and reviewed like a file or URL, but remains rendered in the
        # conversation instead of being disguised as a downloadable artifact.
        manifest = {**manifest, "text": text, "complete": True}
    if not manifest.get("primary") and not manifest.get("url") and not text:
        # A manually submitted requirement may intentionally have no file, URL, or
        # assistant answer.  It still needs an immutable review target so the
        # responsible person can record an acceptance decision and keep the audit
        # chain complete.  Only allow this for tasks without a declared output
        # contract; artifact-producing tasks must continue to fail closed.
        routing = dict(task.work_routing or {})
        contract = dict(routing.get("outputContract") or {})
        has_declared_output = bool(
            contract.get("kind") or contract.get("deliverables") or
            contract.get("expectedArtifacts") or contract.get("outputs") or
            str(getattr(task, "artifact_url", "") or "").strip()
        )
        submission_mode = str(routing.get("executionSubmissionMode") or "").strip().lower()
        if not submission_mode:
            submission_mode = "auto" if has_declared_output else "manual"
        if submission_mode == "manual" and not has_declared_output and not manifest.get("problems"):
            from . import delivery_manifest
            manifest = {
                "schemaVersion": delivery_manifest.SCHEMA_VERSION,
                "complete": True,
                "manual": True,
                "summary": "本轮没有文件或链接交付物，由负责人按实际结果确认",
                "files": [], "primary": [], "supporting": [],
                "evidence": [], "internal": [], "problems": [],
                "counts": {"primary": 0, "supporting": 0, "evidence": 0, "internal": 0},
            }
        else:
            raise ValueError("这条需求还没有可审阅的产出")
    if not manifest.get("complete"):
        problems = list(manifest.get("problems") or [])
        reason = str((problems[0] if problems else {}).get("detail") or "成果结构尚未通过校验")
        raise ValueError("这条需求的主成果还不能交付：" + reason)
    from . import delivery_manifest
    # Manual submission has no explicit execution ref. Preserve the immutable
    # output batch's producer so rejection can route back to that conversation.
    # Mixed or unverified provenance remains unscoped; never select the latest dispatch.
    producer = source_ref or delivery_manifest.unique_output_source(manifest)
    return await ensure_output_candidate(session, task, manifest, source_ref=producer, who=who)


async def ensure_request(session: AsyncSession, task: models.Task, artifact: am.ArtifactVersion,
                         action: str, environment_id: str = "", context: dict | None = None
                         ) -> am.ApprovalRequest:
    existing = (await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.artifact_version_id == artifact.id,
        am.ApprovalRequest.action == action,
        am.ApprovalRequest.environment_id == (environment_id or "")
    ).order_by(am.ApprovalRequest.created_at.desc()).limit(1))).scalar_one_or_none()
    # A cancelled gate belongs to an explicitly ended workflow; a revoked one was
    # withdrawn by an approver on purpose.  Either way a later round needs a fresh,
    # independently auditable request instead of resurrecting the dead one forever.
    if existing is not None and existing.status not in ("cancelled", "revoked"):
        assignments = await approval_routing.ensure_assignments(session, task, existing)
        if len(assignments) < existing.required_count:
            raise ValueError(
                f"审批职责需要 {existing.required_count} 人，但当前只能分配给 {len(assignments)} 人")
        return existing
    pid = {"baseline": POLICY_BASELINE, "review": POLICY_REVIEW,
           "merge": POLICY_MERGE, "uat": POLICY_UAT,
           "deploy": POLICY_PRODUCTION}.get(action, POLICY_REVIEW)
    if action in ("deploy", "uat") and environment_id:
        env = await session.get(am.Environment, environment_id)
        pid = str((context or {}).get("approvalPolicyId") or
                  ((env.approval_policy_id if action == "deploy" else
                    env.acceptance_policy_id) if env else "") or pid)
    policy = await session.get(am.ApprovalPolicy, pid)
    rules = dict((policy.rules if policy else {}) or {})
    # Freeze version, criteria and evidence refs when a gate is created.
    from . import gate_contract
    gate_context = await gate_contract.prepare_context(
        session, task, artifact, action, environment_id or "", context)
    row = am.ApprovalRequest(
        task_id=task.id, artifact_version_id=artifact.id, action=action,
        environment_id=environment_id or "", policy_id=pid,
        required_count=max(1, int(rules.get("required") or 1)),
        policy_snapshot=rules, context=gate_context, created_by="system")
    session.add(row)
    await session.flush()
    assignments = await approval_routing.ensure_assignments(session, task, row)
    if len(assignments) < row.required_count:
        raise ValueError(
            f"审批职责需要 {row.required_count} 人，但当前只能分配给 {len(assignments)} 人；请调整人员或会签人数")
    task_events.record(session, task.id, "release.approval_requested",
                       {"requestId": row.id, "versionId": artifact.id,
                        "action": action, "environmentId": environment_id or ""}, actor="SoduWork")
    return row


async def _decisions(session: AsyncSession, request_id: str) -> list[am.ApprovalDecision]:
    return list((await session.execute(select(am.ApprovalDecision).where(
        am.ApprovalDecision.request_id == request_id)
        .order_by(am.ApprovalDecision.created_at))).scalars().all())


async def decisions_for(session: AsyncSession, request_id: str) -> list[am.ApprovalDecision]:
    """Public interface for reading approval decisions from other modules; keep the private helper
    encapsulated.
    """
    return await _decisions(session, request_id)


async def decisions_bulk(session: AsyncSession, request_ids: list[str]) -> dict:
    """Batch-load decisions grouped by request ID, avoiding one query per approval-list row."""
    if not request_ids:
        return {}
    rows = list((await session.execute(select(am.ApprovalDecision).where(
        am.ApprovalDecision.request_id.in_(request_ids))
        .order_by(am.ApprovalDecision.created_at))).scalars().all())
    out: dict = {}
    for d in rows:
        out.setdefault(d.request_id, []).append(d)
    return out


def _actor_name(actor) -> str:
    data = getattr(actor, "__dict__", {}) or {}
    return str(data.get("display_name") or data.get("username") or
               approval_routing.actor_id(actor) or "审批人")


async def can_decide(session: AsyncSession, task: models.Task, request: am.ApprovalRequest,
                      actor) -> tuple[bool, str]:
    return await approval_routing.can_decide(session, task, request, actor)


async def decide(session: AsyncSession, task: models.Task, actor, *, action: str,
                 decision: str, note: str = "", artifact_version_id: str = "",
                 environment_id: str = "") -> dict:
    """Decide on the current version. Rejection takes effect immediately; approval requires the
    configured countersignature count.
    """
    decision = str(decision or "").lower()
    if decision not in ("approve", "reject"):
        return {"ok": False, "reason": "decision"}
    continue_existing_merge = False
    note = str(note or "").strip()
    if decision == "reject" and not note:
        return {"ok": False, "reason": "note"}
    artifact = await session.get(am.ArtifactVersion, artifact_version_id) \
        if artifact_version_id else await latest_artifact(
            session, task.id, stream="spec" if action == "baseline" else "delivery")
    if artifact is None or artifact.task_id != task.id:
        return {"ok": False, "reason": "stale"}
    latest = await latest_artifact(session, task.id, stream=_stream(artifact.kind))
    if latest is None or latest.id != artifact.id:
        return {"ok": False, "reason": "stale"}
    if artifact.state == "superseded":
        return {"ok": False, "reason": "stale"}
    if action == "review" and artifact.kind != "code":
        from . import delivery_truth
        manifest = delivery_truth.artifact_manifest(artifact)
        if not manifest.get("complete"):
            problems = list(manifest.get("problems") or [])
            detail = str((problems[0] if problems else {}).get("detail") or
                         "当前主成果尚未通过结构校验")
            return {"ok": False, "reason": "invalid_artifact", "detail": detail}
    req = (await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.artifact_version_id == artifact.id,
        am.ApprovalRequest.action == action,
        am.ApprovalRequest.environment_id == (environment_id or "")
    ).order_by(am.ApprovalRequest.created_at.desc()).limit(1)
        .with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    if req is None:
        req = await ensure_request(session, task, artifact, action, environment_id)
    if req.status != "pending":
        return {"ok": False, "reason": "resolved", "request": request_api(req, await _decisions(session, req.id))}
    allowed, why = await can_decide(session, task, req, actor)
    if not allowed:
        return {"ok": False, "reason": "forbidden", "detail": why}
    from . import gate_contract, resource_access
    gate = await gate_contract.packet(session, task, req, artifact)
    if decision == "approve":
        # The API enforces the same evidence gate as the client UI.
        if not dict(gate.get("readiness") or {}).get("canApprove"):
            missing = list(dict(gate.get("readiness") or {}).get("blockers") or [])
            return {"ok": False, "reason": "gate_evidence",
                    "detail": "\u8bf7\u5148\u8865\u9f50\u95e8\u7981\u8bc1\u636e\uff1a" +
                              "\u3001".join(str(x) for x in missing[:8]),
                    "gate": gate}
    uid = approval_routing.actor_id(actor)
    prior = (await session.execute(select(am.ApprovalDecision).where(
        am.ApprovalDecision.request_id == req.id,
        am.ApprovalDecision.user_id == uid).limit(1))).scalar_one_or_none()
    if prior is not None:
        return {"ok": False, "reason": "duplicate"}
    d = am.ApprovalDecision(request_id=req.id, user_id=uid, user_name=_actor_name(actor),
                            decision=decision, note=note[:1200],
                            gate_snapshot=resource_access.stabilize(gate))
    session.add(d)
    await session.flush()
    if decision == "reject":
        req.status = "rejected"
        req.resolved_at = _now()
        if action in ("baseline", "review", "uat"):
            artifact.state = "rejected"
        task_events.record(session, task.id, "release.rejected",
                           {"requestId": req.id, "versionId": artifact.id,
                            "action": action, "note": d.note}, actor=d.user_name)
    else:
        ds = await _decisions(session, req.id)
        approved = len({x.user_id for x in ds if x.decision == "approve"})
        if approved >= req.required_count:
            req.status = "approved"
            req.resolved_at = _now()
            if action == "baseline":
                artifact.state = "baselined"
            elif action == "review":
                task.reviewed_at = _now()
                task.reviewed_by = uid
                task.reviewed_by_name = d.user_name
                already_merged = artifact.kind == "code" and bool(
                    dict(artifact.manifest or {}).get("mergeCommit"))
                artifact.state = "merged" if already_merged else "reviewed"
                if already_merged:
                    continue_existing_merge = True
                elif artifact.kind == "code":
                    await ensure_request(session, task, artifact, "merge", context={
                        "summary": f"合并 {artifact.branch} → {artifact.target}",
                        "commit": artifact.commit_sha,
                    })
            elif action == "merge":
                artifact.state = "approved"
            elif action == "uat":
                # UAT is a business decision over test evidence; retain tested state for deployment validation.
                pass
            elif action == "deploy":
                # Deployment approval is scoped to an environment and must not regress global artifact state.
                # Use the environment-specific ApprovalRequest to determine authorization.
                pass
            task_events.record(session, task.id, "release.approved",
                               {"requestId": req.id, "versionId": artifact.id,
                                "action": action, "note": d.note}, actor=d.user_name)
    await session.commit()
    delivery = None
    if continue_existing_merge:
        from . import code_delivery
        delivery = await code_delivery._after_merge(session, task, {
            "ok": True, "stage": "merged", "already": True,
            "branch": artifact.branch, "target": artifact.target,
            "commits": list(dict(artifact.manifest or {}).get("commits") or []),
            "mergeCommit": str(dict(artifact.manifest or {}).get("mergeCommit") or ""),
        }, d.user_name)
    return {"ok": True, "artifact": artifact_api(artifact),
            "request": request_api(req, await _decisions(session, req.id)),
            **({"delivery": delivery} if delivery is not None else {})}


async def revoke_approval(session: AsyncSession, task: models.Task, actor,
                          request_id: str, note: str = "") -> dict:
    """Revoke an approved request only before irreversible downstream merging or deployment,
    including in-progress deployment. Preserve historical decisions, mark the request revoked,
    and create new review attempts through workflow rework. Later changes require forward
    remediation instead of revocation.
    """
    note = str(note or "").strip()
    if not note:
        return {"ok": False, "reason": "note", "error": "撤回必须写明原因"}
    req = await session.get(am.ApprovalRequest, str(request_id or ""))
    if req is None or req.task_id != task.id:
        return {"ok": False, "reason": "not_found", "error": "审批不存在"}
    if req.status != "approved":
        return {"ok": False, "reason": "status",
                "error": "只有已批准的审批可以撤回（当前：%s）" % req.status}
    allowed, why = await can_decide(session, task, req, actor)
    if not allowed:
        return {"ok": False, "reason": "forbidden", "error": why}
    artifact = await session.get(am.ArtifactVersion, req.artifact_version_id)

    # Check for irreversible downstream actions.
    if req.action in ("merge", "review", "baseline"):
        if artifact is not None and artifact.kind == "code" and artifact.state in (
                "merged", "tested", "released"):
            return {"ok": False, "reason": "irreversible",
                    "error": "这个版本的代码已经合并进目标分支，撤回救不回来；"
                             "请向前修复——新的提交会自动作废旧授权、重新走审查"}
    if req.action in ("deploy", "uat") or req.environment_id:
        deployed = (await session.execute(select(am.DeploymentRun).where(
            am.DeploymentRun.artifact_version_id == req.artifact_version_id,
            am.DeploymentRun.state.in_(("queued", "running", "succeeded"))
        ).limit(1))).scalar_one_or_none()
        if deployed is not None:
            return {"ok": False, "reason": "irreversible",
                    "error": "这个版本已经排入或完成了环境发布，撤回救不回来；"
                             "需要下线请在环境中心回滚或重发上一版"}

    # Locate the associated approval node and rework affected downstream nodes in active runs.
    from . import workflow_engine
    node_row = None
    run_row = None
    runs = list((await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.task_id == task.id
    ).order_by(am.WorkflowRun.created_at.desc()))).scalars().all())
    for run in runs:
        rows = list((await session.execute(select(am.NodeRun).where(
            am.NodeRun.run_id == run.id
        ).order_by(am.NodeRun.attempt.desc()))).scalars().all())
        hit = next((x for x in rows
                    if str((x.output or {}).get("requestId") or "") == req.id), None)
        if hit is not None:
            node_row, run_row = hit, run
            break
    if node_row is not None and run_row is not None and run_row.state not in (
            "succeeded", "failed", "cancelled"):
        # Artifact-state checks already reject completed merges.
        # Also reject successful downstream merge or deploy nodes to guard against state inconsistencies.
        nodes_def = workflow_engine._nodes(await session.get(
            am.PluginVersion, run_row.plugin_version_id))
        affected = workflow_engine._descendants(nodes_def, node_row.node_key)
        latest = await workflow_engine._latest_nodes(session, run_row.id)
        for key in affected:
            row = latest.get(key)
            if row is None or key == node_row.node_key:
                continue
            if row.node_type == "merge" and row.state == "succeeded" \
                    and (row.output or {}).get("commit"):
                return {"ok": False, "reason": "irreversible",
                        "error": "代码已经合并进目标分支，撤回救不回来；请向前修复"}
            if row.node_type in ("deploy", "deploy_chain") and row.state in (
                    "succeeded", "waiting_external"):
                return {"ok": False, "reason": "irreversible",
                        "error": "发布链已经启动，撤回救不回来；需要下线请走环境回滚"}

    # Mark the request revoked while preserving decisions and updating the derived artifact state.
    req.status = "revoked"
    req.resolved_at = _now()
    if artifact is not None:
        rollback_state = {"baseline": "candidate", "review": "candidate",
                          "merge": "reviewed"}.get(req.action)
        if rollback_state:
            artifact.state = rollback_state
    # Revoking review also cancels any automatically created merge request still pending.
    if req.action == "review" and artifact is not None:
        merge_req = (await session.execute(select(am.ApprovalRequest).where(
            am.ApprovalRequest.artifact_version_id == artifact.id,
            am.ApprovalRequest.action == "merge",
            am.ApprovalRequest.status == "pending"))).scalars().first()
        if merge_req is not None:
            merge_req.status = "cancelled"
            merge_req.resolved_at = _now()
    task_events.record(session, task.id, "release.revoked", {
        "requestId": req.id, "versionId": req.artifact_version_id,
        "action": req.action, "note": note[:500],
    }, actor=_actor_name(actor))

    reworked = False
    if node_row is not None and run_row is not None and run_row.state not in (
            "succeeded", "failed", "cancelled"):
        # Affected downstream nodes may currently be running.
        # Unlike ordinary failure recovery, revocation removes their upstream authorization.
        # Stop those executions before invalidating and rescheduling the nodes.
        nodes_def = workflow_engine._nodes(await session.get(
            am.PluginVersion, run_row.plugin_version_id))
        affected = workflow_engine._descendants(nodes_def, node_row.node_key)
        latest = await workflow_engine._latest_nodes(session, run_row.id)
        running_rows = [latest[k] for k in affected
                        if latest.get(k) and k != node_row.node_key
                        and latest[k].state in ("running", "dispatching", "queued")]
        refs = [{"ref": str((r.executor or {}).get("ref") or ""),
                 "runnerId": str((r.executor or {}).get("runnerId") or ""),
                 "provider": str((r.executor or {}).get("provider") or "")}
                for r in running_rows
                if r.node_type in ("ai", "ai_review") and (r.executor or {}).get("ref")]
        if refs:
            from . import workflow_control
            await workflow_control._stop_executors(session, run_row, refs)
        for r in running_rows:
            r.state, r.finished_at = "rework", _now()
        reworked = await workflow_engine._begin_rework(
            session, run_row, node_row,
            {"retryFrom": node_row.node_key, "maxRounds": 5},
            "审批撤回：" + note)
    await session.commit()
    return {"ok": True, "reworked": reworked,
            "request": request_api(req, await _decisions(session, req.id))}


async def merge_authorization(session: AsyncSession, task_id: str) -> tuple[am.ArtifactVersion | None, bool]:
    artifact = await latest_artifact(session, task_id)
    if artifact is None or artifact.kind != "code":
        return artifact, False
    req = (await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.artifact_version_id == artifact.id,
        am.ApprovalRequest.action == "merge",
        am.ApprovalRequest.status == "approved").limit(1))).scalar_one_or_none()
    if req is not None:
        return artifact, True
    review = dict((artifact.manifest or {}).get("aiReview") or {})
    valid_ai_review = (
        review.get("verdict") == "pass"
        and review.get("artifactChecksum") == artifact.checksum
        and review.get("commit") == artifact.commit_sha
        and bool(review.get("reportChecksum"))
    )
    return artifact, valid_ai_review


async def record_ai_review(session: AsyncSession, task: models.Task,
                           artifact: am.ArtifactVersion, report: dict,
                           source: dict | None = None) -> dict:
    """Bind an AI review attestation to one immutable code artifact.

    The attestation is invalid as soon as checksum or commit changes.  It authorizes only merge;
    environment acceptance remains governed by each environment's policy.
    """
    latest = await latest_artifact(session, task.id, stream="delivery")
    if latest is None or latest.id != artifact.id or artifact.kind != "code":
        raise ValueError("AI 代码审查对应的固定代码版本已经失效")
    if str(report.get("verdict") or "") != "pass":
        raise ValueError("AI 代码审查没有通过")
    attestation = {
        "schemaVersion": 1, "verdict": "pass",
        "artifactChecksum": artifact.checksum, "commit": artifact.commit_sha,
        "reportChecksum": str(report.get("reportChecksum") or ""),
        "summary": str(report.get("summary") or "")[:2000],
        "findings": list(report.get("findings") or [])[:100],
        "checks": list(report.get("checks") or [])[:100],
        "attachmentId": str(report.get("attachmentId") or ""),
        "source": dict(source or {}), "reviewedAt": _ms(_now()),
    }
    if not attestation["reportChecksum"]:
        raise ValueError("AI 代码审查报告缺少内容指纹")
    artifact.manifest = {**dict(artifact.manifest or {}), "aiReview": attestation}
    artifact.state = "reviewed"
    task.reviewed_at, task.reviewed_by = _now(), None
    task.reviewed_by_name = "SoduWork AI Code Review"
    pending = list((await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.artifact_version_id == artifact.id,
        am.ApprovalRequest.action.in_(("review", "merge")),
        am.ApprovalRequest.status == "pending",
    ))).scalars().all())
    for request in pending:
        request.status, request.resolved_at = "cancelled", _now()
    task_events.record(session, task.id, "release.ai_reviewed", {
        "versionId": artifact.id, "commit": artifact.commit_sha,
        "reportChecksum": attestation["reportChecksum"],
        "summary": attestation["summary"][:500],
    }, actor="SoduWork AI Code Review")
    return attestation


async def mark_merged(session: AsyncSession, task: models.Task, commit: str, who: str) -> am.ArtifactVersion | None:
    artifact = await latest_artifact(session, task.id)
    if artifact is None:
        return None
    artifact.state = "merged"
    artifact.manifest = {**(artifact.manifest or {}), "mergeCommit": commit}
    task_events.record(session, task.id, "release.merged",
                       {"versionId": artifact.id, "commit": commit}, actor=who)
    return artifact


async def view(session: AsyncSession, task_id: str) -> dict:
    artifact = await latest_artifact(session, task_id)
    requirement = await latest_requirement(session, task_id)
    if artifact is None and requirement is None:
        return {"artifact": None, "requirement": None, "approvals": [], "state": "none"}
    version_ids = {x.id for x in (artifact, requirement) if x is not None}
    reqs = list((await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.artifact_version_id.in_(version_ids))
        .order_by(am.ApprovalRequest.created_at))).scalars().all())
    out = []
    for req in reqs:
        out.append(request_api(req, await _decisions(session, req.id)))
    pending = next((r for r in out if r["status"] == "pending"), None)
    current = artifact or requirement
    state = (pending["action"] + "_pending") if pending else current.state
    return {"artifact": artifact_api(artifact), "requirement": artifact_api(requirement),
            "approvals": out, "state": state}


async def list_pending(session: AsyncSession, user) -> list[dict]:
    """Scope the administration approval inbox by workflow assignments, not one global role for
    every organization's gates.
    """
    request_ids = set((await session.execute(select(am.ApprovalAssignment.request_id).where(
        am.ApprovalAssignment.user_id == approval_routing.actor_id(user)
    ))).scalars().all())
    if not request_ids:
        return []
    rows = list((await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.status == "pending",
        am.ApprovalRequest.action.in_(("merge", "deploy")),
        am.ApprovalRequest.id.in_(request_ids),
    ).order_by(am.ApprovalRequest.created_at))).scalars().all())
    task_ids = {r.task_id for r in rows}
    tasks = {t.id: t for t in (await session.execute(
        select(models.Task).where(models.Task.id.in_(task_ids or {"__none__"}))
    )).scalars().all()}
    artifacts = {a.id: a for a in (await session.execute(select(am.ArtifactVersion).where(
        am.ArtifactVersion.id.in_({r.artifact_version_id for r in rows} or {"__none__"})
    ))).scalars().all()}
    return [{**request_api(r, await _decisions(session, r.id)),
             "task": {"id": r.task_id, "title": getattr(tasks.get(r.task_id), "title", "")},
             "artifact": artifact_api(artifacts.get(r.artifact_version_id))}
            for r in rows]
