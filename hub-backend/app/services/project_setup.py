"""Project-centred automation setup.

The domain still keeps plugins, approval policies, environments and runners independent.  This
service is the product-facing composition layer: an administrator chooses the delivery outcome,
and SoduWork selects a safe built-in workflow and reports the few external facts it cannot invent.
"""
from __future__ import annotations

import asyncio
import json
import re
import uuid
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import (approval_routing, code_creds, environment_service, plugin_service,
               preflight_evidence, release_control, runner_hub, workflow_runs)


MODES = {
    "development": {
        "label": "完成代码修复",
        "summary": "AI 明确边界、修改自测并独立审查，系统自动合并到目标分支；本流程不触发环境发布",
        "pluginKey": "engineering-delivery",
        "requiresRepository": True,
        "requiresDelivery": False,
        "recommended": True,
        "destination": "代码合并到项目目标分支",
        "journey": [
            {"label": "明确修复边界", "actor": "AI"},
            {"label": "创建需求分支", "actor": "AI"},
            {"label": "修改与自测", "actor": "AI"},
            {"label": "隔离质量检查", "actor": "系统"},
            {"label": "独立代码审查", "actor": "AI"},
            {"label": "自动合并", "actor": "系统"},
            {"label": "仓库回执", "actor": "系统"},
        ],
    },
    "standard": {
        "label": "开发新功能并上线",
        "summary": "确认需求后由 AI 完整开发、独立审查并自动合并，再按项目环境发布、健康检查、业务验收和交付事实核对",
        "pluginKey": "software-delivery",
        "requiresRepository": True,
        "requiresDelivery": True,
        "recommended": False,
        "journey": [
            {"label": "需求规格与执行预检", "actor": "AI"},
            {"label": "确认范围", "actor": "你"},
            {"label": "开发与自测", "actor": "AI"},
            {"label": "质量检查", "actor": "系统"},
            {"label": "独立代码审查", "actor": "AI"},
            {"label": "自动合并与发布", "actor": "系统"},
            {"label": "环境健康检查", "actor": "系统"},
            {"label": "业务验收", "actor": "你"},
            {"label": "交付事实核对", "actor": "系统"},
        ],
    },
    "validation": {
        "label": "修复问题并发布",
        "summary": "稳定复现本轮问题，AI 修复并独立审查，自动发布、回归检查、业务验收后核对交付事实",
        "pluginKey": "project-validation-release",
        "requiresRepository": True,
        "requiresDelivery": True,
        "recommended": False,
        "journey": [
            {"label": "稳定复现与执行预检", "actor": "AI"},
            {"label": "修复与自测", "actor": "AI"},
            {"label": "质量检查", "actor": "系统"},
            {"label": "独立代码审查", "actor": "AI"},
            {"label": "自动合并与发布", "actor": "系统"},
            {"label": "发布后回归检查", "actor": "系统"},
            {"label": "业务验收", "actor": "你"},
            {"label": "交付事实核对", "actor": "系统"},
        ],
    },
    "prototype": {
        "label": "整理需求并做原型",
        "summary": "把零散想法整理清楚，交付一个可以直接点击体验的 HTML 原型",
        "pluginKey": "product-prototype",
        "requiresRepository": False,
        "requiresDelivery": False,
        "recommended": False,
        "destination": "可直接打开的产品原型",
        "journey": [
            {"label": "整理需求", "actor": "AI"},
            {"label": "生成原型", "actor": "AI"},
            {"label": "自动验货", "actor": "系统"},
            {"label": "验收原型", "actor": "你"},
            {"label": "交付成品", "actor": "系统"},
        ],
    },
}


def mode_options() -> list[dict]:
    return [{"id": key, **value} for key, value in MODES.items()]


def _version_key(value: str) -> tuple:
    return tuple((0, int(x)) if x.isdigit() else (1, x.lower())
                 for x in re.split(r"[.-]", str(value or "0")))


async def _plugin_version(session: AsyncSession, key: str,
                          org_id: str | None) -> tuple[am.Plugin | None, am.PluginVersion | None]:
    rows = list((await session.execute(select(am.Plugin).where(
        am.Plugin.key == key,
        (am.Plugin.org_id == org_id) | am.Plugin.org_id.is_(None),
    ))).scalars().all())
    plugin = next((x for x in rows if org_id and x.org_id == org_id),
                  next((x for x in rows if x.org_id is None), None))
    if plugin is None:
        return None, None
    versions = list((await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == plugin.id
    ))).scalars().all())
    version = max(versions, key=lambda x: _version_key(x.version), default=None)
    return plugin, version


