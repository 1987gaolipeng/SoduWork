"""Integration aggregation: normalize envelopes, resolve bindings, upsert tasks, and push updates.
Keep claiming and assignment independent of the source platform.
"""
import secrets
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models, automation_models, repository_issue_models  # register subscription ownership metadata
from ..realtime import hub
from .task_access import publish_owner
from ..schemas import binding_to_api, integration_to_api, task_to_api


def _new_ingest_token() -> str:
    return "ingest_" + secrets.token_urlsafe(18)


# Integration management.

async def create_integration(
    session: AsyncSession, name: str, type_: str = "generic", config: dict | None = None
) -> dict:
    from . import scm_support
    scm_support.require_active(type_)
    integ = models.Integration(
        name=name,
        type=type_,
        config=config or {},
        ingest_token=_new_ingest_token(),
    )
    session.add(integ)
    await session.commit()
    await session.refresh(integ)
    return integration_to_api(integ, reveal_token=True)


async def list_integrations(session: AsyncSession) -> list[dict]:
    query = select(models.Integration).order_by(models.Integration.created_at.desc())
    res = await session.execute(query)
    integrations = res.scalars().all()
    counts = dict((await session.execute(
        select(models.Task.integration_id, func.count())
        .where(models.Task.integration_id.in_(query.with_only_columns(models.Integration.id).order_by(None)))
        .group_by(models.Task.integration_id)
    )).all()) if integrations else {}
    return [integration_to_api(item, {"taskCount": int(counts.get(item.id, 0))})
            for item in integrations]


async def update_integration(
    session: AsyncSession, iid: str, enabled: bool | None = None, config: dict | None = None
) -> dict | None:
    """Update the enabled state and merge supplied configuration."""
    i = await session.get(models.Integration, iid)
    if i is None:
        return None
    if enabled or config is not None:
        from . import scm_support
        scm_support.require_active(i.type)
    if enabled is not None:
        i.enabled = bool(enabled)
    if config is not None:
        merged = {**(i.config or {}), **config}  # Assign a new dictionary so JSON changes are tracked.
        # Pull secrets are write-only; expose only user, kind, and secretSet.
        # A masked configuration round trip must not replace stored credentials.
        # Use the dedicated pull-account endpoint for credential updates.
        incoming_pull = config.get("pullAuth")
        stored_pull = dict((i.config or {}).get("pullAuth") or {})
        if isinstance(incoming_pull, dict):
            secret = str(incoming_pull.get("secret") or "")
            if not secret and stored_pull.get("secret"):
                merged["pullAuth"] = {**incoming_pull, "secret": stored_pull["secret"]}
                merged["pullAuth"].pop("secretSet", None)
        elif "pullAuth" in config and stored_pull:
            merged["pullAuth"] = stored_pull   # Null does not delete credentials; use the dedicated endpoint.
        i.config = merged
    await session.commit()
    await session.refresh(i)
    return integration_to_api(i)


async def rotate_integration_token(session: AsyncSession, iid: str) -> dict | None:
    """Generate a replacement credential and reveal it in this response only."""
    i = await session.get(models.Integration, iid)
    if i is None:
        return None
    i.ingest_token = _new_ingest_token()
    await session.commit()
    await session.refresh(i)
    return integration_to_api(i, reveal_token=True)


# Integration bindings.

async def create_binding(session: AsyncSession, integration_id: str, external_actor: str, client_id: str) -> dict:
    res = await session.execute(
        select(models.IntegrationBinding).where(
            models.IntegrationBinding.integration_id == integration_id,
            models.IntegrationBinding.external_actor == external_actor,
        )
    )
    b = res.scalar_one_or_none()
    if b is None:
        b = models.IntegrationBinding(integration_id=integration_id, external_actor=external_actor, client_id=client_id)
        session.add(b)
    else:
        b.client_id = client_id
    await session.commit()
    await session.refresh(b)
    return binding_to_api(b)


async def list_bindings(session: AsyncSession) -> list[dict]:
    res = await session.execute(select(models.IntegrationBinding))
    return [binding_to_api(b) for b in res.scalars().all()]


