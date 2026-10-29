"""Freeze authoritative, secret-free project readiness into managed workflow runs."""
from __future__ import annotations

import json

from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import workflow_contracts


def _mode_for_plugin_key(plugin_key: str) -> str:
    # Local import avoids project_setup -> workflow_runs -> this module -> project_setup.
    from . import project_setup
    wanted = str(plugin_key or "").strip()
    return next((key for key, spec in project_setup.MODES.items()
                 if str(spec.get("pluginKey") or "") == wanted), "")


def _projection(setup: dict | None) -> dict:
    """Keep facts a model needs while excluding credentials and raw probe payloads."""
    data = dict(setup or {})
    project = dict(data.get("project") or {})
    checks = [{
        "key": str(dict(item or {}).get("key") or "")[:40],
        "label": str(dict(item or {}).get("label") or "")[:120],
        "ok": bool(dict(item or {}).get("ok")),
    } for item in list(data.get("checks") or [])[:10]]
    sources = []
    for repo_id, raw in list(dict(data.get("sourceProbes") or {}).items())[:40]:
        item = dict(raw or {})
        sources.append({
            "repoId": str(repo_id)[:80],
            "ok": bool(item.get("ok")),
            "stale": bool(item.get("stale")),
            "state": str(item.get("state") or "")[:40],
            "checkedAt": str(item.get("checkedAt") or "")[:60],
        })
    environments = [{
        "id": str(dict(item or {}).get("id") or "")[:80],
        "name": str(dict(item or {}).get("name") or "")[:120],
        "ready": bool(dict(item or {}).get("ready")),
        "delivery": bool(dict(item or {}).get("delivery")),
    } for item in list(data.get("environmentPath") or [])[:20]]
    approvals = []
    for raw in list(data.get("approvalPlan") or [])[:20]:
        item = dict(raw or {})
        approvals.append({
            "action": str(item.get("action") or item.get("gate") or "")[:80],
            "name": str(item.get("environmentName") or
                        item.get("policyName") or item.get("name") or "")[:120],
            "required": max(0, int(item.get("required") or 0)),
            "available": max(0, int(item.get("available") or 0)),
            "ok": bool(item.get("ok")),
        })
    assignment = dict(data.get("assignment") or {})
    return {
        "schemaVersion": 1,
        "project": {"id": str(project.get("id") or "")[:80],
                    "name": str(project.get("name") or "")[:160]},
        "mode": str(data.get("mode") or "")[:40],
        "ready": bool(data.get("ready")),
        "checks": checks,
        "sourceProbes": sources,
        "environmentPath": environments,
        "approvalPlan": approvals,
        "execution": {
            "clientSelected": bool(assignment.get("clientId")),
            "agentKinds": [str(value)[:100]
                           for value in list(assignment.get("agentKinds") or [])[:20]],
        },
    }


async def capture(session: AsyncSession, task: models.Task,
                  binding: am.PluginBinding, plugin: am.Plugin) -> dict:
    """Recheck a governed project boundary and return only model-safe facts."""
    if not task.project_id:
        return {}
    profile = await session.get(am.ProjectAutomationProfile, task.project_id)
    if not profile or not profile.enabled or profile.binding_id != binding.id:
        return {}
    from . import environment_service, project_setup
    mode = _mode_for_plugin_key(plugin.key)
    if not mode:
        return {}
    project = await session.get(models.Project, task.project_id)
    if project is None:
        return {}
    allowed_clients = await environment_service.task_runner_clients(session, task)
    setup = await project_setup.status(session, project, allowed_clients, mode)
    if not setup.get("ready"):
        blocked = dict(setup.get("nextAction") or {})
        raise workflow_contracts.WorkflowConfigurationError(
            str(blocked.get("detail") or "项目交付预检尚未通过"))
    return _projection(setup)


def prompt(readiness: dict | None) -> str:
    """Explain verified stage boundaries without exposing operational credentials."""
    data = dict(readiness or {})
    if not data:
        return ""
    visible = json.dumps({"deliveryReadiness": data}, ensure_ascii=False,
                         sort_keys=True, separators=(",", ":"))
    state = "READY" if data.get("ready") else "BLOCKED"
    return (
        "[SODUWORK MANAGED DELIVERY PREFLIGHT — " + state + "]\n"
        "This is authoritative, sanitized evidence produced by SoduWork before this workflow run. "
        "Never ask the user for credentials or reveal secrets. Each AI node must work only on its "
        "declared responsibility. Credential readiness, merge permissions, deployment adapters, "
        "target hosts, health checks, rollback and human gates are verified and isolated controls. "
        "When readiness is true, do not treat their absence from this AI workspace as a blocker and "
        "do not attempt to reproduce downstream operations locally. For an analysis or preflight "
        "node, this evidence satisfies managed credential and downstream toolchain checks; require "
        "only tools needed by the current node, not Bash, Docker or deployment access reserved for "
        "later Runners. When readiness is false, stop on the failed check instead of inventing a "
        "workaround.\n" + visible
    )