def _actions(workflow: dict) -> set[str]:
    out = set()
    for node in list(dict(workflow or {}).get("nodes") or []):
        if not isinstance(node, dict):
            continue
        kind, cfg = str(node.get("type") or ""), dict(node.get("config") or {})
        if kind == "spec":
            out.add("baseline")
        elif kind == "human_review":
            out.add(str(cfg.get("action") or "review"))
        elif kind == "approval":
            out.add(str(cfg.get("action") or "merge"))
    return out


def _check(key: str, label: str, ok: bool, detail: str, *, fixable: bool = False,
           advanced: str = "") -> dict:
    return {"key": key, "label": label, "ok": bool(ok), "detail": detail,
            "fixable": bool(fixable and not ok), "advanced": advanced}


def _profile_config(profile: am.ProjectAutomationProfile | None) -> dict:
    return dict((profile.config if profile is not None else {}) or {})


def _source_probe_fingerprint(repo: models.Repo,
                              client: models.Client | None) -> str:
    """Bind read-access evidence to the exact owner device and credentials used."""
    return preflight_evidence.fingerprint({
        "repository": environment_service.repo_probe_fingerprint(repo),
        "clientId": str(client.id if client is not None else ""),
        "credentials": code_creds.probe_fingerprint(client),
    })


def _selected_owner_client(profile: am.ProjectAutomationProfile | None,
                           clients: list[models.Client]) -> tuple[models.Client | None, str]:
    """Resolve one deterministic personal execution device.

    A saved choice is authoritative and never falls through to another machine. Legacy projects
    with exactly one active device remain usable; once a person owns multiple devices the admin
    must choose explicitly instead of relying on last-seen ordering.
    """
    configured_id = str(_profile_config(profile).get("executionClientId") or "").strip()
    if configured_id:
        return next((row for row in clients if row.id == configured_id), None), "configured"
    if len(clients) == 1:
        return clients[0], "single"
    return None, "multiple" if clients else "missing"


def _workflow_agent_kinds(workflow: dict, binding: am.PluginBinding | None) -> list[str]:
    binding_config = dict((binding.config if binding else {}) or {})
    kinds = []
    for node in list(dict(workflow or {}).get("nodes") or []):
        if not isinstance(node, dict) or str(node.get("type") or "") not in ("ai", "ai_review"):
            continue
        route = workflow_runs.execution_route(
            {}, binding_config, dict(node.get("config") or {}), str(node.get("key") or ""))
        kind = str(route.get("agentKind") or "").strip()
        if kind and kind not in kinds:
            kinds.append(kind)
    default_kind = str(binding_config.get("agentKind") or "local:pi").strip()
    return kinds or ([default_kind] if default_kind else [])


def _client_execution_option(client: models.Client) -> dict:
    runner = runner_hub.for_client(client.id)
    online = bool(runner and runner_hub.can_dispatch(runner))
    agents = [{"key": str(item.get("key") or ""),
               "name": str(item.get("name") or item.get("key") or ""),
               "version": str(item.get("version") or "")}
              for item in list(getattr(runner, "agents", []) or [])
              if isinstance(item, dict) and str(item.get("key") or "").strip()]
    return {
        "id": client.id,
        "name": client.name or client.id,
        "online": online,
        "runnerId": str(getattr(runner, "id", "") or "") if runner else "",
        "host": str(getattr(runner, "host", "") or "") if runner else "",
        "agents": agents,
    }


def _execution_readiness(selected: models.Client | None, required_kinds: list[str]) -> dict:
    if selected is None:
        return {"ok": False, "detail": "尚未选择负责人的默认承办设备", "runner": None,
                "missing": list(required_kinds)}
    runner = runner_hub.for_client(selected.id)
    if runner is None or not runner_hub.can_dispatch(runner):
        return {"ok": False,
                "detail": f"{selected.name or selected.id} 的客户端 Runner 当前不在线",
                "runner": runner, "missing": list(required_kinds)}
    installed = {str(item.get("key") or "") for item in (runner.agents or [])
                 if isinstance(item, dict)}
    unsupported = [kind for kind in required_kinds if not kind.startswith("local:")]
    missing = [kind for kind in required_kinds
               if kind.startswith("local:") and kind[6:] not in installed]
    if unsupported:
        return {"ok": False,
                "detail": "员工需求只能使用承办人设备上的 Agent，当前流程仍配置了托管底座",
                "runner": runner, "missing": unsupported + missing}
    if missing:
        labels = "、".join(kind[6:] for kind in missing)
        return {"ok": False,
                "detail": f"{selected.name or selected.id} 尚未安装或启用 {labels}",
                "runner": runner, "missing": missing}
    labels = "、".join(kind[6:] for kind in required_kinds) or "Agent"
    return {"ok": True,
            "detail": f"需求固定由 {selected.name or selected.id} 上的 {labels} 执行",
            "runner": runner, "missing": []}


