"""Environment and deployment-target catalog storing declarative settings and secret references,
never plaintext credentials.
"""
from __future__ import annotations

import asyncio
import re

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from . import preflight_evidence, release_control
from .environment_contracts import (
    _KEY,
    _SECRET_WORD,
    _text,
    _contains_secret,
    _selector,
    promotion_policy,
    _argv,
    _headers,
    _checks,
    _rollback,
    effective_rollback,
    _target_config,
    target_probe_fingerprint,
    repo_probe_fingerprint,
    _channel_config,
)

def _providers() -> set[str]:
    """Read supported release providers from the registry so new providers require no catalog
    changes.
    """
    from . import release_providers
    return {str(x["key"]) for x in release_providers.kinds()}




async def _assert_promotion_graph(session: AsyncSession, row: am.Environment) -> None:
    """Require acyclic environment relationships within an organization; retain unresolved keys for
    staged template imports.
    """
    rows = list((await session.execute(select(am.Environment).where(
        (am.Environment.org_id == row.org_id) | am.Environment.org_id.is_(None)
    ))).scalars().all())
    graph = {x.key: list(promotion_policy(x.promotion_policy).get("requires") or [])
             for x in rows}
    graph[row.key] = list(promotion_policy(row.promotion_policy).get("requires") or [])
    if row.key in graph[row.key]:
        raise ValueError("环境不能依赖自己")
    visiting, visited = set(), set()

    def visit(key: str) -> None:
        if key in visiting:
            raise ValueError("环境推进关系存在循环依赖")
        if key in visited or key not in graph:
            return
        visiting.add(key)
        for parent in graph[key]:
            visit(parent)
        visiting.remove(key)
        visited.add(key)

    for key in graph:
        visit(key)




async def task_org_id(session: AsyncSession, task: models.Task) -> str | None:
    """Resolve tenant ownership from stable repository or project identity before falling back to
    the task's current client.
    """
    if task.repo_id:
        repo = await session.get(models.Repo, task.repo_id)
        if repo and repo.org_id:
            return repo.org_id
    if task.project_id:
        project = await session.get(models.Project, task.project_id)
        if project and project.org_id:
            return project.org_id
    if task.owner_client_id:
        client = await session.get(models.Client, task.owner_client_id)
        user = await session.get(models.User, client.user_ref) if client and client.user_ref else None
        if user and user.org_id:
            return user.org_id
    return None


async def task_runner_clients(session: AsyncSession, task: models.Task) -> set[str]:
    """Task Runners must share the root organization; tasks without an organization may use only
    their own machine.
    """
    org_id = await task_org_id(session, task)
    allowed = {str(task.owner_client_id)} if task.owner_client_id else set()
    if not org_id:
        return allowed
    orgs = list((await session.execute(select(models.OrgUnit))).scalars().all())
    parents = {x.id: x.parent_id for x in orgs}
    root, seen = org_id, set()
    while parents.get(root) and root not in seen:
        seen.add(root)
        root = parents[root]
    from . import rbac
    company_orgs = await rbac.subtree_org_ids(session, root)
    user_ids = set((await session.execute(select(models.User.id).where(
        models.User.org_id.in_(company_orgs or {"__none__"})))).scalars().all())
    client_ids = set((await session.execute(select(models.Client.id).where(
        models.Client.user_ref.in_(user_ids or {"__none__"})))).scalars().all())
    return allowed | client_ids


async def client_runner_clients(session: AsyncSession, client: models.Client) -> set[str]:
    """Devices see Runners in the same organization tree, or only their own Runner when unbound."""
    allowed = {str(client.id)} if client.id else set()
    user = await session.get(models.User, client.user_ref) if client.user_ref else None
    if user is None or not user.org_id:
        return allowed
    orgs = list((await session.execute(select(models.OrgUnit))).scalars().all())
    parents = {x.id: x.parent_id for x in orgs}
    root, seen = user.org_id, set()
    while parents.get(root) and root not in seen:
        seen.add(root)
        root = parents[root]
    from . import rbac
    company_orgs = await rbac.subtree_org_ids(session, root)
    user_ids = set((await session.execute(select(models.User.id).where(
        models.User.org_id.in_(company_orgs or {"__none__"})))).scalars().all())
    peers = set((await session.execute(select(models.Client.id).where(
        models.Client.user_ref.in_(user_ids or {"__none__"})))).scalars().all())
    return allowed | peers


