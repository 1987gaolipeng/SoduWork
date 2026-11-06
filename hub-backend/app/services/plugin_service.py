"""Plugin registration, immutable versions, trust approval, and project bindings."""
from __future__ import annotations

import os
import re
from collections import Counter
from datetime import datetime, timedelta, timezone

from sqlalchemy import inspect as sa_inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import product_brand
from . import (approval_routing, plugin_audience, plugin_compat,
               plugin_identity, plugin_marketplace, plugin_packages,
               plugin_route_readiness, plugin_runtime, plugin_signatures, rbac,
               plugin_ui_contracts)
from .plugin_catalog import _version_key, _submitted_version_key, client_catalog
from .plugin_readiness import binding_readiness, simulate
from . import plugin_bindings
from .plugin_bindings import (
    _SECRET_WORD, _secret_path, _task_user_id, resolve_binding,
    public_inputs, public_workflow_node, available_bindings,
)

def _ms(dt):
    from .release_control import _ms as stamp
    return stamp(dt)


def provenance_api(value: dict | None, checksum: str = "") -> dict:
    """Public, bounded source proof. Package paths and credentials never enter it."""
    row = dict(value or {})
    return {
        "publisherId": str(row.get("publisherId") or "")[:64],
        "publisherName": product_brand.publisher_display(row)[:120],
        "publisherType": str(row.get("publisherType") or "member")[:24],
        "channel": str(row.get("channel") or "unknown")[:32],
        "sourceName": str(row.get("sourceName") or "")[:180],
        "sourceKind": str(row.get("sourceKind") or "")[:24],
        "checksum": str(row.get("checksum") or checksum or "")[:64],
        "signatureState": str(row.get("signatureState") or "unsigned")[:24],
        "signatureKeyId": str(row.get("signatureKeyId") or "")[:120],
        "signatureFingerprint": str(row.get("signatureFingerprint") or "")[:64],
        "signatureSignedAt": str(row.get("signatureSignedAt") or "")[:40],
        "contentChecksum": str(row.get("contentChecksum") or "")[:64],
    }


def _provenance(parsed: dict, user, channel: str, source_name: str,
                signature_proof: dict | None = None,
                publisher_candidate: dict | None = None) -> dict:
    uid = approval_routing.actor_id(user)
    try:
        state = sa_inspect(user)
        loaded = state.dict if state.identity is not None else {}
    except Exception:
        loaded = None
    if loaded is None:
        display_name = getattr(user, "display_name", "")
        username = getattr(user, "username", "")
    else:
        # A long workflow may commit before importing another plugin. Accessing
        # an expired ORM attribute here would attempt async IO from sync code.
        display_name = loaded.get("display_name", "")
        username = loaded.get("username", "")
    name = str(display_name or username or uid or "未知发布者")
    system = uid == "system" or channel == "builtin"
    proof = dict(signature_proof or {})
    verified = proof.get("state") == "verified"
    out = provenance_api({
        "publisherId": proof.get("publisherId") if verified else uid,
        "publisherName": (
            "SoduWork 平台" if system else proof.get("publisherName") if verified else name),
        "publisherType": (
            "platform" if system else proof.get("publisherType") if verified else "member"),
        "channel": channel,
        "sourceName": os.path.basename(str(source_name or "")),
        "sourceKind": str(parsed.get("sourceKind") or ""),
        "checksum": str(parsed.get("checksum") or ""),
        "contentChecksum": str(parsed.get("contentChecksum") or ""),
        "signatureState": "platform" if system else str(proof.get("state") or "unsigned"),
        "signatureKeyId": str(proof.get("keyId") or ""),
        "signatureFingerprint": str(proof.get("fingerprint") or ""),
        "signatureSignedAt": str(proof.get("signedAt") or ""),
    })
    candidate = dict(publisher_candidate or {})
    if candidate:
        out["signatureFingerprint"] = out["signatureFingerprint"] or candidate["fingerprint"]
        out["_publisherCandidate"] = candidate
    return out


