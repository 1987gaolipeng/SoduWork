"""A task's conversation receipt; execution remains in the existing chat runtime.

This is not a second job scheduler. The task row lock prevents duplicate work,
and the native conversation queue owns the order of sends.
"""
import hashlib
from fastapi import HTTPException
from . import task_status, task_events
from .task_access import publish_owner

ACTIVE = {"queued", "running", "waiting"}
SUBMISSION_MODES = {"manual", "auto"}

MAX_DELIVERY_FILES = 60


def receipt_model_source(task, body) -> str:
    """Classify native bookkeeping without granting model execution authority."""
    from .model_reference_privacy import is_local_model_reference
    if is_local_model_reference(body.get("model")):
        raise HTTPException(422, "本地模型引用不能写入 Hub 需求回执")
    current = dict((task.work_routing or {}).get("conversationTurn") or {})
    same = (current.get("turnId") == str(body.get("turnId") or "")[:120] and
            current.get("conversationId") == str(body.get("conversationId") or "")[:180])
    saved = str(current.get("modelSource") or "managed")
    source = str(body.get("modelSource") or (saved if same else "managed"))
    if source not in {"device", "managed"}:
        raise HTTPException(422, "需求执行模型来源无效")
    if same and source != saved:
        raise HTTPException(409, "当前执行轮次的模型来源已确定，请新建轮次后重新选择")
    if source == "device":
        from .model_quota import managed_runtime
        agent = body.get("agentId") or (current.get("modelAgentId") if same else "")
        if (str(body.get("executor") or "native") != "native" or
                body.get("continuationRef") or not managed_runtime(agent)):
            raise HTTPException(422, "设备模型回执只支持本机托管型执行底座")
        if str(body.get("model") or "").strip():
            raise HTTPException(422, "设备模型回执只允许通用来源标记")
        if same and current.get("modelAgentId") and managed_runtime(agent) != current["modelAgentId"]:
            raise HTTPException(409, "当前执行轮次的底座已确定，请新建轮次后重新选择")
    return source

def execution_instruction(value, claimed=None):
    text = str(value or "").strip()
    if len(text) > 50000:
        raise HTTPException(422, "需求文字超过 50000 字符，请将长材料作为附件；需求没有被截断执行")
    return text


def default_submission_mode(task) -> str:
    """Infer the delivery policy when the executor did not make a choice.

    A declared output contract means the executor can finish by producing the
    expected artifact and let the review gate open automatically. A task with
    no declared output has no safe automatic submission trigger, so it remains
    manual until the executor explicitly submits it for review.
    """
    routing = dict(getattr(task, "work_routing", None) or {})
    contract = dict(routing.get("outputContract") or {})
    has_output = bool(
        contract.get("kind") or contract.get("deliverables") or
        contract.get("expectedArtifacts") or contract.get("outputs") or
        str(getattr(task, "artifact_url", "") or "").strip()
    )
    return "auto" if has_output else "manual"


def normalize_submission_mode(value, *, fallback: str = "auto") -> str:
    """Validate the executor's delivery submission policy.

    Callers provide the task-aware fallback so older tasks without a persisted
    policy can still distinguish artifact-producing work from conversational
    work. The generic fallback remains ``auto`` for legacy helper callers.
    """
    mode = str(value or "").strip().lower()
    if not mode:
        mode = str(fallback or "auto").strip().lower() or "auto"
    if mode not in SUBMISSION_MODES:
        raise HTTPException(422, "执行提交方式只能是手动提交或自动提交")
    return mode


def _delivery_issue(task, code="", reason="", *, artifact_version_id=""):
    """Keep the recoverable delivery blocker scoped to the current turn."""
    routing = dict(task.work_routing or {})
    current = dict(routing.get("conversationTurn") or {})
    if code:
        current["deliveryIssue"] = {"code": code, "reason": str(reason)[:500]}
        if artifact_version_id:
            current["deliveryIssue"]["artifactVersionId"] = artifact_version_id
    else:
        current.pop("deliveryIssue", None)
    routing["conversationTurn"] = current
    task.work_routing = routing