async def runner_orgs_for_org(session: AsyncSession, org_id: str | None) -> set[str]:
    """Organization scopes inherited by a task or employee for standalone Runner use."""
    if not org_id:
        return set()
    from . import rbac
    return await rbac.ancestor_org_ids(session, str(org_id))


async def task_runner_orgs(session: AsyncSession, task: models.Task) -> set[str]:
    return await runner_orgs_for_org(session, await task_org_id(session, task))


async def client_runner_orgs(session: AsyncSession, client: models.Client) -> set[str]:
    user = await session.get(models.User, client.user_ref) if client.user_ref else None
    return await runner_orgs_for_org(session, user.org_id if user else None)


async def environment_for_task(session: AsyncSession, task: models.Task, *,
                               environment_id: str = "", key: str = "") -> am.Environment | None:
    org_id = await task_org_id(session, task)
    if environment_id:
        row = await session.get(am.Environment, environment_id)
        return row if row and (row.org_id is None or row.org_id == org_id) else None
    rows = list((await session.execute(select(am.Environment).where(
        am.Environment.key == key, am.Environment.enabled.is_(True)
    ).order_by(am.Environment.org_id.is_(None)))).scalars().all())
    return next((x for x in rows if x.org_id == org_id),
                next((x for x in rows if x.org_id is None), None))


async def visible_environments(session: AsyncSession, org_ids: set[str] | None) -> list[dict]:
    q = select(am.Environment).order_by(am.Environment.sort, am.Environment.created_at)
    if org_ids is not None:
        q = q.where((am.Environment.org_id.in_(org_ids or {"__none__"})) |
                    am.Environment.org_id.is_(None))
    rows = list((await session.execute(q)).scalars().all())
    counts = dict((await session.execute(select(
        am.DeploymentTarget.environment_id, func.count(am.DeploymentTarget.id)
    ).group_by(am.DeploymentTarget.environment_id))).all())
    return [{**release_control.environment_api(row), "targetCount": counts.get(row.id, 0)}
            for row in rows]


