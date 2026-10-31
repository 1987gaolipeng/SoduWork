"""Plugin binding lifecycle, task applicability and safe employee projections.

Immutable package import/publication stays in plugin_service. Callers may inject
readiness at the public facade without replacing any process-wide domain state.
"""
from __future__ import annotations

import re
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import (plugin_audience, plugin_compat, plugin_packages,
               plugin_route_readiness, plugin_runtime, plugin_ui_contracts, rbac)
from .plugin_readiness import binding_readiness

_SECRET_WORD = re.compile(r"password|passwd|token|secret|private.?key|api.?key", re.I)


def _secret_path(value, path="") -> str:
    if isinstance(value, dict):
        for key, child in value.items():
            here = f"{path}.{key}" if path else str(key)
            if _SECRET_WORD.search(str(key)):
                return here
            hit = _secret_path(child, here)
            if hit:
                return hit
    elif isinstance(value, list):
        for idx, child in enumerate(value):
            hit = _secret_path(child, f"{path}[{idx}]")
            if hit:
                return hit
    return ""


async def save_binding(session: AsyncSession, plugin: am.Plugin, body: dict,
                       binding: am.PluginBinding | None = None, *,
                       commit: bool = True, flush: bool = True,
                       verify_readiness: bool = True, readiness_check=None) -> am.PluginBinding:
    version_id = str(body.get("versionId") or (binding.version_id if binding else ""))
    version = await session.get(am.PluginVersion, version_id)
    if version is None or version.plugin_id != plugin.id:
        raise ValueError("插件版本不存在")
    if version.trust_state != "approved" or not version.enabled:
        raise ValueError("这个插件版本还在隔离区，先审批启用")
    if binding is not None and binding.version_id != version.id:
        previous = await session.get(am.PluginVersion, binding.version_id)
        compatibility = plugin_compat.between(previous, version)
        if compatibility["level"] == "breaking" and not body.get("confirmBreaking"):
            raise ValueError("新版本包含破坏性变化；请查看升级影响并明确确认")
    raw_config = body.get("config") if binding is None else body.get("config", binding.config)
    config = dict(raw_config or {})
    from .workflow_route_policy import normalize_binding_execution
    config = normalize_binding_execution(config, version.workflow or {})
    declared_mcp = list(dict(version.capability_report or {}).get("mcpServers") or [])
    tool_grants = plugin_runtime.normalize_mcp_tools(config.get("mcpTools"), declared_mcp)
    if tool_grants:
        from . import plugin_mcp_gateway
        high_risk = sorted(
            f"{server}.{tool}" for server, tools in tool_grants.items() for tool in tools
            if plugin_mcp_gateway.tool_risk(tool) == "high")
        if high_risk and not bool(config.get("mcpHighRiskApproved")):
            raise ValueError("高风险 MCP 工具需要管理员明确确认：" + "、".join(high_risk[:10]))
    if tool_grants:
        config["mcpTools"] = tool_grants
    else:
        config.pop("mcpTools", None)
    if not tool_grants:
        config.pop("mcpHighRiskApproved", None)
    elif "mcpHighRiskApproved" in config:
        config["mcpHighRiskApproved"] = bool(config.get("mcpHighRiskApproved"))
    leaked = _secret_path(config)
    if leaked:
        raise ValueError(f"{leaked} 看起来是凭据；请改用 secretRefs")
    raw_refs = body.get("secretRefs") if binding is None else body.get("secretRefs", binding.secret_refs)
    refs = {str(k): str(v) for k, v in dict(raw_refs or {}).items() if v}
    declared_secrets = set(str(x) for x in
                           dict(version.capability_report or {}).get("secrets") or [])
    unknown_secrets = set(refs) - declared_secrets
    if unknown_secrets:
        raise ValueError("绑定包含插件未声明的密钥：" + "、".join(sorted(unknown_secrets)))
    project_raw = (body.get("projectId") if binding is None else
                   body.get("projectId", binding.project_id))
    project_id = str(project_raw or "")
    project = None
    if project_id:
        from .. import models
        project = await session.get(models.Project, project_id)
        if project is None:
            raise ValueError("绑定的项目不存在")
    # Built-in plugins are global, but bindings to enterprise projects must belong to the project's organization.
    # Otherwise ordinary organization projects cannot use those built-ins.
    # Historical project bindings were created before org ownership became mandatory and therefore
    # carry NULL.  On the first legitimate update, derive ownership from the bound project instead
    # of either blocking the upgrade forever or trusting a caller-supplied cross-tenant org id.
    requested_org = body.get("orgId") or plugin.org_id
    same_persisted_project = (
        binding is not None
        and str(binding.project_id or "") == project_id
    )
    if same_persisted_project and project is not None and project.org_id is not None:
        if body.get("orgId") is not None and body.get("orgId") != project.org_id:
            raise ValueError("插件绑定不能迁移到其他组织")
        # Repair historical NULL or stale organization data from the binding's persisted project.
        binding_org = project.org_id
    elif binding is not None and binding.org_id is not None:
        binding_org = binding.org_id
        if body.get("orgId") is not None and body.get("orgId") != binding_org:
            raise ValueError("插件绑定不能迁移到其他组织")
    else:
        binding_org = requested_org
    if project is not None and project.org_id is not None and binding_org is None:
        raise ValueError("绑定企业项目时必须明确组织归属")
    if plugin.org_id is not None and plugin.org_id != binding_org:
        raise ValueError("插件和绑定不属于同一个组织")
    if project is not None:
        if project.org_id is not None and project.org_id != binding_org:
            raise ValueError("绑定的项目和插件绑定不属于同一个组织")
    for _, ref_id in refs.items():
        ref = await session.get(am.SecretReference, str(ref_id))
        if ref is None or not ref.enabled:
            raise ValueError(f"密钥引用不可用：{ref_id}")
        if ref.provider != "runner-env":
            raise ValueError(f"插件运行只支持 Runner 环境变量密钥引用：{ref_id}")
        if ref.org_id is not None and ref.org_id != binding_org:
            raise ValueError(f"密钥引用不属于这个插件绑定的组织：{ref_id}")
    desired_enabled = bool(
        body.get("enabled", True) if binding is None
        else body.get("enabled", binding.enabled))
    if desired_enabled and verify_readiness:
        readiness = await (readiness_check or binding_readiness)(
            session, version, project, binding_org,
            secret_refs=refs, binding_config=config)
        if not readiness.get("ok"):
            blockers = [str(item) for item in readiness.get("blockers") or []]
            raise ValueError("启用前体检未通过：" +
                             "；".join(blockers[:8] or ["运行条件未就绪"]))

    if binding is None:
        binding = am.PluginBinding(
            plugin_id=plugin.id, version_id=version.id, org_id=binding_org,
            project_id=project_id, config=config,
            secret_refs={str(k): str(v) for k, v in refs.items()}, enabled=desired_enabled)
        session.add(binding)
    else:
        binding.version_id, binding.config = version.id, config
        binding.org_id = binding_org
        binding.secret_refs = {str(k): str(v) for k, v in refs.items()}
        if "projectId" in body:
            binding.project_id = project_id
        binding.enabled = desired_enabled
    if commit:
        await session.commit()
        await session.refresh(binding)
    elif flush:
        await session.flush()
    return binding


