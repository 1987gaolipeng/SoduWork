"""Admin project and repository management.

Mounted at the original position in the admin router. Shared admin scope helpers
are imported inside handlers so there is one policy implementation and no
import-time cycle with the compatibility exports in admin.py.
"""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import require_perm
from ..models import Task, User
from ..schemas import task_to_api
from ..services import audit, rbac
from ..services import tasks as svc

router = APIRouter()


# Projects organize tasks into sequential or parallel dependency graphs.

@router.get("/projects")
async def list_projects(user: User = Depends(require_perm("task.view")), session: AsyncSession = Depends(get_session)):
    """List scoped projects with completed and total task counts."""
    from ..models import Project
    from ..schemas import _ms
    scope = await rbac.scope_org_ids(session, user)   # None leaves superusers unrestricted.
    projs = (await session.execute(select(Project).order_by(Project.created_at.desc()))).scalars().all()
    owner_ids = {str(p.owner_user_id) for p in projs if p.owner_user_id}
    owners = {u.id: u for u in (await session.execute(select(User).where(
        User.id.in_(owner_ids or {"__none__"})
    ))).scalars().all()}
    out = []
    for p in projs:
        if scope is not None and p.org_id is not None and p.org_id not in scope:
            continue
        ts = (await session.execute(select(Task).where(Task.project_id == p.id))).scalars().all()
        active = [t for t in ts if not t.archived_at and t.status != "cancel"]
        out.append({"id": p.id, "name": p.name, "desc": p.desc, "status": p.status,
                    "group": getattr(p, "group", "") or "", "repoUrl": getattr(p, "repo_url", "") or "",
                    "extProjectId": getattr(p, "ext_project_id", "") or "",
                    "ownerUserId": p.owner_user_id or "",
                    "ownerName": ((owners[p.owner_user_id].display_name or
                                   owners[p.owner_user_id].username)
                                  if p.owner_user_id in owners else ""),
                    "total": len(active), "done": sum(1 for t in active if t.status == "done"),
                    "closed": len(ts) - len(active),
                    "createdAt": _ms(p.created_at)})
    return out


@router.get("/project-owner-options")
async def project_owner_options(
    user: User = Depends(require_perm("task.dispatch")),
    session: AsyncSession = Depends(get_session),
):
    """Project ownership is a business responsibility and does not require organization
    user-management permission.
    """
    scope = await rbac.scope_org_ids(session, user)
    query = select(User).where(User.is_active.is_(True))
    if scope is not None:
        query = query.where(User.org_id.in_(scope or {"__none__"}))
    rows = list((await session.execute(query.order_by(
        User.display_name, User.username
    ))).scalars().all())
    return [{"id": row.id, "name": row.display_name or row.username,
             "username": row.username} for row in rows]


async def _project_owner(session: AsyncSession, actor: User, owner_id: str) -> User:
    from .admin import _assert_user_in_scope

    owner = await session.get(User, owner_id)
    if owner is None or not owner.is_active:
        raise HTTPException(status_code=400, detail="请选择一位有效的项目负责人")
    await _assert_user_in_scope(session, actor, owner)
    return owner


@router.post("/projects")
async def create_project(body: dict = Body(default_factory=dict),
                         user: User = Depends(require_perm("task.dispatch")),
                         session: AsyncSession = Depends(get_session)):
    from ..models import Project
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="请填工程名")
    owner = await _project_owner(session, user, str(body.get("ownerUserId") or ""))
    p = Project(name=name, desc=body.get("desc") or "", org_id=owner.org_id or user.org_id,
                owner_user_id=owner.id, created_by=user.id,
                group=(body.get("group") or "").strip(), repo_url=(body.get("repoUrl") or "").strip())
    session.add(p); await session.commit(); await session.refresh(p)
    await audit.log(session, user, "project.create", "project", p.id, name, {})
    return {"id": p.id, "name": p.name, "group": p.group, "repoUrl": p.repo_url,
            "ownerUserId": owner.id, "ownerName": owner.display_name or owner.username}


