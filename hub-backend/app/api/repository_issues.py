"""Scoped admin controls for opt-in repository issue synchronization."""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import require_perm
from ..models import User
from ..services import audit, repository_issue_sync as sync, repository_issue_worker as worker
from ..services.resource_leases import LeaseBusy
from .repositories import _catalog, _scope

router = APIRouter(prefix="/api/v1/admin/repository-catalog", tags=["repository-issues"])


@router.get("/{catalog_id}/issue-sync")
async def get_issue_sync(catalog_id: str, user: User = Depends(require_perm("integration.manage")),
                         session: AsyncSession = Depends(get_session)):
    await _catalog(session, user, catalog_id)
    return await sync.detail(session, catalog_id, await _scope(session, user))


def failure(exc):
    if isinstance(exc, LeaseBusy):
        return HTTPException(423, "该仓库正在同步，请稍后重试")
    # Validation messages originate here; remote exceptions and config secrets
    # never pass through an API response verbatim.
    return HTTPException(409, sync.safe_error(exc))


@router.put("/{catalog_id}/issue-sync")
async def put_issue_sync(catalog_id: str, body: dict = Body(...),
                         user: User = Depends(require_perm("integration.manage")),
                         session: AsyncSession = Depends(get_session)):
    repo = await _catalog(session, user, catalog_id)
    try:
        label = sync.validate_label(body.get("startedLabel", "处理中"), repo.provider)
        if not isinstance(body.get("enabled"), bool):
            raise ValueError("enabled 必须是布尔值")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    try:
        await sync.configure(session, catalog_id, enabled=body["enabled"], started_label=label, user_id=user.id)
    except Exception as exc:
        raise failure(exc) from exc
    await audit.log(session, user, "repository.issue_sync.configure", "repository", catalog_id,
        "Issue 同步", {"enabled": body["enabled"], "startedLabel": label})
    return await sync.detail(session, catalog_id, await _scope(session, user))


@router.post("/{catalog_id}/issue-sync/run")
async def run_issue_sync(catalog_id: str, user: User = Depends(require_perm("integration.manage")),
                         session: AsyncSession = Depends(get_session)):
    await _catalog(session, user, catalog_id)
    try:
        result = await sync.run(session, catalog_id, force=True)
        await worker.writebacks(session, catalog_id)
    except Exception as exc:
        raise failure(exc) from exc
    await audit.log(session, user, "repository.issue_sync.run", "repository", catalog_id,
        "Issue 同步", {"created": result.get("created", 0)})
    result["issueSync"] = (await sync.summaries(session, [catalog_id]))[catalog_id]
    return result


@router.put("/{catalog_id}/issue-sync/members/{external_user_id}")
async def map_issue_member(catalog_id: str, external_user_id: str, body: dict = Body(...),
                           user: User = Depends(require_perm("integration.manage")),
                           session: AsyncSession = Depends(get_session)):
    await _catalog(session, user, catalog_id)
    scope = await _scope(session, user)
    try:
        await sync.map_member(session, catalog_id, external_user_id, str(body.get("userId") or "") or None, scope)
    except Exception as exc:
        raise failure(exc) from exc
    await audit.log(session, user, "repository.issue_sync.member", "repository", catalog_id,
        "Issue 成员关联", {"externalUserId": external_user_id, "userId": body.get("userId")})
    return await sync.detail(session, catalog_id, scope)