_DEFAULT_POLICY = {
    "baseline": release_control.POLICY_BASELINE,
    "review": release_control.POLICY_REVIEW,
    "merge": release_control.POLICY_MERGE,
    "uat": release_control.POLICY_UAT,
    "deploy": release_control.POLICY_PRODUCTION,
}


async def _approval_plan(session: AsyncSession, project: models.Project,
                         owner: models.User | None, repos: list[models.Repo],
                         workflow: dict, *, include_delivery: bool = True) -> list[dict]:
    """Prove that every human gate can be assigned before a workflow is started."""
    if owner is None:
        return []
    owner_clients = list((await session.execute(select(models.Client).where(
        models.Client.user_ref == owner.id
    ).order_by(models.Client.created_at))).scalars().all())
    task = models.Task(
        id=f"setup-preview-{project.id}", title=f"{project.name} 交付预检",
        project_id=project.id, repo_id=repos[0].id if repos else "",
        owner_client_id=owner_clients[0].id if owner_clients else None,
        created_by=owner.id, requester_user_id=owner.id,
    )
    gates: list[tuple[str, str, str, str]] = [
        (action, "", _DEFAULT_POLICY.get(action, release_control.POLICY_REVIEW), "")
        for action in sorted(_actions(workflow))
    ]
    if include_delivery:
        repo_ids = {repo.id for repo in repos}
        targets = list((await session.execute(select(am.DeploymentTarget).where(
            am.DeploymentTarget.repo_id.in_(repo_ids or {"__none__"}),
            am.DeploymentTarget.enabled.is_(True),
        ))).scalars().all())
        envs = {row.id: row for row in (await session.execute(select(am.Environment).where(
            am.Environment.id.in_({target.environment_id for target in targets} or {"__none__"})
        ))).scalars().all()}
        for env in envs.values():
            policy = environment_service.promotion_policy(env.promotion_policy)
            if policy.get("requiresApproval"):
                gates.append(("deploy", env.id,
                              env.approval_policy_id or release_control.POLICY_PRODUCTION,
                              env.name))
            if policy.get("requiresAcceptance"):
                gates.append(("uat", env.id,
                              env.acceptance_policy_id or release_control.POLICY_UAT,
                              env.name))
    plan = []
    seen = set()
    for action, environment_id, policy_id, environment_name in gates:
        key = (action, environment_id, policy_id)
        if key in seen:
            continue
        seen.add(key)
        policy = await session.get(am.ApprovalPolicy, policy_id)
        if policy is None or not policy.enabled:
            plan.append({"action": action, "environmentId": environment_id,
                         "environmentName": environment_name, "policyId": policy_id,
                         "policyName": "", "required": 1, "available": 0,
                         "candidates": [], "ok": False,
                         "error": "审批职责不存在或已停用"})
            continue
        rules = dict(policy.rules or {})
        allowed_actions = set(str(x) for x in rules.get("actions") or [])
        preview = await approval_routing.preview_assignments(session, task, action, rules)
        valid_action = not allowed_actions or action in allowed_actions
        plan.append({**preview, "environmentId": environment_id,
                     "environmentName": environment_name, "policyId": policy.id,
                     "policyName": policy.name, "ok": bool(preview["ok"] and valid_action),
                     **({"error": "这项职责没有覆盖当前动作"} if not valid_action else {})})
    return plan


