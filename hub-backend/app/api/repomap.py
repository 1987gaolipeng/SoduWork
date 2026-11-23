"""Public module behavior and service contracts."""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import require_perm
from ..models import Integration, Project, Repo, RepoBinding, Task, User
from ..services import audit, rbac
from ..services.business_records import business_visible

router = APIRouter(prefix="/api/v1/admin", tags=["repo-map"])


def _tasks_in_scope(scope: set[str] | None):
    query = select(Task)
    if scope is None:
        return query

    # Use the account recorded on the task. A device can change accounts later.
    query = (query.join(Integration, Integration.id == Task.integration_id)
             .outerjoin(Project, Project.id == Task.project_id)
             .outerjoin(User, User.id == Task.owner_user_id))
    orgs = (Task.shared_org_id, Task.pool_org_id, Project.org_id, User.org_id)
    # A newly imported issue can still have only its source integration as evidence.
    source_org = Integration.config["orgId"].as_string()
    source_only = and_(source_org.in_(scope), *(
        or_(column.is_(None), column == "")
        for column in (Task.project_id, Task.owner_user_id, Task.owner_client_id, Task.shared_org_id, Task.pool_org_id)
    ))
    return query.where(
        or_(source_org.is_(None), source_org == "", source_org.in_(scope)),
        or_(*(org.in_(scope) for org in orgs), source_only),
        *(or_(org.is_(None), org == "", org.in_(scope)) for org in orgs),
        or_(Task.project_id.is_(None), Task.project_id == "", Project.id.is_not(None)),
        or_(Task.owner_user_id.is_(None), Task.owner_user_id == "", User.id.is_not(None)),
    )


async def _repo_in_scope(session: AsyncSession, scope: set[str] | None, repo: Repo | None) -> bool:
    if scope is None:
        return True
    if repo is None:
        return False
    if repo.org_id and repo.org_id not in scope:
        return False
    project = await session.get(Project, repo.project_id)
    return project is not None and (project.org_id is None or project.org_id in scope)


async def _assert_repo_scope(session: AsyncSession, scope: set[str] | None, repo: Repo | None) -> None:
    if not await _repo_in_scope(session, scope, repo):
        raise HTTPException(status_code=403, detail="无权管理该工程")


def _api(b: RepoBinding, repo: Repo | None = None) -> dict:
    return {"id": b.id, "integrationId": b.integration_id, "externalRepo": b.external_repo,
            "repoId": b.repo_id, "note": b.note or "",
            "repoName": (repo.name if repo else ""), "projectId": (repo.project_id if repo else "")}


@router.get("/repo-bindings")
async def list_bindings(
    integrationId: str | None = None,
    user: User = Depends(require_perm("binding.manage")),
    session: AsyncSession = Depends(get_session),
):
    scope = await rbac.scope_org_ids(session, user)
    q = select(RepoBinding)
    if integrationId:
        q = q.where(RepoBinding.integration_id == integrationId)
    rows = (await session.execute(q)).scalars().all()
    out = []
    for b in rows:
        repo = await session.get(Repo, b.repo_id)
        if repo is not None and await _repo_in_scope(session, scope, repo):
            out.append(_api(b, repo))
    return {"items": out}


