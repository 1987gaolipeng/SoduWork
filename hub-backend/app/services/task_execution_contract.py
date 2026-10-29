"""Versioned task-execution display contract independent of runtime and environment names.
Normalize workflows, direct sessions, manual actions, evidence, fixed-version decisions, and
releases before client rendering.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


SCHEMA_VERSION = "1.0"

_SUCCESS = {"succeeded", "approved", "done", "released", "merged", "tested", "skipped"}
_LIVE = {"queued", "dispatching", "running", "rework", "waiting_human", "waiting_external"}
_BAD = {"failed", "blocked", "rejected", "rollback_failed"}
_STATE_MAP = {
    "done": "succeeded", "completed": "succeeded", "complete": "succeeded",
    "canceled": "cancelled",
}
_HALTED = {"cancelled", "stopped", "interrupted"}

_CATEGORY = {
    "spec": "understand",
    "condition": "organize",
    "ai": "execute", "script": "execute", "tool": "execute", "manual": "execute",
    "quality": "verify", "validate": "verify", "ai_review": "verify",
    "human_review": "verify", "approval": "verify",
    "merge": "deliver", "deploy": "deliver", "deploy_chain": "deliver", "publish": "deliver",
}

_PHASES = (
    ("understand", "理解工作", "明确目标、边界与输入"),
    ("organize", "组织协作", "确定流程、责任人与执行资源"),
    ("execute", "执行工作", "人和 AI 按计划完成工作"),
    ("verify", "确认结果", "质量检查、证据复核与人工验收"),
    ("deliver", "交付发布", "固定版本并送达目标环境"),
    ("evolve", "评价沉淀", "记录评价与可复用经验"),
)


def state(value: Any) -> str:
    raw = str(value or "planned")
    return _STATE_MAP.get(raw, raw)


def node_state(node: dict | None) -> str:
    """Project engine terminal states into user-facing node states."""
    item = dict(node or {})
    raw = state(item.get("state"))
    output = dict(item.get("output") or item.get("rawOutput") or {})
    decision = dict(output.get("decision") or {})
    if raw == "failed" and decision.get("outcome") == "blocked":
        return "blocked"
    return raw


def category(kind: Any) -> str:
    return _CATEGORY.get(str(kind or ""), "execute")


def is_active(value: Any) -> bool:
    """Whether a workflow/node/session state is still participating in the current run."""
    return state(value) in _LIVE


def is_success(value: Any) -> bool:
    return state(value) in _SUCCESS


def is_failure(value: Any) -> bool:
    return state(value) in _BAD


def latest_attempts(nodes: list[dict]) -> dict[str, dict]:
    """Return only the newest attempt of each workflow node.

    NodeRun rows are usually ordered, but a projection contract must not depend on a
    database's incidental row order. Attempt is authoritative; timestamps and input order are
    deterministic tie breakers for upgraded databases that may contain duplicate attempt values.
    """
    latest: dict[str, tuple[tuple[int, float, int], dict]] = {}
    for index, item in enumerate(nodes or []):
        key = str(item.get("key") or item.get("nodeKey") or item.get("id") or index)
        rank = (
            int(item.get("attempt") or 0),
            _session_time(item.get("createdAt") or item.get("startedAt") or item.get("finishedAt")),
            index,
        )
        if key not in latest or rank >= latest[key][0]:
            latest[key] = (rank, item)
    return {key: row[1] for key, row in latest.items()}


def current_node(run_view: dict) -> dict:
    """Project one current node from a run without reviving superseded attempts."""
    latest = latest_attempts(list(run_view.get("nodes") or []))
    if not latest:
        return {}
    definitions = [str(x.get("key") or "") for x in (run_view.get("workflow") or [])]
    ordered = [latest[key] for key in definitions if key in latest]
    ordered.extend(row for key, row in latest.items() if key not in definitions)
    run_state = state(run_view.get("state"))

    # The engine's persisted cursor is the strongest signal, especially for parallel branches.
    pointed = [latest[str(key)] for key in (run_view.get("currentNodes") or [])
               if str(key) in latest]
    if run_state == "waiting_human":
        waiting = [row for row in pointed if state(row.get("state")) == "waiting_human"]
        if waiting:
            return waiting[0]
    if is_active(run_state):
        for row in pointed:
            if is_active(row.get("state")):
                return row
        active = [x for x in ordered if is_active(x.get("state"))]
        if active:
            return active[0]
    if run_state == "succeeded":
        done = [x for x in ordered if is_success(x.get("state"))]
        return done[-1] if done else ordered[-1]
    if is_failure(run_state):
        failed = [x for x in ordered
                  if is_failure(x.get("state")) or state(x.get("state")) == "rework"]
        if failed:
            return failed[-1]
    halted = [x for x in ordered if state(x.get("state")) in _HALTED]
    if halted:
        return halted[-1]
    return ordered[-1]


def run_progress(run_view: dict) -> dict:
    """Progress counts the latest attempt of declared nodes, never historical successes."""
    total = len(run_view.get("workflow") or []) or len(latest_attempts(run_view.get("nodes") or []))
    latest = latest_attempts(list(run_view.get("nodes") or []))
    done = sum(1 for row in latest.values() if is_success(row.get("state")))
    return {"done": min(done, total), "total": total}


def workflow_office_phase(run_state: Any, node_state: Any = "") -> str:
    """Compact phase used by employee-facing summaries; details keep the canonical state."""
    run_value, node_value = state(run_state), state(node_state)
    if is_failure(run_value) or is_failure(node_value) or node_value == "rework":
        return "failed"
    if run_value == "waiting_human" or node_value == "waiting_human":
        return "waiting"
    if is_success(run_value) or run_value in _HALTED:
        return "done"
    return "running"


def direct_office_phase(task_status: Any, sessions: list[dict], *, delivered: bool = False,
                        reviewed: bool = False) -> str:
    """Compact phase for a direct AI task, derived from the same effective session as trace()."""
    if str(task_status or "") in {"done", "cancel"} or reviewed:
        return "done"
    if sessions:
        current = session_state(sessions, "running")
        if is_active(current):
            return "running"
        if is_failure(current) or current in _HALTED:
            return "failed"
        if is_success(current):
            return "waiting"
        return "failed"
    return "waiting" if delivered else "running"


def _source(item: dict | None = None, node: dict | None = None) -> dict:
    item, node = item or {}, node or {}
    return {
        "taskId": str(item.get("taskId") or ""),
        "workflowRunId": str(item.get("workflowRunId") or node.get("runId") or ""),
        "nodeRunId": str(item.get("nodeRunId") or node.get("id") or ""),
        "executionRef": str(item.get("sourceRef") or ""),
    }


def _producer(item: dict) -> dict:
    uploaded = str(item.get("uploadedBy") or "")
    return {
        "kind": "ai" if item.get("byAgent") else "human",
        "id": uploaded,
        "name": uploaded.removeprefix("agent:").removeprefix("admin:") or "需求参与者",
    }


def attachment_evidence(item: dict, *, role: str = "") -> dict:
    """Convert attachments to standard evidence metadata and URLs without embedding binary
    contents.
    """
    from . import resource_access

    mime = str(item.get("contentType") or "application/octet-stream")
    # ``image/*`` is not sufficient: SVG is active content. Preserve an
    # explicit false from attachment_to_api; use the central raster allowlist
    # only for older payloads that predate the isImage field.
    is_image = (bool(item.get("isImage")) if "isImage" in item
                else resource_access.is_inline_image(mime))
    evidence_role = str(role or item.get("role") or "input")
    # Correct legacy AI-output roles from uploader provenance when migration assigned the input default.
    if evidence_role == "input" and (item.get("byAgent") or
                                     str(item.get("uploadedBy") or "").lower() in {"soduwork ai", "soduwork"}):
        evidence_role = "output"
    verification = dict(item.get("evidenceMeta") or {}).get("verification") or {}
    return {
        "id": str(item.get("id") or ""),
        "kind": "image" if is_image else "file",
        "role": evidence_role,
        "title": str(item.get("filename") or "文件"),
        "label": str(item.get("filename") or "文件"),       # Compatibility fields for pre-1.0 clients.
        "summary": "",
        "value": str(item.get("size") or ""),
        "url": str(item.get("url") or ""),
        "attachmentId": str(item.get("id") or ""),
        "mime": mime,
        "size": int(item.get("size") or 0),
        "isImage": is_image,
        "createdAt": item.get("createdAt"),
        "producer": _producer(item),
        "source": _source(item=item),
        "verification": verification or {"state": "unverified", "by": "", "at": None},
        "meta": dict(item.get("evidenceMeta") or {}),
    }


def node_evidence(node: dict, attachments: list[dict]) -> list[dict]:
    """Convert node outputs to evidence, using exact provenance for new records and time windows
    only for legacy records.
    """
    out: list[dict] = []
    output = dict(node.get("output") or {})
    node_id = str(node.get("id") or "")
    run_id = str(node.get("runId") or "")

    def add(kind: str, title: str, summary: Any = "", *, role: str = "verification",
            verification: str = "unverified", meta: dict | None = None) -> None:
        out.append({
            "id": "%s:%s:%d" % (node_id or node.get("key") or "stage", kind, len(out) + 1),
            "kind": kind, "role": role, "title": str(title), "label": str(title),
            "summary": str(summary or ""), "value": str(summary or ""), "url": "",
            "attachmentId": "", "mime": "", "size": 0, "isImage": False,
            "createdAt": node.get("finishedAt") or node.get("startedAt"),
            "producer": dict(node.get("executor") or {}),
            "source": _source(node=node),
            "verification": {"state": verification, "by": "", "at": node.get("finishedAt")},
            "meta": dict(meta or {}),
        })

    # Prefer nodeRunId; use a same-workflow time window only when historical source columns are absent.
    start, end = node.get("startedAt"), node.get("finishedAt")
    plugin_evidence = [x for x in (output.get("evidence") or []) if isinstance(x, dict)][:60]
    referenced_ids = {str(output.get(k) or "") for k in
                      ("attachmentId", "reportAttachmentId", "evidenceAttachmentId")}
    referenced_ids.update(str(x.get("id") or x.get("attachmentId") or "")
                          for x in (output.get("attachments") or []) if isinstance(x, dict))
    referenced_ids.update(str(x.get("attachmentId") or "") for x in plugin_evidence
                          if x.get("attachmentId"))
    attached_ids: set[str] = set()
    for item in attachments:
        item_node, item_run = str(item.get("nodeRunId") or ""), str(item.get("workflowRunId") or "")
        exact = bool(item_node and item_node == node_id)
        referenced = str(item.get("id") or "") in referenced_ids
        legacy = not item_node and (not item_run or item_run == run_id)
        legacy_output = bool(item.get("byAgent") or
                             str(item.get("uploadedBy") or "").lower() in {"soduwork ai", "soduwork"})
        at = item.get("createdAt")
        in_window = bool(legacy and legacy_output and at is not None and start is not None
                         and at >= start and (end is None or at <= end + 60_000))
        if exact or referenced or in_window:
            out.append(attachment_evidence(item, role=str(item.get("role") or "output")))
            attached_ids.add(str(item.get("id") or ""))

    # Imported plugins emit the shared evidence contract without knowing client components.
    # Images must reference uploaded attachment IDs, not arbitrary external URLs presented as trusted evidence.
    for proof in plugin_evidence:
        attachment_id = str(proof.get("attachmentId") or "")
        title = str(proof.get("title") or proof.get("name") or "插件证据")[:160]
        if attachment_id:
            if attachment_id not in attached_ids:
                add("missing", title, "插件引用的证据附件不存在", verification="failed",
                    meta={"type": "plugin_evidence", "code": str(proof.get("code") or "")[:80]})
            continue
        kind = str(proof.get("kind") or "text").lower()
        if kind not in {"text", "check", "log", "commit"}:
            kind = "text"
        raw_verification = proof.get("verification")
        verification = (str(raw_verification.get("state") or "") if isinstance(raw_verification, dict)
                        else str(raw_verification or ""))
        if verification not in {"passed", "failed", "unverified"}:
            verification = ("passed" if proof.get("ok") is True else
                            "failed" if proof.get("ok") is False else "unverified")
        role = str(proof.get("role") or "verification")
        if role not in {"input", "process", "output", "verification"}:
            role = "verification"
        summary = str(proof.get("summary") or proof.get("detail") or proof.get("value") or "")[:4000]
        add(kind, title, summary, role=role, verification=verification,
            meta={"type": "plugin_evidence", "code": str(proof.get("code") or "")[:80]})

    if output.get("gitHead") or output.get("gitBranch"):
        value = str(output.get("gitHead") or "")[:12]
        if output.get("gitBranch"):
            value += "（%s）" % output["gitBranch"]
        add("commit", "代码提交", value, role="output", verification="passed")

    facts = (("change", "Gerrit change"), ("patchset", "Patchset"),
             ("verdict", "评审结论"), ("vote", "评审投票"), ("summary", "评审总评"),
             ("commit", "合并版本"), ("target", "目标分支"), ("version", "产品版本"),
             ("deployStatus", "部署状态"), ("artifactSha", "制品 SHA"),
             ("shaOk", "制品与合并版本一致"), ("customer", "发布目标"),
             ("shaMatch", "上线核对"))
    for key, title in facts:
        value = output.get(key)
        if value not in (None, "", []):
            passed = "passed" if value is True or key in {"commit", "gitHead", "version"} else "unverified"
            add("text", title, str(value)[:600], verification=passed, meta={"field": key})

    for check in list(output.get("checks") or [])[:60]:
        if not isinstance(check, dict):
            continue
        ok = check.get("ok")
        detail = str(check.get("detail") or check.get("log") or "")[:600]
        add("check", str(check.get("name") or "检查"), detail,
            verification="passed" if ok else "failed", meta={"ok": bool(ok)})

    for step in list(output.get("steps") or [])[:60]:
        if not isinstance(step, dict):
            continue
        detail = ", ".join("%s=%s" % (k, str(v)[:100]) for k, v in step.items() if k != "step")
        add("text", str(step.get("step") or "执行步骤"), detail[:600], role="process",
            verification="passed", meta={"type": "step"})

    if output.get("log"):
        add("log", "执行日志（尾部）", str(output["log"])[-4000:], role="process")
    decision = dict(output.get("decision") or {})
    if decision:
        blocked = decision.get("outcome") == "blocked"
        detail = str(decision.get("summary") or "")
        if decision.get("nextAction"):
            detail += "；下一步：" + str(decision.get("nextAction"))
        add("check", "执行阻断" if blocked else "节点预检通过", detail[:2000],
            verification="failed" if blocked else "passed",
            meta={"type": "node_decision", "reasonCode": decision.get("reasonCode") or "",
                  "evidence": list(decision.get("evidence") or [])[:40]})
    if str(node.get("type") or "") == "ai_review" and output.get("reportChecksum"):
        add("text", "评审报告指纹", str(output["reportChecksum"])[:64], verification="passed")
    receipt = dict(output.get("outputReceipt") or {})
    if str(receipt.get("text") or "").strip():
        add("text", "AI \u4ea4\u4ed8\u7ed3\u679c", str(receipt["text"])[:4000], role="output",
            verification="passed", meta={"type": "text_result"})
    if receipt.get("missing"):
        add("text", "缺少的约定产出", "、".join(str(x) for x in receipt["missing"][:20]),
            verification="failed", meta={"type": "missing"})
    return out


def _matches_approval(approval: dict, stage: dict) -> bool:
    ctx = dict(approval.get("context") or {})
    node_keys = {str(ctx.get(k) or "") for k in ("node", "nodeKey", "nodeRunId")}
    if str(stage.get("id") or "") in node_keys or str(stage.get("key") or "") in node_keys:
        return True
    action, kind = str(approval.get("action") or ""), str(stage.get("kind") or "")
    return ((action == "baseline" and kind == "spec") or
            (action == "review" and kind in {"human_review", "approval"}) or
            (action == "merge" and kind == "merge") or
            (action in {"uat", "deploy"} and kind in {"deploy", "deploy_chain", "publish", "validate"}))


def _artifact_matches(item: dict, stage: dict) -> bool:
    refs = {str(x.get("ref") or "") for x in stage.get("sessions") or []}
    output = dict(stage.get("rawOutput") or {})
    commits = {str(output.get(k) or "") for k in ("gitHead", "commit", "artifactSha")}
    return bool((item.get("sourceRef") and str(item.get("sourceRef")) in refs) or
                (item.get("commit") and str(item.get("commit")) in commits))


def _workflow_stages(runs: list[dict], sessions: list[dict], approvals: list[dict],
                     deployments: list[dict], artifacts: list[dict]) -> list[dict]:
    if not runs:
        return []
    run = next((x for x in runs if state(x.get("state")) in _LIVE), runs[0])
    grouped: dict[str, list[dict]] = {}
    for node in run.get("nodes") or []:
        grouped.setdefault(str(node.get("key") or ""), []).append(node)
    definitions = list(run.get("workflow") or [])
    known = {str(x.get("key") or "") for x in definitions}
    definitions += [{"key": key, "name": rows[-1].get("name"), "type": rows[-1].get("type")}
                    for key, rows in grouped.items() if key not in known]
    has_deploy_chain = any(str(x.get("type") or "") == "deploy_chain" for x in definitions)
    stages = []
    for definition in definitions:
        key = str(definition.get("key") or "")
        attempts = grouped.get(key) or []
        node = latest_attempts(attempts).get(key) if attempts else {
            "id": "", "runId": run.get("id") or "", "key": key,
            "name": definition.get("name") or key, "type": definition.get("type") or "",
            "state": "planned", "attempt": 0, "evidence": [], "input": {}, "output": {},
        }
        node_id = str(node.get("id") or "")
        projected_state = node_state(node)
        diagnosis = dict(node.get("diagnosis") or {})
        node_sessions = [x for x in sessions if (node_id and x.get("nodeRunId") == node_id) or
                         (not x.get("nodeRunId") and
                          (x.get("workflowRunId") == run.get("id") or
                           dict(x.get("plugin") or {}).get("runId") == run.get("id")) and
                          str(dict(x.get("plugin") or {}).get("node") or "") == key)]
        stage = {
            "id": node_id or "%s:%s" % (run.get("id") or "run", key),
            "key": key, "runId": str(run.get("id") or ""),
            "category": category(node.get("type")), "kind": str(node.get("type") or "manual"),
            "name": str(node.get("name") or definition.get("name") or key or "流程节点"),
            "state": projected_state, "attempt": int(node.get("attempt") or 0),
            "actor": dict(node.get("executor") or {}),
            "startedAt": node.get("startedAt"), "finishedAt": node.get("finishedAt"),
            "input": dict(node.get("input") or {}), "rawOutput": dict(node.get("output") or {}),
            "diagnosis": diagnosis,
            "evidence": list(node.get("evidence") or []), "sessions": node_sessions,
            "decisions": [], "deployments": [], "outputs": [],
            "attempts": [{"id": x.get("id"), "attempt": x.get("attempt"),
                          "state": node_state(x), "error": x.get("error") or "",
                          "diagnosis": dict(x.get("diagnosis") or {}),
                          "startedAt": x.get("startedAt"), "finishedAt": x.get("finishedAt")}
                         for x in attempts],
            "error": {"message": str(node.get("error") or ""),
                      "retryable": bool(diagnosis.get("retryable"))},
        }
        stage["decisions"] = [x for x in approvals if _matches_approval(x, stage)]
        if stage["kind"] == "deploy_chain" or (stage["kind"] in {"deploy", "publish"} and not has_deploy_chain):
            stage["deployments"] = deployments
        stage["outputs"] = [x for x in artifacts if _artifact_matches(x, stage)]
        stages.append(stage)
    # Attach legacy versions lacking ref or commit to the final delivery or validation node as a display fallback.
    unbound = [x for x in artifacts if not any(x in stage["outputs"] for stage in stages)]
    target = next((x for x in reversed(stages) if x["category"] in {"deliver", "verify"}), None)
    if target:
        target["outputs"].extend(unbound)
    return stages


def _session_time(value: Any) -> float:
    if value in (None, "", 0):
        return 0.0
    if isinstance(value, (int, float)):
        stamp = float(value)
        return stamp / 1000 if stamp > 10_000_000_000 else stamp
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (TypeError, ValueError, OverflowError):
        return 0.0


def current_session(sessions: list[dict]) -> dict:
    """Return the current execution by actual start time, not any stale running record. Preserve
    caller order for equal timestamps so legacy second-resolution data remains stable.
    """
    if not sessions:
        return {}
    ranked = []
    for index, item in enumerate(sessions):
        started = (_session_time(item.get("startedAt")) or
                   _session_time(item.get("firstStarted")) or
                   _session_time(item.get("at")) or
                   _session_time(item.get("createdAt")))
        ranked.append((started, -index, item))
    return max(ranked, key=lambda row: (row[0], row[1]))[2]


def session_state(sessions: list[dict], fallback: str = "planned") -> str:
    """Derive current execution state from the active attempt; historical attempts remain timeline
    evidence only.
    """
    current = current_session(sessions)
    if not current:
        return fallback
    raw = str(current.get("status") or current.get("state") or "").strip().lower()
    # If recovery confirms process termination but cannot recover its exit result, report interruption.
    # Do not retain running state or invent success.
    if raw in {"", "unknown"}:
        return "interrupted" if current.get("finishedAt") or current.get("ended") else fallback
    return state(raw)


def _lifecycle_task(task: dict, timeline: list[dict] | None) -> dict:
    reopened = max((_session_time(event.get("at")) for event in timeline or []
                    if event.get("kind") == "task.execution_started"
                    and dict(event.get("detail") or {}).get("from") == "done"
                    and dict(event.get("detail") or {}).get("to") in {"todo", "doing", "paused"}), default=0)
    return {**task, "_reopenedAt": reopened} if reopened else task


def _cycle_boundary(task: dict) -> float:
    return task.get("_reopenedAt") or _session_time(task.get("actualEnd"))


def _currently_accepted(task: dict) -> bool:
    reviewed = _session_time(task.get("reviewedAt"))
    if not reviewed or task.get("reviewRejected"):
        return False
    if task.get("_reopenedAt"):
        return reviewed > task["_reopenedAt"]
    # Legacy rows lack reopen events; an end timestamp only proves a prior cycle.
    return not task.get("actualEnd")


def _direct_stages(task: dict, sessions: list[dict], approvals: list[dict],
                   deployments: list[dict], artifacts: list[dict], attachments: list[dict]) -> list[dict]:
    task_state = str(task.get("status") or "todo")
    attachment_rows = [attachment_evidence(x) for x in attachments]
    inputs = [x for x in attachment_rows if x["role"] == "input"]
    outputs = [x for x in attachment_rows if x["role"] != "input"]
    # Legacy local direct tasks may lack persisted session rows.
    # Use completed task state consistently as a legacy execution-display fallback.
    execute_fallback = ("running" if task_state == "doing"
                         else "succeeded" if task_state == "done" else "planned")
    execute_state = session_state(sessions, execute_fallback)
    execution = current_session(sessions)
    current_artifact = next((x for x in reversed(artifacts)
                             if x.get("kind") != "requirement"), None)
    artifact_state = state((current_artifact or {}).get("state"))
    # Immutable artifacts and subsequent review or release facts establish traceable outputs.
    # An older watchdog failure must not overwrite that later execution evidence.
    if (is_failure(execute_state) or execute_state in _HALTED) and artifact_state in _SUCCESS:
        execute_state = "succeeded"
    current_id = str((current_artifact or {}).get("id") or "")
    reviews = [x for x in approvals if x.get("action") == "review"
               and (not current_id or str(x.get("artifactVersionId") or "") == current_id)]
    pending = next((x for x in reviews
                    if state(x.get("status")) in {"pending", "waiting_human"}), None)
    approved = next((x for x in reviews if state(x.get("status")) == "approved"), None)
    rejected = next((x for x in reviews
                     if state(x.get("status")) in {"rejected", "revoked"}), None)
    automated = bool(sessions or artifacts or outputs)
    # A fixed candidate proves reviewable output, not acceptance.
    # Derive verification state from current approval facts rather than process completion.
    verify_state = ("failed" if rejected else "waiting_human" if pending or (artifacts and not approved)
                    else "succeeded" if approved or (not automated and task_state == "done")
                    else "planned")
    dep_states = [state(x.get("state")) for x in deployments]
    deliver_state = (next((x for x in dep_states if x in _BAD or x in _LIVE), "") or
                     ("succeeded" if task_state == "done" else "planned"))
    # These four rows are task milestones, not stored checks or session receipts.
    # Submission proves work was handed in; acceptance remains a separate fact.
    if task_state == "done":
        execute_state = "succeeded"
        verify_state = "succeeded" if task.get("reviewedAt") else "waiting_human"
        deliver_state = "succeeded" if task.get("reviewedAt") else "planned"
    elif task.get("requirementStage") == "reviewing":
        execute_state, verify_state, deliver_state = "succeeded", "waiting_human", "planned"
    elif task_state == "todo":
        execute_state = verify_state = deliver_state = "planned"
    elif task_state in {"doing", "paused"}:
        ended = _cycle_boundary(task)
        current = current_session(sessions)
        started = _session_time(current.get("startedAt") or current.get("at"))
        if _currently_accepted(task):
            execute_state = verify_state = "succeeded"
        elif ended and started <= ended:
            execute_state, verify_state, deliver_state = "running", "planned", "planned"

    def row(key, cat, kind, name, value, **extra):
        return {"id": "direct:" + key, "key": key, "runId": "", "category": cat,
                "kind": kind, "name": name, "state": value, "attempt": 1,
                "actor": {}, "startedAt": None, "finishedAt": None, "input": {},
                "rawOutput": {}, "evidence": [], "sessions": [], "decisions": [],
                "deployments": [], "outputs": [], "attempts": [],
                "error": {"message": "", "retryable": False}, **extra}

    return [
        row("intake", "understand", "spec", "需求与输入已记录", "succeeded",
            startedAt=task.get("createdAt"), finishedAt=task.get("createdAt"), evidence=inputs),
        row("execute", "execute", "ai" if sessions else "manual", "执行工作", execute_state,
            sessions=sessions, evidence=outputs,
            startedAt=execution.get("startedAt") or execution.get("at"), finishedAt=execution.get("finishedAt")),
        row("verify", "verify", "human_review", "结果确认", verify_state,
            decisions=approvals, outputs=artifacts),
        row("deliver", "deliver", "deploy", "交付结果", deliver_state,
            deployments=deployments, outputs=artifacts),
    ]


def build_stages(task: dict, runs: list[dict], sessions: list[dict], approvals: list[dict],
                 deployments: list[dict], artifacts: list[dict], attachments: list[dict], *,
                 timeline: list[dict] | None = None) -> list[dict]:
    stages = _workflow_stages(runs, sessions, approvals, deployments, artifacts)
    return stages or _direct_stages(_lifecycle_task(task, timeline), sessions, approvals, deployments, artifacts, attachments)


def _aggregate(states: list[str], fallback: str = "planned") -> str:
    if not states:
        return fallback
    for name in ("failed", "rejected", "rollback_failed", "rework", "waiting_human",
                 "waiting_external", "running", "dispatching", "queued"):
        if name in states:
            return name
    if all(x in _SUCCESS or x == "cancelled" for x in states):
        return "succeeded" if any(x in _SUCCESS for x in states) else "cancelled"
    return states[-1]


def build_phases(task: dict, stages: list[dict], timeline: list[dict],
                 evolution: dict | None = None) -> list[dict]:
    by_category = {key: [x for x in stages if x.get("category") == key]
                   for key, _name, _desc in _PHASES}
    done_task = str(task.get("status") or "") == "done"
    has_started = any(state(x.get("state")) != "planned" for x in stages)
    learned = any(str(x.get("kind") or "") in {
        "task.evaluated", "evolution.accepted", "evolution.rejected", "evolution.applied"
    }
                  for x in timeline)
    out = []
    for key, name, desc in _PHASES:
        rows = by_category.get(key) or []
        fallback = "planned"
        if key == "understand":
            fallback = "succeeded"
        elif key == "organize" and has_started:
            fallback = "succeeded"
        elif key == "evolve" and (learned or done_task):
            evo_state = str(dict(evolution or {}).get("state") or "")
            fallback = ("waiting_human" if evo_state in {
                "awaiting_evaluation", "awaiting_decision"
            } else "succeeded" if learned or evo_state in {
                "evaluated", "adopted", "applied"
            } else "waiting_human")
        phase_state = _aggregate([state(x.get("state")) for x in rows], fallback)
        extra_evidence = 0
        if key == "evolve":
            counts = dict(dict(evolution or {}).get("counts") or {})
            extra_evidence = int(counts.get("evaluations") or 0) + int(counts.get("proposals") or 0)
        out.append({"key": key, "name": name, "description": desc, "state": phase_state,
                    "stageCount": len(rows),
                    "evidenceCount": sum(len(x.get("evidence") or []) for x in rows) + extra_evidence})
    return out


def _lifecycle(task: dict, current: dict, stages: list[dict]) -> dict:
    """Project task milestones separately from historical workflow/check receipts."""
    status = str(task.get("status") or "todo")
    phase = str(task.get("requirementStage") or "")
    current_state = state(current.get("state"))
    done, title, value, action = 1, "等待开始", "planned", "安排执行"
    if status == "done":
        if task.get("reviewedAt"):
            done, title, value, action = 4, "需求已完成", "succeeded", "查看成果与验收记录"
        else:
            done, title, value, action = 2, "等待验收", "waiting_human", "核对成果与完成标准"
    elif phase == "reviewing":
        done, title, value, action = 2, "等待验收", "waiting_human", "核对成果与完成标准"
    elif status in {"doing", "paused"}:
        title, value, action = "执行工作", "running", "继续执行并提交成果"
        if task.get("reviewRejected"):
            title, value, action = "按意见返修", "rework", "修改成果后重新提交验收"
        elif _currently_accepted(task):
            done, title, value, action = 3, "验收已通过，等待交付", "planned", "完成交付并办结"
            if current.get("category") == "deliver" and current_state in _LIVE | _BAD | _HALTED:
                title, value = str(current.get("name") or title), current_state
                action = "等待人工确认" if value == "waiting_human" else "处理交付阻断" if value in _BAD | _HALTED else "等待交付结果"
        elif current_state in _LIVE | _BAD | _HALTED:
            # A terminal receipt remains an audit fact after a task is reopened.
            # A new attempt may advance again, but a historical success cannot.
            ended = _cycle_boundary(task)
            execution = current_session(list(current.get("sessions") or []))
            started = _session_time(current.get("startedAt") or execution.get("startedAt") or execution.get("at"))
            historical = ended and started and started <= ended
            if not historical:
                title = str(current.get("name") or title)
                value = current_state
                done = {"verify": 2, "deliver": 3}.get(current.get("category"), 1)
                action = {
                    "waiting_human": "等待人工确认", "waiting_external": "等待环境返回结果",
                    "failed": "处理失败后重试", "blocked": "补齐条件后重试",
                    "rework": "按意见返修", "running": "正在执行",
                    "dispatching": "正在派发", "queued": "等待执行资源",
                    "interrupted": "执行已中断，等待处理", "stopped": "执行已停止",
                    "cancelled": "执行已取消",
                }.get(value, action)
        elif current_state == "planned" or current_state in _SUCCESS:
            ended = _cycle_boundary(task)
            def finished_category(category):
                rows = [row for row in stages if row.get("category") == category]
                return bool(rows) and all(
                    state(row.get("state")) in _SUCCESS and
                    (not ended or _session_time(row.get("finishedAt")) > ended)
                    for row in rows)
            if finished_category("verify"):
                done, title, value, action = 3, "等待交付", "planned", "确认交付结果并办结"
            elif finished_category("execute"):
                done, title, value, action = 2, "结果待确认", "waiting_human", "提交成果并核对完成标准"
        if status == "paused" and not task.get("reviewRejected"):
            title, value, action = "执行已暂停", "blocked", "处理阻断后继续执行"
    elif phase in {"intake", "clarifying"} or task.get("triageStage") in {"intake", "clarifying"}:
        title, action = "需求与输入已记录", "补齐背景与完成标准"
    if status == "cancel" or task.get("archivedAt"):
        title, value, action = "需求已归档", "cancelled", "查看历史记录"
    return {
        "title": title, "state": value, "nextAction": action,
        "progress": {"done": done, "total": 4, "unit": "阶段"},
        "description": "需求记录、执行工作、结果确认、交付完成；下方保留各次执行的真实记录。",
    }


def summary(stages: list[dict], phases: list[dict], sessions: list[dict], approvals: list[dict],
            deployments: list[dict], artifacts: list[dict], attachments: list[dict], *,
            task: dict | None = None, timeline: list[dict] | None = None) -> dict:
    current = None
    for preferred in ("waiting_human", "rework", "waiting_external",
                      "running", "dispatching", "queued"):
        current = next((x for x in stages if state(x.get("state")) == preferred), None)
        if current is not None:
            break
    if current is None:
        current = next((x for x in reversed(stages) if state(x.get("state")) in _BAD), None)
    if current is None:
        current = next((x for x in reversed(stages) if state(x.get("state")) in _HALTED), None)
    if current is None:
        current = next((x for x in stages if state(x.get("state")) == "planned"), None)
    if current is None:
        current = next((x for x in reversed(stages) if state(x.get("state")) in _SUCCESS), None)
    current_state = state((current or {}).get("state"))
    next_action = {
        "waiting_human": "等待人工确认", "waiting_external": "等待环境返回结果",
        "failed": "处理失败后重试", "blocked": "补齐条件后重试",
        "rework": "按意见返修", "running": "正在执行",
        "dispatching": "正在派发", "queued": "等待执行资源", "succeeded": "已完成",
        "interrupted": "执行已中断，等待处理", "stopped": "执行已停止",
        "cancelled": "执行已取消",
    }.get(current_state, "等待开始")
    return {
        **({"lifecycle": _lifecycle(_lifecycle_task(task, timeline), current or {}, stages)} if task is not None else {}),
        "totalStages": len(stages),
        "completedStages": sum(1 for x in stages if state(x.get("state")) in _SUCCESS),
        "currentStageId": str((current or {}).get("id") or ""),
        "currentStageName": str((current or {}).get("name") or ""),
        "currentState": current_state, "nextAction": next_action,
        "evidenceCount": sum(len(x.get("evidence") or []) for x in stages),
        "coverage": {"sessions": len(sessions), "decisions": len(approvals),
                     "deployments": len(deployments), "artifacts": len(artifacts),
                     "files": len(attachments)},
        "phases": len(phases),
    }
