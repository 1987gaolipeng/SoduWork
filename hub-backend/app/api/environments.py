"""Environment APIs for deployment environments and repository targets."""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from ..db import get_session
from ..deps import require_perm
from ..models import User
from ..services import (approval_policies as policy_svc, audit, deployments,
                        environment_service as svc, project_setup, rbac,
                        release_control, runner_hub)

router = APIRouter(prefix="/api/v1/admin", tags=["environments"])


def _bad(error: ValueError) -> HTTPException:
    return HTTPException(status_code=409, detail=str(error))


async def _scope(session: AsyncSession, user: User) -> set[str] | None:
    return await rbac.scope_org_ids(session, user)


async def _repo(session: AsyncSession, user: User, repo_id: str) -> models.Repo:
    row = await session.get(models.Repo, repo_id)
    if row is None:
        raise HTTPException(status_code=404, detail="代码仓库不存在")
    scope = await _scope(session, user)
    if scope is not None and row.org_id is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="这个仓库不在你的组织范围内")
    return row


async def _allowed_clients(session: AsyncSession, user: User) -> set[str]:
    scope = await _scope(session, user)
    if scope is None:
        return set((await session.execute(select(models.Client.id))).scalars().all())
    user_ids = set((await session.execute(select(models.User.id).where(
        models.User.org_id.in_(scope or {"__none__"})))).scalars().all())
    return set((await session.execute(select(models.Client.id).where(
        models.Client.user_ref.in_(user_ids or {"__none__"})))).scalars().all())


async def _allowed_runner_orgs(session: AsyncSession, user: User) -> set[str] | None:
    if user.is_super:
        return None
    managed = await _scope(session, user)
    inherited = await rbac.ancestor_org_ids(session, str(user.org_id or ""))
    return set(managed or set()) | inherited


async def _project(session: AsyncSession, user: User, project_id: str) -> models.Project:
    row = await session.get(models.Project, project_id)
    if row is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    scope = await _scope(session, user)
    if scope is not None and row.org_id is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="这个项目不在你的组织范围内")
    return row


