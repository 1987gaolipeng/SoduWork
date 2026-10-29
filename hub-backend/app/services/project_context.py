"""Durable project context snapshots and reviewable task memory capsules."""
from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..project_context_models import (
    ProjectContextSnapshot,
    ProjectMemoryCapsule,
    TaskContextEnvelope,
)
from . import task_code_targets

_WINDOWS_PATH = re.compile(r"(?i)(?:[a-z]:\\|\\\\)[^\r\n]+")
_UNIX_PATH = re.compile(r"(?<![\w.-])/(?:home|root|Users|opt|srv|var)/[^\r\n]+")
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|token|password|passwd|secret|"
    r"authorization)\b(\s*[:=]\s*)([^\s,;]+)")
_URL_CREDENTIAL = re.compile(r"(https?://)[^/\s:@]+:[^@\s/]+@", re.I)
_BEARER_SECRET = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}")


def _text(value, limit: int = 2400) -> str:
    text = str(value or "").replace("\x00", "").strip()
    text = _URL_CREDENTIAL.sub(r"\1[redacted]@", text)
    text = _SECRET_ASSIGNMENT.sub(
        lambda match: match.group(1) + match.group(2) + "[redacted]", text)
    text = _BEARER_SECRET.sub("Bearer [redacted]", text)
    text = _WINDOWS_PATH.sub("[本机路径已隐藏]", text)
    text = _UNIX_PATH.sub("[本机路径已隐藏]", text)
    return text[:limit]


def _strings(values, limit: int = 40, item_limit: int = 300) -> list[str]:
    out = []
    for value in values or []:
        if isinstance(value, dict):
            value = (value.get("filename") or value.get("name")
                     or value.get("label") or value.get("path") or "")
        item = _text(value, item_limit)
        if item and item not in out:
            out.append(item)
        if len(out) >= limit:
            break
    return out


def _evidence(values, limit: int = 40) -> list[dict]:
    out = []
    allowed = ("kind", "name", "value", "branch", "commit")
    for value in values or []:
        if not isinstance(value, dict):
            continue
        item = {key: _text(value.get(key), 300) for key in allowed
                if value.get(key) not in (None, "")}
        if item and item not in out:
            out.append(item)
        if len(out) >= limit:
            break
    return out

def _capsule_api(row: ProjectMemoryCapsule) -> dict:
    return {
        "id": _text(row.id, 36), "title": _text(row.title, 240),
        "summary": _text(row.summary, 1200),
        "commit": _text(row.commit_sha, 64),
        "branch": _text(row.branch, 180),
        "decisions": _strings(row.decisions, 8, 300),
        "files": _strings(row.files, 40, 260),
        "checks": _strings(row.checks, 12, 300),
        "risks": _strings(row.risks, 12, 300),
        "evidence": _evidence(row.evidence, 40),
        "state": row.state,
    }


async def _scope(session: AsyncSession, task: models.Task, repo=None):
    repo = repo or await task_code_targets.repo_view(session, task)
    project_id = str(task.project_id or getattr(repo, "project_id", "") or "")
    project = await session.get(models.Project, project_id) if project_id else None
    return project, repo