async def preflight(session: AsyncSession, project: models.Project,
                    allowed_clients: set[str], requested_mode: str = "") -> dict:
    """Run explicit, read-only probes for source access and every deployment target."""
    from . import ai_remote

    repos = list((await session.execute(select(models.Repo).where(
        models.Repo.project_id == project.id
    ).order_by(models.Repo.created_at))).scalars().all())
    profile = await session.get(am.ProjectAutomationProfile, project.id)
    owner = await session.get(models.User, project.owner_user_id) if project.owner_user_id else None
    clients = list((await session.execute(select(models.Client).where(
        models.Client.user_ref == (owner.id if owner else "__none__"),
        models.Client.auth_state == "active",
        models.Client.revoked_at.is_(None),
    ).order_by(models.Client.created_at))).scalars().all())
    clients = [row for row in clients if row.id in allowed_clients]
    selected_client, _selection_source = _selected_owner_client(profile, clients)
    allowed_orgs = await environment_service.runner_orgs_for_org(session, project.org_id)
    runner = runner_hub.for_client(selected_client.id) if selected_client else None
    if (runner is not None and (not runner_hub.can_dispatch(runner) or
            not runner_hub.supports_capabilities(runner, ["repository", "terminal"]))):
        runner = None
    credential_client = selected_client
    source_results = []
    for repo in repos:
        current = _source_probe_fingerprint(repo, credential_client)
        target = str(repo.merge_branch or repo.default_branch or "")
        if not (repo.git_url or "").strip() or not target:
            result = {"ok": False, "error": "仓库地址或目标分支没有配置"}
        elif runner is None:
            result = {"ok": False, "error": "没有可用于读取代码仓库的在线 Runner"}
        else:
            result = await asyncio.to_thread(
                ai_remote.git_probe_sync,
                {"provider": "runner", "runnerId": runner.id},
                {"gitUrl": repo.git_url, "target": target,
                 "git": code_creds.resolve(credential_client) if credential_client else {},
                 "taskId": f"preflight-{repo.id}"})
        summary = str(result.get("error") or (
            f"已从 {runner.host} 读取 {target}" if result.get("ok") and runner else
            "代码仓库预检通过"))
        evidence = await preflight_evidence.record(
            session, subject_kind="repository", subject_id=repo.id,
            check_kind="scm.read", config_fingerprint=current,
            ok=bool(result.get("ok")), summary=summary,
            executor_id=runner.id if runner else "",
            executor_name=runner.host if runner else "", detail=result)
        source_results.append({"repoId": repo.id, "repoName": repo.name,
                               **preflight_evidence.api(evidence, current)})
    await session.commit()

    target_results = []
    allowed_orgs = await environment_service.runner_orgs_for_org(session, project.org_id)
    selected_mode = (requested_mode if requested_mode in MODES else
                     profile.mode if profile and profile.mode in MODES else "standard")
    if MODES[selected_mode]["requiresDelivery"]:
        targets = list((await session.execute(select(am.DeploymentTarget).where(
            am.DeploymentTarget.repo_id.in_({repo.id for repo in repos} or {"__none__"}),
            am.DeploymentTarget.enabled.is_(True),
        ).order_by(am.DeploymentTarget.created_at))).scalars().all())
        for target_row in targets:
            result = await environment_service.probe_target(
                session, target_row, allowed_clients, allowed_orgs)
            target_results.append({"targetId": target_row.id, "targetName": target_row.name,
                                   "ok": bool(result.get("ok")),
                                   "error": str(result.get("error") or ""),
                                   "probe": result.get("probe") or {}})
    refreshed = await status(session, project, allowed_clients, requested_mode)
    refreshed["preflight"] = {
        "ok": all(x.get("ok") for x in source_results + target_results),
        "sources": source_results, "targets": target_results,
    }
    return refreshed