async def preflight_chain(session: AsyncSession, repo: models.Repo,
                          allowed_clients: set[str] | None = None,
                          require_online: bool = True,
                          allowed_orgs: set[str] | None = None) -> dict:
    """Validate one repository's complete declarative release chain before work starts."""
    from . import release_providers, runner_hub
    if allowed_orgs is None:
        allowed_orgs = await runner_orgs_for_org(session, repo.org_id)
    targets = list((await session.execute(select(am.DeploymentTarget).where(
        am.DeploymentTarget.repo_id == repo.id,
        am.DeploymentTarget.enabled.is_(True),
    ).order_by(am.DeploymentTarget.created_at))).scalars().all())
    blockers, warnings = [], []

    def block(code: str, text: str, environment_id: str = "") -> None:
        item = {"code": code, "message": text, "environmentId": environment_id}
        if item not in blockers:
            blockers.append(item)

    def warn(code: str, text: str, environment_id: str = "") -> None:
        item = {"code": code, "message": text, "environmentId": environment_id}
        if item not in warnings:
            warnings.append(item)

    if not targets:
        block("no-target", "这个仓库还没有接入任何部署目标")
        return {"ok": False, "repoId": repo.id, "repoName": repo.name,
                "stages": [], "blockers": blockers, "warnings": warnings}
    env_ids = {row.environment_id for row in targets}
    ref_ids = {str(ref_id) for target in targets
               for ref_id in dict(target.secret_refs or {}).values() if ref_id}
    refs = {row.id: row for row in (await session.execute(select(am.SecretReference).where(
        am.SecretReference.id.in_(ref_ids or {"__none__"})
    ))).scalars().all()}
    probe_rows = await preflight_evidence.get_many(
        session, "deployment_target", {row.id for row in targets}, "deploy.preflight")
    env_rows = list((await session.execute(select(am.Environment).where(
        (am.Environment.org_id == repo.org_id) | am.Environment.org_id.is_(None)
    ).order_by(am.Environment.org_id.is_(None), am.Environment.sort,
               am.Environment.created_at))).scalars().all())
    # Organization environments override platform environments with the same key, matching runtime resolution.
    by_key = {}
    for row in reversed(env_rows):
        by_key[row.key] = row
    by_id = {row.id: row for row in env_rows}
    target_envs = [by_id[eid] for eid in env_ids if eid in by_id]
    if len(target_envs) != len(env_ids):
        block("missing-environment", "有部署目标引用了不存在或不属于当前组织的环境")
    target_env_ids = {row.id for row in target_envs}
    stages = []
    for env in sorted(target_envs, key=lambda x: (x.sort, x.created_at)):
        policy = promotion_policy(env.promotion_policy)
        env_targets = [row for row in targets if row.environment_id == env.id]
        if not env.enabled:
            block("environment-disabled", f"{env.name} 已停用", env.id)
        if not policy.get("autoStart"):
            block("manual-dead-end", f"{env.name} 未开启自动进入，通用发布链会停在这里", env.id)
        missing_dependencies = []
        for key in policy.get("requires") or []:
            parent = by_key.get(key)
            if parent is None:
                missing_dependencies.append(key)
                block("missing-prerequisite", f"{env.name} 的前置环境 {key} 尚未配置", env.id)
            elif parent.id not in target_env_ids:
                missing_dependencies.append(parent.name)
                block("missing-prerequisite-target",
                      f"{env.name} 依赖 {parent.name}，但该仓库没有对应部署目标", env.id)
        tags = list(dict(env.runner_selector or {}).get("tags") or [])
        runner_ids = list(dict(env.runner_selector or {}).get("runnerIds") or [])
        needs_runner = any(not release_providers.handles(target) for target in env_targets)
        target_probes = []
        for target in env_targets:
            for tag in dict(target.runner_selector or {}).get("tags") or []:
                if tag not in tags:
                    tags.append(tag)
            for runner_id in dict(target.runner_selector or {}).get("runnerIds") or []:
                if runner_id not in runner_ids:
                    runner_ids.append(runner_id)
            rollback = effective_rollback(env, target)
            provider = release_providers.provider_of(target)
            capabilities = release_providers.capabilities(provider)
            supported_checks = set(capabilities.get("healthCheckTypes") or [])
            for check in [*list(env.health_checks or []), *list(target.health_checks or [])]:
                check_type = str(dict(check or {}).get("type") or "http")
                if check_type not in supported_checks:
                    block("unsupported-health-check",
                          f"{target.name} 的发布适配器不支持 {check_type} 健康检查", env.id)
            if rollback.get("mode") == "automatic":
                if not capabilities.get("automaticRollback"):
                    block("rollback-unsupported",
                          f"{target.name} 的发布适配器暂不支持自动回滚", env.id)
                elif not rollback.get("argv"):
                    block("rollback-command",
                          f"{target.name} 开了自动回滚但没有回滚命令", env.id)
            current = target_probe_fingerprint(target, env, repo, refs)
            probe = preflight_evidence.api(probe_rows.get(target.id), current)
            target_probes.append({"targetId": target.id, "targetName": target.name, **probe})
            if probe["state"] == "never":
                block("target-unprobed", f"{target.name} 还没有做真实预检", env.id)
            elif probe["state"] == "stale":
                block("target-probe-stale", f"{target.name} 的配置已变化，需要重新预检", env.id)
            elif not probe["ok"]:
                block("target-probe-failed", f"{target.name} 最近一次预检没有通过：{probe['summary']}", env.id)
        runner = runner_hub.pick_by_tags(
            tags, allowed_client_ids=allowed_clients,
            required_capabilities=["repository", "terminal"],
            allowed_org_ids=allowed_orgs,
            allowed_runner_ids=set(runner_ids) if runner_ids else None) if needs_runner else None
        if needs_runner and runner is None:
            if require_online:
                block("runner-unavailable",
                      f"{env.name} 没有同时满足标签、代码仓库和命令能力的在线 Runner", env.id)
            else:
                warn("runner-unavailable",
                     f"{env.name} 正在等待满足标签、代码仓库和命令能力的 Runner 上线", env.id)
        if not any((target.health_checks or env.health_checks) for target in env_targets):
            if policy.get("marksDelivery"):
                block("delivery-health-check",
                      f"{env.name} 是交付终点，至少要配置一条健康检查", env.id)
            else:
                warn("no-health-check", f"{env.name} 没有健康检查，只能确认命令退出成功", env.id)
        stages.append({
            "id": env.id, "key": env.key, "name": env.name,
            "requires": list(policy.get("requires") or []),
            "missingDependencies": missing_dependencies,
            "marksDelivery": bool(policy.get("marksDelivery")),
            "targetCount": len(env_targets),
            "probeReady": all(x.get("ok") for x in target_probes),
            "targetProbes": target_probes,
            "runnerReady": (runner is not None) if needs_runner else True,
            "runnerHost": runner.host if runner else "", "tags": tags,
            "runnerIds": runner_ids,
        })
    if not any(item.get("marksDelivery") for item in stages):
        block("no-delivery-boundary", "发布链没有交付边界，部署完成后需求无法自动办结")
    return {"ok": not blockers, "repoId": repo.id, "repoName": repo.name,
            "stages": stages, "blockers": blockers, "warnings": warnings}