async def _task_user_id(session: AsyncSession, task) -> str:
    client_id = str(getattr(task, "owner_client_id", "") or "")
    client = await session.get(models.Client, client_id) if client_id else None
    return str(getattr(client, "user_ref", "") or "")


async def resolve_binding(session: AsyncSession, task, *, binding_id: str = "",
                          plugin_id: str = "", org_ids: set[str] | None = None,
                          entrypoint: str = "task"
                          ) -> am.PluginBinding:
    """Select an explicit plugin binding, preferring project-specific over organization-wide
    bindings without cross-tenant inference.
    """
    from . import environment_service
    task_org = await environment_service.task_org_id(session, task)
    # Match employee discovery: a company/parent binding is inherited by its
    # descendants, never by siblings or unrelated tenants. Explicit admin scope
    # remains an additional restriction, not a replacement for task ownership.
    task_orgs = await rbac.ancestor_org_ids(session, task_org) if task_org else set()
    # Use the project's explicit default binding in ordinary flows.
    # Respect explicit binding or plugin selections for advanced use and historical reruns.
    if not binding_id and not plugin_id and getattr(task, "project_id", None):
        profile = await session.get(
            am.ProjectAutomationProfile, str(getattr(task, "project_id", "") or ""))
        if profile is not None and profile.enabled:
            binding_id = str(profile.binding_id or "")
    if binding_id:
        row = await session.get(am.PluginBinding, binding_id)
    else:
        q = select(am.PluginBinding).where(am.PluginBinding.enabled.is_(True))
        if plugin_id:
            q = q.where(am.PluginBinding.plugin_id == plugin_id)
        project_id = str(getattr(task, "project_id", "") or "")
        candidates = list((await session.execute(q.order_by(
            am.PluginBinding.updated_at.desc()))).scalars().all())
        visible_orgs = org_ids
        candidates = [x for x in candidates if visible_orgs is None or
                      x.org_id is None or x.org_id in visible_orgs]
        candidates = [x for x in candidates if x.org_id is None or x.org_id in task_orgs]
        candidates = [x for x in candidates if not x.project_id or x.project_id == project_id]
        row = next((x for x in candidates if project_id and x.project_id == project_id),
                   candidates[0] if candidates else None)
    if row is None or not row.enabled:
        raise ValueError("没有找到适用于这条需求的已启用插件绑定")
    task_project = str(getattr(task, "project_id", "") or "")
    if row.project_id and row.project_id != task_project:
        raise ValueError("这个插件绑定不属于需求所在项目")
    if org_ids is not None and row.org_id is not None and row.org_id not in org_ids:
        raise ValueError("这个插件绑定不在你的组织范围内")
    if row.org_id is not None and row.org_id not in task_orgs:
        raise ValueError("这个插件绑定不属于需求所在组织")
    version = await session.get(am.PluginVersion, row.version_id)
    plugin = await session.get(am.Plugin, row.plugin_id)
    if not version or not plugin or not plugin.enabled or not version.enabled \
            or version.trust_state != "approved":
        raise ValueError("插件版本已经停用或撤销，请刷新后重试")
    if plugin.org_id is not None and plugin.org_id not in task_orgs:
        raise ValueError("这个插件不属于需求所在组织范围")
    allowed = await plugin_audience.allowed_version_ids(
        session, [version.id], await _task_user_id(session, task))
    if not plugin_audience.visible(version, allowed):
        raise ValueError("这个插件没有授权给需求负责人")
    capability = dict(version.capability_report or {})
    manifest = dict(version.manifest or {})
    ui = plugin_ui_contracts.public(manifest.get("ui"), manifest.get("setup"))
    entrypoints = plugin_ui_contracts.effective_entrypoints(
        manifest.get("entrypoints") or capability.get("entrypoints") or {}, ui,
        has_workflow=bool(capability.get("hasWorkflow", True)), jiyong=manifest.get("jiyong"))
    entrypoint = entrypoint if entrypoint in {"task", "automation"} else "task"
    default = bool(capability.get("hasWorkflow", True)) if entrypoint == "automation" else True
    if entrypoint == "automation":
        plugin_ui_contracts.require_unattended(ui, jiyong=manifest.get("jiyong"))
    if entrypoints.get(entrypoint, default) is False:
        label = "自动化" if entrypoint == "automation" else "需求"
        raise ValueError(f"这个能力包没有开放{label}入口")
    return row


