"""Per-user installation state for enterprise conversation plugins."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from . import plugin_setup_contracts


def _ms(value) -> int | None:
    if value is None:
        return None
    return int(value.timestamp() * 1000)


async def by_plugin(session: AsyncSession, user_id: str,
                    plugin_ids) -> dict[str, am.PluginInstallation]:
    ids = {str(value or "") for value in plugin_ids if str(value or "")}
    if not user_id or not ids:
        return {}
    rows = list((await session.execute(select(am.PluginInstallation).where(
        am.PluginInstallation.user_id == str(user_id),
        am.PluginInstallation.plugin_id.in_(ids),
    ))).scalars().all())
    return {row.plugin_id: row for row in rows}


async def ensure_defaults(session: AsyncSession, user_id: str,
                          current_versions: dict[str, tuple[str, str]],
                          policies: dict[str, dict],
                          setup_by_plugin: dict[str, dict] | None = None) -> int:
    """Provision an admin default once; never re-enable or auto-upgrade a user row.

    A disabled row is an explicit employee choice. A stale row records the
    immutable version the employee already accepted and still requires an
    explicit upgrade even if the directory policy later changes.
    """
    if not user_id or not current_versions:
        return 0
    existing = await by_plugin(session, user_id, current_versions)
    schemas = setup_by_plugin or {}
    created = 0
    for plugin_id, (version_id, _version) in current_versions.items():
        policy = policies.get(plugin_id) or {}
        if plugin_id in existing or policy.get("installation") != "installed_by_default":
            continue
        try:
            async with session.begin_nested():
                missing = plugin_setup_contracts.missing_required(
                    schemas.get(plugin_id), {})
                session.add(am.PluginInstallation(
                    user_id=str(user_id), plugin_id=str(plugin_id),
                    version_id=str(version_id), enabled=True, config={},
                    setup_state=("needs_setup" if missing else "ready")))
                await session.flush()
            created += 1
        except IntegrityError:
            # Another window provisioned the same user/plugin first.
            pass
    if created:
        await session.commit()
    return created


async def catalog_states(session: AsyncSession, user_id: str,
                         current_versions: dict[str, tuple[str, str]]) -> dict[str, dict]:
    """Return display-safe installation state for visible enterprise plugins."""
    rows = await by_plugin(session, user_id, current_versions)
    accepted_ids = {row.version_id for row in rows.values() if row.version_id}
    accepted_versions = {}
    if accepted_ids:
        accepted_versions = {
            row.id: row.version
            for row in (await session.execute(select(am.PluginVersion).where(
                am.PluginVersion.id.in_(accepted_ids)
            ))).scalars().all()
        }
    states: dict[str, dict] = {}
    for plugin_id, (current_id, current_name) in current_versions.items():
        row = rows.get(plugin_id)
        installed = bool(row and row.enabled)
        update_available = bool(installed and row.version_id != current_id)
        states[plugin_id] = {
            "installed": installed,
            "installedVersion": (
                accepted_versions.get(row.version_id, "") if row else ""),
            "updateAvailable": update_available,
            "installationState": (
                "update" if update_available else
                "installed" if installed else "available"),
            "currentVersion": str(current_name or ""),
            "setupState": (
                "upgrade_required" if update_available else
                str(getattr(row, "setup_state", "") or "ready")
                if row else "not_installed"),
            "configured": bool(
                row and not update_available
                and str(getattr(row, "setup_state", "") or "ready")
                == "ready"),
            "verifiedAt": _ms(
                getattr(row, "verified_at", None)
                if row and not update_available else None),
            # Setup preferences are guaranteed non-secret at the package and
            # write boundaries, so the owner may edit their current values.
            "setupConfig": dict(
                getattr(row, "config", None) or {}) if row else {},
        }
    return states


async def install_current(session: AsyncSession, user_id: str, plugin_id: str,
                          version_id: str, setup: dict | None = None,
                          config: dict | None = None,
                          verified: bool = False) -> am.PluginInstallation:
    """Install or explicitly accept the currently published immutable version."""
    row = (await session.execute(select(am.PluginInstallation).where(
        am.PluginInstallation.user_id == str(user_id),
        am.PluginInstallation.plugin_id == str(plugin_id),
    ))).scalar_one_or_none()
    candidate = (
        config if config is not None else
        dict(getattr(row, "config", None) or {}) if row else {})
    clean = plugin_setup_contracts.validate(
        setup, candidate, require_required=True)
    if row is None:
        row = am.PluginInstallation(
            user_id=str(user_id), plugin_id=str(plugin_id),
            version_id=str(version_id), enabled=True,
            config=clean, setup_state="ready")
        session.add(row)
    else:
        row.version_id = str(version_id)
        row.enabled = True
        row.config = clean
        row.setup_state = "ready"
    row.verified_at = (
        datetime.now(timezone.utc) if verified else None)
    await session.commit()
    await session.refresh(row)
    return row


async def mark_setup_needed(session: AsyncSession, user_id: str,
                            plugin_id: str) -> None:
    row = (await by_plugin(session, user_id, [plugin_id])).get(plugin_id)
    if row is None:
        return
    row.setup_state = "needs_setup"
    row.verified_at = None
    await session.commit()


async def uninstall(session: AsyncSession, user_id: str,
                    plugin_id: str) -> am.PluginInstallation | None:
    row = (await session.execute(select(am.PluginInstallation).where(
        am.PluginInstallation.user_id == str(user_id),
        am.PluginInstallation.plugin_id == str(plugin_id),
    ))).scalar_one_or_none()
    if row is None:
        return None
    row.enabled = False
    await session.commit()
    await session.refresh(row)
    return row