async def attach(session: AsyncSession, extra: dict, task: models.Task,
                 repo=None) -> dict:
    """Attach a portable project descriptor before choosing local or remote execution."""
    out = dict(extra or {})
    from . import org_memory
    # Rebuild at dispatch from the owner's current membership, never trust an
    # organization prompt supplied by an earlier client or queued execution.
    out.pop("organizationMemory", None)
    organization = await org_memory.for_task(session, task)
    if organization.get("prompt"):
        out["organizationMemory"] = organization
    project, repo = await _scope(session, task, repo)
    if project is None and repo is None:
        return out
    project_id = str(getattr(project, "id", "") or getattr(repo, "project_id", "") or "")
    repo_id = str(getattr(repo, "id", "") or "")
    statement = select(ProjectMemoryCapsule).where(
        ProjectMemoryCapsule.project_id == project_id,
        ProjectMemoryCapsule.state == "accepted",
    )
    if repo_id:
        statement = statement.where(or_(
            ProjectMemoryCapsule.repo_id == repo_id,
            ProjectMemoryCapsule.repo_id == ""))
    rows = list((await session.execute(
        statement.order_by(ProjectMemoryCapsule.reviewed_at.desc().nullslast(),
                           ProjectMemoryCapsule.created_at.desc()).limit(6)
    )).scalars().all())
    branch = str(getattr(repo, "merge_branch", "")
                 or getattr(repo, "default_branch", "") or "")
    accepted = [_capsule_api(row) for row in rows]
    out["projectContext"] = {
        "schemaVersion": "project-context.v1",
        "memory": {
            "schemaVersion": "project-memory.v2",
            "scope": {"orgId": str(getattr(project, "org_id", "") or ""),
                      "projectId": project_id, "repoId": repo_id,
                      "baseBranch": branch},
            "policy": "accepted-only; advisory evidence; verify against current worktree",
            "capsules": accepted,
        },
        "orgId": str(getattr(project, "org_id", "") or ""),
        "projectId": project_id, "repoId": repo_id,
        "project": {
            "name": str(getattr(project, "name", "") or ""),
            "description": _text(getattr(project, "desc", ""), 2000),
        },
        "repo": {
            "name": str(getattr(repo, "name", "") or ""),
            "kind": str(getattr(repo, "kind", "") or ""),
            "branch": branch,
            "note": _text(getattr(repo, "note", ""), 2400),
        },
        "task": {
            "id": str(task.id), "title": _text(task.title, 240),
            "note": _text(task.note, 4000),
        },
        "priorCapsules": accepted,
    }
    return out


def _public_report(report: dict) -> dict:
    keys = (
        "schemaVersion", "state", "orgId", "projectId", "projectName",
        "repoId", "repoName", "branch", "baselineCommit", "dirty",
        "fingerprint", "sourceCount", "sources", "conventions", "commands",
        "capsuleCount", "summary", "capturedAt", "error",
        "memorySchemaVersion", "memoryIds", "memoryBranches",
    )
    return {key: report.get(key) for key in keys if key in report}


async def _snapshot(session: AsyncSession, report: dict):
    fingerprint = str(report.get("fingerprint") or "")[:64]
    if not fingerprint:
        return None
    row = (await session.execute(select(ProjectContextSnapshot).where(
        ProjectContextSnapshot.fingerprint == fingerprint
    ).limit(1))).scalar_one_or_none()
    if row is not None:
        return row
    candidate = ProjectContextSnapshot(
        org_id=str(report.get("orgId") or "")[:36],
        project_id=str(report.get("projectId") or "")[:36],
        repo_id=str(report.get("repoId") or "")[:36],
        branch=str(report.get("branch") or "")[:180],
        baseline_commit=str(report.get("baselineCommit") or "")[:64],
        fingerprint=fingerprint,
        state=str(report.get("state") or "partial")[:20],
        summary=_text(report.get("summary"), 2000),
        sources=list(report.get("sources") or [])[:40],
        conventions=_strings(report.get("conventions"), 30),
        commands=_strings(report.get("commands"), 30),
        error=_text(report.get("error"), 500),
    )
    try:
        async with session.begin_nested():
            session.add(candidate)
            await session.flush()
        return candidate
    except IntegrityError:
        return (await session.execute(select(ProjectContextSnapshot).where(
            ProjectContextSnapshot.fingerprint == fingerprint
        ).limit(1))).scalar_one_or_none()


async def record_dispatch(session: AsyncSession, task: models.Task,
                          dispatch: dict, execution_ref: str = "") -> None:
    """Persist the exact context observed by the execution machine."""
    report = dict(dispatch.get("contextReport") or {})
    if not report:
        return
    public = _public_report(report)
    snapshot = await _snapshot(session, public)
    envelope = await session.get(TaskContextEnvelope, str(task.id))
    if envelope is None:
        envelope = TaskContextEnvelope(task_id=str(task.id))
        session.add(envelope)
    envelope.snapshot_id = str(getattr(snapshot, "id", "") or "")
    envelope.project_id = str(public.get("projectId") or task.project_id or "")[:36]
    envelope.repo_id = str(public.get("repoId") or task.repo_id or "")[:36]
    envelope.execution_ref = str(
        execution_ref or dispatch.get("issueId") or dispatch.get("ref") or "")[:180]
    envelope.branch = str(public.get("branch") or "")[:180]
    envelope.baseline_commit = str(public.get("baselineCommit") or "")[:64]
    envelope.fingerprint = str(public.get("fingerprint") or "")[:64]
    envelope.state = str(public.get("state") or "partial")[:20]
    envelope.payload = {
        **public,
        "taskTitle": _text(task.title, 240),
    }