async def save_environment(session: AsyncSession, body: dict, row: am.Environment | None = None
                           ) -> am.Environment:
    creating = row is None
    key = _text(body.get("key"), 64).lower()
    tier = _text(body.get("tier"), 24).lower() or "custom"
    if creating:
        if not _KEY.fullmatch(key):
            raise ValueError("环境标识只允许小写字母、数字和短横线，且以字母开头")
        org_id = body.get("orgId") or None
        if await session.scalar(select(func.count(am.Environment.id)).where(
                am.Environment.key == key, am.Environment.org_id == org_id)):
            raise ValueError("环境标识已经存在")
        row = am.Environment(key=key, name=_text(body.get("name"), 80) or key,
                             tier=tier, org_id=org_id)
        session.add(row)
    elif key and key != row.key:
        if not _KEY.fullmatch(key):
            raise ValueError("环境标识不合法")
        if await session.scalar(select(func.count(am.Environment.id)).where(
                am.Environment.key == key, am.Environment.org_id == row.org_id,
                am.Environment.id != row.id)):
            raise ValueError("环境标识已经存在")
        row.key = key
    if "name" in body:
        row.name = _text(body.get("name"), 80) or row.name
    if "tier" in body:
        row.tier = tier or "custom"
    if "description" in body:
        row.description = _text(body.get("description"), 400)
    if "runnerSelector" in body:
        row.runner_selector = _selector(body.get("runnerSelector"))
    if "healthChecks" in body:
        row.health_checks = _checks(body.get("healthChecks"))
    if "rollback" in body:
        row.rollback = _rollback(body.get("rollback"), command_required=False)
    if "approvalPolicyId" in body:
        policy_id = _text(body.get("approvalPolicyId"), 36)
        if policy_id and await session.get(am.ApprovalPolicy, policy_id) is None:
            raise ValueError("审批策略不存在")
        row.approval_policy_id = policy_id
    if "acceptancePolicyId" in body:
        policy_id = _text(body.get("acceptancePolicyId"), 36)
        if policy_id and await session.get(am.ApprovalPolicy, policy_id) is None:
            raise ValueError("验收职责不存在")
        row.acceptance_policy_id = policy_id
    if "promotionPolicy" in body or creating:
        row.promotion_policy = promotion_policy(body.get("promotionPolicy"))
    if "enabled" in body:
        row.enabled = bool(body.get("enabled"))
    if "sort" in body:
        row.sort = int(body.get("sort") or 0)
    await session.flush()
    await _assert_promotion_graph(session, row)
    await session.commit()
    await session.refresh(row)
    return row