def ensure_available(task, claimed=None, executor=None):
    from .task_requirements import ensure_executable
    ensure_executable(task)
    current = (task.work_routing or {}).get("conversationTurn") or {}
    # Only the head turn may enter its configured executor. Task ownership and
    # workflow/Runner authorization are still checked by the original APIs.
    if (isinstance(claimed, dict) and current.get("state") == "running"
            and current.get("executor") in {"workflow", "dispatch"}
            and (executor is None or current.get("executor") == executor)
            and claimed.get("turnId") == current.get("turnId")
            and claimed.get("conversationId") == current.get("conversationId")):
        return
    if current.get("state") in ACTIVE:
        raise ValueError("需求已在会话中执行或排队，请先在原会话中处理")


async def _workflow_starting(session, task_id):
    from datetime import datetime, timezone
    from sqlalchemy import select
    from ..automation_models import ResourceLease
    return (await session.execute(select(ResourceLease.id).where(
        ResourceLease.resource_kind == "workflow-start",
        ResourceLease.resource_key == task_id,
        ResourceLease.lease_until > datetime.now(timezone.utc),
        ResourceLease.token != "",
    ).limit(1))).scalar_one_or_none() is not None


async def _has_active_execution(session, task_id):
    from sqlalchemy import select
    from ..automation_models import ExecutionSession
    from .task_execution_contract import is_active
    # An expired dispatch acknowledgement window does not prove that execution has stopped.
    states = (await session.scalars(select(ExecutionSession.state).where(
        ExecutionSession.task_id == task_id))).all()
    return any(is_active(value) for value in states)


def _delivery_hint(reason: str, files: list[str]) -> str:
    """Return actionable recovery guidance for the failure category instead of repeating an
    ineffective operation. Document-protection software may make an artifact fail format
    validation; suggest providing an accessible format when appropriate."""
    text = str(reason or "")
    names = " ".join(str(x) for x in (files or []))
    lower = names.lower()
    if "压缩结构损坏" in text or "损坏" in text:
        if any(ext in lower for ext in (".docx", ".xlsx", ".pptx", ".pdf")):
            return "若本机启用了企业透明加密，请让 AI 改用纯文本/Markdown 或网页格式重新交付，勿再重试同格式"
        return "请让 AI 检查文件是否完整后再重新交付"
    return ""


