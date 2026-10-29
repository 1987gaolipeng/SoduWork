"""Plan and atomically apply plugin-version rollouts across governed bindings."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from . import plugin_compat, plugin_service


def _version_label(version: am.PluginVersion | None) -> str:
    return str(getattr(version, "version", "") or "未知版本")


def _visible(binding: am.PluginBinding, project, org_ids: set[str] | None) -> bool:
    if org_ids is None:
        return True
    if binding.org_id is not None:
        return binding.org_id in org_ids
    return project is not None and project.org_id in org_ids


async def _context(session: AsyncSession, plugin: am.Plugin, target_version_id: str,
                   org_ids: set[str] | None, *, lock: bool = False) -> dict:
    versions = list((await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == plugin.id
    ).order_by(
        am.PluginVersion.created_at.desc(),
        am.PluginVersion.id.desc(),
    ))).scalars().all())
    version_by_id = {row.id: row for row in versions}
    target = version_by_id.get(str(target_version_id or ""))
    if target is None:
        raise ValueError("目标版本不存在或不属于这个插件")
    if target.trust_state != "approved" or not target.enabled:
        raise ValueError("目标版本尚未通过审批并启用")

    binding_query = select(am.PluginBinding).where(
        am.PluginBinding.plugin_id == plugin.id
    ).order_by(
        am.PluginBinding.enabled.desc(),
        am.PluginBinding.updated_at.desc(),
        am.PluginBinding.id.desc(),
    )
    if lock:
        binding_query = binding_query.with_for_update()
    bindings = list((await session.execute(binding_query)).scalars().all())
    project_ids = {row.project_id for row in bindings if row.project_id}
    projects = {}
    if project_ids:
        project_rows = list((await session.execute(select(models.Project).where(
            models.Project.id.in_(project_ids)
        ))).scalars().all())
        projects = {row.id: row for row in project_rows}

    visible = [
        row for row in bindings
        if _visible(row, projects.get(row.project_id), org_ids)
    ]
    return {
        "target": target,
        "versions": versions,
        "versionById": version_by_id,
        "bindings": visible,
        "projects": projects,
    }


def _item(binding: am.PluginBinding, target: am.PluginVersion,
          version_by_id: dict, projects: dict) -> dict:
    current = version_by_id.get(binding.version_id)
    project = projects.get(binding.project_id)
    compatibility = plugin_compat.between(current, target)
    target_secrets = {
        str(value) for value in
        dict(target.capability_report or {}).get("secrets") or []
    }
    mapped_secrets = {str(value) for value in dict(binding.secret_refs or {})}
    removed_refs = sorted(mapped_secrets - target_secrets)
    missing_refs = sorted(target_secrets - mapped_secrets)
    issues = []
    if current is None:
        issues.append("当前绑定版本已不存在，需要单独修复")
    if removed_refs:
        issues.append("目标版本不再声明密钥：" + "、".join(removed_refs[:8]))
    if missing_refs:
        issues.append("目标版本新增密钥映射：" + "、".join(missing_refs[:8]))

    if not binding.enabled:
        state = "disabled"
    elif binding.version_id == target.id:
        state = "current"
    elif current is None or issues:
        state = "blocked"
    else:
        state = "eligible"
    return {
        "id": binding.id,
        "pluginId": binding.plugin_id,
        "projectId": binding.project_id,
        "scope": project.name if project is not None else "组织通用",
        "scopeKind": "project" if project is not None else "organization",
        "orgId": binding.org_id or getattr(project, "org_id", None),
        "enabled": binding.enabled,
        "state": state,
        "currentVersionId": binding.version_id,
        "currentVersion": _version_label(current),
        "targetVersionId": target.id,
        "targetVersion": target.version,
        "compatibility": compatibility,
        "issues": issues,
    }


async def plan(session: AsyncSession, plugin: am.Plugin, target_version_id: str,
               org_ids: set[str] | None = None) -> dict:
    ctx = await _context(session, plugin, target_version_id, org_ids)
    target = ctx["target"]
    items = [
        _item(row, target, ctx["versionById"], ctx["projects"])
        for row in ctx["bindings"]
    ]
    order = {"blocked": 0, "eligible": 1, "current": 2, "disabled": 3}
    items.sort(key=lambda row: (
        order.get(row["state"], 9),
        row["compatibility"].get("level") != "breaking",
        row["scope"],
    ))
    active = [row for row in items if row["enabled"]]
    eligible = [row for row in items if row["state"] == "eligible"]
    return {
        "pluginId": plugin.id,
        "pluginName": plugin.name,
        "target": plugin_service.version_api(target),
        "summary": {
            "bindings": len(items),
            "active": len(active),
            "current": sum(row["state"] == "current" for row in items),
            "eligible": len(eligible),
            "breaking": sum(
                row["compatibility"].get("level") == "breaking"
                for row in eligible),
            "review": sum(
                row["compatibility"].get("level") == "review"
                for row in eligible),
            "blocked": sum(
                row["state"] == "blocked" or bool(row["issues"])
                for row in items),
            "disabled": sum(row["state"] == "disabled" for row in items),
        },
        "items": items,
    }


async def execute(session: AsyncSession, plugin: am.Plugin, target_version_id: str,
                  binding_ids: list[str], expected_versions: dict[str, str],
                  org_ids: set[str] | None = None, *,
                  confirm_breaking: bool = False) -> dict:
    wanted = list(dict.fromkeys(str(value) for value in binding_ids if str(value)))
    if not wanted:
        raise ValueError("至少选择一个要切换的绑定")
    if len(wanted) > 100:
        raise ValueError("一次最多切换 100 个绑定")

    ctx = await _context(session, plugin, target_version_id, org_ids, lock=True)
    target = ctx["target"]
    by_id = {row.id: row for row in ctx["bindings"]}
    missing = [binding_id for binding_id in wanted if binding_id not in by_id]
    if missing:
        raise ValueError("部分绑定不存在或不在你的管理范围内")

    items = {
        row["id"]: row for row in (
            _item(binding, target, ctx["versionById"], ctx["projects"])
            for binding in ctx["bindings"])
    }
    selected = [items[binding_id] for binding_id in wanted]
    invalid = [row for row in selected if row["state"] != "eligible"]
    if invalid:
        raise ValueError("只能切换已启用且尚未使用目标版本的绑定")
    stale = [
        row for row in selected
        if str(expected_versions.get(row["id"]) or "") != row["currentVersionId"]
    ]
    if stale:
        raise ValueError("绑定版本已经变化，请刷新影响清单后重试")
    breaking = [
        row for row in selected
        if row["compatibility"].get("level") == "breaking"
    ]
    if breaking and not confirm_breaking:
        raise ValueError("选择中包含破坏性变更，请查看影响并明确确认")
    static_issues = [
        f"{row['scope']}：{'；'.join(row['issues'])}"
        for row in selected if row["issues"]
    ]
    if static_issues:
        raise ValueError("切换前需要处理配置：" + "；".join(static_issues[:5]))

    readiness_issues = []
    for row in selected:
        binding = by_id[row["id"]]
        project = ctx["projects"].get(binding.project_id)
        readiness = await plugin_service.binding_readiness(
            session, target, project, binding.org_id or getattr(project, "org_id", None),
            secret_refs=binding.secret_refs, binding_config=binding.config)
        if not readiness.get("ok"):
            blockers = "；".join(str(value) for value in readiness.get("blockers") or [])
            readiness_issues.append(f"{row['scope']}：{blockers or '运行条件未就绪'}")
    if readiness_issues:
        raise ValueError("体检未通过，所有绑定保持不变：" + "；".join(readiness_issues[:5]))

    try:
        for row in selected:
            binding = by_id[row["id"]]
            await plugin_service.save_binding(
                session, plugin, {
                    "versionId": target.id,
                    "config": binding.config or {},
                    "secretRefs": binding.secret_refs or {},
                    "enabled": True,
                    "confirmBreaking": confirm_breaking,
                }, binding, commit=False, flush=False,
                verify_readiness=False)
        await session.commit()
    except Exception:
        await session.rollback()
        raise

    updated = await plan(session, plugin, target.id, org_ids)
    return {
        "ok": True,
        "changed": len(selected),
        "bindingIds": wanted,
        "plan": updated,
    }