def version_api(v: am.PluginVersion, compatibility: dict | None = None, audience_count: int = 0) -> dict:
    report = dict(v.capability_report or {})
    public_workflow = v.workflow or {} if report.get("hasWorkflow", True) else {"nodes": []}
    out = {
        "id": v.id, "pluginId": v.plugin_id, "version": v.version,
        "checksum": v.checksum, "manifest": product_brand.manifest_display(v),
        "workflow": public_workflow, "capabilities": report,
        "provenance": provenance_api(v.provenance, v.checksum),
        "process": plugin_packages.process_profile(v.manifest or {}, report),
        "trustState": v.trust_state, "visibility": plugin_audience.normalize(v.visibility),
        "audienceCount": int(audience_count), "enabled": v.enabled, "createdAt": _ms(v.created_at),
    }
    if compatibility is not None:
        out["compatibility"] = compatibility
    return out


def binding_api(b: am.PluginBinding) -> dict:
    return {
        "id": b.id, "pluginId": b.plugin_id, "versionId": b.version_id,
        "orgId": b.org_id, "projectId": b.project_id, "config": b.config or {},
        "secretRefs": b.secret_refs or {}, "enabled": b.enabled,
        "createdAt": _ms(b.created_at),
    }


def _plugin_health_summary(runs: list, failures: list, version_names: dict[str, str],
                           *, sampled: bool = False, window_days: int = 30) -> dict:
    states = Counter(str(row.state or "unknown") for row in runs)
    decided = states["succeeded"] + states["failed"]
    success_rate = round(states["succeeded"] * 100 / decided, 1) if decided else None
    durations = []
    for row in runs:
        start, finish = row.started_at or row.created_at, row.finished_at
        if not start or not finish:
            continue
        try:
            duration = max(0, int((finish.timestamp() - start.timestamp()) * 1000))
        except (AttributeError, OSError, ValueError):
            continue
        durations.append(duration)
    durations.sort()

    def percentile(ratio: float) -> int | None:
        if not durations:
            return None
        index = min(len(durations) - 1, max(0, int(len(durations) * ratio + .999) - 1))
        return durations[index]

    if not runs:
        health_state, health_label = "no-data", "暂无运行"
    elif decided < 3:
        health_state, health_label = "learning", "观察中"
    elif success_rate is not None and success_rate >= 90:
        health_state, health_label = "healthy", "运行稳定"
    elif success_rate is not None and success_rate >= 70:
        health_state, health_label = "attention", "需要关注"
    else:
        health_state, health_label = "critical", "需要修复"

    versions = Counter(version_names.get(row.plugin_version_id, "未知版本") for row in runs)
    failed_nodes = Counter(str(row.node_key or "unknown") for row in failures)
    latest_failures = [{
        "runId": row.run_id,
        "nodeKey": str(row.node_key or ""),
        "error": str(row.error or "")[:240],
        "at": _ms(row.finished_at or row.created_at),
    } for row in failures[:5]]
    return {
        "windowDays": window_days, "sampled": bool(sampled),
        "state": health_state, "label": health_label,
        "runs": len(runs), "active": sum(states[x] for x in (
            "queued", "running", "waiting_human", "waiting_external")),
        "succeeded": states["succeeded"], "failed": states["failed"],
        "cancelled": states["cancelled"], "successRate": success_rate,
        "medianDurationMs": percentile(.5), "p95DurationMs": percentile(.95),
        "lastRunAt": _ms(runs[0].created_at) if runs else None,
        "versions": [{"version": name, "runs": count}
                     for name, count in versions.most_common(8)],
        "failureHotspots": [{"nodeKey": key, "attempts": count}
                            for key, count in failed_nodes.most_common(5)],
        "latestFailures": latest_failures,
    }


async def plugin_health(session: AsyncSession, plugin_id: str,
                        version_names: dict[str, str]) -> dict:
    since = datetime.now(timezone.utc) - timedelta(days=30)
    rows = list((await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.plugin_id == plugin_id,
        am.WorkflowRun.created_at >= since,
    ).order_by(am.WorkflowRun.created_at.desc()).limit(501))).scalars().all())
    sampled = len(rows) > 500
    runs = rows[:500]
    run_ids = [row.id for row in runs]
    failures = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id.in_(run_ids or {"__none__"}),
        am.NodeRun.state.in_(("failed", "rework")),
    ).order_by(am.NodeRun.created_at.desc()).limit(500))).scalars().all())
    return _plugin_health_summary(
        runs, failures, version_names, sampled=sampled, window_days=30)