async def delete_binding(session: AsyncSession, bid: str) -> dict:
    b = await session.get(models.IntegrationBinding, bid)
    if b is None:
        return {"ok": False}
    await session.delete(b)
    await session.commit()
    return {"ok": True}


async def _resolve_repo(session: AsyncSession, integration_id: str, ext_repo: str | None) -> tuple[str, str | None]:
    """Resolve an external repository to repository and project IDs using explicit trimmed,
    case-folded bindings. Unmapped repositories return empty defaults.
    """
    key = (ext_repo or "").strip()
    if not key:
        return "", None
    res = await session.execute(
        select(models.RepoBinding).where(models.RepoBinding.integration_id == integration_id)
    )
    hit = next((b for b in res.scalars().all()
                if (b.external_repo or "").strip().lower() == key.lower()), None)
    if hit is None:
        return "", None
    repo = await session.get(models.Repo, hit.repo_id)
    if repo is None:
        return "", None                       # A binding to a deleted repository is treated as unmapped.
    return repo.id, repo.project_id


async def _smart_route(session: AsyncSession, title: str, note: str) -> tuple[str, str | None]:
    """Use only configured route_keywords for fallback routing; ambiguous or absent matches remain
    unassigned.
    """
    from . import optional_internal_features
    if not optional_internal_features.available("smart_route"):
        return "", None
    from . import smart_route
    rows = [r for r in (await session.execute(
        select(models.Repo))).scalars().all()
        if (getattr(r, "route_keywords", None) or [])]
    if not rows:
        return "", None
    repo, why = smart_route.match(rows, title, note)
    if repo is None:
        return "", None
    return repo.id, repo.project_id


_SEV_URGENT = ("critical", "blocker", "p0", "p1", "致命", "严重", "紧急")
_SEV_PRIO = {"critical": "critical", "blocker": "critical", "p0": "critical", "致命": "critical",
             "严重": "high", "high": "high", "major": "high", "p1": "high",
             "low": "low", "minor": "low", "轻微": "low", "建议": "low"}


def _from_severity(sev: str | None) -> tuple[str | None, bool | None]:
    """Normalize severity to priority, including urgent; return None for unknown values."""
    s = (sev or "").strip().lower()
    if not s:
        return None, None
    return _SEV_PRIO.get(s), (True if any(k in s for k in _SEV_URGENT) else None)


async def _resolve_owner(session: AsyncSession, integration_id: str, assignee: str | None) -> str | None:
    if not assignee:
        return None
    res = await session.execute(
        select(models.IntegrationBinding).where(
            models.IntegrationBinding.integration_id == integration_id,
            models.IntegrationBinding.external_actor == assignee,
        )
    )
    b = res.scalar_one_or_none()
    return b.client_id if b else None


# Task ingestion.

async def ingest_one(session: AsyncSession, integration: models.Integration, env: dict) -> dict:
    # Subscription enable and legacy ingestion share one fence, including the
    # first-enable remote validation window. No old importer can slip through
    # before enabled_at becomes visible and produce a duplicate requirement.
    from . import repository_issue_sync as issues, resource_leases
    repo = await issues.catalog_for_envelope(session, integration, env)
    if repo is None:
        return await _ingest_one_legacy(session, integration, env)
    lease = await resource_leases.acquire(session, "repository-issues", repo.id, ttl_seconds=120)
    try:
        if await issues.owns_envelope(session, integration, env):
            return {"ok": True, "created": False, "assigned": False,
                    "skipped": "repository_issue_subscription"}
        return await _ingest_one_legacy(session, integration, env, lease=lease)
    except BaseException:
        await session.rollback()
        raise
    finally:
        await resource_leases.release(session, lease)


