"""Node-specific input and output contracts. Repository association selects default workspace,
while each node declares file, Git, or evidence delivery independently.
"""
from __future__ import annotations

import os
import re


OUTPUT_KINDS = {"file", "git", "evidence", "url", "decision"}
_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
# escalation means automation cannot decide and requires human judgment.
# Treat it as terminal rather than repeating the same computation.
_TERMINAL_FAILURES = {"contract", "configuration", "authorization", "escalation"}
# Failure categories are independent of the two recovery mechanisms:
# _TERMINAL_FAILURES determines whether retrying the same node can help;
# this list determines whether rewinding business nodes through onFailure.retryFrom can help.
# Contract failures can be repaired by redoing upstream work and are therefore excluded.
# Configuration and authorization failures need configuration or permission changes; infrastructure failures need runtime or transport repair.
# Rewriting code cannot address these causes and would needlessly rerun upstream work.
# For example, a missing deployment target must not trigger another implementation attempt.
# Escalation likewise requests human judgment rather than another code rewrite.
# Keep that human-intervention path explicit in otherwise automated workflows.
_REWORK_FORBIDDEN = {"configuration", "authorization", "infrastructure", "escalation"}

# Map AI outcome=blocked reasonCode values to failure categories; the engine and tests share this definition.

# no_reproducible_issue, unsafe_change, and other require human judgment.
# The AI nextAction already requests review; suggesting configuration changes would not resolve these cases.
_BLOCKED_KINDS = {
    "missing_credentials": "authorization",
    "missing_toolchain": "configuration",
    "missing_input": "configuration",
}


def blocked_failure_kind(reason_code: str) -> str:
    return _BLOCKED_KINDS.get(str(reason_code or "").strip(), "escalation")


class WorkflowContractError(ValueError):
    """Configuration or upstream output violates the workflow contract; an unchanged retry will not
    repair it.
    """

    failure_kind = "contract"


class WorkflowConfigurationError(WorkflowContractError):
    """Required environment or deployment infrastructure configuration is missing or unavailable;
    repair configuration rather than rerunning business work.
    """

    failure_kind = "configuration"


def _safe_path(value: object, node_key: str) -> str:
    path = str(value or "").strip().replace("\\", "/").lstrip("/")[:300]
    parts = path.split("/") if path else []
    if not path or os.path.isabs(path) or any(x in ("", ".", "..") for x in parts):
        raise WorkflowContractError(f"节点 {node_key} 的文件产出路径不合法")
    return path


def normalize_outputs(value: object, node_key: str) -> list[dict]:
    """Normalize plugin output declarations into a stable executable schema."""
    if value in (None, []):
        return []
    if not isinstance(value, list) or len(value) > 20:
        raise WorkflowContractError(f"节点 {node_key} 的产出声明必须是至多 20 项的列表")
    out, keys = [], set()
    decision_count = 0
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise WorkflowContractError(f"节点 {node_key} 的第 {index + 1} 项产出声明不合法")
        kind = str(raw.get("kind") or "file").strip().lower()
        key = str(raw.get("key") or f"output_{index + 1}").strip()[:64]
        if kind not in OUTPUT_KINDS:
            raise WorkflowContractError(f"节点 {node_key} 不支持产出类型：{kind}")
        if kind == "decision":
            decision_count += 1
            if decision_count > 1:
                raise WorkflowContractError(f"节点 {node_key} 只能声明一项节点决策")
        if not _KEY.fullmatch(key) or key in keys:
            raise WorkflowContractError(f"节点 {node_key} 的产出 key 不合法或重复：{key}")
        item = {
            "key": key,
            "kind": kind,
            "label": str(raw.get("label") or key).strip()[:100],
            "required": bool(raw.get("required", True)),
        }
        if kind in {"file", "decision"}:
            item["path"] = _safe_path(raw.get("path"), node_key)
        out.append(item)
        keys.add(key)
    return out