def public_inputs(manifest: dict) -> list[dict]:
    """Return only client-fillable form definitions, excluding arbitrary plugin-package extension
    fields.
    """
    out = []
    for raw in list(dict(manifest or {}).get("inputs") or [])[:50]:
        if not isinstance(raw, dict):
            continue
        key = str(raw.get("key") or "").strip()[:64]
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", key):
            continue
        kind = str(raw.get("type") or "text").lower()
        kind = {"string": "text", "bool": "boolean", "enum": "select"}.get(kind, kind)
        if kind == "text" and raw.get("multiline"):
            kind = "textarea"
        if kind not in ("text", "textarea", "boolean", "number", "select"):
            kind = "text"
        item = {
            "key": key,
            "label": str(raw.get("label") or key).strip()[:100],
            "type": kind,
            "required": bool(raw.get("required")),
            "description": str(raw.get("description") or "").strip()[:300],
            "placeholder": str(raw.get("placeholder") or "").strip()[:180],
        }
        if kind == "select":
            item["options"] = [{
                "value": str(x.get("value") if isinstance(x, dict) else x)[:200],
                "label": str((x.get("label") if isinstance(x, dict) else x) or "")[:100],
            } for x in list(raw.get("options") or [])[:50]]
        if "default" in raw and isinstance(raw.get("default"), (str, int, float, bool)):
            item["default"] = raw.get("default")
        out.append(item)
    return out


