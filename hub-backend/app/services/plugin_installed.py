"""One authorization rule for installed enterprise plugins, independent of tasks."""
from __future__ import annotations

from sqlalchemy import select

from .. import automation_models as am
from . import (mcp_servers, plugin_audience, plugin_installations,
               plugin_marketplace, plugin_setup_contracts, rbac)
from . import plugin_application_mcp


async def resolve(session, org_id, user_id, plugin_ids, *, provision_defaults=True):
    if not user_id:
        raise ValueError("当前设备尚未绑定员工")
    ids = list(dict.fromkeys(str(item).strip() for item in plugin_ids if str(item).strip()))
    if not ids or len(ids) > 3:
        raise ValueError("一轮对话请选择 1 至 3 个插件")
    scope = await rbac.ancestor_org_ids(session, org_id) if org_id else set()
    plugins = {row.id: row for row in (await session.execute(
        select(am.Plugin).where(am.Plugin.id.in_(ids)))).scalars().all()}
    versions = list((await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id.in_(ids)))).scalars().all())
    by_version = {row.id: row for row in versions}
    allowed = await plugin_audience.allowed_version_ids(
        session, by_version.keys(), user_id)
    installations = await plugin_installations.by_plugin(session, user_id, ids)
    policies = await plugin_marketplace.by_plugin(session, ids)
    result = []
    for plugin_id in ids:
        plugin = plugins.get(plugin_id)
        if (plugin is None or not plugin.enabled
                or plugin.org_id is not None and plugin.org_id not in scope):
            raise ValueError("插件不存在或不在当前企业的可用范围内")
        policy = plugin_marketplace.public_policy(policies.get(plugin_id))
        if policy["installation"] == plugin_marketplace.NOT_AVAILABLE:
            raise ValueError(f"《{plugin.name}》仅供受控需求和自动化使用，不能加入普通对话")
        installed = installations.get(plugin_id)
        if (installed is None and provision_defaults
                and policy["installation"] == plugin_marketplace.INSTALLED_BY_DEFAULT):
            from .plugin_catalog import _version_key
            candidates = [row for row in versions if row.plugin_id == plugin_id
                          and row.enabled and row.trust_state == "approved"
                          and plugin_audience.visible(row, allowed)]
            if not candidates:
                raise ValueError(f"《{plugin.name}》尚无获准使用的版本")
            version = max(candidates, key=_version_key)
            setup = dict(version.manifest or {}).get("setup")
            plugin_setup_contracts.validate(setup, {}, require_required=True)
            names = plugin_application_mcp.company_names(
                dict(version.manifest or {}), dict(version.capability_report or {}).get("mcpServers") or [])
            if names and policy["authentication"] == plugin_marketplace.ON_INSTALL:
                readiness = await mcp_servers.readiness(session, names)
                if not readiness.get("ok"):
                    raise ValueError("安装前需要配置企业连接：" + "、".join(readiness.get("missing") or []))
            installed = await plugin_installations.install_current(
                session, user_id, plugin_id, version.id, setup=setup)
        if installed is None or not installed.enabled:
            raise ValueError(f"《{plugin.name}》尚未安装或已停用，请在插件页确认")
        version = by_version.get(installed.version_id)
        if (version is None or version.plugin_id != plugin_id or not version.enabled
                or version.trust_state != "approved"):
            raise ValueError(f"《{plugin.name}》已安装版本已停用或撤销，请在插件页升级")
        if not plugin_audience.visible(version, allowed):
            raise ValueError(f"《{plugin.name}》没有授权给当前用户")
        entrypoints = dict(dict(version.manifest or {}).get("entrypoints")
                           or dict(version.capability_report or {}).get("entrypoints") or {})
        if entrypoints.get("conversation", True) is False:
            raise ValueError(f"《{plugin.name}》只支持需求或自动化调用")
        if str(installed.setup_state or "ready") != "ready":
            raise ValueError(f"《{plugin.name}》需要先在插件页完成设置")
        preferences = plugin_setup_contracts.context(
            dict(version.manifest or {}).get("setup"), dict(installed.config or {}))
        result.append((plugin, version, preferences))
    return result