def normalize_inputs(value: object, node_key: str, depends_on: list[str],
                     outputs_by_node: dict[str, list[dict]]) -> list[dict]:
    """Normalize explicit cross-node references; hidden prompt coupling is not allowed."""
    if value in (None, []):
        return []
    if not isinstance(value, list) or len(value) > 40:
        raise WorkflowContractError(f"节点 {node_key} 的输入引用必须是至多 40 项的列表")
    direct = set(depends_on or [])
    out, keys = [], set()
    for index, raw in enumerate(value):
        if isinstance(raw, str):
            parts = raw.strip().split(".", 1)
            raw = {"fromNode": parts[0], "outputKey": parts[1]} if len(parts) == 2 else {}
        if not isinstance(raw, dict):
            raise WorkflowContractError(
                f"节点 {node_key} 的第 {index + 1} 项输入引用不合法")
        source = str(raw.get("fromNode") or raw.get("node") or "").strip()[:64]
        output_key = str(raw.get("outputKey") or raw.get("output") or "").strip()[:64]
        key = str(raw.get("key") or output_key or f"input_{index + 1}").strip()[:64]
        if not _KEY.fullmatch(key) or key in keys:
            raise WorkflowContractError(
                f"节点 {node_key} 的输入 key 不合法或重复：{key}")
        if source not in direct:
            raise WorkflowContractError(
                f"节点 {node_key} 的输入 {key} 必须引用直接上游节点")
        declared = {str(item.get("key") or ""): item
                    for item in outputs_by_node.get(source, [])}
        if output_key not in declared:
            raise WorkflowContractError(
                f"节点 {node_key} 的输入 {key} 引用了 {source} 未声明的产出：{output_key}")
        out.append({
            "key": key, "fromNode": source, "outputKey": output_key,
            "label": str(raw.get("label") or key).strip()[:100],
            "required": bool(raw.get("required", True)),
        })
        keys.add(key)
    return out

def outputs_of(node: dict | None) -> list[dict]:
    return [dict(x) for x in ((node or {}).get("outputs") or []) if isinstance(x, dict)]


def delivery_mode(node: dict | None, has_repo: bool) -> str:
    """Tell the executor whether this node must return files, Git evidence, or both."""
    kinds = {x.get("kind") for x in outputs_of(node) if x.get("required", True)}
    wants_files = bool(kinds.intersection({"file", "evidence", "url", "decision"}))
    wants_git = "git" in kinds
    if wants_files and wants_git:
        return "mixed"
    if wants_files:
        return "files"
    if wants_git:
        return "git"
    return "git" if has_repo else "files"


def dependency_keys(workflow: dict | None, node: dict | None) -> list[str]:
    """Return the transitive upstream nodes in workflow order.

    A task may carry repository context even when a particular workflow only
    produces a document or prototype. Review semantics therefore follow the
    node graph and its declared outputs, never ``Task.repo_id``.
    """
    nodes = [dict(item) for item in dict(workflow or {}).get("nodes") or []
             if isinstance(item, dict)]
    by_key = {str(item.get("key") or ""): item for item in nodes}
    pending = [str(key or "") for key in dict(node or {}).get("dependsOn") or []]
    found: set[str] = set()
    while pending:
        key = pending.pop()
        if not key or key in found:
            continue
        found.add(key)
        parent = by_key.get(key) or {}
        pending.extend(str(value or "") for value in parent.get("dependsOn") or [])
    return [str(item.get("key") or "") for item in nodes
            if str(item.get("key") or "") in found]


def review_requires_code(workflow: dict | None, node: dict | None) -> bool:
    """Whether a human gate is reviewing an immutable code version."""
    definition = dict(node or {})
    config = dict(definition.get("config") or {})
    if "requireCodeVersion" in config:
        return bool(config.get("requireCodeVersion"))
    artifact_kind = str(config.get("artifactKind") or "").strip().lower()
    if artifact_kind:
        return artifact_kind == "code"
    if str(config.get("action") or "").strip().lower() in {"merge", "deploy"}:
        return True

    nodes = [dict(item) for item in dict(workflow or {}).get("nodes") or []
             if isinstance(item, dict)]
    upstream = set(dependency_keys(workflow, definition))
    for item in nodes:
        if str(item.get("key") or "") not in upstream:
            continue
        if str(item.get("type") or "") in {
                "quality", "script", "merge", "deploy", "deploy_chain"}:
            return True
        if any(str(output.get("kind") or "").lower() == "git"
               for output in outputs_of(item)):
            return True
    return False