async def deliver_artifacts(session, task, *, conversation_id: str, turn_id: str,
                            provider: str = "", files: list,
                            categories: dict | None = None, declared_paths: set[str] | None = None,
                            replacements: dict[str, list[str]] | None = None,
                            outcome: str = "completed") -> dict:
    """Ingest conversation-turn outputs through shared classification, validation, versioning, and
    review. Only completed turns create candidates; incomplete turns retain evidence without
    requesting review. Deduplicate filenames within a turn and create new versions across rework
    turns, respecting the receipt state machine.
    """
    from datetime import datetime, timezone
    import uuid as _uuid

    from sqlalchemy import select
    from ..models import Attachment, TaskEvent
    from . import delivery_manifest, storage
    from .ai_exec import EV_ARTIFACTS

    if not files:
        raise HTTPException(400, "这次交付没有携带任何产出文件")
    routing = dict(task.work_routing or {})
    submission_mode = normalize_submission_mode(
        routing.get("executionSubmissionMode"), fallback=default_submission_mode(task))
    current = dict(routing.get("conversationTurn") or {})
    if (current.get("turnId") != turn_id or
            current.get("conversationId") != conversation_id):
        raise HTTPException(409, "需求执行标识已变化，请刷新会话后重试")
    if current.get("state") not in {"running", "waiting"}:
        raise HTTPException(409, "这项需求的当前轮次已经结束，产出不重复收取")
    if len(files) > MAX_DELIVERY_FILES:
        raise HTTPException(413, f"产出超过 {MAX_DELIVERY_FILES} 个文件，请合并后重新交付")

    # Skip files already received for this turn when the client retries after a lost completion response.
    # Increment the conversation's receipt round so rework files become new versions.
    received: set[str] = set()
    round_no = 1
    ref = "conversation:" + conversation_id
    events = (await session.execute(select(TaskEvent).where(
        TaskEvent.task_id == task.id,
        TaskEvent.kind.in_([EV_ARTIFACTS, "artifact.delivery_deferred"])))).scalars().all()
    receipts = [event for event in events if event.kind == EV_ARTIFACTS]
    # Older receipts lack outcome, but their deferred event identifies the
    # incomplete round. A resumed completion must validate/freeze final bytes
    # even when the same filename was already stored as process evidence.
    deferred = {(str((event.detail or {}).get("ref") or ""),
                 str((event.detail or {}).get("identifier") or ""),
                 str((event.detail or {}).get("round") or ""))
                for event in events if event.kind == "artifact.delivery_deferred"}
    for event in receipts:
        detail = dict(event.detail or {})
        if str(detail.get("identifier") or "") != turn_id or str(detail.get("ref") or "") != ref:
            continue
        incomplete = detail.get("outcome") == "incomplete" or (
            ref, turn_id, str(detail.get("round") or "")) in deferred
        if outcome == "completed" and incomplete:
            continue
        received.update(str(x) for x in (detail.get("files") or []) if x)
    for event in receipts:
        if str((event.detail or {}).get("ref") or "") != ref:
            continue
        try:
            round_no = max(round_no, 1 + int((event.detail or {}).get("round") or 0))
        except (TypeError, ValueError):
            pass

    from . import delivery_manifest
    who = "agent:" + (provider or "conversation")
    got: list[str] = []
    valid: set[str] = set()
    deliverables: set[str] = set()
    primary: set[str] = set()
    evidence: set[str] = set()
    ignored: set[str] = set()
    invalid: list[dict] = []
    for name, data, ctype in files:
        fn = delivery_manifest.normalize_name(name)
        if not fn or fn in received:
            continue
        declared = (categories or {}).get(name)
        category = delivery_manifest.classify_name(fn, role="output", meta={"category": declared})
        verification = delivery_manifest.validate_bytes(fn, data, ctype, category=category)
        if verification.get("state") == "passed":
            truncated = await delivery_manifest.code_truncation(fn, data)
            if truncated:
                verification = {"state": "failed", "reason": truncated}
        if verification.get("state") != "passed":
            # Retain invalid files as downloadable evidence without blocking valid outputs.
            # Exclude invalid files from output and verification roles.
            # One corrupted file must not prevent review of all valid files in the turn.
            # Keep the validation failure visible in the process archive.
            role = "process"
            invalid.append({"name": fn, "reason": verification.get("reason") or "文件校验失败"})
        elif category == "evidence":
            role = "verification"
            evidence.add(fn)
            valid.add(fn)
        elif category in ("primary", "supporting"):
            role = "output"
            deliverables.add(fn)
            valid.add(fn)
            if category == "primary" and outcome == "completed":
                primary.add(fn)
            if outcome != "completed":
                # Treat incomplete-turn outputs as process evidence, not deliverables.
                # A later completed turn retransmits and reclassifies its full output set.
                role = "process"
                deliverables.discard(fn)
        else:
            role = "process"
            ignored.add(fn)
            valid.add(fn)
        key = f"ai/{task.id}/{_uuid.uuid4().hex[:8]}-{fn}"
        session.add(Attachment(
            task_id=task.id, filename=fn, content_type=ctype, size=len(data),
            storage_key=key, backend=storage.put(key, data, ctype), uploaded_by=who,
            role=role, source_ref=ref,
            evidence_meta={"provider": provider or "conversation",
                           "sha256": hashlib.sha256(data).hexdigest(),
                           "identifier": turn_id, "round": round_no,
                           "conversationId": conversation_id,
                           "category": category, "verification": verification,
                           **({"requestedOutput": True} if declared_paths and fn in declared_paths else {}),
                           **({"replaces": replacements[fn]} if replacements and replacements.get(fn) else {})},
            created_at=datetime.now(timezone.utc)))
        got.append(fn)
        received.add(fn)
    if not got:
        return {"ok": True, "already": True, "files": [],
                "submissionMode": submission_mode,
                **({"deliveryBlocked": True, "reason": current["deliveryIssue"]["reason"]}
                   if current.get("deliveryIssue", {}).get("code") in {"invalid_delivery", "review_unassigned"} else {}),
                "pendingSubmission": submission_mode == "manual"}
    task_events.record(session, task.id, EV_ARTIFACTS,
                       {"files": got, "identifier": turn_id, "ref": ref,
                        "provider": provider or "conversation", "round": round_no, "outcome": outcome,
                        "valid": sorted(valid), "deliverables": sorted(deliverables),
                        "evidence": sorted(evidence), "ignored": sorted(ignored),
                        "invalid": invalid[-100:]}, actor=who)
    if outcome != "completed":
        # Incomplete-turn files remain available as process evidence without creating a review candidate.
        # Do not create a candidate or review request until a completed turn arrives.
        # That turn retransmits the workspace outputs under a new round.
        task_events.record(session, task.id, "artifact.delivery_deferred",
                           {"ref": ref, "identifier": turn_id, "round": round_no,
                            "files": sorted(got),
                            "reason": "轮次未完成，本轮产出仅留证，待轮次完成后再交付"},
                           actor=who)
        await session.commit()
        return {"ok": True, "files": got, "round": round_no,
                "deferred": True, "invalid": invalid[-100:],
                "submissionMode": submission_mode,
                "pendingSubmission": submission_mode == "manual"}
    if routing.get("executionSubmissionChoice") == "infer":
        if not primary:
            reason = "本轮没有校验通过的正式交付文件，请检查交付文件或清单后重新提交"
            if invalid:
                reason = str(invalid[0].get("reason") or reason)[:500]
            _delivery_issue(task, "invalid_delivery", reason)
            task_events.record(session, task.id, "artifact.delivery_rejected",
                               {"ref": ref, "identifier": turn_id, "files": sorted(got), "reason": reason}, actor=who)
            await session.commit()
            from . import task_access, tasks as tasks_svc
            await task_access.publish_task(session, task, "task.updated", await tasks_svc.task_to_api_live(session, task))
            return {"ok": True, "files": got, "round": round_no, "invalid": invalid[-100:],
                    "submissionMode": submission_mode, "pendingSubmission": False,
                    "deliveryBlocked": True, "reason": reason}
        # Resolve the new client's default only after validating current-turn
        # primary output. Unknown historical manual choices remain untouched.
        submission_mode = "auto"
        routing["executionSubmissionMode"] = submission_mode
        task.work_routing = routing
    _delivery_issue(task)
    if submission_mode == "manual":
        # Manual submission mode stores artifacts without opening review.
        # submit-review explicitly freezes the candidate and creates the request later.
        task_events.record(session, task.id, "artifact.delivery_waiting_manual",
                           {"ref": ref, "identifier": turn_id, "round": round_no,
                            "files": sorted(got), "submissionMode": submission_mode},
                           actor=who)
        await session.commit()
        from . import task_access, tasks as tasks_svc
        await task_access.publish_task(session, task, "task.updated",
                                       await tasks_svc.task_to_api_live(session, task))
        return {"ok": True, "files": got, "round": round_no,
                "invalid": invalid[-100:], "submissionMode": submission_mode,
                "pendingSubmission": True}
    # Freeze non-code outputs into immutable review candidates.
    # code_delivery retains control of code candidates and workflow gates; this path stores receipts and manifests.
    try:
        from . import code_delivery
        code = await code_delivery.check(session, task, who="SoduWork", force=True)
    except Exception:  # noqa: BLE001 - Code-delivery checks must not prevent artifact storage.
        code = {}
    review_request_id = ""
    if not code.get("applies"):
        from .artifact_version_guard import OutputAwaitingRework
        artifact = None
        try:
            from . import release_control
            artifact, _ = await release_control.ensure_current_output(session, task, source_ref=ref,
                                                                        who=who, automatic_round=round_no)
            # Completed AI delivery automatically creates the candidate and human review gate.
            # Project the task as awaiting review without requiring a manual board move.
            # Avoid a separate state update that could race with candidate creation.
            # Reuse versions and pending requests when content is unchanged.
            # ensure_output_candidate supersedes or cancels pending requests when new content creates a version.
            request = await release_control.ensure_request(session, task, artifact, "review")
            task_events.record(session, task.id, "artifact.submitted_for_review",
                               {"requestId": request.id, "versionId": artifact.id,
                                "note": "会话产出自动提交验收", "auto": True, "ref": ref},
                               actor=who)
            if request.status == "pending":
                review_request_id = request.id
        except OutputAwaitingRework:
            # A late delivery receipt cannot undo a reviewer's rejection.
            await session.commit()
            return {"ok": True, "files": got, "round": round_no, "deferred": True,
                    "pendingRework": True, "submissionMode": submission_mode}
        except ValueError as error:
            # Report structural validation failures explicitly.
            # Do not conceal them behind a generic missing-deliverable or conflict message.
            # Notify the task owner of the actual failure.
            # Choose recovery guidance from the failure type.
            # For transparent encryption failures, changing output format may work where regeneration does not.
            reason = str(error)[:500]
            from . import approval_routing
            missing_reviewer = isinstance(error, approval_routing.ReviewAssignmentUnavailable)
            _delivery_issue(task, "review_unassigned" if missing_reviewer else "invalid_delivery", reason,
                            artifact_version_id=artifact.id if missing_reviewer else "")
            # The generic reason may say no reviewable outputs remain.
            # Pass this turn's detailed invalid-file results to the recovery hint generator.
            # Otherwise format-specific guidance cannot be selected.
            failure_forms = " ".join(str(item.get("reason") or "") for item in invalid[-20:])
            hint = _delivery_hint(reason + " " + failure_forms, got)
            task_events.record(session, task.id, "artifact.delivery_rejected",
                               {"ref": ref, "files": sorted(got), "reason": reason,
                                **({"hint": hint} if hint else {})}, actor=who)
            from ..realtime import hub
            if task.owner_client_id:
                await publish_owner(session, task, {
                    "type": "notice", "taskId": task.id,
                    "text": f"「{task.title}」的产出自检未通过，未进入待验收：{reason}{('（' + hint + '）') if hint else ''}"})
    # Persist the review and its notification atomically. A notice must never
    # invite a click before the gate is committed, nor hold upload completion
    # hostage to a slow device transport. The existing outbox owns retries.
    from . import task_notifications
    task_notifications.enqueue(session, task, "task.updated", review_request_id=review_request_id)
    await session.commit()
    return {"ok": True, "files": got, "round": round_no,
            "invalid": invalid[-100:], "submissionMode": submission_mode,
            **({"deliveryBlocked": True, "reason": task.work_routing["conversationTurn"]["deliveryIssue"]["reason"]}
               if task.work_routing.get("conversationTurn", {}).get("deliveryIssue") else {}),
            "pendingSubmission": False}