async def status(session: AsyncSession, project: models.Project,
                 allowed_clients: set[str] | None, requested_mode: str = "") -> dict:
    allowed_orgs = await environment_service.runner_orgs_for_org(
        session, project.org_id)
    profile = await session.get(am.ProjectAutomationProfile, project.id)
    project_bindings = list((await session.execute(select(am.PluginBinding).where(
        am.PluginBinding.project_id == project.id,
        am.PluginBinding.enabled.is_(True),
    ).order_by(am.PluginBinding.updated_at.desc()))).scalars().all())
    if requested_mode in MODES:
        mode = requested_mode
    elif profile and profile.enabled and profile.mode in MODES:
        mode = profile.mode
    else:
        plugin_ids = {x.plugin_id for x in project_bindings}
        plugins = list((await session.execute(select(am.Plugin).where(
            am.Plugin.id.in_(plugin_ids or {"__none__"})
        ))).scalars().all())
        plugin_keys = {x.id: x.key for x in plugins}
        recommended_mode = next(
            (key for key, value in MODES.items() if value.get("recommended")), "standard")
        mode = next((key for key, spec in MODES.items() if any(
            plugin_keys.get(x.plugin_id) == spec["pluginKey"] for x in project_bindings)),
            recommended_mode)
    spec = MODES[mode]
    catalog_plugin, catalog_version = await _plugin_version(
        session, spec["pluginKey"], project.org_id)
    plugin, version = catalog_plugin, catalog_version
    binding = None
    if profile and profile.binding_id:
        candidate = await session.get(am.PluginBinding, profile.binding_id)
        if candidate and candidate.project_id == project.id and candidate.enabled:
            binding = candidate
    if binding is not None:
        bound_plugin = await session.get(am.Plugin, binding.plugin_id)
        bound_version = await session.get(am.PluginVersion, binding.version_id)
        bound_scope_ok = bool(
            bound_plugin and
            (bound_plugin.org_id is None or bound_plugin.org_id == project.org_id) and
            binding.org_id == project.org_id
        )
        if (not bound_plugin or not bound_version or
                bound_version.plugin_id != bound_plugin.id or
                bound_plugin.key != spec["pluginKey"] or not bound_scope_ok):
            binding = None
        else:
            # Profiles pin immutable approved versions. A newer catalog release
            # must not make an intentionally pinned project method look absent.
            plugin, version = bound_plugin, bound_version
    if binding is None and catalog_plugin is not None:
        binding = next(
            (x for x in project_bindings
             if x.plugin_id == catalog_plugin.id and x.org_id == project.org_id), None)
        if binding is not None:
            bound_version = await session.get(am.PluginVersion, binding.version_id)
            if bound_version and bound_version.plugin_id == catalog_plugin.id:
                plugin, version = catalog_plugin, bound_version

    repos = list((await session.execute(select(models.Repo).where(
        models.Repo.project_id == project.id
    ).order_by(models.Repo.created_at))).scalars().all())
    owner = await session.get(models.User, project.owner_user_id) if project.owner_user_id else None
    owner_ok = bool(owner and owner.is_active)
    owner_clients = list((await session.execute(select(models.Client).where(
        models.Client.user_ref == (owner.id if owner_ok else "__none__"),
        models.Client.auth_state == "active",
        models.Client.revoked_at.is_(None),
    ).order_by(models.Client.last_seen_at.desc(), models.Client.created_at,
               models.Client.id))).scalars().all())
    if allowed_clients is not None:
        owner_clients = [row for row in owner_clients if row.id in allowed_clients]
    target_client, selection_source = _selected_owner_client(profile, owner_clients)
    configured_client_id = str(_profile_config(profile).get("executionClientId") or "")
    required_agent_kinds = _workflow_agent_kinds(
        version.workflow if version else {}, binding)
    execution = _execution_readiness(target_client, required_agent_kinds)
    owner_client_ok = target_client is not None
    credential_state = code_creds.api_view(target_client) if target_client else {}
    credential_ok = (not spec["requiresRepository"] or
                     bool(target_client and credential_state.get("ready")))
    repo_ready = [x for x in repos if (x.git_url or "").strip() and
                  (not spec["requiresRepository"] or (x.merge_branch or x.default_branch or "").strip())]
    source_evidence = await preflight_evidence.get_many(
        session, "repository", {row.id for row in repo_ready}, "scm.read")
    source_probe = {row.id: preflight_evidence.api(
        source_evidence.get(row.id), _source_probe_fingerprint(row, target_client))
        for row in repo_ready}
    verified_repos = [row for row in repo_ready if source_probe[row.id]["ok"]]
    source_ok = owner_ok and owner_client_ok and credential_ok and (
        not spec["requiresRepository"] or
        (bool(repo_ready) and len(verified_repos) == len(repo_ready)))
    if not owner_ok:
        source_detail = "缺少项目负责人"
    elif not owner_clients:
        source_detail = "项目负责人还没有可接收需求的 SoduWork 客户端"
    elif target_client is None and configured_client_id:
        source_detail = "原来选择的承办设备已失效或不再属于项目负责人，请重新选择"
    elif target_client is None:
        source_detail = (f"项目负责人有 {len(owner_clients)} 台可用设备，"
                         "请明确选择本项目默认在哪台电脑执行")
    elif spec["requiresRepository"] and not repo_ready:
        source_detail = "还没有配置仓库地址和目标分支"
    elif spec["requiresRepository"] and not credential_ok:
        source_detail = str(credential_state.get("why") or
                            "项目负责人的代码提交身份和推送凭据尚未配置")
    elif spec["requiresRepository"] and len(verified_repos) != len(repo_ready):
        source_detail = (f"{len(verified_repos)}/{len(repo_ready)} 个代码仓库已从真实 Runner "
                         "测通；其余仓库尚未探测或配置已变化")
    else:
        source_detail = (f"{len(verified_repos)} 个代码仓库已测通；负责人 "
                         f"{owner.display_name or owner.username}，承办设备 "
                         f"{target_client.name or target_client.id}")

    version_ready = bool(plugin and version and plugin.enabled and version.enabled and
                         version.trust_state == "approved")
    binding_ready = bool(binding and plugin and version and binding.plugin_id == plugin.id and
                         binding.version_id == version.id and binding.enabled)
    method_ok = version_ready and binding_ready and bool(profile and profile.enabled and
                                                          profile.mode == mode and
                                                          profile.binding_id == binding.id)
    method_detail = (f"已启用「{plugin.name}」v{version.version}"
                     if method_ok else f"系统可自动启用「{spec['label']}」的安全版本")

    approval_plan = await _approval_plan(
        session, project, owner if owner_ok else None, repo_ready,
        version.workflow if version else {},
        include_delivery=bool(spec["requiresDelivery"]))
    review_ok = owner_ok and all(item.get("ok") for item in approval_plan)
    blocked_gate = next((item for item in approval_plan if not item.get("ok")), None)
    review_detail = (f"{len(approval_plan)} 个人工关卡均有足够人员承接" if review_ok else
                     "缺少可用负责人" if not owner_ok else
                     ((blocked_gate or {}).get("environmentName") or
                      (blocked_gate or {}).get("policyName") or "人工关卡") +
                     f"需要 {(blocked_gate or {}).get('required', 1)} 人，"
                     f"当前只有 {(blocked_gate or {}).get('available', 0)} 人可处理")

    chain_results = []
    if spec["requiresDelivery"]:
        for repo in repo_ready:
            chain_results.append(await environment_service.preflight_chain(
                session, repo, allowed_clients, require_online=True,
                allowed_orgs=allowed_orgs))
        environment_ok = bool(chain_results) and all(x.get("ok") for x in chain_results)
        blockers = [str(item.get("message") or "") for row in chain_results
                    for item in row.get("blockers") or []]
        environment_detail = ("发布环境、健康检查和交付边界已经连通" if environment_ok else
                              blockers[0] if blockers else "还没有为代码仓库接入发布目标")
    else:
        environment_ok, environment_detail = True, "该交付方式不需要部署环境"

    runner_ok = bool(execution["ok"])
    delivery_runner_ok = True
    if spec["requiresDelivery"]:
        delivery_runner_ok = bool(chain_results) and all(
            all(stage.get("runnerReady") for stage in row.get("stages") or [])
            for row in chain_results)
        runner_ok = runner_ok and delivery_runner_ok
    runner_detail = str(execution["detail"])
    if execution["ok"] and not delivery_runner_ok:
        runner_detail = "个人 AI 执行设备已就绪，但发布环境的 Runner 尚未全部就绪"

    checks = [
        _check("source", "工程与负责人", source_ok, source_detail,
               advanced="projects"),
        _check("method", "AI 工作方法", method_ok, method_detail,
               fixable=bool(plugin and version and plugin.source_kind == "builtin"),
               advanced="plugin"),
        _check("review", "人工把关", review_ok, review_detail,
               advanced="projects" if not owner_ok else "approval"),
        _check("environment", "交付目标", environment_ok, environment_detail,
               advanced="environment"),
        _check("runner", "执行节点", runner_ok, runner_detail, advanced="environment"),
    ]
    environment_path = []
    seen_environments = set()
    for chain in chain_results:
        for stage in chain.get("stages") or []:
            stage_id = str(stage.get("id") or stage.get("key") or stage.get("name") or "")
            if not stage_id or stage_id in seen_environments:
                continue
            seen_environments.add(stage_id)
            environment_path.append({
                "id": stage_id,
                "name": str(stage.get("name") or stage.get("key") or "发布环境"),
                "ready": bool(stage.get("runnerReady") and stage.get("probeReady")),
                "delivery": bool(stage.get("marksDelivery")),
            })
    first_missing = next((x for x in checks if not x["ok"]), None)
    launch_repos = repo_ready if spec["requiresRepository"] else []
    execution_options = [_client_execution_option(row) for row in owner_clients]
    return {
        "project": {"id": project.id, "name": project.name},
        "mode": mode, "modes": mode_options(), "ready": all(x["ok"] for x in checks),
        "checks": checks,
        "journey": list(spec.get("journey") or []),
        "environmentPath": environment_path,
        "nextAction": first_missing,
        "canAutoConfigure": bool(owner_ok and any(x["fixable"] for x in checks)),
        "autoFixCount": sum(x["fixable"] for x in checks),
        "canPreflight": bool(owner_ok and repo_ready and credential_ok and
                             execution.get("runner") and
                             (not spec["requiresDelivery"] or chain_results)),
        "sourceProbes": source_probe,
        "approvalPlan": approval_plan,
        "profile": {"bindingId": profile.binding_id, "enabled": profile.enabled,
                    "executionClientId": configured_client_id}
        if profile else None,
        "assignment": {
            "ownerId": owner.id if owner_ok else "",
            "ownerName": (owner.display_name or owner.username) if owner_ok else "",
            "clientId": target_client.id if target_client else "",
            "clientName": (target_client.name or target_client.id) if target_client else "",
            "selectionSource": selection_source,
            "codeAccount": credential_state,
            "requiresSelection": bool(owner_ok and len(owner_clients) > 1 and
                                       not configured_client_id),
            "agentKinds": required_agent_kinds,
            "devices": [{**item, "selected": item["id"] == (
                target_client.id if target_client else "")} for item in execution_options],
        },
        "launch": {
            "ownerId": owner.id if owner_ok else "",
            "ownerName": (owner.display_name or owner.username) if owner_ok else "",
            "clientId": target_client.id if target_client else "",
            "clientName": (target_client.name or target_client.id) if target_client else "",
            "agentKinds": required_agent_kinds,
            "methodName": plugin.name if plugin else spec["label"],
            "methodVersion": version.version if version else "",
            "repositories": [{"id": row.id, "name": row.name,
                              "branch": row.merge_branch or row.default_branch or ""}
                             for row in launch_repos],
            "defaultRepoId": launch_repos[0].id if len(launch_repos) == 1 else "",
            "inputs": plugin_service.public_inputs(version.manifest or {}) if version else [],
        },
    }


