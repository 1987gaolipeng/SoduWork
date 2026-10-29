"""Admin API for repository discovery and project-specific branch mappings."""
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from ..db import get_session
from ..deps import require_perm
from ..models import User
from ..services import audit, rbac, repository_catalog as catalog
from ..services.resource_leases import LeaseBusy as resource_busy

router = APIRouter(prefix="/api/v1/admin", tags=["repository-catalog"])


def _conflict(exc: Exception) -> HTTPException:
    return HTTPException(status_code=409, detail=str(exc))


async def _scope(session: AsyncSession, user: User) -> set[str] | None:
    return await rbac.scope_org_ids(session, user)


async def _project(session: AsyncSession, user: User, project_id: str) -> models.Project:
    row = await session.get(models.Project, project_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    scope = await _scope(session, user)
    if scope is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="Project is outside your organization scope")
    return row


async def _repo(session: AsyncSession, user: User, repo_id: str) -> models.Repo:
    row = await session.get(models.Repo, repo_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Repository mapping not found")
    scope = await _scope(session, user)
    if scope is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="Repository mapping is outside your organization scope")
    return row


async def _catalog(session: AsyncSession, user: User,
                   catalog_id: str) -> am.ScmRepository:
    row = await session.get(am.ScmRepository, catalog_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Repository catalog item not found")
    scope = await _scope(session, user)
    if scope is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="Repository catalog item is outside your organization scope")
    return row


async def _client_in_scope(session: AsyncSession, user: User, client_id: str) -> None:
    if not client_id or user.is_super:
        return
    client = await session.get(models.Client, client_id)
    if client is None or not client.user_ref:
        raise HTTPException(status_code=403, detail="The selected SoduWork code account is not in your organization")
    owner = await session.get(models.User, client.user_ref)
    scope = await _scope(session, user)
    if owner is None or scope is not None and owner.org_id not in scope:
        raise HTTPException(status_code=403, detail="The selected SoduWork code account is not in your organization")


@router.get("/repository-catalog")
async def list_repository_catalog(
    integrationId: str = "", search: str = "", includeInactive: bool = False,
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    return {"items": await catalog.list_catalog(
        session, scope=await _scope(session, user),
        integration_id=integrationId, search=search,
        include_inactive=includeInactive)}


@router.post("/integrations/{integration_id}/repositories/sync")
async def sync_repositories(
    integration_id: str, body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    client_id = str(body.get("clientId") or "")
    await _client_in_scope(session, user, client_id)
    try:
        result = await catalog.sync_integration(session, integration_id,
                                                client_id=client_id)
    except resource_busy as exc:
        raise HTTPException(status_code=423, detail="Repository synchronization is already running") from exc
    except Exception as exc:
        raise _conflict(exc) from exc
    await audit.log(session, user, "repository.sync", "integration",
                    integration_id, "repository catalog", result)
    return result


@router.post("/integrations/{integration_id}/pull-account")
async def save_pull_account(
    integration_id: str, body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Store the source's backend pull credentials: username and password or token."""
    try:
        await catalog.set_pull_account(
            session, integration_id,
            user=str(body.get("user") or ""), secret=body.get("secret"),
            kind=str(body.get("kind") or "") if "kind" in body else None,
            org_id=str(body.get("orgId") or ""))
    except ValueError as exc:
        raise _conflict(exc) from exc
    await audit.log(session, user, "repository.pull_account", "integration",
                    integration_id, "repository pull account",
                    {"user": str(body.get("user") or "")})
    return {"ok": True}


@router.post("/integrations/{integration_id}/pull-account/test")
async def test_pull_account(
    integration_id: str, body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("integration.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Test the pending account edits, retaining stored fields omitted by the form."""
    override = {key: body[key] for key in ("user", "secret", "kind") if key in body} or None
    try:
        return await catalog.verify_pull_account(session, integration_id, override=override)
    except ValueError as exc:
        return {"ok": False, "detail": str(exc)}


@router.get("/repository-catalog/{catalog_id}/branches")
async def list_repository_branches(
    catalog_id: str, clientId: str = Query(default=""),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    await _client_in_scope(session, user, clientId)
    row = await _catalog(session, user, catalog_id)
    try:
        values = await catalog.branches(session, row, client_id=clientId)
    except Exception as exc:
        raise _conflict(exc) from exc
    return {"items": values, "default": row.default_branch}


@router.post("/projects/{project_id}/repos/from-catalog")
async def create_repo_mapping(
    project_id: str, body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    project = await _project(session, user, project_id)
    row = await _catalog(session, user, str(body.get("catalogId") or ""))
    try:
        repo = await catalog.create_mapping(session, project, row, body)
    except resource_busy as exc:
        raise HTTPException(status_code=423, detail="This repository mapping is being updated") from exc
    except ValueError as exc:
        raise _conflict(exc) from exc
    await audit.log(session, user, "repository.mapping.create", "repo",
                    repo.id, repo.name, {"projectId": project.id,
                                        "branch": repo.default_branch})
    return {"id": repo.id, "projectId": repo.project_id,
            "sourceRepositoryId": repo.source_repository_id,
            "name": repo.name, "gitUrl": repo.git_url,
            "branch": repo.default_branch, "mergeBranch": repo.merge_branch,
            "localDir": repo.local_dir, "scm": repo.scm}


@router.post("/repos/{repo_id}/copy")
async def copy_repo_mapping(
    repo_id: str, body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    source = await _repo(session, user, repo_id)
    target = await _project(session, user, str(body.get("projectId") or ""))
    try:
        repo = await catalog.copy_mapping(session, source, target, body)
    except resource_busy as exc:
        raise HTTPException(status_code=423, detail="This repository mapping is being updated") from exc
    except ValueError as exc:
        raise _conflict(exc) from exc
    await audit.log(session, user, "repository.mapping.copy", "repo",
                    repo.id, repo.name, {"sourceRepoId": source.id,
                                        "projectId": target.id,
                                        "branch": repo.default_branch})
    return {"id": repo.id, "projectId": repo.project_id,
            "sourceRepositoryId": repo.source_repository_id,
            "name": repo.name, "gitUrl": repo.git_url,
            "branch": repo.default_branch, "mergeBranch": repo.merge_branch,
            "localDir": repo.local_dir, "scm": repo.scm}