async def delete_environment(session: AsyncSession, row: am.Environment) -> None:
    used = await session.scalar(select(func.count(am.DeploymentTarget.id)).where(
        am.DeploymentTarget.environment_id == row.id))
    if used:
        raise ValueError("这个环境还有部署目标，先处理部署目标")
    await session.delete(row)
    await session.commit()


async def list_targets(session: AsyncSession, repo_id: str = "",
                       org_ids: set[str] | None = None) -> list[dict]:
    q = select(am.DeploymentTarget).join(
        models.Repo, models.Repo.id == am.DeploymentTarget.repo_id
    ).order_by(am.DeploymentTarget.created_at)
    if repo_id:
        q = q.where(am.DeploymentTarget.repo_id == repo_id)
    if org_ids is not None:
        q = q.where((models.Repo.org_id.in_(org_ids or {"__none__"})) |
                    models.Repo.org_id.is_(None))
    rows = list((await session.execute(q)).scalars().all())
    envs = {row.id: row for row in (await session.execute(select(am.Environment).where(
        am.Environment.id.in_({x.environment_id for x in rows} or {"__none__"})
    ))).scalars().all()}
    repos = {row.id: row for row in (await session.execute(select(models.Repo).where(
        models.Repo.id.in_({x.repo_id for x in rows} or {"__none__"})
    ))).scalars().all()}
    ref_ids = {str(ref_id) for target in rows
               for ref_id in dict(target.secret_refs or {}).values() if ref_id}
    refs = {row.id: row for row in (await session.execute(select(am.SecretReference).where(
        am.SecretReference.id.in_(ref_ids or {"__none__"})
    ))).scalars().all()}
    evidence = await preflight_evidence.get_many(
        session, "deployment_target", {x.id for x in rows}, "deploy.preflight")
    return [{**release_control.target_api(row),
             "effectiveRollback": effective_rollback(envs.get(row.environment_id), row),
             "effectiveHealthChecks": [
                 *list((envs.get(row.environment_id).health_checks
                       if envs.get(row.environment_id) else []) or []),
                 *list(row.health_checks or []),
             ],
             "probe": preflight_evidence.api(
        evidence.get(row.id), target_probe_fingerprint(
            row, envs.get(row.environment_id), repos.get(row.repo_id), refs))}
            for row in rows]


def secret_api(row: am.SecretReference) -> dict:
    return {"id": row.id, "orgId": row.org_id, "name": row.name,
            "provider": row.provider, "locator": row.locator,
            "metadata": row.metadata_ or {}, "enabled": row.enabled,
            "createdAt": release_control._ms(row.created_at)}


async def list_secret_refs(session: AsyncSession, org_ids: set[str] | None) -> list[dict]:
    q = select(am.SecretReference).order_by(am.SecretReference.created_at)
    if org_ids is not None:
        q = q.where((am.SecretReference.org_id.in_(org_ids or {"__none__"})) |
                    am.SecretReference.org_id.is_(None))
    return [secret_api(x) for x in (await session.execute(q)).scalars().all()]


async def save_secret_ref(session: AsyncSession, body: dict,
                          row: am.SecretReference | None = None) -> am.SecretReference:
    provider = _text(body.get("provider") if row is None else body.get("provider", row.provider), 32)
    locator = _text(body.get("locator") if row is None else body.get("locator", row.locator), 500)
    if provider != "runner-env":
        raise ValueError("首版密钥引用只支持 Runner 环境变量")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", locator):
        raise ValueError("Runner 环境变量名不合法")
    if row is None:
        row = am.SecretReference(org_id=body.get("orgId") or None,
                                 name=_text(body.get("name"), 100) or locator,
                                 provider=provider, locator=locator)
        session.add(row)
    else:
        row.provider, row.locator = provider, locator
        if "name" in body:
            row.name = _text(body.get("name"), 100) or row.name
    if "enabled" in body:
        row.enabled = bool(body.get("enabled"))
    await session.commit()
    await session.refresh(row)
    return row