def _request_id(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        return str(uuid.uuid4())
    try:
        return str(uuid.UUID(raw))
    except (ValueError, AttributeError) as exc:
        raise ValueError("启动标识不合法，请刷新后重试") from exc


async def launch(session: AsyncSession, project: models.Project,
                 allowed_clients: set[str] | None, requested_mode: str,
                 actor: models.User, body: dict) -> dict:
    """Create one project task and start its configured workflow as one product action.

    The task id is supplied by the caller as an idempotency key. A retry resumes the same task/run
    instead of creating another delivery. The setup projection remains the source of truth for
    owner, repository, binding and environment readiness.
    """
    from ..schemas import task_to_api
    from . import task_access, tasks as task_service, workflow_runs

    request_id = _request_id(body.get("requestId"))
    task = await session.get(models.Task, request_id)
    if task is not None and (task.project_id != project.id or task.created_by != actor.id):
        raise ValueError("启动标识已经被其他需求使用，请刷新后重试")
    if task is not None:
        existing_run = (await session.execute(select(am.WorkflowRun).where(
            am.WorkflowRun.task_id == task.id
        ).order_by(am.WorkflowRun.created_at.desc()).limit(1))).scalar_one_or_none()
        if existing_run is not None:
            return {"task": task_to_api(task),
                    "run": await workflow_runs.run_api(session, existing_run),
                    "reused": True, "mode": str(requested_mode or "")}

    setup = await status(session, project, allowed_clients, requested_mode)
    if not setup["ready"]:
        blocked = setup.get("nextAction") or {}
        raise ValueError(str(blocked.get("detail") or "这套交付方案尚未准备完成"))
    mode = str(setup["mode"])
    title = str(body.get("title") or "").strip()[:200]
    if not title:
        raise ValueError("请填写要交付的需求")
    note = str(body.get("note") or "").strip()[:20_000]
    inputs = body.get("inputs") or {}
    if not isinstance(inputs, dict) or len(json.dumps(inputs, ensure_ascii=False)) > 100_000:
        raise ValueError("工作流补充信息必须是小于 100KB 的对象")
    for field in setup["launch"].get("inputs") or []:
        if field.get("required") and inputs.get(field.get("key")) in (None, ""):
            raise ValueError("请填写工作流必填项：" + str(field.get("label") or field.get("key")))

    client_id = str(setup["launch"].get("clientId") or "")
    if not client_id:
        raise ValueError("项目负责人还没有可接收需求的 SoduWork 客户端")
    repo_id = str(body.get("repoId") or setup["launch"].get("defaultRepoId") or "")
    allowed_repos = {str(row.get("id") or "") for row in setup["launch"].get("repositories") or []}
    if MODES[mode]["requiresRepository"]:
        if not repo_id:
            raise ValueError("这个项目有多个代码仓库，请选择本次要修改的工程")
        if repo_id not in allowed_repos:
            raise ValueError("选择的代码仓库不属于当前交付方案")
    else:
        repo_id = ""

    reused = task is not None
    binding = await plugin_service.resolve_binding(
        session, task or SimpleNamespace(project_id=project.id, owner_client_id=client_id,
                                         repo_id=repo_id))
    if task is None:
        priority = str(body.get("priority") or "normal").lower()
        if priority not in {"low", "normal", "high", "critical"}:
            priority = "normal"
        await task_service.create_task(
            session, client_id, {
                "title": title, "note": note, "status": "todo",
                "priority": priority, "projectId": project.id, "repoId": repo_id,
                "tags": [MODES[mode]["label"]], "source": "项目交付",
            }, origin="dispatch", notify=False,
            creator=(actor.id, actor.display_name or actor.username), task_id=request_id)
        task = await session.get(models.Task, request_id)

    run = (await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.task_id == task.id
    ).order_by(am.WorkflowRun.created_at.desc()).limit(1))).scalar_one_or_none()
    if run is None:
        run = await workflow_runs.start(
            session, task, binding, inputs, actor_id=str(actor.id),
            instruction=note, repo_id=repo_id, notify=False)
    await session.refresh(task)
    task_api = task_to_api(task)
    if task.owner_client_id:
        actor_id = str(actor.id or "")
        arrival = "dispatch" if actor_id and actor_id != str(task.assignee_user_id or "") else ""
        await task_access.publish_task(
            session, task, "task.created", task_api,
            arrival=arrival, by=actor.display_name or actor.username or "")
    return {"task": task_api, "run": await workflow_runs.run_api(session, run),
            "reused": reused, "mode": mode}