@router.get("/automation-overview")
async def automation_overview(
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    """Summarize delivery readiness from configuration and recorded state without triggering health
    probes.
    """
    scope = await _scope(session, user)
    project_q = select(models.Project)
    if scope is not None:
        project_q = project_q.where(
            models.Project.org_id.in_(scope or {"__none__"}) |
            models.Project.org_id.is_(None))
    projects = list((await session.execute(
        project_q.order_by(models.Project.created_at.desc()))).scalars().all())
    project_ids = {x.id for x in projects}
    repos = list((await session.execute(select(models.Repo).where(
        models.Repo.project_id.in_(project_ids or {"__none__"})
    ))).scalars().all())
    repo_ids = {x.id for x in repos}
    targets = list((await session.execute(select(am.DeploymentTarget).where(
        am.DeploymentTarget.repo_id.in_(repo_ids or {"__none__"}),
        am.DeploymentTarget.enabled.is_(True)
    ))).scalars().all())
    envs = await svc.visible_environments(session, scope)
    env_by_id = {x["id"]: x for x in envs}
    binding_q = select(am.PluginBinding).where(am.PluginBinding.enabled.is_(True))
    if scope is not None:
        binding_q = binding_q.where(
            am.PluginBinding.project_id.in_(project_ids or {"__none__"}) |
            am.PluginBinding.org_id.in_(scope or {"__none__"}))
    bindings = list((await session.execute(binding_q)).scalars().all())
    profiles = list((await session.execute(select(am.ProjectAutomationProfile).where(
        am.ProjectAutomationProfile.project_id.in_(project_ids or {"__none__"}),
        am.ProjectAutomationProfile.enabled.is_(True),
    ))).scalars().all())
    profile_by_project = {x.project_id: x for x in profiles}
    enabled_binding_ids = {x.id for x in bindings}
    policies = await policy_svc.list_visible(session, scope)
    task_ids = set((await session.execute(select(models.Task.id).where(
        models.Task.project_id.in_(project_ids or {"__none__"})
    ))).scalars().all())
    run_states = list((await session.execute(select(am.WorkflowRun.state).where(
        am.WorkflowRun.task_id.in_(task_ids or {"__none__"})
    ))).scalars().all())
    pending_approvals = int(await session.scalar(select(func.count(am.ApprovalRequest.id)).where(
        am.ApprovalRequest.task_id.in_(task_ids or {"__none__"}),
        am.ApprovalRequest.status == "pending")) or 0)
    # Count plugins as workflow definitions following FlowTemplate retirement.
    flow_count = int(await session.scalar(select(func.count(am.Plugin.id))) or 0)
    allowed_clients = None if user.is_super else await _allowed_clients(session, user)
    allowed_orgs = await _allowed_runner_orgs(session, user)
    runners = [runner.api() for runner in runner_hub.online()
               if runner_hub.in_scope(runner, allowed_clients, allowed_orgs)]

    repo_by_project: dict[str, list] = {}
    for row in repos:
        repo_by_project.setdefault(row.project_id, []).append(row)
    targets_by_repo: dict[str, list] = {}
    for row in targets:
        targets_by_repo.setdefault(row.repo_id, []).append(row)

    items = []
    for project in projects:
        owned_repos = repo_by_project.get(project.id, [])
        owned_targets = [target for repo in owned_repos
                         for target in targets_by_repo.get(repo.id, [])]
        applicable_bindings = [x for x in bindings if x.project_id == project.id or (
            not x.project_id and (x.org_id is None or x.org_id == project.org_id))]
        profile = profile_by_project.get(project.id)
        boundary = any(bool(dict((env_by_id.get(x.environment_id) or {}).get(
            "promotionPolicy") or {}).get("marksDelivery")) for x in owned_targets)
        checks = {
            "repository": bool(owned_repos and any((x.git_url or "").strip() for x in owned_repos)),
            "workflow": bool(profile and profile.binding_id in enabled_binding_ids),
            "environment": bool(owned_targets),
            "deliveryBoundary": boundary,
            "runner": bool(runners),
        }
        missing = [key for key, ok in checks.items() if not ok]
        items.append({
            "id": project.id, "name": project.name, "orgId": project.org_id or "",
            "repoCount": len(owned_repos), "targetCount": len(owned_targets),
            "bindingCount": len(applicable_bindings), "checks": checks,
            "score": int(round(100 * sum(1 for ok in checks.values() if ok) / len(checks))),
            "missing": missing,
        })
    return {
        "summary": {
            "projects": len(projects), "projectsReady": sum(not x["missing"] for x in items),
            "flows": flow_count, "environments": len(envs), "targets": len(targets), "policies": len(policies),
            "runnersOnline": len(runners), "runningRuns": sum(
                x in ("queued", "running", "waiting_human", "waiting_external") for x in run_states),
            "failedRuns": sum(x == "failed" for x in run_states),
            "pendingApprovals": pending_approvals,
        },
        "projects": items,
        "runners": [{"id": x.get("runnerId"), "host": x.get("host"),
                     "busy": x.get("busy", 0), "tags": x.get("tags") or []} for x in runners],
        "note": "配置完整度不等于环境已探活；部署目标仍需在环境页逐项测通。",
    }


@router.get("/automation-projects/{project_id}/setup")
async def automation_project_setup(
    project_id: str,
    mode: str = "",
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    """Return one user-facing delivery plan; no probes or mutations happen implicitly."""
    return await project_setup.status(
        session, await _project(session, user, project_id),
        await _allowed_clients(session, user), mode)


@router.post("/automation-projects/{project_id}/setup")
async def configure_automation_project(
    project_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Apply only safe defaults; real repositories, environments and credentials are never invented."""
    project = await _project(session, user, project_id)
    mode = str(body.get("mode") or "")
    try:
        profile = await project_setup.apply(session, project, mode, user, body)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "automation.project_configure", "project", project.id,
                    project.name, {"mode": profile.mode, "bindingId": profile.binding_id,
                                   "executionClientId": str((profile.config or {}).get(
                                       "executionClientId") or "")})
    return await project_setup.status(
        session, project, await _allowed_clients(session, user), profile.mode)


@router.post("/automation-projects/{project_id}/preflight")
async def preflight_automation_project(
    project_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Explicitly prove source and deployment access; never deploy or modify a repository."""
    project = await _project(session, user, project_id)
    result = await project_setup.preflight(
        session, project, await _allowed_clients(session, user), str(body.get("mode") or ""))
    proof = result.get("preflight") or {}
    await audit.log(session, user, "automation.project_preflight", "project", project.id,
                    project.name, {"ok": bool(proof.get("ok")),
                                   "sources": len(proof.get("sources") or []),
                                   "targets": len(proof.get("targets") or [])})
    return result


@router.post("/automation-projects/{project_id}/launch")
async def launch_automation_project(
    project_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("task.dispatch")),
    _plugin_user: User = Depends(require_perm("plugin.run")),
    session: AsyncSession = Depends(get_session),
):
    """Create the project task and start its configured workflow without a split-brain handoff."""
    project = await _project(session, user, project_id)
    try:
        result = await project_setup.launch(
            session, project, await _allowed_clients(session, user),
            str(body.get("mode") or ""), user, body)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "automation.project_launch", "task",
                    result["task"]["id"], result["task"]["title"],
                    {"projectId": project.id, "mode": result["mode"],
                     "runId": result["run"]["id"], "reused": result["reused"]})
    return result


@router.get("/approval-policies")
async def approval_policies(
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    return {"items": await policy_svc.list_visible(session, await _scope(session, user))}


@router.post("/approval-policies")
async def create_approval_policy(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("flow.manage")),
    session: AsyncSession = Depends(get_session),
):
    safe = dict(body)
    safe["orgId"] = body.get("orgId") if user.is_super else user.org_id
    try:
        row = await policy_svc.save(session, safe)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "approval_policy.create", "approval_policy",
                    row.id, row.name, {"actions": list((row.rules or {}).get("actions") or [])})
    return policy_svc.api(row)