@router.get("/ai-projects", dependencies=[Depends(require_perm("task.view"))])
async def list_ai_projects(session: AsyncSession = Depends(get_session)):
    """Return executor projects. Current execution paths have no project catalog, so retain an
    empty compatibility endpoint.
    """
    import asyncio as _aio

    from ..services import ai_exec
    ctx = await ai_exec.load(session, force=True)
    if not ai_exec.configured(ctx):
        return {"projects": [], "reason": "AI 执行底座还没配"}
    p = ai_exec.provider(ctx)
    if not hasattr(p, "list_projects_sync"):
        return {"projects": [], "reason": "当前执行底座没有项目概念"}
    rows = await _aio.to_thread(p.list_projects_sync, ctx.get("cfg") or {})
    return {"projects": rows, "provider": ai_exec.provider_name(ctx)}


@router.put("/projects/{pid}")
async def update_project(pid: str, body: dict = Body(default_factory=dict),
                         user: User = Depends(require_perm("task.dispatch")),
                         session: AsyncSession = Depends(get_session)):
    """Update project metadata, repository information, and any linked executor project."""
    from .admin import _assert_org_in_scope

    from ..models import Project, Repo
    p = await session.get(Project, pid)
    if p is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    await _assert_org_in_scope(session, user, p.org_id)
    old_owner = p.owner_user_id or ""
    old_org = p.org_id
    migrated_repos = 0
    owner = None
    if "ownerUserId" in body:
        owner = await _project_owner(session, user, str(body.get("ownerUserId") or ""))
        p.owner_user_id = owner.id
        if not p.org_id:
            p.org_id = owner.org_id
            if p.org_id:
                legacy_repos = list((await session.execute(select(Repo).where(
                    Repo.project_id == p.id, Repo.org_id.is_(None)
                ))).scalars().all())
                for repo in legacy_repos:
                    repo.org_id = p.org_id
                migrated_repos = len(legacy_repos)
    for k, f in (("name", "name"), ("desc", "desc"), ("group", "group"),
                 ("repoUrl", "repo_url"), ("extProjectId", "ext_project_id")):
        if k in body:
            setattr(p, f, str(body.get(k) or "").strip())
    if not p.name:
        raise HTTPException(status_code=400, detail="请填工程名")
    rerouted = {"requests": 0, "assignments": 0, "skipped": 0}
    if owner is not None and owner.id != old_owner:
        from ..services import approval_routing
        rerouted = await approval_routing.reroute_pending_for_project(
            session, p.id, user.display_name or user.username)
    await session.commit()
    await session.refresh(p)
    await audit.log(session, user, "project.update", "project", p.id, p.name,
                    {"extProjectId": p.ext_project_id, "ownerUserId": p.owner_user_id,
                     "previousOwnerUserId": old_owner, "pendingRerouted": rerouted,
                     "previousOrgId": old_org or "", "orgId": p.org_id or "",
                     "migratedRepos": migrated_repos})
    current_owner = owner or (await session.get(User, p.owner_user_id) if p.owner_user_id else None)
    return {"id": p.id, "name": p.name, "desc": p.desc, "group": p.group,
            "repoUrl": p.repo_url, "extProjectId": p.ext_project_id,
            "ownerUserId": p.owner_user_id or "",
            "ownerName": ((current_owner.display_name or current_owner.username)
                          if current_owner else ""),
            "pendingRerouted": rerouted}