_POLICY_UNSET = object()

async def plugin_api(session: AsyncSession, p: am.Plugin, detail: bool = False,
                     catalog_policy=_POLICY_UNSET) -> dict:
    out = {
        "id": p.id, "orgId": p.org_id, "key": p.key, "name": p.name,
        **plugin_identity.public(p),
        "description": p.description, "sourceKind": p.source_kind,
        "enabled": p.enabled, "createdBy": p.created_by,
        "createdAt": _ms(p.created_at), "updatedAt": _ms(p.updated_at),
    }
    if catalog_policy is _POLICY_UNSET:
        catalog_policy = await plugin_marketplace.get(session, p.id)
    out["catalogPolicy"] = plugin_marketplace.public_policy(catalog_policy)
    versions = list((await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == p.id
    ).order_by(am.PluginVersion.created_at.desc(), am.PluginVersion.id.desc()))).scalars().all())
    versions.sort(key=_submitted_version_key, reverse=True)
    audience_counts = await plugin_audience.counts(session, [row.id for row in versions])
    version_rows = [
        version_api(row, plugin_compat.between(
            versions[index + 1] if index + 1 < len(versions) else None, row),
            audience_counts.get(row.id, 0))
        for index, row in enumerate(versions)
    ]
    out["latestVersion"] = version_rows[0] if version_rows else None
    out["versionCount"] = len(versions)
    if detail:
        out["versions"] = version_rows
        bindings = list((await session.execute(select(am.PluginBinding).where(
            am.PluginBinding.plugin_id == p.id
        ).order_by(am.PluginBinding.created_at.desc()))).scalars().all())
        by_version = {row.id: row for row in versions}
        binding_rows = []
        for binding in bindings:
            item = binding_api(binding)
            current = by_version.get(binding.version_id)
            item["upgradeOptions"] = {
                target.id: plugin_compat.between(current, target)
                for target in versions if target.id != binding.version_id
            }
            binding_rows.append(item)
        out["bindings"] = binding_rows
        out["health"] = await plugin_health(
            session, p.id, {row.id: row.version for row in versions})
    return out


async def list_plugins(session: AsyncSession, org_ids: set[str] | None = None) -> list[dict]:
    """Return the catalog with a bounded query count.

    The old implementation called plugin_api for every row, producing two
    extra queries per plugin. The management overview and employee catalog both
    depend on this path, so assemble the same public shape from batched versions
    and audience counts.
    """
    q = select(am.Plugin).order_by(am.Plugin.updated_at.desc())
    if org_ids is not None:
        q = q.where((am.Plugin.org_id.in_(org_ids or {"__none__"})) |
                    am.Plugin.org_id.is_(None))
    rows = list((await session.execute(q)).scalars().all())
    if not rows:
        return []
    policies = await plugin_marketplace.by_plugin(session, [row.id for row in rows])
    versions = list((await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id.in_([row.id for row in rows])
    ).order_by(am.PluginVersion.created_at.desc(), am.PluginVersion.id.desc()))).scalars().all())
    versions.sort(key=_submitted_version_key, reverse=True)
    grouped: dict[str, list[am.PluginVersion]] = {}
    for version in versions:
        grouped.setdefault(version.plugin_id, []).append(version)
    audience_counts = await plugin_audience.counts(
        session, [version.id for version in versions])
    out = []
    for plugin in rows:
        version_rows = grouped.get(plugin.id, [])
        public_versions = [
            version_api(version, plugin_compat.between(
                version_rows[index + 1] if index + 1 < len(version_rows) else None,
                version), audience_counts.get(version.id, 0))
            for index, version in enumerate(version_rows)
        ]
        item = {
            "id": plugin.id, "orgId": plugin.org_id, "key": plugin.key,
            **plugin_identity.public(plugin),
            "name": plugin.name, "description": plugin.description,
            "sourceKind": plugin.source_kind, "enabled": plugin.enabled,
            "createdBy": plugin.created_by, "createdAt": _ms(plugin.created_at),
            "updatedAt": _ms(plugin.updated_at),
            "catalogPolicy": plugin_marketplace.public_policy(policies.get(plugin.id)),
            "latestVersion": public_versions[0] if public_versions else None,
            "versionCount": len(public_versions),
        }
        out.append(item)
    return out


