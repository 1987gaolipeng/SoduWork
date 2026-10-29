"""CICD publication nodes shared by GitLab and generic Git workflows.

Historical target settings remain readable independently of SCM review services.
"""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from . import optional_internal_features, task_code_targets, task_events, workflow_contracts
from .delivery_evidence import require_evidence


async def legacy_publish_config(session, repo) -> dict | None:
    """Read repository publication targets from gerrit_publish_targets. Return None when absent;
    never infer a deployment destination.
    """
    import json
    row = await session.get(models.AppSetting, "gerrit_publish_targets")
    if not row or not str(getattr(row, "value", "") or "").strip():
        return None
    try:
        m = json.loads(row.value)
    except (ValueError, TypeError):
        return None
    cfg = m.get(str(repo.id)) if isinstance(m, dict) else None
    return cfg if isinstance(cfg, dict) and cfg.get("customer") else None


def default_service(repo) -> list:
    """Default service selection uses the repository name and target branch."""
    url = str(getattr(repo, "git_url", "") or "").rstrip("/")
    name = url.rsplit("/", 1)[-1] if url else (str(getattr(repo, "local_dir", "") or "")
                                               or getattr(repo, "name", ""))
    return [name, str(getattr(repo, "default_branch", "") or "develop")]


def wants_cicd(node: dict | None) -> bool:
    """Recognize an explicit CICD publish node by mode or configuration. Otherwise retain the
    ordinary delivery-completion behavior.
    """
    cfg = dict((node or {}).get("config") or {})
    return str(cfg.get("mode") or "").lower() == "cicd" or isinstance(cfg.get("cicd"), dict)


def _services(raw, repo) -> list[tuple[str, str]]:
    """Accept service/branch pairs or dictionaries; otherwise derive them from repository
    configuration.
    """
    out: list[tuple[str, str]] = []
    for item in (raw or []):
        if isinstance(item, dict) and item.get("service"):
            out.append((str(item["service"]), str(item.get("branch") or "")))
        elif isinstance(item, (list, tuple)) and item:
            out.append((str(item[0]), str(item[1]) if len(item) > 1 else ""))
    if out:
        return [(svc, branch or str(getattr(repo, "merge_branch", "")
                                    or getattr(repo, "default_branch", "") or "develop"))
                for svc, branch in out]
    return [tuple(default_service(repo))]


async def _publish_target(session: AsyncSession, run, node: dict, repo) -> dict | None:
    """Behavior and constraints for this operation."""
    from sqlalchemy import select as _sel

    from .. import automation_models as am
    from . import release_providers
    cfg = dict(node.get("config") or {})
    candidates: list[dict] = []
    if repo is not None:
        rows = list((await session.execute(_sel(am.DeploymentTarget).where(
            am.DeploymentTarget.repo_id == repo.id,
            am.DeploymentTarget.enabled.is_(True)))).scalars().all())
        for row in rows:
            if release_providers.provider_of(row) == release_providers.CICD:
                # Retain the deployment-target identity so verification reads assertions from the same configuration.
                candidates.append({**dict(row.config or {}), "targetId": row.id,
                                   "environmentId": row.environment_id})
    if isinstance(cfg.get("cicd"), dict):
        candidates.append(dict(cfg["cicd"]))
    binding = await session.get(am.PluginBinding, run.binding_id) if run.binding_id else None
    bind_cfg = dict((binding.config if binding else {}) or {})
    if isinstance(bind_cfg.get("cicdPublish"), dict):
        candidates.append(dict(bind_cfg["cicdPublish"]))
    from_setting = await legacy_publish_config(session, repo) if repo else None
    if from_setting:
        candidates.append(dict(from_setting))
    for item in candidates:
        if str(item.get("customer") or "").strip():
            return item
    return None


def _merged_commit(nr) -> str:
    """Read the upstream merge revision used for artifact verification."""
    for output in (dict((nr.input or {}).get("dependencies") or {})).values():
        commit = str(dict(output or {}).get("commit") or "")
        if commit:
            return commit
    return ""


async def publish_cicd(session: AsyncSession, run, task, nr, node: dict) -> dict:
    """Execute CICD publication, retaining deployment steps and artifact SHA evidence."""
    optional_internal_features.require("cicd")
    from . import cicd_publish
    repo = await task_code_targets.repo_view(session, task)
    target = await _publish_target(session, run, node, repo)
    if not target:
        raise workflow_contracts.WorkflowConfigurationError(
            "发布节点没有可用的 CICD 目标（客户/环境/服务）：在插件绑定或 "
            "app_setting gerrit_publish_targets 里配好再跑——发布绝不猜目标")
    cfg = dict(node.get("config") or {})
    expect_sha = _merged_commit(nr)
    outcome = await cicd_publish.publish_task(
        session, task, customer=str(target["customer"]),
        services=_services(target.get("services"), repo),
        environment=str(target.get("environment") or ""), expect_sha=expect_sha,
        cicd_url=str(cfg.get("cicdMcpUrl") or target.get("cicdMcpUrl")
                     or cicd_publish.DEFAULT_CICD_MCP), do_notify=True)
    raw = dict(outcome.get("result") or {})
    output = {"customer": str(target["customer"]),
              "environment": str(target.get("environment") or ""),
              # Record the selected deployment target for subsequent business-assertion checks.
              "targetId": str(target.get("targetId") or ""),
              "environmentId": str(target.get("environmentId") or ""),
              "version": raw.get("new_version"), "buildStatus": raw.get("build_status"),
              "deployStatus": outcome.get("deployStatus"),
              "deploymentId": raw.get("deployment_id"),
              "artifactSha": outcome.get("artifactSha") or "",
              "expectSha": expect_sha, "shaOk": bool(outcome.get("shaOk")),
              "steps": list(raw.get("steps") or [])}
    # Persist evidence before deciding success; failure handling may roll back workflow state.
    nr.output = output
    await session.commit()
    if not outcome.get("ok"):
        # Propagate the actual failure reason.
        # Distinguish an artifact that was never built or deployed from a deployed SHA mismatch.
        why = str(outcome.get("error") or "").strip()
        if outcome.get("notBuilt") or why:
            raise ValueError(why or "CICD 发布没成")
        raise ValueError("CICD 发布没成：部署状态 %s%s" % (
            outcome.get("deployStatus") or "未知",
            "" if outcome.get("shaOk") else "；制品 SHA 与合并版本对不上（发的不是这条修复）"))
    task_events.record(session, task.id, "plugin.node_published", {
        "runId": run.id, "node": nr.node_key, "customer": output["customer"],
        "version": output["version"], "deployStatus": output["deployStatus"],
    }, actor="SoduWork")
    return require_evidence("publish", output)
