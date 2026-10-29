"""Public module behavior and service contracts."""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import require_perm
from ..models import Integration, Repo, RepoBinding, Task, User
from ..services import audit, rbac

router = APIRouter(prefix="/api/v1/admin", tags=["repo-map"])


async def _repo_in_scope(session: AsyncSession, user: User, repo: Repo) -> bool:
    scope = await rbac.scope_org_ids(session, user)
    return scope is None or repo.org_id is None or repo.org_id in scope


async def _assert_repo_scope(session: AsyncSession, user: User, repo: Repo) -> None:
    if not await _repo_in_scope(session, user, repo):
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
    q = select(RepoBinding)
    if integrationId:
        q = q.where(RepoBinding.integration_id == integrationId)
    rows = (await session.execute(q)).scalars().all()
    out = []
    for b in rows:
        repo = await session.get(Repo, b.repo_id)
        if repo is not None and await _repo_in_scope(session, user, repo):
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
    if await session.get(Integration, iid) is None:
        raise HTTPException(status_code=404, detail="集成不存在")
    repo = await session.get(Repo, rid)
    if repo is None:
        raise HTTPException(status_code=404, detail="SoduWork 这边没有这个工程")
    await _assert_repo_scope(session, user, repo)
    rows = (await session.execute(
        select(RepoBinding).where(RepoBinding.integration_id == iid))).scalars().all()
    b = next((x for x in rows if (x.external_repo or "").strip().lower() == ext.lower()), None)
    if b is None:
        b = RepoBinding(integration_id=iid, external_repo=ext, repo_id=rid,
                        note=str(body.get("note") or "")[:200])
        session.add(b)
    else:
        b.repo_id = rid
        b.note = str(body.get("note") or b.note or "")[:200]
    # Apply new mappings to existing unmapped issues as well as future imports.
    # Otherwise configuring a mapping would leave previously blocked issues unresolved.
    # Fill only missing ownership; preserve manual assignments.
    rows = (await session.execute(
        select(Task).where(Task.integration_id == iid))).scalars().all()
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
    b = await session.get(RepoBinding, bid)
    if b is None:
        return {"ok": False, "reason": "not_found"}
    repo = await session.get(Repo, b.repo_id)
    if repo is not None:
        await _assert_repo_scope(session, user, repo)
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
    rows = (await session.execute(
        select(Task).where(Task.integration_id.is_not(None),
                           Task.status.in_(("todo", "doing"))))).scalars().all()
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
    repos = (await session.execute(select(Repo))).scalars().all()
    visible_repos = [repo for repo in repos
                     if await _repo_in_scope(session, user, repo)]
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
