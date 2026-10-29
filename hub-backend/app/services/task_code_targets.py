"""Immutable repository/branch snapshot for an engineering task."""
from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models


def _payload(task: models.Task, repo: models.Repo) -> dict:
    return {
        "taskId": str(task.id),
        "projectId": str(task.project_id or repo.project_id or ""),
        "repoId": str(repo.id),
        "sourceRepositoryId": str(getattr(repo, "source_repository_id", "") or ""),
        "repoName": str(repo.name or ""),
        "kind": str(repo.kind or "other"),
        "scm": str(getattr(repo, "scm", "") or "git"),
        "gitUrl": str(repo.git_url or ""),
        "baseBranch": str(repo.default_branch or "main"),
        "targetBranch": str(repo.merge_branch or repo.default_branch or "main"),
        "localDir": str(repo.local_dir or ""),
        "serverDir": str(repo.server_dir or ""),
        "aiWorkDir": str(repo.ai_work_dir or ""),
        "gerritBase": str(getattr(repo, "gerrit_base", "") or ""),
        "devFlow": dict(getattr(repo, "dev_flow", None) or {}),
        "routeKeywords": list(getattr(repo, "route_keywords", None) or []),
        "routeLayer": str(getattr(repo, "route_layer", "") or ""),
        "routePriority": int(getattr(repo, "route_priority", 0) or 0),
    }


def _fingerprint(payload: dict) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


async def get(session: AsyncSession, task_id: str) -> am.TaskCodeTarget | None:
    return (await session.execute(select(am.TaskCodeTarget).where(
        am.TaskCodeTarget.task_id == str(task_id)))).scalar_one_or_none()


async def freeze(session: AsyncSession, task: models.Task,
                 repo: models.Repo | None) -> am.TaskCodeTarget | None:
    from . import scm_support
    scm_support.require_active(repo)
    current = await get(session, task.id)
    if current is not None:
        scm_support.require_active(current)
        if repo is not None and current.repo_id != repo.id:
            raise ValueError("this task already targets another repository")
        return current
    if repo is None:
        return None
    payload = _payload(task, repo)
    row = am.TaskCodeTarget(
        task_id=task.id, project_id=payload["projectId"],
        repo_id=payload["repoId"],
        source_repository_id=payload["sourceRepositoryId"],
        repo_name=payload["repoName"], scm=payload["scm"],
        git_url=payload["gitUrl"], base_branch=payload["baseBranch"],
        target_branch=payload["targetBranch"], local_dir=payload["localDir"],
        config_snapshot=payload, fingerprint=_fingerprint(payload))
    session.add(row)
    await session.flush()
    return row


async def repo_view(session: AsyncSession, task: models.Task,
                    live: models.Repo | None = None):
    """Return a repo-shaped object whose execution-critical fields are frozen."""
    target = await get(session, task.id)
    if target is None:
        if live is not None:
            return live
        return await session.get(models.Repo, task.repo_id) if task.repo_id else None
    source = live or await session.get(models.Repo, target.repo_id)
    data = {
        column.key: getattr(source, column.key)
        for column in models.Repo.__table__.columns
    } if source is not None else {}
    cfg = dict(target.config_snapshot or {})
    data.update({
        "id": target.repo_id,
        "project_id": target.project_id,
        "source_repository_id": target.source_repository_id,
        "name": target.repo_name,
        "kind": cfg.get("kind") or data.get("kind") or "other",
        "scm": target.scm,
        "git_url": target.git_url,
        "default_branch": target.base_branch,
        "merge_branch": target.target_branch,
        "local_dir": target.local_dir,
        "server_dir": cfg.get("serverDir") or "",
        "ai_work_dir": cfg.get("aiWorkDir") or "",
        "gerrit_base": cfg.get("gerritBase") or "",
        "dev_flow": dict(cfg.get("devFlow") or {}),
        "route_keywords": list(cfg.get("routeKeywords") or []),
        "route_layer": cfg.get("routeLayer") or "",
        "route_priority": int(cfg.get("routePriority") or 0),
    })
    return SimpleNamespace(**data)


def api(row: am.TaskCodeTarget | None) -> dict:
    if row is None:
        return {}
    return {
        "id": row.id, "taskId": row.task_id, "projectId": row.project_id,
        "repoId": row.repo_id, "sourceRepositoryId": row.source_repository_id,
        "repoName": row.repo_name, "scm": row.scm, "gitUrl": row.git_url,
        "baseBranch": row.base_branch, "targetBranch": row.target_branch,
        "localDir": row.local_dir, "fingerprint": row.fingerprint,
        "capturedAt": row.captured_at.isoformat() if row.captured_at else None,
    }
