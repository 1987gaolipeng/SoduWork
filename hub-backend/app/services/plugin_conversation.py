"""Resolve approved plugins into bounded, non-secret conversation guidance."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from . import plugin_audience, plugin_builtin, plugin_platforms, workflow_inputs

MAX_PLUGINS = 3
MAX_CONTEXT = 10_000


def _clip(value, limit: int) -> str:
    return " ".join(str(value or "").replace("\x00", "").split())[:limit]


def _block(value, limit: int) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _mcp_guidance(names) -> str:
    """Describe built-in and administrator-managed MCP dependencies separately."""
    normalized = list(dict.fromkeys(
        str(name or "").strip() for name in (names or [])
        if str(name or "").strip()))
    builtin = [name for name in normalized if plugin_builtin.is_virtual_mcp(name)]
    external = [name for name in normalized if not plugin_builtin.is_virtual_mcp(name)]
    parts = []
    if builtin:
        parts.append(
            "本轮使用 SoduWork 内置能力：" + "、".join(builtin) +
            "。这些能力由 SoduWork 直接提供，无需用户配置外部 MCP。")
    if external:
        parts.append(
            "本轮依赖的企业 MCP：" + "、".join(external) +
            "。只有当前员工已配置且本轮实际授权时才能调用；不可用时明确说明，不能假装成功。")
    return "\n".join(parts)




async def _plugin_context(session: AsyncSession, plugin: am.Plugin,
                          version: am.PluginVersion, binding: am.PluginBinding,
                          project_name: str = "",
                          preference_context: str = "",
                          resource_bundle: dict | None = None) -> tuple[str, list[dict]]:
    manifest = dict(version.manifest or {})
    workflow = dict(version.workflow or {})
    report = dict(version.capability_report or {})
    has_workflow = bool(report.get("hasWorkflow", True))
    nodes = ([node for node in list(workflow.get("nodes") or [])
              if isinstance(node, dict)][:50] if has_workflow else [])
    steps: list[dict] = []
    guides: list[str] = []
    deliverables: list[str] = []
    controls: list[str] = []
    for node in nodes:
        key = _clip(node.get("key"), 64)
        node_type = _clip(node.get("type"), 32)
        name = _clip(node.get("name") or key, 100)
        config = dict(node.get("config") or {})
        steps.append({"key": key, "type": node_type, "name": name})
        prompt = _block(config.get("prompt"), 2400)
        if prompt and node_type in {"ai", "ai_review", "spec"}:
            guides.append(f"- {name}：{prompt}")
        for output in [item for item in list(node.get("outputs") or []) if isinstance(item, dict)][:20]:
            label = _clip(output.get("label") or output.get("key") or "交付物", 120)
            kind = _clip(output.get("kind") or "artifact", 32)
            path = _clip(output.get("path"), 240)
            required = "必交" if output.get("required") else "可选"
            deliverables.append(
                f"- {name}：{label}（{kind}，{required}{'，' + path if path else ''}）")
        if node_type in {"spec", "human_review", "approval"}:
            summary = _clip(
                config.get("summary") or config.get("message") or config.get("action"), 600)
            controls.append(f"- {name}" + (f"：{summary}" if summary else ""))

    description = _clip(manifest.get("description") or plugin.description, 600)
    instructions = _block(manifest.get("instructions"), 4000)
    runtime = [str(x) for x in report.get("runtime") or []][:20]
    mcp_servers = [str(x) for x in report.get("mcpServers") or []][:20]
    quality_criteria: list[str] = []
    for case in list(report.get("evaluationCases") or [])[:10]:
        for criterion in list(dict(case or {}).get("criteria") or [])[:20]:
            text = _clip(criterion, 300)
            if text and text not in quality_criteria:
                quality_criteria.append(text)
            if len(quality_criteria) >= 20:
                break
        if len(quality_criteria) >= 20:
            break
    from . import plugin_package_resources
    skill_guidance = plugin_package_resources.index(resource_bundle or {})
    if resource_bundle is None and report.get("bundledSkills"):
        skill_guidance = "随包技能将在本轮执行前完整加载到执行机，预览摘要不能替代技能正文。"
    bundled_names = {str(row.get("name")) for row in report.get("bundledSkills") or []}
    external = (report.get("externalSkills") if "externalSkills" in report else
                sorted(set(report.get("skills") or []) - bundled_names))
    if external:
        # Preserve the organization's external-skill allow-list. The desktop
        # capability resolver provides those installed skills on the executor.
        await workflow_inputs.plugin_skills(session, version, list(external))
    scope = (f"项目“{project_name}”" if binding.project_id else
             "企业指定成员" if version.visibility == plugin_audience.USERS else
             "企业指定团队" if version.visibility == plugin_audience.ORG_UNITS else
             "当前企业")
    sequence = " → ".join(step["name"] for step in steps if step["name"])[:1200]
    parts = [
        f"你正在采用企业已审批插件《{_clip(manifest.get('name') or plugin.name, 120)}》"
        f"（版本 {version.version}）处理这一轮请求。",
        f"适用范围：{scope}。",
        f"用途：{description}" if description else "",
        ("这是对话内的快速采用：请遵循插件的方法、质量标准和步骤，但不要声称已经启动"
         "多 Agent 工作流、脚本、审批、合并或发布。需要这些受控动作时，应明确建议用户创建任务运行完整插件工作流。"
         if has_workflow else
         "这是可直接调用的企业能力包：请使用已经授权的 Skill、MCP 与工具完成当前请求，"
         "不要声称存在并未声明的工作流、审批或发布步骤。"),
        "工作方法：\n" + instructions if instructions else "",
        skill_guidance,
        preference_context,
        _mcp_guidance(mcp_servers),
        ("本轮需要的基础执行能力：" + "、".join(runtime) +
         "。只在当前会话已经授权并实际可用时调用；不可用时明确说明，不能假装执行成功。")
        if runtime else "",
        "交付质量标准：\n- " + "\n- ".join(quality_criteria) if quality_criteria else "",
        f"推荐步骤：{sequence}" if sequence else "",
        "节点方法：\n" + "\n".join(guides) if guides else "",
        "期望交付：\n" + "\n".join(deliverables) if deliverables else "",
        "受控确认点（对话中只能提醒，不能代替真实审批）：\n" + "\n".join(controls) if controls else "",
        "交付时说明实际完成了什么、使用了哪些依据、哪些动作尚未执行；不要伪造证据。",
    ]
    context = "\n".join(part for part in parts if part).strip()[:MAX_CONTEXT]
    return context, steps


async def resolve(session: AsyncSession, org_id: str | None, plugin_ids,
                  project_id: str = "", user_id: str = "",
                  *, include_resources: bool = False, client=None) -> dict:
    """Use the accepted installed version; workflow bindings never gate a chat."""
    from types import SimpleNamespace
    from . import plugin_installed, plugin_package_resources
    selected = await plugin_installed.resolve(
        session, org_id, user_id, plugin_ids if isinstance(plugin_ids, list) else [], client=client)
    items = []
    for plugin, version, preferences in selected:
        bundle = plugin_package_resources.for_version(version) if include_resources else None
        context, steps = await _plugin_context(
            session, plugin, version, SimpleNamespace(project_id=""),
            preference_context=preferences, resource_bundle=bundle)
        report = dict(version.capability_report or {})
        bundled = {str(row.get("name")) for row in report.get("bundledSkills") or []}
        external = (report.get("externalSkills") if "externalSkills" in report else
                    sorted(set(report.get("skills") or []) - bundled))
        platforms = list(report.get("platforms") or [])
        if not platforms and plugin.key in plugin_platforms.PROVIDERS:
            # Compatibility for the original 1.0 platform packs, which used
            # the reserved plugin key before `capabilities.platforms` existed.
            platforms = [plugin.key]
        item = {
            "pluginId": plugin.id, "key": str(dict(version.manifest or {}).get("key") or plugin.key),
            "name": _clip(dict(version.manifest or {}).get("name") or plugin.name, 120),
            "version": version.version, "versionId": version.id,
            "scope": "audience" if version.visibility in {
                plugin_audience.USERS, plugin_audience.ORG_UNITS} else "organization",
            "scopeLabel": ("指定人员授权" if version.visibility == plugin_audience.USERS else
                           "团队授权" if version.visibility == plugin_audience.ORG_UNITS else "全公司"),
            "workflow": steps,
            "capabilities": {
                "platforms": platforms,
                "skills": list(external or []),
                "mcpServers": list(report.get("mcpServers") or []),
                "runtime": list(report.get("runtime") or []),
            },
            # The renderer needs to know whether the conversation-only
            # fallback may omit package resources.  This flag carries no
            # package content or secret and keeps a missing archive fail-closed
            # for bundled Skills and runtime assets.
            "resourceRequired": bool(report.get("runtimeResources") or report.get("bundledSkills")),
            "context": context,
        }
        if bundle is not None:
            item["resourceBundle"] = bundle
        items.append(item)
    return {"ok": True, "items": items, "_bindingIds": [],
            "_versionIds": [version.id for _, version, _ in selected]}
