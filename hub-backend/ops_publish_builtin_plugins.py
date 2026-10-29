"""Idempotently publish built-in plugins and create or upgrade organization bindings.

Startup registers built-in versions as quarantined. They require an administrator to trust
and enable them and establish bindings before use. This script performs that publication:

  python ops_publish_builtin_plugins.py                     # Dry run: print the plan.
  python ops_publish_builtin_plugins.py --apply             # Publish to the sole organization.
  python ops_publish_builtin_plugins.py --apply --org <id>  # Select an organization.
  python ops_publish_builtin_plugins.py --apply --keys ai-errand,web-collect

Only modify plugins with an empty org_id and source_kind=builtin. Select each plugin's
latest version, enable quarantined versions, and skip revoked versions with a warning.
Create missing organization bindings and upgrade old ones. Preserve existing bindings
on breaking changes and report that manual review is required. Apply the same upgrade
rules to project bindings. Run inside the configured Hub application environment.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import select

sys.path.insert(0, ".")

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.services import plugin_service  # noqa: E402

ACTOR = "运维发布脚本"


async def _target_org(session, org_id: str) -> str:
    """Treat root organization units as organization identities."""
    if org_id:
        row = await session.get(models.OrgUnit, org_id)
        if row is None:
            raise SystemExit(f"组织（根部门）不存在：{org_id}")
        return org_id
    rows = list((await session.execute(select(models.OrgUnit).where(
        models.OrgUnit.parent_id.is_(None)))).scalars().all())
    if len(rows) != 1:
        names = "、".join(f"{row.name}({row.id})" for row in rows[:10])
        raise SystemExit(f"存在 {len(rows)} 个根部门，必须用 --org 指定绑定到哪一个：{names}")
    return rows[0].id


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="真正执行；默认只打印计划")
    parser.add_argument("--org", default="", help="绑定的组织 id（只有一个组织时可省略）")
    parser.add_argument("--keys", default="", help="只发布这些插件 key（逗号分隔），默认全部内置")
    args = parser.parse_args()
    wanted = {key.strip() for key in args.keys.split(",") if key.strip()}

    async with SessionLocal() as session:
        org_id = await _target_org(session, args.org.strip())
        query = select(am.Plugin).where(
            am.Plugin.org_id.is_(None), am.Plugin.source_kind == "builtin"
        ).order_by(am.Plugin.key)
        plugins = list((await session.execute(query)).scalars().all())
        if wanted:
            missing = wanted - {row.key for row in plugins}
            if missing:
                raise SystemExit("找不到这些内置插件：" + "、".join(sorted(missing)))
            plugins = [row for row in plugins if row.key in wanted]

        changed = 0
        plugin_refs = [(row.id, row.key) for row in plugins]
        for plugin_id, plugin_key in plugin_refs:
            plugin = await session.get(am.Plugin, plugin_id)
            versions = list((await session.execute(select(am.PluginVersion).where(
                am.PluginVersion.plugin_id == plugin.id
            ).order_by(am.PluginVersion.created_at.desc(),
                       am.PluginVersion.id.desc()))).scalars().all())
            if not versions:
                print(f"[跳过] {plugin_key}: 没有任何版本")
                continue
            latest = versions[0]
            state = f"v{latest.version} {latest.trust_state}" + \
                ("+enabled" if latest.enabled else "")

            if latest.trust_state == "revoked":
                print(f"[跳过] {plugin_key}: 最新版本已撤销（{state}），不自动复活")
                continue
            if latest.trust_state != "approved" or not latest.enabled:
                if args.apply:
                    await plugin_service.approve_version(session, latest, True, ACTOR)
                    changed += 1
                print(f"[发布] {plugin_key}: {state} -> approved+enabled"
                      + ("" if args.apply else "（计划）"))
            elif not plugin.enabled:
                if args.apply:
                    plugin.enabled = True
                    await session.commit()
                    changed += 1
                print(f"[启用] {plugin_key}: 版本已批准但插件开关关闭"
                      + ("" if args.apply else "（计划）"))
            else:
                print(f"[已好] {plugin_key}: {state}")

            # Rollback expires every ORM object in the session.
            # Snapshot binding data before operations that may roll back.
            # Reload objects by ID after failure to avoid async lazy-loading errors.
            latest_id, latest_ver = latest.id, latest.version
            binding_rows = [{
                "id": row.id, "versionId": row.version_id,
                "projectId": row.project_id, "enabled": row.enabled,
                "orgId": row.org_id,
            } for row in (await session.execute(select(am.PluginBinding).where(
                am.PluginBinding.plugin_id == plugin.id))).scalars().all()]
            org_wide = [row for row in binding_rows
                        if not row["projectId"] and row["orgId"] in (org_id, None)]
            if not org_wide:
                if args.apply:
                    await plugin_service.save_binding(session, plugin, {
                        "versionId": latest_id, "orgId": org_id, "enabled": True})
                    changed += 1
                print(f"  [绑定] 新建组织级绑定 -> v{latest_ver}"
                      + ("" if args.apply else "（计划）"))
            for info in binding_rows:
                scope = (f"项目 {info['projectId']} 的" if info["projectId"] else "组织级")
                if info["versionId"] == latest_id:
                    if not info["enabled"] and not info["projectId"]:
                        if args.apply:
                            row = await session.get(am.PluginBinding, info["id"])
                            row.enabled = True
                            await session.commit()
                            changed += 1
                        print("  [绑定] 组织级绑定重新启用"
                              + ("" if args.apply else "（计划）"))
                    continue
                if args.apply:
                    try:
                        row = await session.get(am.PluginBinding, info["id"])
                        await plugin_service.save_binding(
                            session, plugin, {"versionId": latest_id}, row)
                        changed += 1
                        print(f"  [升级] {scope}绑定 -> v{latest_ver}")
                    except ValueError as exc:
                        await session.rollback()
                        plugin = await session.get(am.Plugin, plugin_id)
                        print(f"  [人工] {scope}绑定升级被拦（保留旧版本）：{exc}")
                else:
                    print(f"  [升级] {scope}绑定 -> v{latest_ver}（计划）")

        print(f"\n{'已执行' if args.apply else '干跑'}：{len(plugins)} 个插件，"
              f"{changed} 处变更。绑定组织：{org_id}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