def _repo_api(r) -> dict:
    return {"id": r.id, "projectId": r.project_id,
            "sourceRepositoryId": getattr(r, "source_repository_id", "") or "",
            "name": r.name, "kind": r.kind,
            "gitUrl": r.git_url, "branch": r.default_branch, "localDir": r.local_dir,
            "note": r.note,
            # Repository merge and deployment configuration.
            "serverDir": getattr(r, "server_dir", "") or "",
            "mergeBranch": getattr(r, "merge_branch", "") or "",
            # Keep the AI execution directory separate from serverDir, the clean merge checkout.
            "aiWorkDir": getattr(r, "ai_work_dir", "") or "",
            "deployTargets": list(getattr(r, "deploy_targets", None) or []),
            # Store repository-specific development overrides; missing values inherit global defaults.
            # Do not merge defaults here: the UI must distinguish explicit overrides from inherited values.
            "devFlow": dict(getattr(r, "dev_flow", None) or {}),
            # Gerrit repositories push to refs/for and track Gerrit changes for merging.
            "scm": getattr(r, "scm", "") or "git",
            "gerritBase": getattr(r, "gerrit_base", "") or "",
            # Use keyword and layer matching when explicit repository routing does not match.
            "routeKeywords": list(getattr(r, "route_keywords", None) or []),
            "routeLayer": getattr(r, "route_layer", "") or "",
            "routePriority": int(getattr(r, "route_priority", 0) or 0)}


@router.get("/projects/{pid}/repos")
async def list_repos(pid: str, user: User = Depends(require_perm("task.view")),
                     session: AsyncSession = Depends(get_session)):
    """List repositories associated with a project."""
    from ..models import Project, Repo
    from ..services import rbac
    project = await session.get(Project, pid)
    if project is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None and project.org_id is not None and project.org_id not in scope:
        raise HTTPException(status_code=403, detail="这个项目不在你的组织范围内")
    rows = (await session.execute(
        select(Repo).where(Repo.project_id == pid).order_by(Repo.created_at))).scalars().all()
    return [_repo_api(r) for r in rows]


@router.post("/projects/{pid}/repos")
async def add_repo(pid: str, body: dict = Body(default_factory=dict),
                   user: User = Depends(require_perm("task.dispatch")),
                   session: AsyncSession = Depends(get_session)):
    """Add a repository using local_dir relative to the device's configured workspace; resolve
    machine-specific absolute paths at dispatch.
    """
    from ..models import Project, Repo
    p = await session.get(Project, pid)
    if p is None:
        raise HTTPException(status_code=404, detail="工程所属项目不存在")
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="请填工程名")
    kind = (body.get("kind") or "other").strip().lower()
    if kind not in ("backend", "frontend", "mobile", "infra", "other"):
        kind = "other"
    local = (body.get("localDir") or "").strip().replace("\\", "/").strip("/")
    if ".." in local.split("/"):
        raise HTTPException(status_code=400, detail="子目录名不能带 ..")
    r = Repo(project_id=pid, name=name, kind=kind,
             git_url=(body.get("gitUrl") or "").strip(),
             default_branch=(body.get("branch") or "main").strip() or "main",
             local_dir=local or name, note=(body.get("note") or "").strip()[:2000],
             # Accept automatic merge and dispatch settings during creation as well as updates.
             server_dir=(body.get("serverDir") or "").strip()[:400],
             merge_branch=(body.get("mergeBranch") or "").strip()[:120],
             ai_work_dir=(body.get("aiWorkDir") or "").strip()[:400],
             org_id=p.org_id)
    from ..services import scm_support
    scm = str(body.get("scm") or "git").strip().lower()
    if scm not in ("git", "gitlab"):
        raise HTTPException(status_code=400, detail=scm_support.GERRIT_RETIRED if scm == "gerrit" else "scm 只能是 git 或 gitlab")
    if isinstance(body.get("devFlow"), dict):
        # Normalize creation-time development overrides with the same rules as update_repo.
        from ..services import ai_prompts
        err = ai_prompts.check(body["devFlow"])
        if err:
            raise HTTPException(status_code=400, detail=err)
        r.dev_flow = {k: ai_prompts.normalize({k: body["devFlow"][k]})[k]
                      for k in ai_prompts.DEFAULTS
                      if str(body["devFlow"].get(k) or "").strip()}
    session.add(r)
    await session.commit()
    await session.refresh(r)
    await audit.log(session, user, "repo.create", "repo", r.id, name, {"project": pid})
    return _repo_api(r)


