"""Administration and live employee checks for use/edit plugin access."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from ..db import get_session
from ..deps import current_client, require_perm
from ..services import audit, plugin_access, plugin_audience, plugin_packages, rbac

admin_router = APIRouter(prefix="/api/v1/admin/plugins", tags=["plugins"])
router = APIRouter(prefix="/api/v1/plugins", tags=["plugins"])


async def _managed(session, user, plugin_id):
    from .plugins import _plugin
    plugin = await _plugin(session, user, plugin_id)
    if plugin.org_id is None and not user.is_super:
        raise HTTPException(403, "系统级插件只能由超级管理员配置权限")
    return plugin


@admin_router.get("/{plugin_id}/access-policy")
async def access_policy(plugin_id: str, user=Depends(require_perm("plugin.manage")),
                        session: AsyncSession = Depends(get_session)):
    await _managed(session, user, plugin_id)
    return await plugin_access.get(session, plugin_id)


@admin_router.patch("/{plugin_id}/access-policy")
async def update_access_policy(plugin_id: str, body: dict = Body(default_factory=dict),
                               user=Depends(require_perm("plugin.manage")),
                               session: AsyncSession = Depends(get_session)):
    plugin = await _managed(session, user, plugin_id)
    before = await plugin_access.get(session, plugin_id)
    try:
        result = await plugin_access.save(session, plugin, body, user.id)
    except plugin_access.PolicyConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    await audit.log(session, user, "plugin.access_policy", "plugin", plugin.id,
                    plugin.name, {"before": before, "after": result})
    await plugin_access.notify(session, plugin, result["updatedAt"])
    return result


@admin_router.get("/{plugin_id}/access-candidates")
async def access_candidates(plugin_id: str, user=Depends(require_perm("plugin.manage")),
                            session: AsyncSession = Depends(get_session)):
    plugin = await _managed(session, user, plugin_id)
    scope = await rbac.subtree_org_ids(session, plugin.org_id) if plugin.org_id else None
    members = select(models.User).where(models.User.is_active.is_(True))
    teams = select(models.OrgUnit)
    if scope is not None:
        members = members.where(models.User.org_id.in_(scope))
        teams = teams.where(models.OrgUnit.id.in_(scope))
    users = (await session.execute(members.order_by(models.User.display_name, models.User.username))).scalars()
    orgs = (await session.execute(teams.order_by(models.OrgUnit.sort, models.OrgUnit.name))).scalars()
    return {"items": [{"id": u.id, "name": u.display_name or u.username,
                        "username": u.username, "orgId": u.org_id or ""} for u in users],
            "orgUnits": [{"id": o.id, "name": o.name, "parentId": o.parent_id or ""} for o in orgs]}


async def _employee(session, client, plugin_id):
    from .plugin_client_catalog import _client_actor
    actor = await _client_actor(session, client)
    plugin = await session.get(am.Plugin, plugin_id)
    company_scope = await rbac.company_org_ids(session, actor)
    if plugin is None or (plugin.org_id is not None
                          and company_scope is not None
                          and plugin.org_id not in company_scope):
        raise HTTPException(404, "插件不存在或不属于当前组织")
    decision = (await plugin_access.decisions(session, [plugin], actor.user_id))[plugin.id]
    versions = (await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == plugin.id).order_by(
        am.PluginVersion.created_at.desc(), am.PluginVersion.id.desc()))).scalars().all()
    from ..services.plugin_catalog import _version_key
    versions.sort(key=_version_key, reverse=True)
    allowed = await plugin_audience.allowed_version_ids(session, [v.id for v in versions], actor.user_id)
    can_use = bool(plugin.enabled and any(v.enabled and v.trust_state == "approved"
                                         and plugin_audience.visible(v, allowed) for v in versions))
    return actor, plugin, versions, {"canUse": can_use, "canEdit": bool(decision["canEdit"])}


@router.get("/{plugin_id}/permissions")
async def employee_permissions(plugin_id: str, client=Depends(current_client),
                               session: AsyncSession = Depends(get_session)):
    _, _, _, permissions = await _employee(session, client, plugin_id)
    return {"pluginId": plugin_id, **permissions}


@router.get("/{plugin_id}/draft")
async def editable_plugin(plugin_id: str, client=Depends(current_client),
                          session: AsyncSession = Depends(get_session)):
    actor, plugin, versions, permissions = await _employee(session, client, plugin_id)
    if not permissions["canEdit"]:
        raise HTTPException(403, "你没有这个插件的编辑改进权限，或权限已被管理员收回")
    # Prefer the published version; a creator can also continue their own
    # quarantined initial submission without needing a publication first.
    version = next((v for v in versions if v.enabled and v.trust_state == "approved"), None)
    version = version or next((v for v in versions if v.created_by == actor.user_id
                               and v.trust_state == "quarantined"), None)
    if version is None:
        raise HTTPException(409, "插件没有可供编辑的版本")
    try:
        with open(version.package_path, "rb") as stream:
            parsed = plugin_packages.parse(stream.read(plugin_packages._MAX_PACKAGE + 1))
        if parsed["checksum"] != version.checksum:
            raise ValueError("插件包校验失败")
        draft = plugin_packages.personal_draft(parsed)
    except (OSError, ValueError) as exc:
        raise HTTPException(409, "插件原始包缺失或校验失败，请联系管理员重新发布") from exc
    draft["sourcePluginId"] = plugin.id
    return {"pluginId": plugin.id, "versionId": version.id, "draft": draft}