async def apply(session: AsyncSession, project: models.Project, mode: str,
                actor: models.User, config: dict | None = None) -> am.ProjectAutomationProfile:
    if mode not in MODES:
        raise ValueError("请选择一种交付方式")
    requested = dict(config or {})
    owner = await session.get(models.User, project.owner_user_id) if project.owner_user_id else None
    if owner is None or not owner.is_active:
        raise ValueError("请先为项目选择一位有效负责人；SoduWork 不会用当前管理员代替业务负责人")
    spec = MODES[mode]
    plugin, version = await _plugin_version(session, spec["pluginKey"], project.org_id)
    if plugin is None or version is None:
        raise ValueError("这套交付方式尚未安装")
    if plugin.source_kind != "builtin":
        raise ValueError("企业自定义插件必须先完成安全审查，不能自动启用")
    if version.trust_state != "approved" or not version.enabled or not plugin.enabled:
        await plugin_service.approve_version(
            session, version, True, actor.display_name or actor.username)
    profile = await session.get(am.ProjectAutomationProfile, project.id)
    profile_config = _profile_config(profile)
    execution_client_id = str(
        requested.get("executionClientId")
        if "executionClientId" in requested else profile_config.get("executionClientId") or ""
    ).strip()
    owner_clients = list((await session.execute(select(models.Client).where(
        models.Client.user_ref == owner.id,
        models.Client.auth_state == "active",
        models.Client.revoked_at.is_(None),
    ).order_by(models.Client.created_at, models.Client.id))).scalars().all())
    if not execution_client_id and len(owner_clients) == 1:
        execution_client_id = owner_clients[0].id
    selected_client = next(
        (row for row in owner_clients if row.id == execution_client_id), None)
    if selected_client is None:
        if execution_client_id:
            raise ValueError("选择的承办设备不属于项目负责人或已经停用")
        if len(owner_clients) > 1:
            raise ValueError("项目负责人有多台设备，请明确选择默认承办设备")
        raise ValueError("项目负责人还没有已激活的 SoduWork 客户端")
    requested_kind = str(requested.get("agentKind") or "").strip()
    if requested_kind:
        from . import ai_exec
        allowed_kinds = {str(item.get("key") or "") for item in ai_exec.agent_kinds()
                         if str(item.get("key") or "").startswith("local:")}
        if requested_kind not in allowed_kinds:
            raise ValueError("项目默认 Agent 不受支持；员工需求只能使用本人设备上的 Agent")
    bindings = list((await session.execute(select(am.PluginBinding).where(
        am.PluginBinding.project_id == project.id,
        am.PluginBinding.plugin_id == plugin.id,
    ).order_by(am.PluginBinding.updated_at.desc()))).scalars().all())
    binding = bindings[0] if bindings else None
    binding_config = dict((binding.config if binding else {}) or {})
    if requested_kind:
        node_overrides = dict(binding_config.get("nodeOverrides") or {})
        for node in list(dict(version.workflow or {}).get("nodes") or []):
            if not isinstance(node, dict) or str(node.get("type") or "") not in ("ai", "ai_review"):
                continue
            node_key = str(node.get("key") or "").strip()
            if not node_key:
                continue
            raw_override = dict(node_overrides.get(node_key) or {})
            execution = dict(raw_override.get("execution") or {})
            for key in ("model", "reasoningEffort", "fallbackMode", "runnerTags"):
                if key not in execution and key in raw_override:
                    execution[key] = raw_override[key]
            execution["agentKind"] = requested_kind
            node_overrides[node_key] = {"execution": execution}
        binding_config["nodeOverrides"] = node_overrides
    agent_kind = requested_kind or str(binding_config.get("agentKind") or "local:pi")
    body = {"versionId": version.id, "projectId": project.id,
            "orgId": project.org_id, "enabled": True,
            "config": {**binding_config, "agentKind": agent_kind}}
    binding = await plugin_service.save_binding(session, plugin, body, binding)
    if profile is None:
        profile = am.ProjectAutomationProfile(project_id=project.id)
        session.add(profile)
    profile.mode, profile.binding_id = mode, binding.id
    profile.enabled = True
    profile.config = {**profile_config, "executionClientId": execution_client_id,
                      "agentKind": agent_kind}
    profile.configured_by = actor.id
    await session.commit()
    await session.refresh(profile)
    return profile