async def install(session: AsyncSession, data: bytes, user, org_id: str | None = None, *,
                  visibility: str = plugin_audience.ORGANIZATION,
                  audience_user_ids=None, audience_org_unit_ids=None,
                  source_channel: str = "admin-import", source_name: str = "",
                  publisher_candidate: dict | None = None,
                  source_plugin_id: str = "") -> dict:
    parsed = plugin_packages.parse(data)
    if source_plugin_id:
        from . import plugin_access
        source = await session.get(am.Plugin, str(source_plugin_id))
        if source is None:
            raise PermissionError("原插件不存在")
        await plugin_access.require_edit(session, source, approval_routing.actor_id(user))
        if str(parsed["manifest"]["key"]) != source.key:
            raise ValueError("改进原插件时不能更改插件标识；请保留原标识再提交")
        # The source is trusted server state, never a client-supplied org ID.
        org_id = source.org_id
    signature_proof = await plugin_signatures.inspect(session, parsed, org_id)
    plugin_signatures.assert_importable(signature_proof)
    candidate = (plugin_signatures.verify_candidate(
        parsed, publisher_candidate,
        str(getattr(user, "display_name", "") or getattr(user, "username", "") or ""))
        if publisher_candidate else {})
    manifest = parsed["manifest"]
    mode = plugin_audience.normalize(visibility)
    selected_users = (await plugin_audience.validate_users(
        session, org_id, audience_user_ids)) if mode == plugin_audience.USERS else []
    selected_orgs = (await plugin_audience.validate_org_units(
        session, org_id, audience_org_unit_ids)
        if mode == plugin_audience.ORG_UNITS else [])
    uid = approval_routing.actor_id(user)
    plugin, _created_plugin = await plugin_identity.get_or_create_plugin(
        session, org_id=org_id, key=manifest["key"], name=manifest["name"],
        description=manifest["description"], source_kind=parsed["sourceKind"],
        created_by=uid)
    if not _created_plugin and source_channel in {"client-package", "client-builder", "personal-publish"}:
        from . import plugin_access
        await plugin_access.require_edit(session, plugin, uid)

    async def reuse_version(existing: am.PluginVersion) -> dict:
        # Quarantined packages must not mutate metadata employees already see.
        # Their original author may update review provenance and audience.
        if existing.trust_state == "quarantined" and existing.created_by == uid:
            saved_candidate = candidate or dict(
                dict(existing.provenance or {}).get("_publisherCandidate") or {})
            existing.provenance = _provenance(
                parsed, user, source_channel, source_name,
                signature_proof, saved_candidate)
            await plugin_audience.replace(
                session, existing, mode, selected_users, org_id=org_id,
                created_by=uid, org_unit_ids=selected_orgs)
            await session.commit()
        return {"created": False, "versionId": existing.id,
                "plugin": await plugin_api(session, plugin, True)}

    state, existing = await plugin_identity.version_state(
        session, plugin.id, manifest["version"], parsed["checksum"])
    if state == "same" and existing is not None:
        return await reuse_version(existing)
    if state == "conflict":
        raise plugin_identity.PluginVersionConflict(
            "同一个版本号的插件内容已经变化，请提升版本号后再导入")

    path = plugin_packages.store(parsed)
    capability_report = dict(parsed["capabilities"] or {})
    capability_report["sourceKind"] = parsed["sourceKind"]
    version = am.PluginVersion(
        plugin_id=plugin.id, version=manifest["version"], checksum=parsed["checksum"],
        manifest=manifest, workflow=parsed["workflow"],
        capability_report=capability_report,
        provenance=_provenance(
            parsed, user, source_channel, source_name, signature_proof, candidate),
        package_path=path,
        trust_state="quarantined", visibility=mode, enabled=False, created_by=uid)
    version, created = await plugin_identity.insert_version_once(session, version)
    if not created:
        return await reuse_version(version)
    await plugin_audience.replace(
        session, version, mode, selected_users, org_id=org_id, created_by=uid,
        org_unit_ids=selected_orgs)
    await session.commit()
    return {"created": created, "versionId": version.id,
            "plugin": await plugin_api(session, plugin, True)}