@router.put("/repos/{rid}")
async def update_repo(rid: str, body: dict = Body(default_factory=dict),
                      user: User = Depends(require_perm("task.dispatch")),
                      session: AsyncSession = Depends(get_session)):
    from ..models import Repo
    r = await session.get(Repo, rid)
    if r is None:
        raise HTTPException(status_code=404, detail="工程不存在")
    from ..services import scm_support
    if "scm" in body:
        scm = str(body.get("scm") or "git").strip().lower()
        if scm not in ("git", "gitlab"):
            raise HTTPException(status_code=400, detail=scm_support.GERRIT_RETIRED if scm == "gerrit" else "scm 只能是 git 或 gitlab")
        r.scm = "git"
    for k, f in (("name", "name"), ("gitUrl", "git_url"), ("branch", "default_branch"),
                 ("note", "note"), ("serverDir", "server_dir"), ("mergeBranch", "merge_branch"),
                 ("aiWorkDir", "ai_work_dir")):
        if k in body:
            setattr(r, f, str(body.get(k) or "").strip())
    if "routeKeywords" in body:
        kws = body.get("routeKeywords")
        if not isinstance(kws, list):
            raise HTTPException(status_code=400, detail="routeKeywords 要是字符串数组")
        r.route_keywords = [str(k).strip()[:60] for k in kws if str(k).strip()][:30]
    if "routeLayer" in body:
        lay = str(body.get("routeLayer") or "").strip().lower()
        if lay not in ("", "frontend", "backend"):
            raise HTTPException(status_code=400, detail="routeLayer 只能是 frontend/backend/空")
        r.route_layer = lay
    if "routePriority" in body:
        try:
            r.route_priority = max(-100, min(100, int(body.get("routePriority") or 0)))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="routePriority 要是整数") from None
    if "devFlow" in body:
        # Persist only explicit repository overrides; empty values inherit global defaults.
        # Do not store empty strings that would blur the distinction between an unset value and an explicit empty override.
        from ..services import ai_prompts
        v = body.get("devFlow") if isinstance(body.get("devFlow"), dict) else {}
        err = ai_prompts.check(v)
        if err:
            raise HTTPException(status_code=400, detail=err)
        kept = {}
        for key in ai_prompts.DEFAULTS:
            raw = str(v.get(key) or "").strip()
            if not raw:
                continue                                   # An omitted value inherits the global default.
            kept[key] = ai_prompts.normalize({key: raw})[key]   # Normalize each field and apply its fallback.
        r.dev_flow = kept
    if "deployTargets" in body:
        # Multiple {name, env, cmd, auto} targets; administrators define commands and SoduWork triggers them.
        v = body.get("deployTargets")
        r.deploy_targets = [
            {"name": str(x.get("name") or "")[:60], "env": str(x.get("env") or "")[:60],
             "cmd": str(x.get("cmd") or "")[:1000], "auto": bool(x.get("auto"))}
            for x in (v if isinstance(v, list) else []) if isinstance(x, dict)
        ][:10]
    if "kind" in body:
        v = str(body.get("kind") or "other").lower()
        r.kind = v if v in ("backend", "frontend", "mobile", "infra", "other") else "other"
    if "localDir" in body:
        local = str(body.get("localDir") or "").strip().replace("\\", "/").strip("/")
        if ".." in local.split("/"):
            raise HTTPException(status_code=400, detail="子目录名不能带 ..")
        r.local_dir = local
    if not r.default_branch:
        r.default_branch = "main"
    await session.commit()
    await session.refresh(r)
    await audit.log(session, user, "repo.update", "repo", r.id, r.name, {})
    return _repo_api(r)