async def delete_secret_ref(session: AsyncSession, row: am.SecretReference) -> None:
    targets = list((await session.execute(select(am.DeploymentTarget))).scalars().all())
    bindings = list((await session.execute(select(am.PluginBinding))).scalars().all())
    used = any(row.id in {str(x) for x in dict(t.secret_refs or {}).values()} for t in targets)
    used = used or any(row.id in {str(x) for x in dict(b.secret_refs or {}).values()} for b in bindings)
    if used:
        raise ValueError("这个密钥引用仍被部署目标或插件绑定使用，只能停用")
    await session.delete(row)
    await session.commit()


async def probe_secret_ref(row: am.SecretReference, tags: list[str],
                           allowed_clients: set[str],
                           allowed_orgs: set[str] | None = None) -> dict:
    from . import runner_hub
    runner = runner_hub.pick_by_tags(
        tags, allowed_client_ids=allowed_clients,
        required_capabilities=["files", "terminal"], allowed_org_ids=allowed_orgs)
    if runner is None:
        return {"ok": False, "error": "没有符合标签、组织范围且具备文件和命令能力的在线 Runner"}
    result = await asyncio.to_thread(
        runner_hub.call_sync, runner, "deploy.preflight", {"spec": {"secrets": [{
            "env": row.locator, "provider": row.provider, "locator": row.locator,
        }]}, "requiredCapabilities": ["files", "terminal"]}, 30)
    return {**result, "runnerId": runner.id, "host": runner.host}


async def probe_target(session: AsyncSession, row: am.DeploymentTarget,
                       allowed_clients: set[str],
                       allowed_orgs: set[str] | None = None) -> dict:
    from . import release_providers, runner_hub
    repo = await session.get(models.Repo, row.repo_id)
    env = await session.get(am.Environment, row.environment_id)
    if allowed_orgs is None:
        allowed_orgs = await runner_orgs_for_org(
            session, repo.org_id if repo else None)
    ref_ids = {str(ref_id) for ref_id in dict(row.secret_refs or {}).values() if ref_id}
    refs = {item.id: item for item in (await session.execute(select(am.SecretReference).where(
        am.SecretReference.id.in_(ref_ids or {"__none__"})
    ))).scalars().all()}
    current = target_probe_fingerprint(row, env, repo, refs)

    async def finish(out: dict) -> dict:
        ok = bool(out.get("ok"))
        summary = str(out.get("error") or out.get("detail") or
                      ("真实预检已通过" if ok else "真实预检未通过"))[:600]
        evidence = await preflight_evidence.record(
            session, subject_kind="deployment_target", subject_id=row.id,
            check_kind="deploy.preflight", config_fingerprint=current, ok=ok,
            summary=summary, executor_id=str(out.get("runnerId") or ""),
            executor_name=str(out.get("host") or out.get("channel") or ""), detail=out)
        await session.commit()
        return {**out, "error": "" if ok else summary,
                "probe": preflight_evidence.api(evidence, current)}

    # Non-Runner providers implement their own read-only connection preview without publishing.
    if release_providers.handles(row):
        out = await release_providers.probe(session, row, repo,
                                            allowed_clients=allowed_clients,
                                            allowed_orgs=allowed_orgs)
        return await finish({**out, "provider": release_providers.provider_of(row),
                             "channel": release_providers.describe(row)})
    tags = list(dict((env.runner_selector if env else {}) or {}).get("tags") or [])
    runner_ids = list(dict((env.runner_selector if env else {}) or {}).get("runnerIds") or [])
    for tag in dict(row.runner_selector or {}).get("tags") or []:
        if tag not in tags:
            tags.append(tag)
    for runner_id in dict(row.runner_selector or {}).get("runnerIds") or []:
        if runner_id not in runner_ids:
            runner_ids.append(runner_id)
    runner = runner_hub.pick_by_tags(
        tags, allowed_client_ids=allowed_clients,
        required_capabilities=["repository", "terminal"], allowed_org_ids=allowed_orgs,
        allowed_runner_ids=set(runner_ids) if runner_ids else None)
    if runner is None:
        return await finish({"ok": False,
                             "error": "没有符合标签、组织范围且具备代码仓库和命令能力的在线 Runner",
                             "tags": tags, "runnerIds": runner_ids})
    secrets = []
    for env_name, ref_id in dict(row.secret_refs or {}).items():
        ref = refs.get(str(ref_id))
        if ref:
            secrets.append({"env": str(env_name), "provider": ref.provider,
                            "locator": ref.locator})
    result = await asyncio.to_thread(
        runner_hub.call_sync, runner, "deploy.preflight",
        {"spec": {"argv": dict(row.config or {}).get("argv") or [], "secrets": secrets},
         "requiredCapabilities": ["repository", "terminal"]}, 30)
    return await finish({**result, "runnerId": runner.id, "host": runner.host,
                         "tags": tags, "runnerIds": runner_ids})