async def approve_version(session: AsyncSession, version: am.PluginVersion, enabled: bool,
                          who: str, *, commit: bool = True) -> am.PluginVersion:
    if enabled:
        provenance = provenance_api(version.provenance, version.checksum)
        signature_state = provenance.get("signatureState")
        if signature_state not in {"unsigned", "platform"}:
            if not version.package_path or not os.path.isfile(version.package_path):
                raise ValueError("签名插件的原始包已缺失，不能发布")
            from . import file_io
            parsed = await file_io.run(plugin_packages.parse_file, version.package_path)
            if parsed.get("checksum") != version.checksum:
                raise ValueError("插件包内容与不可变版本不一致")
            plugin = await session.get(am.Plugin, version.plugin_id)
            proof = await plugin_signatures.inspect(
                session, parsed, plugin.org_id if plugin is not None else None)
            plugin_signatures.assert_publishable(proof)
            version.provenance = provenance_api({
                **provenance,
                "publisherId": proof.get("publisherId"),
                "publisherName": proof.get("publisherName"),
                "publisherType": proof.get("publisherType"),
                "checksum": parsed.get("checksum"),
                "contentChecksum": parsed.get("contentChecksum"),
                "signatureState": proof.get("state"),
                "signatureKeyId": proof.get("keyId"),
                "signatureFingerprint": proof.get("fingerprint"),
                "signatureSignedAt": proof.get("signedAt"),
            })
    version.trust_state = "approved" if enabled else "revoked"
    version.enabled = bool(enabled)
    plugin = await session.get(am.Plugin, version.plugin_id)
    if plugin is not None:
        if enabled:
            plugin.enabled = True
            manifest = dict(version.manifest or {})
            plugin.name = str(manifest.get("name") or plugin.name)[:120]
            plugin.description = str(
                manifest.get("description") or plugin.description or "")[:600]
            plugin.source_kind = str(
                dict(version.capability_report or {}).get("sourceKind")
                or plugin.source_kind)[:24]
        else:
            # Revoking one version must preserve other approved versions of the same plugin.
            other = await session.scalar(select(am.PluginVersion.id).where(
                am.PluginVersion.plugin_id == version.plugin_id,
                am.PluginVersion.id != version.id,
                am.PluginVersion.trust_state == "approved",
                am.PluginVersion.enabled.is_(True)).limit(1))
            plugin.enabled = bool(other)
            bindings = list((await session.execute(select(am.PluginBinding).where(
                am.PluginBinding.version_id == version.id,
                am.PluginBinding.enabled.is_(True)))).scalars().all())
            for binding in bindings:
                binding.enabled = False
    if commit:
        await session.commit()
    else:
        await session.flush()
    return version