async def _cancel_turn_review(session, task, *, ref: str, turn_id: str, actor: str = "") -> None:
    """Cancel pending review gates bound to this conversation turn when the turn fails."""
    from datetime import datetime, timezone

    from sqlalchemy import select
    from ..automation_models import ApprovalRequest, ArtifactVersion
    from ..models import TaskEvent
    from ..realtime import hub

    versions = (await session.execute(select(ArtifactVersion.id).where(
        ArtifactVersion.task_id == task.id,
        ArtifactVersion.source_ref == ref))).scalars().all()
    if not versions:
        return
    reqs = (await session.execute(select(ApprovalRequest).where(
        ApprovalRequest.task_id == task.id,
        ApprovalRequest.artifact_version_id.in_(versions),
        ApprovalRequest.action == "review",
        ApprovalRequest.status == "pending"))).scalars().all()
    for req in reqs:
        req.status = "cancelled"
        req.resolved_at = datetime.now(timezone.utc)
        task_events.record(session, task.id, "artifact.review_cancelled",
                           {"requestId": req.id, "ref": ref, "turnId": turn_id,
                            "reason": "轮次未完成，自动提交的验收单已撤回"}, actor)
        if task.owner_client_id:
            try:
                await publish_owner(session, task, {
                    "type": "notice", "taskId": task.id,
                    "text": f"「{task.title}」的这一轮执行未完成，自动提交的验收单已撤回，请继续返修后重新提交"})
            except Exception:  # noqa: BLE001 - Notification failure must not affect the state machine.
                pass