async def save_target(session: AsyncSession, body: dict, row: am.DeploymentTarget | None = None
                      ) -> am.DeploymentTarget:
    repo_id = _text(body.get("repoId") if row is None else body.get("repoId", row.repo_id), 36)
    env_id = _text(body.get("environmentId") if row is None else body.get("environmentId", row.environment_id), 36)
    repo_row = await session.get(models.Repo, repo_id)
    if not repo_row:
        raise ValueError("代码仓库不存在")
    env_row = await session.get(am.Environment, env_id)
    if env_row is None:
        raise ValueError("环境不存在")
    if env_row.org_id is not None and env_row.org_id != repo_row.org_id:
        raise ValueError("环境和代码仓库不属于同一个组织")
    provider = _text(body.get("provider") if row is None else body.get("provider", row.provider),
                     40) or "runner-command"
    if provider not in _providers():
        raise ValueError("不认识的发布通路：%s（可选：%s）"
                         % (provider, "、".join(sorted(_providers()))))
    config = _target_config(
        body.get("config") if row is None else body.get("config", row.config), provider)
    raw_refs = body.get("secretRefs") if row is None else body.get("secretRefs", row.secret_refs)
    refs = dict(raw_refs or {})
    for env_name, ref_id in refs.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(env_name)):
            raise ValueError(f"密钥注入变量名不合法：{env_name}")
        secret = await session.get(am.SecretReference, str(ref_id))
        if secret is None or not secret.enabled:
            raise ValueError(f"密钥引用不存在或已停用：{ref_id}")
        if secret.org_id is not None and secret.org_id != repo_row.org_id:
            raise ValueError(f"密钥引用不属于这个仓库的组织：{ref_id}")
    if row is None:
        row = am.DeploymentTarget(repo_id=repo_id, environment_id=env_id,
                                  name=_text(body.get("name"), 100) or env_row.name,
                                  provider=provider)
        session.add(row)
    else:
        row.repo_id, row.environment_id, row.provider = repo_id, env_id, provider
        if "name" in body:
            row.name = _text(body.get("name"), 100) or row.name
    row.config = config
    row.secret_refs = {str(k): str(v) for k, v in refs.items()}
    if "runnerSelector" in body:
        row.runner_selector = _selector(body.get("runnerSelector"))
    if "healthChecks" in body:
        row.health_checks = _checks(body.get("healthChecks"))
    if "rollback" in body:
        row.rollback = _rollback(body.get("rollback"))
    if "enabled" in body:
        row.enabled = bool(body.get("enabled"))
    await session.commit()
    await session.refresh(row)
    return row


async def delete_target(session: AsyncSession, row: am.DeploymentTarget) -> None:
    used = await session.scalar(select(func.count(am.DeploymentRun.id)).where(
        am.DeploymentRun.target_id == row.id))
    if used:
        raise ValueError("这个部署目标已有运行历史，只能停用，不能删除")
    await session.delete(row)
    await session.commit()