async def _ingest_one_legacy(session: AsyncSession, integration: models.Integration, env: dict, *, lease=None) -> dict:
    """Normalize and idempotently upsert an envelope by integration and external ID, then notify its owner."""
    ext_id = env.get("external_id")
    if not ext_id:
        return {"ok": False, "reason": "missing external_id"}
    assignee = env.get("assignee")
    owner = await _resolve_owner(session, integration.id, assignee)
    res = await session.execute(
        select(models.Task).where(
            models.Task.integration_id == integration.id,
            models.Task.external_id == str(ext_id),
        )
    )
    t = res.scalar_one_or_none()
    repo_id, project_id = await _resolve_repo(session, integration.id, env.get("ext_repo"))
    if not repo_id:
        # If explicit repository mapping fails, try configured content-based routing.
        # Leave unresolved repositories empty and report them in unmappedRepos.
        repo_id, project_id = await _smart_route(
            session, str(env.get("title") or ""), str(env.get("note") or ""))
    prio, sev_urgent = _from_severity(env.get("severity"))
    fields = {
        "title": env.get("title") or "未命名",
        "source": env.get("source_label") or integration.name,
        "note": env.get("note") or "",
        "status": env.get("status") or "todo",
        "urgent": env.get("urgent") if env.get("urgent") is not None else sev_urgent,
        "important": env.get("important"),
        "external_url": env.get("external_url"),
        "external_actor": assignee,
    }
    created = t is None
    if t is None:
        t = models.Task(
            integration_id=integration.id,
            origin=integration.type,
            external_id=str(ext_id),
            owner_client_id=owner,
            **fields,
        )
        session.add(t)
    else:
        for k, v in fields.items():
            setattr(t, k, v)
        if t.owner_client_id is None and owner is not None:  # Assign previously unowned tasks when a binding becomes available.
            t.owner_client_id = owner
    # Always retain the source platform's original repository name.
    # The administration mapping queue relies on that source name.
    ext_repo = (env.get("ext_repo") or "").strip()
    if ext_repo:
        t.ext_repo = ext_repo[:200]
    # Fill repository, priority, and requester fields only when empty.
    # Repeated ingestion must preserve manual changes made in SoduWork.
    if repo_id and not (getattr(t, "repo_id", "") or ""):
        t.repo_id = repo_id
    if project_id and not t.project_id:
        t.project_id = project_id
    if prio and (t.priority or "normal") == "normal":
        t.priority = prio
    rep = (env.get("reporter") or "").strip()
    if rep and not (t.requester_name or ""):
        t.requester_name = rep[:64]
    integration.last_ingest_at = datetime.now(timezone.utc)  # Track the most recent external-data receipt for integration health.
    if lease is not None:
        from .repository_issue_sync import fence
        await fence(session, lease)
    await session.commit()
    await session.refresh(t)
    api = task_to_api(t)
    if t.owner_client_id:
        await publish_owner(session, t, {"type": "task." + ("created" if created else "updated"), "task": api})
    return {"ok": True, "assigned": bool(t.owner_client_id), "created": created, "task": api,
            # Report whether this item's repository was resolved.
            "repoMapped": bool(t.repo_id), "extRepo": (env.get("ext_repo") or "").strip()}


async def ingest_many(session: AsyncSession, integration: models.Integration, items: list[dict]) -> dict:
    results = [await ingest_one(session, integration, e) for e in items]
    assigned = sum(1 for r in results if r.get("assigned"))
    # Return unresolved repositories directly to the sender.
    # A successful HTTP response must not conceal tasks left unassigned.
    unmapped = sorted({r.get("extRepo") for r in results
                       if r.get("ok") and r.get("extRepo") and not r.get("repoMapped")})
    return {
        "ok": True,
        "count": len(results),
        "assigned": assigned,
        "unassigned": len(results) - assigned,
        "unmappedRepos": unmapped,
    }


# Unassigned task pool.

async def list_unassigned(session: AsyncSession) -> list[dict]:
    res = await session.execute(
        select(models.Task).where(models.Task.owner_client_id.is_(None)).order_by(models.Task.created_at.desc())
    )
    return [task_to_api(t) for t in res.scalars().all()]


async def assign_task(session: AsyncSession, task_id: str, client_id: str, create_binding_flag: bool = True) -> dict:
    t = await session.get(models.Task, task_id)
    if t is None:
        return {"ok": False, "reason": "not_found"}
    t.owner_client_id = client_id
    await session.commit()
    if create_binding_flag and t.integration_id and t.external_actor:
        await create_binding(session, t.integration_id, t.external_actor, client_id)
    await session.refresh(t)
    api = task_to_api(t)
    await publish_owner(session, t, {"type": "task.created", "task": api})
    return {"ok": True, "task": api}