@router.patch("/approval-policies/{policy_id}")
async def update_approval_policy(
    policy_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("flow.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(am.ApprovalPolicy, policy_id)
    if row is None:
        raise HTTPException(status_code=404, detail="审批职责不存在")
    scope = await _scope(session, user)
    if row.org_id is None and not user.is_super:
        raise HTTPException(status_code=403, detail="系统审批职责只能由超级管理员调整")
    if scope is not None and row.org_id is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="这项审批职责不在你的组织范围内")
    try:
        row = await policy_svc.save(session, body, row)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "approval_policy.update", "approval_policy",
                    row.id, row.name, {"actions": list((row.rules or {}).get("actions") or [])})
    return policy_svc.api(row)


@router.delete("/approval-policies/{policy_id}")
async def delete_approval_policy(
    policy_id: str,
    user: User = Depends(require_perm("flow.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(am.ApprovalPolicy, policy_id)
    if row is None:
        raise HTTPException(status_code=404, detail="审批职责不存在")
    scope = await _scope(session, user)
    if scope is not None and (row.org_id is None or row.org_id not in scope):
        raise HTTPException(status_code=403, detail="这项审批职责不在你的组织范围内")
    name = row.name
    try:
        await policy_svc.delete(session, row)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "approval_policy.delete", "approval_policy",
                    policy_id, name, {})
    return {"ok": True}


@router.get("/environments")
async def environments(
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    return {"items": await svc.visible_environments(session, await _scope(session, user))}


@router.post("/environments")
async def create_environment(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    try:
        safe = dict(body)
        safe["orgId"] = body.get("orgId") if user.is_super else user.org_id
        row = await svc.save_environment(session, safe)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "environment.create", "environment", row.id, row.name,
                    {"key": row.key, "tier": row.tier})
    return release_control.environment_api(row)


@router.patch("/environments/{eid}")
async def update_environment(
    eid: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(am.Environment, eid)
    if row is None:
        raise HTTPException(status_code=404, detail="环境不存在")
    scope = await _scope(session, user)
    if row.org_id is None and not user.is_super:
        raise HTTPException(status_code=403, detail="系统环境只能由超级管理员修改")
    if scope is not None and row.org_id is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="这个环境不在你的组织范围内")
    try:
        row = await svc.save_environment(session, body, row)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "environment.update", "environment", row.id, row.name, {})
    return release_control.environment_api(row)


@router.delete("/environments/{eid}")
async def delete_environment(
    eid: str,
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(am.Environment, eid)
    if row is None:
        raise HTTPException(status_code=404, detail="环境不存在")
    scope = await _scope(session, user)
    if row.org_id is None and not user.is_super:
        raise HTTPException(status_code=403, detail="系统环境只能由超级管理员修改")
    if scope is not None and row.org_id is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="这个环境不在你的组织范围内")
    name = row.name
    try:
        await svc.delete_environment(session, row)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "environment.delete", "environment", eid, name, {})
    return {"ok": True}


@router.get("/deployment-targets")
async def targets(
    repoId: str = "",
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    if repoId:
        await _repo(session, user, repoId)
    return {"items": await svc.list_targets(session, repoId, await _scope(session, user))}


@router.get("/environment-preflight")
async def environment_preflight(
    repoId: str,
    user: User = Depends(require_perm("task.view")),
    session: AsyncSession = Depends(get_session),
):
    repo = await _repo(session, user, repoId)
    return await svc.preflight_chain(
        session, repo, await _allowed_clients(session, user))


@router.post("/environment-preflight")
async def probe_environment_preflight(
    repoId: str,
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Probe every target for one repository, then evaluate the complete chain."""
    repo = await _repo(session, user, repoId)
    allowed = await _allowed_clients(session, user)
    targets = list((await session.execute(select(am.DeploymentTarget).where(
        am.DeploymentTarget.repo_id == repo.id,
        am.DeploymentTarget.enabled.is_(True),
    ).order_by(am.DeploymentTarget.created_at))).scalars().all())
    probes = []
    for target in targets:
        result = await svc.probe_target(session, target, allowed)
        probes.append({"targetId": target.id, "targetName": target.name,
                       "ok": bool(result.get("ok")),
                       "error": str(result.get("error") or "")})
    chain = await svc.preflight_chain(session, repo, allowed)
    return {**chain, "probes": probes}


@router.get("/release-channels")
async def release_channels(user: User = Depends(require_perm("task.view"))):
    """Return release-provider choices and field metadata from services/release_providers for
    dynamic configuration forms.
    """
    from ..services import release_providers
    return {"items": release_providers.kinds()}


@router.post("/deployment-targets")
async def create_target(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    await _repo(session, user, str(body.get("repoId") or ""))
    try:
        row = await svc.save_target(session, body)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "deployment_target.create", "deployment_target",
                    row.id, row.name, {"repoId": row.repo_id, "environmentId": row.environment_id})
    return release_control.target_api(row)


@router.patch("/deployment-targets/{target_id}")
async def update_target(
    target_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(am.DeploymentTarget, target_id)
    if row is None:
        raise HTTPException(status_code=404, detail="部署目标不存在")
    await _repo(session, user, row.repo_id)
    if body.get("repoId"):
        await _repo(session, user, str(body["repoId"]))
    try:
        row = await svc.save_target(session, body, row)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "deployment_target.update", "deployment_target",
                    row.id, row.name, {})
    return release_control.target_api(row)


@router.delete("/deployment-targets/{target_id}")
async def delete_target(
    target_id: str,
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(am.DeploymentTarget, target_id)
    if row is None:
        raise HTTPException(status_code=404, detail="部署目标不存在")
    await _repo(session, user, row.repo_id)
    name = row.name
    try:
        await svc.delete_target(session, row)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "deployment_target.delete", "deployment_target",
                    target_id, name, {})
    return {"ok": True}


@router.post("/deployment-targets/{target_id}/probe")
async def probe_target(
    target_id: str,
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(am.DeploymentTarget, target_id)
    if row is None:
        raise HTTPException(status_code=404, detail="部署目标不存在")
    await _repo(session, user, row.repo_id)
    return await svc.probe_target(session, row, await _allowed_clients(session, user))


@router.post("/deployment-targets/{target_id}/redeploy")
async def redeploy_target(
    target_id: str,
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    """Redeploy the current artifact after deployment-script or environment changes without
    changing its version.
    """
    row = await session.get(am.DeploymentTarget, target_id)
    if row is None:
        raise HTTPException(status_code=404, detail="部署目标不存在")
    await _repo(session, user, row.repo_id)
    out = await deployments.redeploy_target(
        session, row, who=user.display_name or user.username)
    if out.get("ok"):
        await audit.log(session, user, "deployment_target.redeploy", "deployment_target",
                        target_id, row.name,
                        {"commit": (out.get("run") or {}).get("commit") or ""})
    return out


@router.get("/secret-references")
async def secret_references(
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    return {"items": await svc.list_secret_refs(session, await _scope(session, user))}


@router.post("/secret-references")
async def create_secret_reference(
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    safe = dict(body)
    safe["orgId"] = body.get("orgId") if user.is_super else user.org_id
    try:
        row = await svc.save_secret_ref(session, safe)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "secret_reference.create", "secret_reference",
                    row.id, row.name, {"provider": row.provider, "locator": row.locator})
    return svc.secret_api(row)


@router.patch("/secret-references/{ref_id}")
async def update_secret_reference(
    ref_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(am.SecretReference, ref_id)
    if row is None:
        raise HTTPException(status_code=404, detail="密钥引用不存在")
    scope = await _scope(session, user)
    if row.org_id is None and not user.is_super:
        raise HTTPException(status_code=403, detail="系统级密钥引用只能由超级管理员修改")
    if scope is not None and row.org_id is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="这个密钥引用不在你的组织范围内")
    try:
        row = await svc.save_secret_ref(session, body, row)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "secret_reference.update", "secret_reference",
                    row.id, row.name, {"enabled": row.enabled})
    return svc.secret_api(row)


@router.post("/secret-references/{ref_id}/probe")
async def probe_secret_reference(
    ref_id: str,
    body: dict = Body(default_factory=dict),
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(am.SecretReference, ref_id)
    if row is None:
        raise HTTPException(status_code=404, detail="密钥引用不存在")
    scope = await _scope(session, user)
    if scope is not None and row.org_id is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="这个密钥引用不在你的组织范围内")
    tags = [str(x).strip().lower() for x in (body.get("tags") or []) if str(x).strip()]
    return await svc.probe_secret_ref(
        row, tags, None if user.is_super else await _allowed_clients(session, user),
        await _allowed_runner_orgs(session, user))


@router.delete("/secret-references/{ref_id}")
async def delete_secret_reference(
    ref_id: str,
    user: User = Depends(require_perm("environment.manage")),
    session: AsyncSession = Depends(get_session),
):
    row = await session.get(am.SecretReference, ref_id)
    if row is None:
        raise HTTPException(status_code=404, detail="密钥引用不存在")
    scope = await _scope(session, user)
    if row.org_id is None and not user.is_super:
        raise HTTPException(status_code=403, detail="系统级密钥引用只能由超级管理员删除")
    if scope is not None and row.org_id is not None and row.org_id not in scope:
        raise HTTPException(status_code=403, detail="这个密钥引用不在你的组织范围内")
    name = row.name
    try:
        await svc.delete_secret_ref(session, row)
    except ValueError as e:
        raise _bad(e) from e
    await audit.log(session, user, "secret_reference.delete", "secret_reference",
                    ref_id, name, {})
    return {"ok": True}
