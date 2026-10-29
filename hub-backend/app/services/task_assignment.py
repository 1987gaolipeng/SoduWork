"""Human ownership and deterministic execution-device routing."""
from __future__ import annotations

from datetime import timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models


def _seen(client: models.Client) -> float:
    value = client.last_seen_at
    if value is None:
        return 0.0
    aware = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return aware.timestamp()


async def active_devices(session: AsyncSession, user_id: str) -> list[models.Client]:
    """Return only devices allowed to receive new work."""
    if not str(user_id or "").strip():
        return []
    rows = list((await session.execute(select(models.Client).where(
        models.Client.user_ref == user_id,
        models.Client.auth_state == "active",
        models.Client.revoked_at.is_(None),
    ))).scalars().all())
    return sorted(rows, key=lambda row: (-_seen(row), str(row.created_at or ""), row.id))


async def project_route(session: AsyncSession, project_id: str | None) -> dict:
    """Return project defaults without allowing them to cross an owner boundary."""
    pid = str(project_id or "").strip()
    if not pid:
        return {"clientId": "", "agentKind": "", "ownerUserId": ""}
    project = await session.get(models.Project, pid)
    owner_user_id = str((project.owner_user_id if project else "") or "")
    profile = await session.get(am.ProjectAutomationProfile, pid)
    if profile is None or not profile.enabled:
        return {"clientId": "", "agentKind": "", "ownerUserId": owner_user_id}
    config = dict(profile.config or {})
    kind = str(config.get("agentKind") or "").strip()
    if not kind and profile.binding_id:
        binding = await session.get(am.PluginBinding, profile.binding_id)
        if binding is not None and binding.enabled:
            kind = str(dict(binding.config or {}).get("agentKind") or "").strip()
    return {
        "clientId": str(config.get("executionClientId") or "").strip(),
        "agentKind": kind,
        "ownerUserId": owner_user_id,
    }


async def pick_device(session: AsyncSession, user_id: str, *,
                      project_id: str | None = None,
                      preferred_client_id: str = "") -> models.Client | None:
    """Choose one device owned by ``user_id`` and never another person's device.

    Explicit choice wins, then the project's configured execution device, then the
    user's most recently active device. AI dispatch remains pinned to this result.
    """
    rows = await active_devices(session, user_id)
    if not rows:
        return None
    by_id = {row.id: row for row in rows}
    preferred = str(preferred_client_id or "").strip()
    if preferred:
        return by_id.get(preferred)
    route = await project_route(session, project_id)
    configured = str(route.get("clientId") or "")
    project_owner = str(route.get("ownerUserId") or "")
    if configured and project_owner == str(user_id or ""):
        return by_id.get(configured)
    return rows[0]


def apply_project_agent_default(binding_config: dict | None, route: dict | None,
                                node_key: str) -> dict:
    """Layer the project's portable Agent above plugin defaults for one AI node.

    A binding's explicit per-node override remains authoritative. Otherwise the
    project's chosen Agent beats a plugin's packaged default, so every workflow
    bound to the project follows the same owner-device policy.
    """
    config = dict(binding_config or {})
    kind = str(dict(route or {}).get("agentKind") or "").strip()
    key = str(node_key or "").strip()
    if not kind or not key:
        return config
    overrides = dict(config.get("nodeOverrides") or {})
    raw = dict(overrides.get(key) or {})
    execution = dict(raw.get("execution") or {})
    if str(execution.get("agentKind") or raw.get("agentKind") or "").strip():
        return config
    execution["agentKind"] = kind
    raw["execution"] = execution
    overrides[key] = raw
    config["nodeOverrides"] = overrides
    return config