def public_workflow_node(node: dict, binding_config: dict | None = None,
                         capability_report: dict | None = None) -> dict:
    """Return a portable route summary; never expose concrete Runner identities."""
    from .workflow_route_policy import execution_route

    node = dict(node or {})
    key = str(node.get("key") or "")[:64]
    node_type = str(node.get("type") or "")[:32]
    item = {
        "key": key,
        "type": node_type,
        "name": str(node.get("name") or key)[:100],
    }
    if node_type not in {"ai", "ai_review"}:
        return item

    binding_config = dict(binding_config or {})
    node_config = dict(node.get("config") or {})
    override = dict(dict(binding_config.get("nodeOverrides") or {}).get(key) or {})
    route = execution_route({}, binding_config, node_config, key)
    required = plugin_runtime.node_capabilities(
        node, dict(capability_report or {}))["runtime"]

    def declared(layer: dict, field: str) -> bool:
        nested = dict(layer.get("execution") or {})
        return bool(nested.get(field) or layer.get(field))

    def source(field: str) -> str:
        if declared(override, field):
            return "project"
        if declared(node_config, field):
            return "plugin"
        return "runtime"

    item["route"] = {
        "agentKind": str(route.get("agentKind") or "")[:40],
        "model": str(route.get("model") or "")[:160],
        "fallbackMode": str(route.get("fallbackMode") or "")[:20],
        "runnerTags": list(route.get("runnerTags") or [])[:20],
        "runtime": list(required)[:50],
        "agentSource": source("agentKind"),
        "modelSource": source("model"),
    }
    return item


