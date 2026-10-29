"""Canonical GitLab/GitHub repository catalog and project-specific mappings.

Secrets are resolved from a selected SoduWork code account for one request and are
never persisted in the integration or repository catalog.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models, repository_issue_models  # register catalog subscription metadata
from ..connectors import get_connector
from . import code_creds, resource_leases, scm_support


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _fingerprint(payload: dict) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _slug(value: str, fallback: str = "repo") -> str:
    value = re.sub(r"[^0-9A-Za-z._-]+", "-", str(value or "")).strip("-.")
    return value[:180] or fallback


def _mapping_identity(row: models.Repo) -> str:
    """Stable lock identity for catalog and manually registered mappings."""
    if row.source_repository_id:
        return str(row.source_repository_id)
    canonical = str(row.git_url or "").strip().rstrip("/").lower()
    return "url-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


def _catalog_api(row: am.ScmRepository) -> dict:
    return {
        "id": row.id, "integrationId": row.integration_id,
        "orgId": row.org_id or "", "provider": row.provider,
        "externalId": row.external_id, "fullName": row.full_name,
        "displayName": row.display_name, "cloneUrl": row.clone_url,
        "sshUrl": row.ssh_url, "webUrl": row.web_url,
        "defaultBranch": row.default_branch, "visibility": row.visibility,
        "archived": bool(row.archived), "active": bool(row.active),
        "fingerprint": row.fingerprint,
        "lastSeenAt": row.last_seen_at.isoformat() if row.last_seen_at else None,
    }


def _materialize_pull(cfg: dict, provider: str, user: str, secret: str,
                      kind: str = "") -> None:
    """Populate connector runtime fields from the dedicated pull account, modifying cfg in place."""
    if provider in {"gitlab", "github"}:
        if provider == "github" and kind not in {"", "token"}:
            raise ValueError("GitHub 拉取账号仅支持访问令牌")
        cfg["_auth_user"], cfg["_auth_secret"] = user, secret
        cfg["_auth_kind"] = "token" if provider == "github" else _text(kind, 16)
    else:
        raise ValueError("这个集成源不提供仓库目录（目前支持 GitLab 和 GitHub）")


async def _runtime_config(session: AsyncSession, integration: models.Integration,
                          client_id: str = "",
                          override: dict | None = None) -> tuple[dict, str | None]:
    """Behavior and constraints for this operation."""
    cfg = dict(integration.config or {})
    provider = _text(integration.type, 24).lower()
    scm_support.require_active(provider)
    org_id = _text(cfg.get("orgId"), 64) or None

    pull = cfg.get("pullAuth") if isinstance(cfg.get("pullAuth"), dict) else {}
    # A probe must test the same draft that saving would persist. Blank secrets
    # retain the stored secret, while an explicitly blank username is invalid.
    ov = override or {}
    if any(key in ov for key in ("user", "secret", "kind")):
        ov_user = _text(ov.get("user", pull.get("user")), 200)
        ov_secret = str(ov.get("secret") or pull.get("secret") or "")
        ov_kind = _text(ov.get("kind", pull.get("kind")), 16)
        if not ov_user:
            raise ValueError("请填用户名")
        if not ov_secret:
            raise ValueError("第一次配置需要填密码/令牌")
        _materialize_pull(cfg, provider, ov_user, ov_secret, ov_kind)
        return cfg, org_id

    # Dedicated backend pull account.
    p_user, p_secret = _text(pull.get("user"), 200), str(pull.get("secret") or "")
    if p_user and p_secret:
        _materialize_pull(cfg, provider, p_user, p_secret, _text(pull.get("kind"), 16))
        return cfg, org_id

    if provider == "github":
        # Device credentials are not provider-scoped. Never reuse a GitLab or
        # another account's device token for a GitHub catalog request.
        raise ValueError("请在「仓库目录」为 GitHub 配置固定拉取账号和访问令牌")

    # Legacy fallback: use a selected device's code-hosting account.
    selected = _text(client_id or cfg.get("credentialClientId")
                     or cfg.get("credential_client_id"), 64)
    if not selected:
        raise ValueError("这个代码源还没配拉取账号：在「仓库目录」里填上用户名和密码/令牌，再同步")
    client = await session.get(models.Client, selected)
    if client is None:
        raise ValueError("原来绑定的 SoduWork 设备已不存在——请改用固定拉取账号（填用户名+密码/令牌）")
    git = code_creds.resolve(client)
    if provider == "gitlab":
        token = _text(git.get("token"), 4096)
        if not token:
            raise ValueError("这台设备还没录 GitLab 令牌——建议直接给这个源配固定拉取账号")
        cfg["token"] = token
    else:
        raise ValueError("这个集成源不提供仓库目录（目前支持 GitLab）")
    if org_id is None and client.user_ref:
        user = await session.get(models.User, client.user_ref)
        org_id = str(user.org_id) if user and user.org_id else None
    return cfg, org_id


async def set_pull_account(session: AsyncSession, integration_id: str, *,
                           user: str, secret, kind: str | None = None,
                           org_id: str = "") -> None:
    """Save fixed pull credentials with masked readback. An omitted or None secret preserves the
    current secret when other fields change.
    """
    integration = await session.get(models.Integration, integration_id)
    if integration is None:
        raise ValueError("Integration not found")
    provider = _text(integration.type, 24).lower()
    scm_support.require_active(provider)
    if provider not in ("gitlab", "github"):
        raise ValueError("只有 GitLab 和 GitHub 源支持拉取账号")
    if provider == "github" and kind not in {None, "", "token"}:
        raise ValueError("GitHub 拉取账号仅支持访问令牌")
    cfg = dict(integration.config or {})
    pull = dict(cfg.get("pullAuth") or {})
    pull["user"] = _text(user, 200)
    if secret is not None and str(secret) != "":
        pull["secret"] = str(secret)[:8000]
    if kind is not None:
        pull["kind"] = _text(kind, 16)
    if provider == "github":
        pull["kind"] = "token"
    if not pull.get("user"):
        raise ValueError("请填用户名")
    cfg["pullAuth"] = pull
    if org_id:
        cfg["orgId"] = _text(org_id, 64)
    integration.config = cfg
    await session.commit()


async def verify_pull_account(session: AsyncSession, integration_id: str, *,
                              override: dict | None = None) -> dict:
    """Verify through the connector, allowing a temporary credential override before saving."""
    integration = await session.get(models.Integration, integration_id)
    if integration is None:
        raise ValueError("Integration not found")
    scm_support.require_active(integration.type)
    connector = get_connector(integration.type)
    if connector is None or not callable(getattr(connector, "verify", None)):
        raise ValueError("这个集成源不支持验证拉取账号")
    cfg, _ = await _runtime_config(session, integration, override=override)
    return await asyncio.to_thread(connector.verify, cfg)


def _normalized(integration: models.Integration, raw: dict,
                org_id: str | None) -> dict:
    payload = {
        "integrationId": str(integration.id), "orgId": org_id or "",
        "provider": _text(integration.type, 24).lower(),
        "externalId": _text(raw.get("externalId"), 200),
        "fullName": _text(raw.get("fullName") or raw.get("displayName"), 400),
        "displayName": _text(raw.get("displayName") or raw.get("fullName"), 200),
        "cloneUrl": _text(raw.get("cloneUrl"), 700),
        "sshUrl": _text(raw.get("sshUrl"), 700),
        "webUrl": _text(raw.get("webUrl"), 700),
        "defaultBranch": _text(raw.get("defaultBranch") or "main", 160),
        "visibility": _text(raw.get("visibility"), 24),
        "archived": bool(raw.get("archived")),
        "metadata": dict(raw.get("metadata") or {}),
    }
    if not payload["externalId"] or not payload["fullName"]:
        raise ValueError("Repository catalog item has no stable identity")
    payload["fingerprint"] = _fingerprint(payload)
    return payload


async def sync_integration(session: AsyncSession, integration_id: str, *,
                           client_id: str = "") -> dict:
    integration = await session.get(models.Integration, integration_id)
    if integration is None:
        raise ValueError("Integration not found")
    scm_support.require_active(integration.type)
    connector = get_connector(integration.type)
    if connector is None or not callable(getattr(connector, "list_repositories", None)):
        raise ValueError("This integration cannot list repositories")
    lease = await resource_leases.acquire(
        session, "repository-sync", str(integration.id), ttl_seconds=1800,
        detail={"integrationId": str(integration.id)})
    try:
        cfg, org_id = await _runtime_config(session, integration, client_id)
        rows = await asyncio.to_thread(connector.list_repositories, cfg)
        seen: set[str] = set()
        created = updated = 0
        now = datetime.now(timezone.utc)
        for raw in rows if isinstance(rows, list) else []:
            payload = _normalized(integration, raw if isinstance(raw, dict) else {}, org_id)
            external_id = payload["externalId"]
            if external_id in seen:
                continue
            seen.add(external_id)
            row = (await session.execute(select(am.ScmRepository).where(
                am.ScmRepository.integration_id == integration.id,
                am.ScmRepository.external_id == external_id,
            ))).scalar_one_or_none()
            if row is None:
                row = am.ScmRepository(integration_id=integration.id,
                                       external_id=external_id)
                session.add(row)
                created += 1
            else:
                updated += 1
            row.org_id = org_id
            row.provider = payload["provider"]
            row.full_name = payload["fullName"]
            row.display_name = payload["displayName"]
            row.clone_url = payload["cloneUrl"]
            row.ssh_url = payload["sshUrl"]
            row.web_url = payload["webUrl"]
            row.default_branch = payload["defaultBranch"]
            row.visibility = payload["visibility"]
            row.archived = payload["archived"]
            row.active = True
            row.fingerprint = payload["fingerprint"]
            row.metadata_json = payload["metadata"]
            row.last_seen_at = now
        existing = list((await session.execute(select(am.ScmRepository).where(
            am.ScmRepository.integration_id == integration.id
        ))).scalars().all())
        stale = 0
        for row in existing:
            if row.external_id not in seen and row.active:
                row.active = False
                stale += 1
        cfg_saved = dict(integration.config or {})
        selected = _text(client_id or cfg_saved.get("credentialClientId")
                         or cfg_saved.get("credential_client_id"), 64)
        if selected:
            cfg_saved.pop("credential_client_id", None)
            cfg_saved["credentialClientId"] = selected
            integration.config = cfg_saved
        integration.repository_sync_at = now
        integration.repository_sync_ok = True
        integration.repository_sync_error = None
        integration.repository_sync_count = len(seen)
        await session.commit()
        return {"ok": True, "total": len(seen), "created": created,
                "updated": updated, "inactive": stale}
    except Exception as exc:
        await session.rollback()
        integration = await session.get(models.Integration, integration_id)
        if integration is not None:
            integration.repository_sync_at = datetime.now(timezone.utc)
            integration.repository_sync_ok = False
            integration.repository_sync_error = str(exc)[:512]
            await session.commit()
        raise
    finally:
        await resource_leases.release(session, lease)


async def list_catalog(session: AsyncSession, *, scope: set[str] | None,
                       integration_id: str = "", search: str = "",
                       include_inactive: bool = False) -> list[dict]:
    query = select(am.ScmRepository)
    if scope is not None:
        query = query.where(am.ScmRepository.org_id.in_(scope or {"__none__"}))
    if integration_id:
        query = query.where(am.ScmRepository.integration_id == integration_id)
    if not include_inactive:
        query = query.where(am.ScmRepository.active.is_(True), am.ScmRepository.provider.in_(("gitlab", "github")))
    rows = list((await session.execute(query.order_by(
        am.ScmRepository.full_name.asc()))).scalars().all())
    needle = search.strip().lower()
    if needle:
        rows = [row for row in rows if needle in row.full_name.lower()
                or needle in row.display_name.lower()]
    rows = rows[:1000]
    from . import repository_issue_sync
    states = await repository_issue_sync.summaries(session, [row.id for row in rows])
    return [{**_catalog_api(row), "issueSync": states[row.id]} for row in rows]


async def branches(session: AsyncSession, row: am.ScmRepository, *,
                   client_id: str = "") -> list[str]:
    integration = await session.get(models.Integration, row.integration_id)
    if integration is None:
        raise ValueError("Repository integration not found")
    scm_support.require_active(integration.type)
    connector = get_connector(integration.type)
    if connector is None or not callable(getattr(connector, "list_branches", None)):
        raise ValueError("This integration cannot list branches")
    cfg, _ = await _runtime_config(session, integration, client_id)
    values = await asyncio.to_thread(connector.list_branches, cfg, row.external_id)
    return sorted({str(value).strip() for value in values or [] if str(value).strip()})


async def create_mapping(session: AsyncSession, project: models.Project,
                         source: am.ScmRepository, body: dict) -> models.Repo:
    scm_support.require_active(source.provider)
    scm_support.require_active(body)
    branch = _text(body.get("branch") or source.default_branch or "main", 120)
    target = _text(body.get("mergeBranch") or branch, 120)
    use_ssh = bool(body.get("useSsh"))
    git_url = source.ssh_url if use_ssh and source.ssh_url else source.clone_url
    if not git_url:
        raise ValueError("The catalog repository has no clone URL")
    name = _text(body.get("name") or source.display_name or source.full_name, 120)
    lease = await resource_leases.acquire(
        session, "repository-mapping", f"{project.id}:{source.id}:{branch}",
        ttl_seconds=45, detail={"projectId": str(project.id),
                                "sourceRepositoryId": str(source.id),
                                "branch": branch})
    try:
        existing = (await session.execute(select(models.Repo).where(
            models.Repo.project_id == project.id,
            models.Repo.source_repository_id == source.id,
            models.Repo.default_branch == branch,
        ))).scalar_one_or_none()
        if existing is not None:
            raise ValueError("This repository branch is already mapped to the project")
        row = models.Repo(
            project_id=project.id, org_id=project.org_id,
            source_repository_id=source.id, name=name,
            kind=_text(body.get("kind") or "other", 16), git_url=git_url,
            default_branch=branch, merge_branch=target,
            local_dir=_text(body.get("localDir") or _slug(
                f"{source.display_name or source.full_name}-{branch}"), 200),
            note=_text(body.get("note"), 4000),
            scm="git",
            dev_flow=dict(body.get("devFlow") or {}),
            route_keywords=list(body.get("routeKeywords") or []),
            route_layer=_text(body.get("routeLayer"), 16),
            route_priority=int(body.get("routePriority") or 0))
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return row
    except Exception:
        if not session.is_active:
            await session.rollback()
        raise
    finally:
        await resource_leases.release(session, lease)


async def copy_mapping(session: AsyncSession, source: models.Repo,
                       project: models.Project, body: dict) -> models.Repo:
    scm_support.require_active(source)
    scm_support.require_active(body)
    branch = _text(body.get("branch") or source.default_branch or "main", 120)
    target = _text(body.get("mergeBranch") or branch, 120)
    identity = _mapping_identity(source)
    lease = await resource_leases.acquire(
        session, "repository-mapping", f"{project.id}:{identity}:{branch}",
        ttl_seconds=45, detail={"projectId": str(project.id),
                                "sourceRepoId": str(source.id),
                                "branch": branch})
    try:
        duplicate = select(models.Repo).where(
            models.Repo.project_id == project.id,
            models.Repo.default_branch == branch)
        if source.source_repository_id:
            duplicate = duplicate.where(
                models.Repo.source_repository_id == source.source_repository_id)
        else:
            duplicate = duplicate.where(models.Repo.git_url == source.git_url)
        if (await session.execute(duplicate)).scalar_one_or_none() is not None:
            raise ValueError("This repository branch is already mapped to the project")
        row = models.Repo(
            project_id=project.id, org_id=project.org_id,
            source_repository_id=source.source_repository_id,
            name=_text(body.get("name") or source.name, 120), kind=source.kind,
            git_url=source.git_url, default_branch=branch, merge_branch=target,
            local_dir=_text(body.get("localDir") or _slug(
                f"{source.name}-{project.name}-{branch}"), 200),
            note=source.note, scm=source.scm, gerrit_base=source.gerrit_base,
            dev_flow=dict(source.dev_flow or {}),
            route_keywords=list(source.route_keywords or []),
            route_layer=source.route_layer, route_priority=source.route_priority,
            server_dir="", ai_work_dir="", deploy_targets=[])
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return row
    except Exception:
        if not session.is_active:
            await session.rollback()
        raise
    finally:
        await resource_leases.release(session, lease)


log = logging.getLogger("uvicorn.error")


async def sync_all(session: AsyncSession) -> dict:
    """Refresh every enabled GitLab/GitHub catalog that has a credential owner.
    
    Copy IDs and configuration into plain data before syncing. sync_integration can commit or
    roll back; LeaseBusy also expires ORM objects in the session. Reading integration.id after
    that would trigger synchronous lazy I/O and a greenlet_spawn error under asyncpg,
    potentially preventing other sources from refreshing.
    """
    rows = list((await session.execute(select(models.Integration).where(
        models.Integration.enabled.is_(True),
        models.Integration.type.in_(("gitlab", "github")),
    ))).scalars().all())
    plans = [{"id": str(i.id), "cfg": dict(i.config or {})} for i in rows]
    results = []
    for plan in plans:
        iid, cfg = plan["id"], plan["cfg"]
        pull = cfg.get("pullAuth") if isinstance(cfg.get("pullAuth"), dict) else {}
        has_fixed = bool(str(pull.get("user") or "").strip()
                         and str(pull.get("secret") or "").strip())
        client_id = _text(cfg.get("credentialClientId")
                          or cfg.get("credential_client_id"), 64)
        if not (has_fixed or client_id):
            results.append({"integrationId": iid, "ok": False,
                            "skipped": "credential_not_selected"})
            continue
        try:
            result = await sync_integration(session, iid, client_id=client_id)
            results.append({"integrationId": iid, **result})
        except resource_leases.LeaseBusy:
            results.append({"integrationId": iid, "ok": True,
                            "skipped": "already_running"})
        except Exception as exc:  # one source must never stop the whole catalog
            log.warning("repository catalog sync failed integration=%s: %s", iid, exc)
            results.append({"integrationId": iid, "ok": False,
                            "error": str(exc)[:240]})
    return {"integrations": len(results), "results": results}


async def sync_loop() -> None:
    """Periodic catalog refresh; DB leases make it safe across Hub instances."""
    from ..config import get_settings
    from ..db import SessionLocal

    interval = int(get_settings().repository_sync_interval_seconds or 0)
    if interval <= 0:
        log.info("repository catalog auto sync disabled")
        return
    log.info("repository catalog auto sync started, interval=%ss", interval)
    while True:
        try:
            async with SessionLocal() as session:
                result = await sync_all(session)
            if result["integrations"]:
                log.info("repository catalog sync round: %s", result)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # a bad round must not kill future refreshes
            log.warning("repository catalog sync round failed: %s", exc)
        await asyncio.sleep(max(60, interval))


def api(row: am.ScmRepository) -> dict:
    return _catalog_api(row)