@router.delete("/repos/{rid}")
async def delete_repo(rid: str, user: User = Depends(require_perm("task.dispatch")),
                      session: AsyncSession = Depends(get_session)):
    from ..models import Repo
    r = await session.get(Repo, rid)
    if r is None:
        return {"ok": True}
    name = r.name
    await session.delete(r)
    await session.commit()
    await audit.log(session, user, "repo.delete", "repo", rid, name, {})
    return {"ok": True}


@router.get("/projects/{pid}")
async def project_detail(pid: str, user: User = Depends(require_perm("task.view")),
                         session: AsyncSession = Depends(get_session)):
    """Return project details and task dependencies, status, and owners for the dependency graph."""
    from .admin import _assert_org_in_scope

    from ..models import Project
    from ..services.boxes import box_owner_names
    p = await session.get(Project, pid)
    if p is None:
        raise HTTPException(status_code=404, detail="工程不存在")
    await _assert_org_in_scope(session, user, p.org_id)
    ts = (await session.execute(select(Task).where(Task.project_id == pid).order_by(Task.created_at))).scalars().all()
    box_names = await box_owner_names(session, [t.owner_client_id for t in ts])
    tasks_out = []
    for t in ts:
        d = task_to_api(t)
        d["ownerName"] = box_names.get(t.owner_client_id, "")
        tasks_out.append(d)
    from ..services import task_requirement_projection
    await task_requirement_projection.decorate_many(session, ts, tasks_out)
    owner = await session.get(User, p.owner_user_id) if p.owner_user_id else None
    return {"id": p.id, "name": p.name, "desc": p.desc, "status": p.status,
            "group": getattr(p, "group", "") or "", "repoUrl": getattr(p, "repo_url", "") or "",
            "extProjectId": getattr(p, "ext_project_id", "") or "",
            "ownerUserId": p.owner_user_id or "",
            "ownerName": ((owner.display_name or owner.username) if owner else ""),
            "tasks": tasks_out}


@router.post("/projects/{pid}/tasks")
async def add_project_task(pid: str, body: dict = Body(default_factory=dict),
                           user: User = Depends(require_perm("task.dispatch")),
                           session: AsyncSession = Depends(get_session)):
    """Dispatch a project task with optional dependencies on existing project tasks."""
    from .admin import _assert_org_in_scope, _visible_client_ids

    from ..models import Project
    p = await session.get(Project, pid)
    if p is None:
        raise HTTPException(status_code=404, detail="工程不存在")
    await _assert_org_in_scope(session, user, p.org_id)
    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="请填需求标题")
    box = body.get("target")
    if not box:
        raise HTTPException(status_code=400, detail="请选落哪个 SoduWork")
    vis = await _visible_client_ids(session, user)
    if vis is not None and box not in vis:
        raise HTTPException(status_code=403, detail="无权下发到该 SoduWork")
    data = {"title": title, "note": body.get("note") or "", "handler": body.get("handler") or "me",
            "projectId": pid, "deps": body.get("deps") or [],
            "triageStage": body.get("triageStage") or "ready",
            "priority": body.get("priority") or "normal"}
    creator = (user.id, user.display_name or user.username)
    api = await svc.create_task(session, box, data, origin="dispatch", creator=creator)
    await audit.log(session, user, "project.addtask", "project", pid, p.name, {"title": title})
    return api


@router.delete("/projects/{pid}")
async def delete_project(pid: str, user: User = Depends(require_perm("task.dispatch")),
                         session: AsyncSession = Depends(get_session)):
    """Delete the project while retaining its tasks and clearing their project_id association."""
    from .admin import _assert_org_in_scope

    from ..models import Project
    p = await session.get(Project, pid)
    if p is None:
        return {"ok": True}
    await _assert_org_in_scope(session, user, p.org_id)
    ts = (await session.execute(select(Task).where(Task.project_id == pid))).scalars().all()
    for t in ts:
        t.project_id = None
    name = p.name
    await session.delete(p); await session.commit()
    await audit.log(session, user, "project.delete", "project", pid, name, {})
    return {"ok": True}