async def available_bindings(
        session: AsyncSession, task, *,
        global_keys: set[str] | None = None,
        entrypoint: str = "task",
        run_context: dict | None = None) -> list[dict]:
    """List methods available at this entry point using safe summaries required for ordinary
    execution.
    """
    from . import environment_service

    task_org = await environment_service.task_org_id(session, task)
    task_orgs = await rbac.ancestor_org_ids(session, task_org) if task_org else set()
    project_id = str(getattr(task, "project_id", "") or "")
    project = await session.get(models.Project, project_id) if project_id else None
    profile = await session.get(am.ProjectAutomationProfile, project_id) if project_id else None
    rows = list((await session.execute(select(am.PluginBinding).where(
        am.PluginBinding.enabled.is_(True)
    ).order_by(am.PluginBinding.updated_at.desc()))).scalars().all())
    rows = [row for row in rows
            if (row.org_id is None or row.org_id in task_orgs)
            and (not row.project_id or row.project_id == project_id)]
    # Prefer project-specific bindings when an organization-wide binding exists for the same plugin.
    # Select the latest enabled binding to avoid duplicate cards.
    chosen = {}
    for row in sorted(rows, key=lambda item: not bool(item.project_id)):
        chosen.setdefault(row.plugin_id, row)
    rows = list(chosen.values())
    if not rows:
        return []

    plugins = {row.id: row for row in (await session.execute(select(am.Plugin).where(
        am.Plugin.id.in_({x.plugin_id for x in rows})
    ))).scalars().all()}
    versions = {row.id: row for row in (await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.id.in_({x.version_id for x in rows})
    ))).scalars().all()}
    allowed_versions = await plugin_audience.allowed_version_ids(
        session, versions.keys(), await _task_user_id(session, task))
    wanted_globals = ({str(key).strip() for key in global_keys if str(key).strip()}
                      if global_keys is not None else None)
    route_ctx = await plugin_route_readiness.context_for_task(session, task)
    out = []
    for binding in rows:
        plugin, version = plugins.get(binding.plugin_id), versions.get(binding.version_id)
        if not plugin or not version or not plugin.enabled or not version.enabled \
                or version.trust_state != "approved" \
                or (plugin.org_id is not None and plugin.org_id not in task_orgs) \
                or not plugin_audience.visible(version, allowed_versions):
            continue
        # Task creation prechecks only relevant organization-wide workflows while retaining project-specific workflows.
        # Other entry points can omit global_keys to retain the complete catalog.
        if (wanted_globals is not None and not binding.project_id
                and plugin.key not in wanted_globals):
            continue
        nodes = list(dict(version.workflow or {}).get("nodes") or [])[:100]
        cap = dict(version.capability_report or {})
        manifest = dict(version.manifest or {})
        has_workflow = bool(cap.get("hasWorkflow", True))
        ui = plugin_ui_contracts.public(manifest.get("ui"), manifest.get("setup"))
        entrypoints = plugin_ui_contracts.effective_entrypoints(
            manifest.get("entrypoints") or cap.get("entrypoints") or {}, ui,
            has_workflow=has_workflow, jiyong=manifest.get("jiyong"))
        entrypoint = entrypoint if entrypoint in {"task", "automation"} else "task"
        default = has_workflow if entrypoint == "automation" else True
        if entrypoints.get(entrypoint, default) is False:
            continue
        readiness = await plugin_route_readiness.catalog_check(
            session, version, project, task_org, secret_refs=binding.secret_refs,
            binding_config=binding.config, ctx=route_ctx,
            client_id=str(getattr(task, "owner_client_id", "") or ""), task=task,
            run_context=run_context)
        out.append({
            "bindingId": binding.id,
            "pluginId": plugin.id,
            # The plugin key is the stable workflow identifier.
            # Map inferred workflows by key rather than display name so renaming cannot change selection.
            "key": plugin.key,
            "name": plugin.name,
            "description": plugin.description or "",
            "version": version.version,
            "sourceKind": plugin.source_kind,
            "process": plugin_packages.process_profile(version.manifest or {}, cap),
            "projectSpecific": bool(binding.project_id),
            "isDefault": bool(profile and profile.enabled and
                              profile.binding_id == binding.id),
            "runnable": bool(readiness.get("ok")),
            "readiness": {
                "blockers": list(readiness.get("blockers") or [])[:12],
                "warnings": list(readiness.get("warnings") or [])[:12],
                "checks": list(readiness.get("checks") or [])[:12],
            },
            "agentRoutes": list(readiness.get("agentRoutes") or [])[:100],
            "agentKind": str(dict(binding.config or {}).get("agentKind") or "")[:64],
            "inputs": public_inputs(version.manifest or {}),
            "ui": ui,
            "entrypoints": entrypoints,
            "workflow": ([public_workflow_node(node, binding.config, cap)
                          for node in nodes if isinstance(node, dict)] if has_workflow else []),
            "capabilities": {
                "nodeTypes": list(cap.get("nodeTypes") or [])[:30],
                "skills": list(cap.get("skills") or [])[:50],
                "mcpServers": list(cap.get("mcpServers") or [])[:50],
                "secrets": list(cap.get("secrets") or [])[:50],
                "runtime": list(cap.get("runtime") or [])[:50],
                "environments": list(cap.get("environments") or [])[:30],
                "network": bool(cap.get("network")),
                "hasScript": bool(cap.get("hasScript")),
                "hasWorkflow": has_workflow,
                "executionMode": str(cap.get("executionMode") or
                                     ("workflow" if has_workflow else "direct")),
                "components": list(cap.get("components") or [])[:20],
                "componentCount": int(cap.get("componentCount") or 0),
                "permissionSummary": dict(cap.get("permissionSummary") or {}),
                "resultContract": list(cap.get("resultContract") or [])[:100],
                "evaluationCases": list(cap.get("evaluationCases") or [])[:20],
                "qualitySummary": dict(cap.get("qualitySummary") or {}),
            },
        })
    out.sort(key=lambda item: (not item["isDefault"], not item["projectSpecific"],
                               item["name"].lower()))
    return out
