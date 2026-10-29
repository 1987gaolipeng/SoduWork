"""Explicit publication audience for immutable enterprise plugin versions."""
from __future__ import annotations

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import rbac

ORGANIZATION = "organization"
USERS = "users"
ORG_UNITS = "org_units"
MAX_USERS = 200
MAX_ORG_UNITS = 100


class VersionAccess(set):
    """Version publication grants plus the current plugin-wide use policy."""
    def __init__(self, values=(), overrides=None):
        super().__init__(values)
        self.overrides = overrides or {}


def normalize(value) -> str:
    visibility = str(value or ORGANIZATION).strip().lower()
    if visibility not in {ORGANIZATION, USERS, ORG_UNITS}:
        raise ValueError("插件可见范围只能是全公司、指定人员或团队部门")
    return visibility


def ids(raw, limit: int = MAX_USERS, label: str = "人") -> list[str]:
    values: list[str] = []
    for item in raw if isinstance(raw, list) else []:
        value = str(item or "").strip()[:64]
        if value and value not in values:
            values.append(value)
    if len(values) > limit:
        raise ValueError(f"一次最多指定 {limit} 个{label}")
    return values


async def validate_users(session: AsyncSession, org_id: str | None, raw) -> list[str]:
    wanted = ids(raw)
    if not wanted:
        raise ValueError("选择指定人员时，至少要选择一位成员")
    rows = list((await session.execute(select(models.User).where(
        models.User.id.in_(wanted), models.User.is_active.is_(True)
    ))).scalars().all())
    scope = await rbac.subtree_org_ids(session, org_id) if org_id else {None}
    valid = {row.id for row in rows if row.org_id in scope}
    if valid != set(wanted):
        raise ValueError("指定人员中包含无效、停用或不属于当前组织树的账号")
    return wanted


async def validate_org_units(session: AsyncSession, org_id: str | None, raw) -> list[str]:
    wanted = ids(raw, MAX_ORG_UNITS, "团队或部门")
    if not wanted:
        raise ValueError("选择团队或部门时，至少要选择一个组织")
    rows = list((await session.execute(select(models.OrgUnit.id).where(
        models.OrgUnit.id.in_(wanted)
    ))).scalars().all())
    valid = set(rows)
    if org_id:
        valid &= await rbac.subtree_org_ids(session, org_id)
    if valid != set(wanted):
        raise ValueError("指定团队中包含无效或不属于当前组织树的部门")
    return wanted


async def replace(session: AsyncSession, version: am.PluginVersion, visibility,
                  user_ids, *, org_id: str | None, created_by: str,
                  org_unit_ids=None) -> list[str]:
    mode = normalize(visibility)
    wanted_users = await validate_users(
        session, org_id, user_ids) if mode == USERS else []
    wanted_orgs = await validate_org_units(
        session, org_id, org_unit_ids) if mode == ORG_UNITS else []
    await session.execute(delete(am.PluginAudience).where(
        am.PluginAudience.version_id == version.id))
    version.visibility = mode
    for user_id in wanted_users:
        session.add(am.PluginAudience(
            plugin_id=version.plugin_id, version_id=version.id, org_id=org_id,
            principal_type="user", principal_id=user_id, created_by=created_by,
        ))
    for selected_org_id in wanted_orgs:
        session.add(am.PluginAudience(
            plugin_id=version.plugin_id, version_id=version.id, org_id=org_id,
            principal_type="org_unit", principal_id=selected_org_id,
            created_by=created_by,
        ))
    return wanted_users or wanted_orgs


async def allowed_version_ids(session: AsyncSession, version_ids, user_id: str) -> set[str]:
    wanted = {str(item or "") for item in version_ids if str(item or "")}
    if not wanted:
        return set()
    from . import plugin_access
    plugins = (await session.execute(select(am.Plugin).join(
        am.PluginVersion, am.PluginVersion.plugin_id == am.Plugin.id).where(
        am.PluginVersion.id.in_(wanted)).distinct())).scalars().all()
    decisions = await plugin_access.decisions(session, plugins, user_id)
    overrides = {key: value["useOverride"] for key, value in decisions.items()
                 if value["useOverride"] is not None}
    if not user_id:
        return VersionAccess(overrides=overrides)
    user = await session.get(models.User, user_id)
    orgs = (await rbac.ancestor_org_ids(session, user.org_id)
            if user is not None and user.org_id else set())
    principals = [and_(
        am.PluginAudience.principal_type == "user",
        am.PluginAudience.principal_id == user_id,
    )]
    if orgs:
        principals.append(and_(
            am.PluginAudience.principal_type == "org_unit",
            am.PluginAudience.principal_id.in_(orgs),
        ))
    rows = list((await session.execute(select(am.PluginAudience.version_id).where(
        am.PluginAudience.version_id.in_(wanted),
        or_(*principals),
    ))).scalars().all())
    return VersionAccess(rows, overrides)


def visible(version: am.PluginVersion, allowed: set[str]) -> bool:
    overrides = getattr(allowed, "overrides", {})
    if version.plugin_id in overrides:
        return overrides[version.plugin_id]
    return normalize(getattr(version, "visibility", ORGANIZATION)) == ORGANIZATION \
        or version.id in allowed


async def counts(session: AsyncSession, version_ids) -> dict[str, int]:
    wanted = {str(item or "") for item in version_ids if str(item or "")}
    if not wanted:
        return {}
    rows = list((await session.execute(select(am.PluginAudience).where(
        am.PluginAudience.version_id.in_(wanted)
    ))).scalars().all())
    out: dict[str, int] = {}
    for row in rows:
        out[row.version_id] = out.get(row.version_id, 0) + 1
    return out


async def members(session: AsyncSession, version_id: str) -> list[dict]:
    """Management-only audience details; employee catalogs must never call this."""
    rows = list((await session.execute(select(am.PluginAudience).where(
        am.PluginAudience.version_id == version_id,
    ).order_by(am.PluginAudience.created_at, am.PluginAudience.id))).scalars().all())
    user_ids = [row.principal_id for row in rows if row.principal_type == "user"]
    org_ids = [row.principal_id for row in rows if row.principal_type == "org_unit"]
    users = {row.id: row for row in (await session.execute(select(models.User).where(
        models.User.id.in_(user_ids or {"__none__"})
    ))).scalars().all()}
    orgs = {row.id: row for row in (await session.execute(select(models.OrgUnit).where(
        models.OrgUnit.id.in_(org_ids or {"__none__"})
    ))).scalars().all()}
    out = []
    for row in rows:
        if row.principal_type == "org_unit":
            org = orgs.get(row.principal_id)
            out.append({
                "id": row.principal_id,
                "name": str(org.name if org else "已删除团队")[:64],
                "username": "",
                "active": bool(org),
                "type": "org_unit",
            })
        else:
            user = users.get(row.principal_id)
            out.append({
                "id": row.principal_id,
                "name": str((user.display_name or user.username) if user else "已删除成员")[:64],
                "username": str(user.username if user else "")[:64],
                "active": bool(user and user.is_active),
                "type": "user",
            })
    return out