def ai_review_requires_code(workflow: dict | None, node: dict | None) -> bool:
    """Review the declared deliverable, not the task's incidental repository.

    Explicit Gerrit voting, code-review.json and legacy untyped review nodes keep
    their strict code-version contract. File/decision workflows can be reviewed
    independently without manufacturing a Git commit.
    """
    definition = dict(node or {})
    outputs = outputs_of(definition)
    if str(dict(definition.get('config') or {}).get('mode') or '').lower() == 'auto':
        return True
    if any(str(item.get('path') or '').replace('\\', '/').rsplit('/', 1)[-1]
           == 'code-review.json' for item in outputs):
        return True
    if review_requires_code(workflow, definition):
        return True
    return not outputs and not definition.get('inputs')


def decision_prompt(node: dict | None) -> str:
    decisions = [item for item in outputs_of(node) if item.get('kind') == 'decision']
    if not decisions:
        return ''
    paths = '、'.join(str(item.get('path') or '') for item in decisions)
    return (
        '【机器可校验的节点结论】\n'
        f'将结论写入 {paths}，内容必须是单个 UTF-8 JSON 对象；'
        '即使历史声明使用 .md 后缀也遵循这个 decision 类型协议，不写 Markdown 或代码围栏。\n'
        '字段：schemaVersion=1，outcome="proceed" 或 "blocked"，summary=真实复核结论，'
        'reasonCode="ready"（通过）或 "missing_input"/"unsafe_change"/"other"（阻断），'
        'evidence=依据字符串数组，nextAction=阻断时必须说明如何修正。'
        '未知、无法读取或未达到标准必须 blocked，不得为推进流程伪造通过。'
    )


def evaluate(node: dict | None, status: dict, receipt: dict) -> dict:
    """Compare actual receipts with declared outputs for evidence validation and recovery
    decisions.
    """
    from . import delivery_manifest

    declared = outputs_of(node)
    received = {str(x).replace("\\", "/").lstrip("/")
                for x in (receipt.get("received") or []) if x}
    # New receipts distinguish received, valid bytes, and deliverable status; interpret older receipts through compatible filename rules.
    valid = ({str(x).replace("\\", "/").lstrip("/") for x in receipt.get("valid") or [] if x}
             if "valid" in receipt else set(received))
    deliverables = ({str(x).replace("\\", "/").lstrip("/")
                     for x in receipt.get("deliverables") or [] if x}
                    if "deliverables" in receipt else
                    {x for x in received if delivery_manifest.is_deliverable_name(x)})
    evidence = {str(x).replace("\\", "/").lstrip("/")
                for x in receipt.get("evidence") or [] if x}
    usable = deliverables | evidence
    git_head = str(status.get("gitHead") or "")
    git_branch = str(status.get("gitBranch") or "")
    url = str(status.get("artifactUrl") or "")
    final_text = str(status.get("finalText") or "").strip()[:20000]
    items, missing = [], []
    for spec in declared:
        kind, required = str(spec.get("kind") or ""), bool(spec.get("required", True))
        ok, value = True, ""
        if kind in {"file", "decision"}:
            value = str(spec.get("path") or "")
            ok = value in valid
        elif kind == "git":
            value = git_head or git_branch
            ok = bool(git_head)
        elif kind == "url":
            value, ok = url, bool(url)
        elif kind == "evidence":
            # Evidence is intentionally polymorphic: an office answer may be text, a
            # document task may return files, and a runnable result may return a URL.
            # File/decision contracts remain strict and cannot be satisfied by text.
            value = "text" if final_text and not (usable or url) else str(len(usable))
            ok = bool(usable or url or final_text)
        if required and not ok:
            missing.append(str(spec.get("label") or spec.get("key") or kind))
        items.append({**spec, "ok": ok, "value": value})
    return {"declared": items, "missing": missing, "received": sorted(received),
            "valid": sorted(valid), "deliverables": sorted(deliverables),
            "evidence": sorted(evidence),
            "invalid": list(receipt.get("invalid") or [])[:100],
            "ignored": sorted({str(x) for x in (receipt.get("ignored") or []) if x}),
            "text": final_text,
            "gitBranch": git_branch, "gitHead": git_head, "artifactUrl": url}


def failure_output(kind: str, **detail) -> dict:
    return {"failureKind": str(kind or "")[:40], **detail}


def terminal_failure(output: dict | None) -> bool:
    return str(dict(output or {}).get("failureKind") or "") in _TERMINAL_FAILURES


def rework_forbidden(output: dict | None) -> bool:
    """Check whether this failure forbids onFailure or onReject business-node rework."""
    return str(dict(output or {}).get("failureKind") or "") in _REWORK_FORBIDDEN