def _guard_check(label: str, value) -> str:
    if not isinstance(value, dict) or not value:
        return ""
    if value.get("ok") is True or value.get("status") in {"passed", "pass", "ok"}:
        return label + "：通过"
    if value.get("enabled") is False:
        return label + "：未启用"
    reason = _text(value.get("reason") or value.get("error"), 180)
    return label + "：需关注" + (("（" + reason + "）") if reason else "")


async def record_completion(session: AsyncSession, task: models.Task, execution,
                            status: dict, receipt: dict | None = None) -> None:
    """Store one compact candidate memory; acceptance remains a task decision."""
    ref = str(getattr(execution, "ref", "") or "")[:180]
    report = dict(status.get("contextReport") or {})
    if report:
        await record_dispatch(
            session, task, {"contextReport": report}, execution_ref=ref)
    envelope = await session.get(TaskContextEnvelope, str(task.id))
    project_id = str(
        getattr(envelope, "project_id", "") or task.project_id or "")
    repo_id = str(getattr(envelope, "repo_id", "") or task.repo_id or "")
    if not project_id:
        return
    if not ref:
        return
    row = (await session.execute(select(ProjectMemoryCapsule).where(
        ProjectMemoryCapsule.task_id == str(task.id),
        ProjectMemoryCapsule.execution_ref == ref,
    ).limit(1))).scalar_one_or_none()
    if row is None:
        row = ProjectMemoryCapsule(task_id=str(task.id), execution_ref=ref)
        session.add(row)
    receipt = dict(receipt or {})
    code = dict(receipt.get("code") or {})
    summary = _text(
        status.get("finalText") or task.result or
        ("执行完成，等待需求验收" if status.get("done") else ""),
        3000)
    files = _strings(status.get("attachments"), 80, 260)
    checks = [
        item for item in (
            _guard_check("工作区边界", status.get("workspaceGuard")),
            _guard_check("执行策略", status.get("executionPolicyGuard")),
        ) if item
    ]
    risks = []
    if status.get("error"):
        risks.append("执行报告：" + _text(status.get("error"), 300))
    if status.get("gitDeliveryPending"):
        risks.append("远端代码提交尚未确认")
    dropped = int(status.get("artifactsDropped") or 0)
    if dropped:
        risks.append(f"{dropped} 项文件未进入逐文件清单")
    missing = _strings(receipt.get("missing"), 40, 200)
    risks.extend("缺少交付：" + item for item in missing)
    commit = str(status.get("gitHead") or code.get("head")
                 or code.get("commit") or "")[:64]
    branch = str(status.get("gitRemoteBranch") or status.get("gitBranch")
                 or getattr(envelope, "branch", "") or "")[:180]
    evidence = [{"kind": "file", "name": name} for name in files[:40]]
    if commit:
        evidence.append({"kind": "commit", "value": commit, "branch": branch})
    terminal_success = bool(status.get("done")) and not bool(status.get("error"))
    accepted = bool(task.status == "done" or task.reviewed_at)
    row.org_id = str(
        dict(getattr(envelope, "payload", None) or {}).get("orgId") or "")[:36]
    row.project_id = project_id[:36]
    row.repo_id = repo_id[:36]
    row.branch = branch
    row.commit_sha = commit
    row.title = _text(task.title, 240)
    row.summary = summary
    row.decisions = []
    row.files = files
    row.checks = checks
    row.risks = _strings(risks, 40)
    row.evidence = evidence
    if row.state != "accepted":
        if not terminal_success:
            row.state = "failed"
        else:
            row.state = "accepted" if accepted else "candidate"
    if row.state == "accepted":
        row.reviewed_at = row.reviewed_at or datetime.now(timezone.utc)


