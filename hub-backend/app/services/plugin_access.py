"""Live per-plugin employee permissions, independent of immutable versions.

Policies use the existing runtime settings store. Every authorization reads the
current row; package, installation and signed-ticket caches cannot retain grants.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

from sqlalchemy import select

from .. import automation_models as am, models
from . import plugin_audience, rbac, workflow_contracts

PREFIX = "plugin_access_policy:"
MODES = {"inherit", "organization", "users", "org_units", "none"}


class PolicyConflict(ValueError):
    pass


class PluginUseDenied(workflow_contracts.WorkflowContractError):
    failure_kind = "authorization"


def _rule(value=None):
    raw = value if isinstance(value, dict) else {}
    return {"mode": str(raw.get("mode") or "inherit"),
            "userIds": list(raw.get("userIds") or []),
            "orgUnitIds": list(raw.get("orgUnitIds") or [])}


def public(value=None):
    raw = value if isinstance(value, dict) else {}
    return {"configured": bool(raw.get("configured")), "use": _rule(raw.get("use")),
            "edit": _rule(raw.get("edit")), "updatedAt": int(raw.get("updatedAt") or 0)}


async def policies(session, plugin_ids):
    keys = {PREFIX + str(value) for value in plugin_ids if value}
    if not keys:
        return {}
    rows = (await session.execute(select(models.AppSetting).where(
        models.AppSetting.key.in_(keys)).execution_options(populate_existing=True))).scalars()
    result = {}
    for row in rows:
        try:
            value = json.loads(row.value)
            if not isinstance(value, dict):
                raise ValueError("Invalid policy")
            for action in ("use", "edit"):
                rule = value.get(action)
                if not isinstance(rule, dict) or rule.get("mode") not in MODES:
                    raise ValueError("Invalid rule")
                if any(not isinstance(rule.get(key, []), list)
                       or any(not isinstance(item, str) for item in rule.get(key, []))
                       for key in ("userIds", "orgUnitIds")):
                    raise ValueError("Invalid principals")
        except (TypeError, ValueError):
            # A corrupted configured rule must never reopen a permission.
            value = {"use": {"mode": "none"}, "edit": {"mode": "none"}}
        result[row.key[len(PREFIX):]] = public({**value, "configured": True})
    return result


async def get(session, plugin_id):
    return (await policies(session, [plugin_id])).get(plugin_id, public())


async def save(session, plugin, body, actor_id):
    if not isinstance(body, dict):
        raise ValueError("插件权限必须是对象")
    # Serialize concurrent first writes as well as updates on PostgreSQL.
    await session.execute(select(am.Plugin.id).where(
        am.Plugin.id == plugin.id).with_for_update())
    before = await get(session, plugin.id)
    if ("expectedUpdatedAt" in body
            and body["expectedUpdatedAt"] != before["updatedAt"]):
        raise PolicyConflict("权限已被其他管理员修改，请刷新后再保存")
    value = {"configured": True, "orgId": plugin.org_id, "updatedBy": actor_id}
    for action in ("use", "edit"):
        raw = body.get(action, before[action])
        if not isinstance(raw, dict) or raw.get("mode") not in MODES:
            raise ValueError("权限范围必须是沿用现有范围、全组织、指定人员、指定团队或禁止")
        mode = raw["mode"]
        users = []
        if mode == "users":
            if plugin.org_id is not None:
                users = await plugin_audience.validate_users(session, plugin.org_id, raw.get("userIds"))
            else:
                users = plugin_audience.ids(raw.get("userIds"))
                active = set((await session.execute(select(models.User.id).where(
                    models.User.id.in_(users), models.User.is_active.is_(True)))).scalars())
                if not users or set(users) != active:
                    raise ValueError("指定人员中包含无效或停用账号，且至少需要选择一位成员")
        orgs = (await plugin_audience.validate_org_units(session, plugin.org_id, raw.get("orgUnitIds"))
                if mode == "org_units" else [])
        value[action] = {"mode": mode, "userIds": users, "orgUnitIds": orgs}
    value["updatedAt"] = max(time.time_ns() // 1_000_000, before["updatedAt"] + 1)
    row = await session.get(models.AppSetting, PREFIX + plugin.id)
    if row is None:
        row = models.AppSetting(key=PREFIX + plugin.id)
        session.add(row)
    row.value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    await session.commit()
    return public(value)


async def decisions(session, plugins, user_id):
    values = list(plugins)
    policy_rows = await policies(session, [p.id for p in values])
    user = await session.get(models.User, user_id) if user_id else None
    active = bool(user and user.is_active)
    ancestors = await rbac.ancestor_org_ids(session, user.org_id) if active and user.org_id else set()
    company_scope = await rbac.company_org_ids(session, user) if active else set()
    role = await session.get(models.Role, user.role_id) if active and user.role_id else None
    manages = bool(active and (user.is_super or role and "plugin.manage" in (role.permissions or [])))
    managed_orgs = await rbac.scope_org_ids(session, user) if manages else set()
    result = {}
    for plugin in values:
        policy = policy_rows.get(plugin.id, public())
        # ``organization`` means every member of the company that owns the
        # plugin.  Keep targeted team/user rules on the plugin subtree, but
        # do not let the catalog's old department boundary defeat a company-
        # wide grant for sibling departments.
        in_scope = bool(active and (plugin.org_id is None
                                    or company_scope is None
                                    or plugin.org_id in company_scope))
        manager = bool(manages and (user.is_super or plugin.org_id is not None
                                   and plugin.org_id in managed_orgs))

        def matches(rule):
            mode = rule["mode"]
            if not in_scope or mode == "none":
                return False
            return (mode == "organization" or mode == "users" and user_id in rule["userIds"]
                    or mode == "org_units" and bool(ancestors & set(rule["orgUnitIds"])))

        use = policy["use"]
        edit = policy["edit"]
        result[plugin.id] = {
            "useOverride": None if use["mode"] == "inherit" else matches(use),
            "canEdit": manager or (in_scope and plugin.created_by == user_id
                                   if edit["mode"] == "inherit" else matches(edit)),
        }
    return result


async def require_edit(session, plugin, user_id):
    if not (await decisions(session, [plugin], user_id))[plugin.id]["canEdit"]:
        raise PermissionError("你没有这个插件的编辑改进权限，或权限已被管理员收回")


async def assert_draft_edit(session, user_id, org_id, body):
    """Recheck both source identity and an existing same-key target at submission."""
    from . import plugin_identity
    source = str(body.get("sourcePluginId") or "").strip()
    if source:
        plugin = await session.get(am.Plugin, source)
        if plugin is None:
            raise PermissionError("原插件不存在")
        await require_edit(session, plugin, user_id)
        if str(body.get("key") or "").strip() != plugin.key:
            raise ValueError("改进原插件时不能更改插件标识；请保留原标识再提交")
        return
    key = str(body.get("key") or "").strip()
    existing = await plugin_identity.find_plugin(session, org_id, key) if key else None
    if existing:
        await require_edit(session, existing, user_id)


async def assert_task_use(session, plugin_id, task):
    """Revalidate explicit mutable policy at dispatch/retry, not just selection."""
    policy = await get(session, plugin_id)
    if policy["use"]["mode"] == "inherit":
        return
    plugin = await session.get(am.Plugin, plugin_id)
    if plugin is None:
        raise ValueError("插件已经不存在")
    client = await session.get(models.Client, str(getattr(task, "owner_client_id", "") or ""))
    user_id = str(client.user_ref or "") if client else ""
    decision = (await decisions(session, [plugin], user_id))[plugin_id]
    if not decision["useOverride"]:
        raise PluginUseDenied("这个插件的使用权限已被管理员收回，不能继续执行")


async def assert_run_use(session, run):
    task = await session.get(models.Task, run.task_id)
    await assert_task_use(session, run.plugin_id, task)


async def notify(session, plugin, updated_at):
    try:
        await _notify(session, plugin, updated_at)
    except Exception as exc:
        # Persistence is already committed. A notification outage must not
        # report a failed save or invite the user to overwrite it again.
        logging.getLogger("uvicorn.error").warning(
            "插件权限已保存；设备通知暂不可用: %s", type(exc).__name__)


async def _notify(session, plugin, updated_at):
    from ..realtime import hub
    online = hub.online_devices()
    if not online:
        return
    query = select(models.Client.id).join(models.User, models.User.id == models.Client.user_ref).where(
        models.Client.id.in_(online), models.User.is_active.is_(True))
    if plugin.org_id:
        scope = await rbac.company_org_ids_for_org(session, plugin.org_id)
        query = query.where(models.User.org_id.in_(scope))
    devices = (await session.execute(query)).scalars().all()
    event = {"type": "plugins.policy", "pluginId": plugin.id, "updatedAt": updated_at}
    results = await asyncio.gather(*(hub.publish(device, event) for device in devices),
                                   return_exceptions=True)
    if any(isinstance(result, BaseException) for result in results):
        logging.getLogger("uvicorn.error").warning("插件权限已保存；部分设备通知暂不可用")