async def apply(session, task, body, actor=""):
    model_source = receipt_model_source(task, body)
    action = str(body.get("action") or "prepare")
    turn_id = str(body.get("turnId") or "")[:120]
    conversation_id = str(body.get("conversationId") or "")[:180]
    if not turn_id or not conversation_id:
        raise HTTPException(422, "缺少会话或发送标识")
    routing = dict(task.work_routing or {})
    current = dict(routing.get("conversationTurn") or {})
    submission_key = ("executionSubmissionMode" if "executionSubmissionMode" in body
                      else "submissionMode" if "submissionMode" in body else "")
    has_submission_mode = bool(submission_key)
    stored_submission_mode = routing.get("executionSubmissionMode")
    submission_mode = normalize_submission_mode(
        body.get(submission_key) if has_submission_mode else stored_submission_mode,
        fallback=stored_submission_mode or default_submission_mode(task))
    same = current.get("turnId") == turn_id and current.get("conversationId") == conversation_id
    executor = str(body.get("executor") or "native")
    continuation_ref = str(body.get("continuationRef") or "")
    if executor not in {"native", "workflow", "dispatch"}:
        raise HTTPException(422, "不支持的需求执行方式")
    native_choice = body.get("executionChoice") == "native"
    if action == "prepare":
        choice = routing.get("executionSubmissionChoice") if executor == "native" else None
        requested_choice = body.get("submissionChoice")
        if requested_choice is not None:
            if (executor != "native" or not isinstance(requested_choice, str)
                    or requested_choice not in {"infer", "manual", "auto"}):
                raise HTTPException(422, "提交选择仅支持本机会话的自动判断、手动或自动提交")
            if has_submission_mode and body.get(submission_key) and requested_choice != submission_mode:
                raise HTTPException(422, "提交选择与提交方式不一致")
            if same and requested_choice != choice:
                raise HTTPException(409, "当前执行轮次已确定提交选择，不能中途切换")
            choice = requested_choice
        elif executor == "native" and has_submission_mode and body.get(submission_key):
            if same and choice and choice != submission_mode:
                raise HTTPException(409, "当前执行轮次已确定提交选择，不能中途切换")
            choice = submission_mode
        if choice == "infer" and not same:
            submission_mode = default_submission_mode(task)
        elif choice in SUBMISSION_MODES:
            submission_mode = choice
        from . import dispatch_instructions
        instructions = dispatch_instructions.submitted(body, current.get("initialSubmissionMode", submission_mode)
                                                        if same else submission_mode)
        from .task_requirements import ensure_executable
        try:
            ensure_executable(task)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        if same:
            await dispatch_instructions.preserve_retry(session, task.id, current, instructions)
            if continuation_ref != str(current.get("continuationRef") or ""):
                raise HTTPException(409, "原执行会话已变化，请刷新需求后重试")
            if (has_submission_mode and stored_submission_mode and
                    submission_mode != normalize_submission_mode(stored_submission_mode)):
                raise HTTPException(409, "当前执行轮次已确定提交方式，不能中途切换")
            if submission_mode:
                routing["executionSubmissionMode"] = submission_mode
            task.work_routing = routing
            return current
        if native_choice and (executor != "native" or task.status != "todo" or
                              current.get("state") == "completed"):
            raise HTTPException(409, "仅待开始且没有交付结果的需求可以重新选择执行方式")
        if task.status in ("done", "cancel"):
            raise HTTPException(409, "需求已经结束")
        if continuation_ref:
            from . import ai_exec
            dispatch = await ai_exec.last_dispatch_event(session, task.id)
            detail = dict(dispatch.detail or {}) if dispatch else {}
            if (executor != "dispatch" or native_choice or
                    current.get("conversationId") != conversation_id or
                    continuation_ref != str(detail.get("ref") or detail.get("issueId") or "")):
                raise HTTPException(409, "原执行会话已变化，请从需求入口继续修正")
            if await _has_active_execution(session, task.id):
                raise HTTPException(409, "原执行尚未结束，请等待后再继续修正")
        if (current.get("state") == "completed" and executor != "native" and not continuation_ref):
            raise HTTPException(409, "这项需求已经在会话中返回结果，请先查看结果，避免重复执行")
        # Native conversation execution may start a new turn after completion.
        # Follow-up requests run through a new start/complete cycle and output round.
        # Workflow and Runner executions retain their independent gate restrictions.
        if current.get("state") in ACTIVE:
            raise HTTPException(409, "这项需求已在会话中执行或排队，请勿重复安排执行")
        if ((routing.get("selectedStrategy") == "workflow" and executor != "workflow" and not native_choice) or
                await _workflow_starting(session, task.id) or await task_status.engine_owns(session, [task.id])):
            raise HTTPException(409, "这项需求由工作流执行，不能改为普通会话执行")
        from . import dispatch_attempts
        if await dispatch_attempts.existing(session, task.id, task.status):
            raise HTTPException(409, "需求已经派给执行机，请等待当前执行结束")
        if native_choice and await _has_active_execution(session, task.id):
            raise HTTPException(409, "需求仍有活动执行，请先停止原执行并确认结束后再改选")
        if native_choice:
            import re
            aid = str(body.get("agentId") or "")
            if not re.fullmatch(r"local:[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}", aid):
                raise HTTPException(422, "请明确选择本机 Agent")
            # Change selection after task locking and execution-ownership validation, committing with the new receipt.
            # Preserve scenario, materials, delivery contract, and history instead of rebuilding the work snapshot.
            task_events.record(session, task.id, "execution.choice", {
                "strategy": "direct", "executor": "native", "agentId": aid,
                "previousStrategy": routing.get("selectedStrategy") or "",
                "previousBindingId": routing.get("workflowBindingId") or routing.get("selectedWorkflowBindingId") or "",
            }, actor)
            previous_context = dict(routing.get("executionContext") or {})
            routing.update(selectedStrategy="direct", workflowBindingId="", selectedWorkflowBindingId="",
                executionContext={"schemaVersion": 1, "strategy": "direct", "agent": {"id": aid, "cli": aid[6:]},
                    "runner": {"mode": "local"}, "location": {"mode": "local"},
                    "model": str(body.get("model") or "")[:160],
                    **({"modelSource": "device"} if model_source == "device" else {}),
                    **({"repo": previous_context["repo"]} if previous_context.get("repo") else {})})
        if submission_mode:
            routing["executionSubmissionMode"] = submission_mode
        if choice:
            routing["executionSubmissionChoice"] = choice
        else:
            routing.pop("executionSubmissionChoice", None)
        current = {"turnId": turn_id, "conversationId": conversation_id, "state": "queued", "executor": executor}
        if choice == "infer":
            current["initialSubmissionMode"] = submission_mode
        if model_source == "device":
            from .model_quota import managed_runtime
            current.update(modelSource="device", modelAgentId=managed_runtime(body.get("agentId")))
        if continuation_ref:
            current["continuationRef"] = continuation_ref
        dispatch_instructions.record(session, task.id, instructions, current, actor)
        # Starting manual rework clears the existing pending-rework marker.
        # A later rejection or failure creates a new reworkPending marker.
        # Runner rework is acknowledged only after its message admission. Queue
        # preparation alone must not make an old Runner output eligible again.
        rework_taken = routing.pop("reworkPending", None) if not continuation_ref else None
        if rework_taken is not None:
            task_events.record(session, task.id, "ai.rework_taken", {
                "ref": conversation_id, "turnId": turn_id,
                "feedback": str(dict(rework_taken or {}).get("feedback") or "")[:500],
            }, actor)
    else:
        if not same:
            raise HTTPException(409, "需求执行标识已变化，请刷新会话")
        if action == "started":
            # `start` claims the queue head before runtime preparation. This
            # separate receipt is emitted only by the native Agent start event.
            if (current.get("executor") != "native" or executor != "native"
                    or current.get("state") not in {"running", "waiting"}):
                raise HTTPException(409, "尚未收到本机执行开始确认")
            from . import repository_issue_access
            if await repository_issue_access.record_started(session, task):
                task_events.record(session, task.id, "execution.started", {
                    "conversationId": conversation_id, "turnId": turn_id, "source": "native"}, actor)
            return current
        state = {"start": "running", "complete": "completed", "fail": "failed",
                 "wait": "waiting", "cancel": "cancelled"}.get(action)
        if not state:
            raise HTTPException(422, "不支持的会话需求操作")
        issue = body.get("deliveryIssue")
        if issue is not None:
            if (action not in {"wait", "fail"} or executor != "native"
                    or not isinstance(issue, dict)
                    or issue.get("code") not in {"capture_pending", "capture_failed", "sync_pending"}
                    or not isinstance(issue.get("reason"), str) or not issue["reason"].strip()):
                raise HTTPException(422, "交付状态说明无效")
            issue = {"code": issue["code"], "reason": issue["reason"][:500]}
        same_state = current.get("state") == state
        if same_state and (issue is None or issue == current.get("deliveryIssue")):
            return current
        allowed = {"start": {"queued"}, "complete": {"running", "waiting"},
                   "fail": ACTIVE, "wait": {"running"}, "cancel": ACTIVE}
        if not same_state and current.get("state") not in allowed[action]:
            raise HTTPException(409, "需求执行状态已变化")
        if action == "start" and not await task_status.mark(session, task, "doing", why="需求开始执行"):
            raise HTTPException(409, "需求正由其他流程接管")
        if action == "fail":
            # Server-side failure handling cancels this turn's automatically created pending review requests.
            # This backs up the client's outcome gate.
            # A failed receipt and pending review must not coexist for the same turn.
            # Leave historical requests with a different source_ref unchanged.
            await _cancel_turn_review(session, task,
                                      ref="conversation:" + conversation_id,
                                      turn_id=turn_id, actor=actor)
        # A completed model turn is a delivery receipt, not human acceptance.
        # Do not bypass delivery_truth by marking the business task done here.
        current = {**current, "state": state}
        if issue is not None:
            current["deliveryIssue"] = issue
        elif action == "complete" and current.get("deliveryIssue", {}).get("code") in {"capture_pending", "sync_pending"}:
            current.pop("deliveryIssue", None)
    routing["conversationTurn"] = current
    task.work_routing = routing
    task_events.record(session, task.id, "conversation.turn", current, actor)
    return current