async def accept_task_capsules(session: AsyncSession, task: models.Task,
                               reviewed_by: str = "") -> int:
    rows = list((await session.execute(select(ProjectMemoryCapsule).where(
        ProjectMemoryCapsule.task_id == str(task.id),
        ProjectMemoryCapsule.state == "candidate",
    ))).scalars().all())
    now = datetime.now(timezone.utc)
    for row in rows:
        row.state = "accepted"
        row.reviewed_at = now
        row.reviewed_by = str(reviewed_by or task.reviewed_by or "")[:36]
    return len(rows)


async def task_view(session: AsyncSession, task: models.Task) -> dict:
    """Compact projection shared by task detail, AI work and approval screens."""
    project, repo = await _scope(session, task)
    if project is None and repo is None:
        return {"visible": False}
    envelope = await session.get(TaskContextEnvelope, str(task.id))
    snapshot = None
    if envelope is not None and envelope.snapshot_id:
        snapshot = await session.get(ProjectContextSnapshot, envelope.snapshot_id)
    project_id = str(
        getattr(envelope, "project_id", "")
        or getattr(project, "id", "") or getattr(repo, "project_id", "") or "")
    repo_id = str(
        getattr(envelope, "repo_id", "") or getattr(repo, "id", "") or "")
    count_statement = select(func.count(ProjectMemoryCapsule.id)).where(
        ProjectMemoryCapsule.project_id == project_id,
        ProjectMemoryCapsule.state == "accepted",
    )
    latest_statement = select(ProjectMemoryCapsule).where(
        ProjectMemoryCapsule.project_id == project_id,
        ProjectMemoryCapsule.state == "accepted",
    )
    if repo_id:
        match = or_(ProjectMemoryCapsule.repo_id == repo_id,
                    ProjectMemoryCapsule.repo_id == "")
        count_statement = count_statement.where(match)
        latest_statement = latest_statement.where(match)
    accepted_count = int((await session.execute(count_statement)).scalar() or 0)
    latest = (await session.execute(
        latest_statement.order_by(
            ProjectMemoryCapsule.reviewed_at.desc().nullslast(),
            ProjectMemoryCapsule.created_at.desc()).limit(1)
    )).scalar_one_or_none()
    payload = dict(getattr(envelope, "payload", None) or {})
    sources = list(getattr(snapshot, "sources", None) or payload.get("sources") or [])
    state = str(getattr(envelope, "state", "") or "available")
    labels = {
        "ready": "已就绪", "partial": "基础上下文",
        "failed": "需要关注", "pending": "正在准备",
        "available": "执行时准备",
    }
    return {
        "visible": True, "schemaVersion": "project-context.v1",
        "state": state, "stateLabel": labels.get(state, "执行时准备"),
        "projectId": project_id,
        "projectName": str(getattr(project, "name", "") or payload.get("projectName") or ""),
        "repoId": repo_id,
        "repoName": str(getattr(repo, "name", "") or payload.get("repoName") or ""),
        "branch": str(getattr(envelope, "branch", "") or
                      getattr(repo, "default_branch", "") or ""),
        "baselineCommit": str(getattr(envelope, "baseline_commit", "") or ""),
        "fingerprint": str(getattr(envelope, "fingerprint", "") or ""),
        "summary": str(getattr(snapshot, "summary", "") or payload.get("summary") or ""),
        "sourceCount": len(sources), "sources": sources[:20],
        "conventions": list(getattr(snapshot, "conventions", None) or [])[:20],
        "commands": list(getattr(snapshot, "commands", None) or [])[:20],
        "memoryCount": accepted_count,
        "latestMemory": ({
            "title": latest.title, "summary": latest.summary,
            "commit": latest.commit_sha,
        } if latest is not None else None),
        "dirty": bool(payload.get("dirty")),
        "error": str(getattr(snapshot, "error", "") or payload.get("error") or ""),
        "capturedAt": str(payload.get("capturedAt") or ""),
    }