async def delete_plugin(session: AsyncSession, plugin: am.Plugin,
                        *, force: bool = False, actor_id: str = "",
                        commit: bool = True) -> dict:
    """Permanently remove an unpublished plugin and its immutable snapshots.

    Deletion is intentionally stricter than unpublishing.  A plugin must be
    hidden from the employee catalog, have no approved versions, active
    bindings/installations/runs, or in-flight publication evaluations.  Audit
    history is kept by the API layer; package files are removed only after all
    guards pass.

    ``force=True`` runs the same guards but clears the reversible references
    first: delisting from the employee catalog, disabling bindings and
    employee installations, and revoking approved versions.  In-flight runs
    and evaluations are still refused so the runtime stays authoritative.
    """
    locked = await session.scalar(select(am.Plugin).where(
        am.Plugin.id == plugin.id).with_for_update())
    if locked is not None:
        plugin = locked
    policy = await plugin_marketplace.get(session, plugin.id)
    if force:
        if policy is not None and policy.installation != plugin_marketplace.NOT_AVAILABLE:
            await plugin_marketplace.upsert(
                session, plugin.id, {"installation": plugin_marketplace.NOT_AVAILABLE},
                actor_id or "plugin-delete", commit=False)
    elif policy is None or policy.installation != plugin_marketplace.NOT_AVAILABLE:
        raise ValueError("请先将插件下架后再删除")
    versions = list((await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == plugin.id))).scalars().all())
    approved = [row for row in versions
                if row.trust_state == "approved" and row.enabled]
    if force:
        if approved:
            for row in approved:
                row.trust_state = "revoked"
                row.enabled = False
        plugin.enabled = False
    elif approved or plugin.enabled:
        raise ValueError("仍有已审核启用的版本，请先撤销版本")
    bindings = list((await session.execute(select(am.PluginBinding).where(
        am.PluginBinding.plugin_id == plugin.id,
        am.PluginBinding.enabled.is_(True)))).scalars().all())
    if force:
        for binding in bindings:
            binding.enabled = False
    elif bindings:
        raise ValueError(f"仍有 {len(bindings)} 个启用中的需求绑定，请先停用")
    installations = list((await session.execute(select(am.PluginInstallation).where(
        am.PluginInstallation.plugin_id == plugin.id,
        am.PluginInstallation.enabled.is_(True)))).scalars().all())
    if force:
        for installation in installations:
            installation.enabled = False
    elif installations:
        raise ValueError(f"仍有 {len(installations)} 个员工安装，请先停用")
    active_states = {"queued", "dispatching", "running", "waiting_human",
                     "waiting_external", "rework"}
    active_runs = list((await session.execute(select(am.WorkflowRun).where(
        am.WorkflowRun.plugin_id == plugin.id,
        am.WorkflowRun.state.in_(active_states)))).scalars().all())
    if active_runs:
        raise ValueError(f"仍有 {len(active_runs)} 个运行中的需求，请等待完成或取消")
    active_evaluations = list((await session.execute(select(am.PluginEvaluationRun).where(
        am.PluginEvaluationRun.plugin_id == plugin.id,
        am.PluginEvaluationRun.state.in_(active_states)))).scalars().all())
    if active_evaluations:
        raise ValueError(f"仍有 {len(active_evaluations)} 个发布评测运行中，请先停止")

    package_paths = {str(row.package_path or "") for row in versions if row.package_path}
    shared_paths = set((await session.execute(select(am.PluginVersion.package_path).where(
        am.PluginVersion.plugin_id != plugin.id,
        am.PluginVersion.package_path.in_(package_paths or {"__none__"})))).scalars().all())
    package_paths -= {str(path or "") for path in shared_paths}
    # These tables have deliberately no ORM relationships, so delete children
    # explicitly and remain compatible with the existing SQLite deployments.
    for model in (am.PluginInstallation, am.PluginAudience,
                  am.PluginEvaluationRun, am.PluginBinding,
                  am.PluginCatalogPolicy, am.PluginVersion):
        rows = list((await session.execute(select(model).where(
            getattr(model, "plugin_id") == plugin.id))).scalars().all())
        for row in rows:
            await session.delete(row)
    # Placement slots reference plugins by (target_type, target_id), not
    # plugin_id, so they leave the loop above and are cleaned separately.
    rec_rows = list((await session.execute(select(am.PluginRecommendation).where(
        am.PluginRecommendation.target_type == "plugin",
        am.PluginRecommendation.target_id == plugin.id))).scalars().all())
    for row in rec_rows:
        await session.delete(row)
    await session.delete(plugin)
    if commit:
        await session.commit()
    else:
        await session.flush()
    if commit:
        for path in package_paths:
            try:
                if path and os.path.isfile(path):
                    os.remove(path)
            except OSError:
                # The database deletion is authoritative; an orphaned package is
                # harmless and can be cleaned by the normal data-root retention job.
                pass
    return {"pluginId": plugin.id, "versionsDeleted": len(versions),
            "forced": bool(force),
            "bindingsDisabled": len(bindings),
            "installationsDisabled": len(installations)}


async def save_binding(session: AsyncSession, plugin: am.Plugin, body: dict,
                       binding: am.PluginBinding | None = None, *,
                       commit: bool = True, flush: bool = True,
                       verify_readiness: bool = True) -> am.PluginBinding:
    return await plugin_bindings.save_binding(
        session, plugin, body, binding, commit=commit, flush=flush,
        verify_readiness=verify_readiness, readiness_check=binding_readiness)


async def bootstrap_example(session: AsyncSession) -> None:
    """Discover and reconcile the immutable built-in plugin catalog."""
    from . import plugin_bootstrap
    await plugin_bootstrap.bootstrap_example(session, provenance_api)