@router.post("/repo-bindings")
async def upsert_binding(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("binding.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Upsert one mapping per integration and external_repo; repeated submissions update its target
    idempotently.
    """
    iid = str(body.get("integrationId") or "").strip()
    ext = str(body.get("externalRepo") or "").strip()
    rid = str(body.get("repoId") or "").strip()
    if not (iid and ext and rid):
        raise HTTPException(status_code=400, detail="集成、平台工程标识、SoduWork 工程三样都要给")
    await rbac.lock_org_tree(session, shared=True)
    scope = await rbac.scope_org_ids(session, user)
    integration = await session.get(Integration, iid, with_for_update=True)
    if integration is None:
        raise HTTPException(status_code=404, detail="集成不存在")
    owner = (integration.config or {}).get("orgId")
    if scope is not None and owner not in (None, "") and (not isinstance(owner, str) or owner not in scope):
        raise HTTPException(status_code=403, detail="无权管理该集成")
    bindings = await session.scalars(
        select(RepoBinding).where(RepoBinding.integration_id == iid).order_by(RepoBinding.id).with_for_update())
    b = next((row for row in bindings if (row.external_repo or "").strip().lower() == ext.lower()), None)
    # Lock the binding first, as deletion does, then its old and new repositories in order.
    repo_ids = {rid, b.repo_id} if b else {rid}
    targets = await session.scalars(select(Repo).where(Repo.id.in_(repo_ids)).order_by(Repo.id).with_for_update())
    repos = {row.id: row for row in targets}
    repo = repos.get(rid)
    if repo is None:
        raise HTTPException(status_code=404, detail="SoduWork 这边没有这个工程")
    await _assert_repo_scope(session, scope, repo)
    if b is None:
        b = RepoBinding(integration_id=iid, external_repo=ext, repo_id=rid,
                        note=str(body.get("note") or "")[:200])
        session.add(b)
    else:
        if b.repo_id != rid:
            await _assert_repo_scope(session, scope, repos.get(b.repo_id))
        b.repo_id = rid
        b.note = str(body.get("note") or b.note or "")[:200]
    # Apply new mappings to existing unmapped issues as well as future imports.
    # Otherwise configuring a mapping would leave previously blocked issues unresolved.
    # Fill only missing ownership; preserve manual assignments.
    rows = (await session.execute(
        _tasks_in_scope(scope).where(Task.integration_id == iid).with_for_update(of=Task))).scalars().all()
    fixed = 0
    for t in rows:
        if (getattr(t, "repo_id", "") or "").strip():
            continue
        if (getattr(t, "ext_repo", "") or "").strip().lower() != ext.lower():
            continue
        t.repo_id = rid
        if not t.project_id:
            t.project_id = repo.project_id
        fixed += 1
    await session.commit()
    await session.refresh(b)
    await audit.log(session, user, "repo_binding.upsert", "repo_binding", b.id,
                    ext, {"integrationId": iid, "repoId": rid,
                          "backfilled": fixed})
    return {**_api(b, repo), "backfilled": fixed}


@router.delete("/repo-bindings/{bid}")
async def delete_binding(
    bid: str,
    user: User = Depends(require_perm("binding.manage")),
    session: AsyncSession = Depends(get_session),
):
    await rbac.lock_org_tree(session, shared=True)
    scope = await rbac.scope_org_ids(session, user)
    b = await session.get(RepoBinding, bid, with_for_update=True)
    if b is None:
        return {"ok": False, "reason": "not_found"}
    repo = await session.get(Repo, b.repo_id, with_for_update=True)
    await _assert_repo_scope(session, scope, repo)
    external_repo = b.external_repo
    integration_id = b.integration_id
    repo_id = b.repo_id
    await session.delete(b)
    await session.commit()
    await audit.log(session, user, "repo_binding.delete", "repo_binding", bid,
                    external_repo, {"integrationId": integration_id,
                                    "repoId": repo_id})
    return {"ok": True}


@router.get("/repo-bindings/pending")
async def pending(
    user: User = Depends(require_perm("binding.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Group imported issues with unmapped repositories by external repository ID and include
    sample titles for configuration.
    """
    scope = await rbac.scope_org_ids(session, user)
    rows = (await session.execute(
        _tasks_in_scope(scope).where(Task.integration_id.is_not(None), Task.status.in_(("todo", "doing"))))).scalars().all()
    stuck = [t for t in rows
             if not (getattr(t, "repo_id", "") or "").strip()
             and (getattr(t, "ext_repo", "") or "").strip()]
    groups: dict[tuple[str, str], dict] = {}
    for t in stuck:
        key = (t.integration_id or "", (t.ext_repo or "").strip())
        g = groups.setdefault(key, {"integrationId": key[0], "externalRepo": key[1],
                                    "count": 0, "samples": []})
        g["count"] += 1
        if len(g["samples"]) < 3:
            g["samples"].append({"id": t.id, "title": t.title})
    # Include available SoduWork repositories so the mapping form needs no additional request.
    available_projects = select(Project.id).where(business_visible(Project))
    repos = (await session.execute(select(Repo).where(
        business_visible(Repo), Repo.project_id.is_(None) | Repo.project_id.in_(available_projects)))).scalars().all()
    visible_repos = [repo for repo in repos
                     if await _repo_in_scope(session, scope, repo)]
    return {"items": sorted(groups.values(), key=lambda x: -x["count"]), "total": len(stuck),
            "repos": [{"id": r.id, "name": r.name, "projectId": r.project_id,
                       "ready": bool((r.server_dir or "").strip() and (r.merge_branch or "").strip())}
                      for r in visible_repos]}


@router.get("/autobatch")
async def autobatch_preview(
    run: bool = False,
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Preview automatic task batches and their routing reasons. Dispatch requires both run=true
    and AUTOBATCH_ENABLED=true.
    """
    from ..config import get_settings
    from ..services import autobatch
    # Require both the request flag and the global automatic-batching switch.
    # The endpoint must not bypass the global switch.
    dry = not (run and bool(get_settings().autobatch_enabled))
    out = await autobatch.run_once(session, dry=dry)
    if run and dry:
        out["note"] = "总开关没开（AUTOBATCH_ENABLED=false），这次只是预览"
    return out
