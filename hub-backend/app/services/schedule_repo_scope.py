"""Authorize schedule repositories through the owner's existing task catalog."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from .. import models


async def resolve_repo(session: AsyncSession, schedule, *,
                       org_ids: set[str] | None = None,
                       client: models.Client | None = None) -> models.Repo | None:
    """Admin scope restricts, and never replaces, the execution owner's scope."""
    repo_id = str(getattr(schedule, "repo_id", "") or "")
    if not repo_id:
        return None
    repo = await session.get(models.Repo, repo_id)
    if repo is None:
        raise ValueError("选择的工程已经不存在")
    if client is None:
        client_id = str(getattr(schedule, "owner_client_id", "") or "")
        client = await session.get(models.Client, client_id) if client_id else None
    if client is None:
        raise ValueError("请先选择任务归属的 SoduWork")

    from .task_execution_options import _visible_repos

    _owner, visible = await _visible_repos(session, client)
    if not any(str(item["id"]) == repo_id for item in visible):
        raise ValueError("选择的工程已不可用或不在任务归属人的可见范围内")
    if org_ids is not None:
        project = await session.get(models.Project, repo.project_id)
        if any(org_id is not None and org_id not in org_ids for org_id in (
                repo.org_id, project.org_id if project else None)):
            raise ValueError("选择的工程不在你的组织范围内")
    return repo
