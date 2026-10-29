"""Declarative deployment orchestration: persist state on the server, execute on Runners, and
derive environment relationships from configuration.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from .task_access import publish_owner
from . import (environment_service, release_control, resource_leases, runner_hub,
               task_code_targets, task_events)

log = logging.getLogger("uvicorn.error")
_TERMINAL = {"succeeded", "failed", "rolled_back", "rollback_failed", "cancelled"}
_ACTIVE_RELEASE = ("queued", "running")
_DEPLOYMENT_OWNER = resource_leases.default_owner("deployment")
_START_LEASE_SECONDS = 120


def _now():
    return datetime.now(timezone.utc)


def _verification_api(result: dict, state: str) -> dict:
    checks = [{
        "name": str(item.get("name") or "上线检查")[:100],
        "type": str(item.get("type") or "")[:30],
        "ok": bool(item.get("ok")),
        "detail": str(item.get("detail") or "")[:1000],
    } for item in (result.get("checks") or []) if isinstance(item, dict)]
    planned = max(len(checks), int(result.get("checksPlanned") or 0))
    failed = sum(1 for item in checks if not item["ok"])
    if failed:
        verification_state = "failed"
    elif planned and len(checks) < planned:
        verification_state = "running" if state in {"queued", "running"} else "incomplete"
    elif checks:
        verification_state = "passed"
    elif state in {"queued", "running"}:
        verification_state = "pending"
    else:
        verification_state = "not_configured" if state == "succeeded" else "not_run"
    return {"state": verification_state, "planned": planned, "completed": len(checks),
            "passed": len(checks) - failed, "failed": failed, "checks": checks}


def run_api(row: am.DeploymentRun, env: am.Environment | None = None,
            target: am.DeploymentTarget | None = None) -> dict:
    result = dict(row.result or {})
    return {
        "id": row.id, "taskId": row.task_id, "artifactVersionId": row.artifact_version_id,
        "environmentId": row.environment_id, "environmentName": env.name if env else "",
        "environmentTier": env.tier if env else "", "targetId": row.target_id,
        "targetName": target.name if target else "", "state": row.state,
        "attempt": row.attempt, "runnerId": row.runner_id, "commit": row.commit_sha,
        "log": row.logs or "", "result": result,
        "queue": dict(result.get("queue") or {}), "error": row.error or "",
        "verification": _verification_api(result, str(row.state or "")),
        "rollback": dict(result.get("rollback") or {}),
        "startedAt": release_control._ms(row.started_at),
        "finishedAt": release_control._ms(row.finished_at),
        "createdAt": release_control._ms(row.created_at),
    }


def _progress_signature(row: am.DeploymentRun) -> tuple:
    """Broadcast only changed deployment facts to avoid redundant refreshes during polling."""
    return (
        str(row.state or ""), str(row.runner_id or ""), str(row.error or ""),
        str(row.logs or ""),
        json.dumps(dict(row.result or {}), ensure_ascii=False, sort_keys=True, default=str),
    )


async def _publish_update(session: AsyncSession, row: am.DeploymentRun) -> None:
    """Use lightweight notifications shared with sessions; task-chain reads provide the detailed
    payload.
    """
    try:
        task = await session.get(models.Task, row.task_id)
        if task is None or not str(task.owner_client_id or ""):
            return
        env = await session.get(am.Environment, row.environment_id)
        target = await session.get(am.DeploymentTarget, row.target_id)
        from ..realtime import hub as realtime_hub
        await publish_owner(session, task, {
            "type": "execution.updated", "taskId": row.task_id,
            "deployment": run_api(row, env, target),
        })
    except Exception as exc:  # noqa: BLE001 - Notification failure must not mark deployment as failed.
        log.warning("发布进度通知失败 %s: %s", row.id, type(exc).__name__)


async def list_runs(session: AsyncSession, task_id: str = "", limit: int = 100,
                    task_ids: set[str] | None = None) -> list[dict]:
    q = select(am.DeploymentRun).order_by(am.DeploymentRun.created_at.desc()).limit(
        min(300, max(1, int(limit))))
    if task_id:
        q = q.where(am.DeploymentRun.task_id == task_id)
    elif task_ids is not None:
        q = q.where(am.DeploymentRun.task_id.in_(task_ids or {"__none__"}))
    rows = list((await session.execute(q)).scalars().all())
    envs = {x.id: x for x in (await session.execute(select(am.Environment).where(
        am.Environment.id.in_({r.environment_id for r in rows} or {"__none__"})))).scalars().all()}
    targets = {x.id: x for x in (await session.execute(select(am.DeploymentTarget).where(
        am.DeploymentTarget.id.in_({r.target_id for r in rows} or {"__none__"})))).scalars().all()}
    return [run_api(r, envs.get(r.environment_id), targets.get(r.target_id)) for r in rows]


async def _targets(session: AsyncSession, task: models.Task, env_id: str) -> list[am.DeploymentTarget]:
    repo_id = str(task.repo_id or "")
    if not repo_id:
        return []
    return list((await session.execute(select(am.DeploymentTarget).where(
        am.DeploymentTarget.repo_id == repo_id,
        am.DeploymentTarget.environment_id == env_id,
        am.DeploymentTarget.enabled.is_(True)
    ).order_by(am.DeploymentTarget.created_at))).scalars().all())


async def has_targets(session: AsyncSession, task: models.Task, tier: str = "") -> bool:
    if not task.repo_id:
        return False
    q = select(func.count(am.DeploymentTarget.id)).join(
        am.Environment, am.Environment.id == am.DeploymentTarget.environment_id
    ).where(am.DeploymentTarget.repo_id == task.repo_id,
            am.DeploymentTarget.enabled.is_(True), am.Environment.enabled.is_(True))
    if tier:
        q = q.where(am.Environment.tier == tier)
    return bool(await session.scalar(q))


async def delivery_complete(session: AsyncSession, task: models.Task) -> bool:
    """Use marksDelivery to define the delivery boundary, independent of environment names, types,
    or counts.
    """
    artifact = await release_control.latest_artifact(session, task.id)
    if artifact is None:
        return not await has_targets(session, task)  # Compatibility for historical tasks already merged before migration.
    if not await has_targets(session, task):
        return artifact.state in ("merged", "tested", "released")
    # PostgreSQL cannot apply DISTINCT to a complete Environment row because it
    # contains JSON columns. Deduplicate the scalar foreign key instead, then
    # load environments normally. SQLite accepted the old query and hid this
    # production-only failure.
    environment_ids = select(am.DeploymentTarget.environment_id).where(
        am.DeploymentTarget.repo_id == task.repo_id,
        am.DeploymentTarget.enabled.is_(True),
    ).distinct()
    envs = list((await session.execute(select(am.Environment).where(
        am.Environment.id.in_(environment_ids),
        am.Environment.enabled.is_(True),
    ))).scalars().all())
    boundaries = [x for x in envs if environment_service.promotion_policy(
        x.promotion_policy).get("marksDelivery")]
    if not boundaries:
        return False
    return all([await _environment_ready(session, task, artifact.id, x)
                for x in boundaries])


async def _environment_succeeded(session: AsyncSession, task: models.Task,
                                 artifact_id: str, env_id: str) -> bool:
    targets = await _targets(session, task, env_id)
    if not targets:
        return False
    for target in targets:
        latest = (await session.execute(select(am.DeploymentRun).where(
            am.DeploymentRun.artifact_version_id == artifact_id,
            am.DeploymentRun.target_id == target.id
        ).order_by(am.DeploymentRun.attempt.desc()).limit(1))).scalar_one_or_none()
        if latest is None or latest.state != "succeeded":
            return False
    return True


async def _acceptance_request(session: AsyncSession, artifact_id: str,
                              env_id: str) -> am.ApprovalRequest | None:
    return (await session.execute(select(am.ApprovalRequest).where(
        am.ApprovalRequest.artifact_version_id == artifact_id,
        am.ApprovalRequest.environment_id == env_id,
        am.ApprovalRequest.action == "uat",
    ).order_by(am.ApprovalRequest.created_at.desc()).limit(1))).scalar_one_or_none()


async def _environment_ready(session: AsyncSession, task: models.Task,
                             artifact_id: str, env: am.Environment) -> bool:
    """An environment passes only after both deployment evidence and environment acceptance are
    complete.
    """
    if not await _environment_succeeded(session, task, artifact_id, env.id):
        return False
    policy = environment_service.promotion_policy(env.promotion_policy)
    if not policy.get("requiresAcceptance"):
        return True
    request = await _acceptance_request(session, artifact_id, env.id)
    return bool(request and request.status == "approved")


async def _ensure_acceptance(session: AsyncSession, task: models.Task,
                             artifact: am.ArtifactVersion,
                             env: am.Environment) -> am.ApprovalRequest:
    context = {
        "summary": f"验收{env.name}的运行结果与业务目标",
        "environmentName": env.name,
        "approvalPolicyId": env.acceptance_policy_id,


        "receipt": await _receipt_context(session, task, artifact, env),
    }
    return await release_control.ensure_request(
        session, task, artifact, "uat", env.id, context)


async def _receipt_context(session: AsyncSession, task: models.Task,
                           artifact: am.ArtifactVersion,
                           env: am.Environment) -> dict:
    """Return this version's deployment facts for every target in the environment, including checks
    and receipt screenshots.
    """
    entries, screenshots = [], []
    for target in await _targets(session, task, env.id):
        last = (await session.execute(select(am.DeploymentRun).where(
            am.DeploymentRun.artifact_version_id == artifact.id,
            am.DeploymentRun.target_id == target.id
        ).order_by(am.DeploymentRun.attempt.desc()).limit(1))).scalar_one_or_none()
        if last is None:
            continue
        result = dict(last.result or {})
        checks = [{
            "name": str(item.get("name") or "")[:100],
            "ok": bool(item.get("ok")),
            "detail": str(item.get("detail") or "")[:300],
            "type": str(item.get("type") or "")[:24],
        } for item in list(result.get("checks") or []) if isinstance(item, dict)]
        shots = [str(x) for x in list(result.get("screenshots") or []) if x]
        screenshots += shots
        entries.append({
            "targetName": target.name, "state": str(last.state or ""),
            "commit": str(last.commit_sha or "")[:12],
            "finishedAt": release_control._ms(last.finished_at),
            "checks": checks[:16],
        })
    return {"version": str(artifact.commit_sha or "")[:12] or f"v{artifact.seq}",
            "runs": entries, "screenshots": list(dict.fromkeys(screenshots))[:6]}


async def _missing_prerequisites(session: AsyncSession, task: models.Task,
                                 artifact_id: str, env: am.Environment) -> list[str]:
    missing = []
    policy = environment_service.promotion_policy(env.promotion_policy)
    for key in policy.get("requires") or []:
        parent = await environment_service.environment_for_task(session, task, key=key)
        if parent is None:
            missing.append(f"{key}（未配置）")
        elif not await _environment_ready(session, task, artifact_id, parent):
            missing.append(parent.name)
    return missing


def _failure_kind(runs: list) -> str:
    """Classify prepare-stage connection, Git, and credential failures as infrastructure problems
    that must not trigger code rework. Deploy/check-stage failures follow the plugin's
    configured recovery policy.
    """
    for row in runs:
        if str(getattr(row, "state", "")) not in {"failed", "rolled_back", "rollback_failed"}:
            continue
        result = dict(getattr(row, "result", None) or {})
        stage = str(result.get("stage") or "")
        if stage == "prepare":
            return "infrastructure"
        # An adapter that cannot itself be started is an execution-environment
        # failure, not evidence that the product code is wrong. Keep the release
        # node retryable after operators repair its target configuration; never
        # rewind an already reviewed implementation.
        text = "\n".join((
            str(getattr(row, "error", "") or ""),
            str(getattr(row, "logs", "") or ""),
            str(result.get("detail") or ""),
            str(dict(result.get("rollback") or {}).get("detail") or ""),
        )).lower()
        command_missing = bool(
            "executable file not found" in text
            or re.search(
                r"(?:^|\n)(?:bash|sh|/bin/sh|cmd(?:\.exe)?):[^\n]*"
                r"(?:no such file or directory|command not found|"
                r"not recognized as an internal or external command)",
                text,
            )
            or re.search(
                r"(?:^|\n)sh:\s*\d+:\s*cannot open [^\n]*no such file", text,
            )
        )
        adapter_failure = (
            "/opt/soduwork/deployers/" in text
            and any(hint in text for hint in (
                "not found", "permission denied", "syntax error",
            ))
        )
        if stage == "deploy" and (command_missing or adapter_failure):
            return "infrastructure"
    return ""


async def chain_status(session: AsyncSession, task: models.Task) -> dict:
    """Return aggregate release-chain status independent of environment names."""
    repo = await task_code_targets.repo_view(session, task)
    # Configuration failures require repository, target, or promotion-policy corrections.
    # Classify them explicitly so onFailure cannot incorrectly roll back to implementation.
    if repo is None:
        return {"ok": False, "complete": False, "failureKind": "configuration",
                "error": "需求没有绑定可发布的代码仓库"}
    preflight = await environment_service.preflight_chain(
        session, repo, await environment_service.task_runner_clients(session, task),
        require_online=False,
        allowed_orgs=await environment_service.task_runner_orgs(session, task))
    if not preflight.get("ok"):
        blockers = list(preflight.get("blockers") or [])
        return {"ok": False, "complete": False, "preflight": preflight,
                "failureKind": "configuration",
                "error": (blockers[0].get("message") if blockers else "企业发布链尚未就绪")}
    artifact = await release_control.latest_artifact(session, task.id)
    if artifact is None or artifact.kind != "code":
        return {"ok": False, "complete": False, "error": "还没有可发布的代码版本"}
    targets = list((await session.execute(select(am.DeploymentTarget).where(
        am.DeploymentTarget.repo_id == str(task.repo_id or ""),
        am.DeploymentTarget.enabled.is_(True)
    ).order_by(am.DeploymentTarget.created_at))).scalars().all())
    if not targets:
        return {"ok": False, "complete": False, "failureKind": "configuration",
                "error": "这个仓库还没有配置任何部署目标"}
    env_ids = {x.environment_id for x in targets}
    envs = {x.id: x for x in (await session.execute(select(am.Environment).where(
        am.Environment.id.in_(env_ids), am.Environment.enabled.is_(True)
    ))).scalars().all()}
    rows = list((await session.execute(select(am.DeploymentRun).where(
        am.DeploymentRun.artifact_version_id == artifact.id,
        am.DeploymentRun.target_id.in_({x.id for x in targets})
    ).order_by(am.DeploymentRun.created_at))).scalars().all())
    latest = {}
    for row in rows:
        if row.target_id not in latest or row.attempt >= latest[row.target_id].attempt:
            latest[row.target_id] = row
    failed = [x for x in latest.values()
              if x.state in {"failed", "rolled_back", "rollback_failed", "cancelled"}]
    states = []
    pending_acceptance = []
    acceptance_rejected = []
    for env in sorted(envs.values(), key=lambda x: (x.sort, x.created_at)):
        policy = environment_service.promotion_policy(env.promotion_policy)
        succeeded = await _environment_succeeded(session, task, artifact.id, env.id)
        acceptance = await _acceptance_request(session, artifact.id, env.id) \
            if policy.get("requiresAcceptance") else None
        if acceptance and acceptance.status in {"rejected", "cancelled"}:
            acceptance_rejected.append(env.name)
        acceptance_state = acceptance.status if acceptance else (
            "not_required" if not policy.get("requiresAcceptance") else "not_started")
        state = {
            "id": env.id, "key": env.key, "name": env.name,
            "deployed": succeeded,
            "acceptance": acceptance_state,
            "marksDelivery": bool(policy.get("marksDelivery")),
        }
        if acceptance is not None:
            state["acceptanceRequestId"] = acceptance.id
        if succeeded and acceptance_state == "pending":
            pending_acceptance.append(state)
        states.append(state)
    error = ""
    kind = ""
    if failed:
        error = failed[-1].error or "环境发布失败或已回滚"
        kind = _failure_kind(failed)
    elif acceptance_rejected:
        error = f"{acceptance_rejected[0]}验收未通过"
    complete = bool(not error and await delivery_complete(session, task))
    return {
        "ok": True, "complete": complete, "failed": bool(error), "error": error,
        "pendingAcceptance": bool(pending_acceptance),
        **({"requestId": pending_acceptance[0]["acceptanceRequestId"]}
           if pending_acceptance else {}),
        **({"failureKind": kind} if kind else {}),
        "artifactVersionId": artifact.id, "environments": states,
        "runs": [run_api(x, envs.get(x.environment_id),
                         next((t for t in targets if t.id == x.target_id), None))
                 for x in latest.values()],
    }


async def request_environment(session: AsyncSession, task: models.Task, env_id: str,
                              who: str = "SoduWork") -> dict:
    """Queue the current version for an environment according to its prerequisite and approval
    policy.
    """
    artifact = await release_control.latest_artifact(session, task.id)
    if artifact is None or artifact.kind != "code" or artifact.state not in (
            "merged", "tested", "released"):
        return {"ok": False, "error": "只有已经合并的代码版本才能部署"}
    env = await environment_service.environment_for_task(
        session, task, environment_id=env_id)
    if env is None or not env.enabled:
        return {"ok": False, "failureKind": "configuration", "error": "环境不存在或已停用"}
    targets = await _targets(session, task, env.id)
    if not targets:
        return {"ok": False, "failureKind": "configuration",
                "error": f"{env.name}还没有为这个仓库配置部署目标"}
    policy = environment_service.promotion_policy(env.promotion_policy)
    missing = await _missing_prerequisites(session, task, artifact.id, env)
    if missing:
        return {"ok": False, "blocked": True,
                "error": f"进入{env.name}前还需要通过：{'、'.join(missing)}"}
    if policy.get("requiresApproval"):
        req = await release_control.ensure_request(session, task, artifact, "deploy", env.id,
                                                    {"summary": f"发布到{env.name}",
                                                     "commit": artifact.commit_sha,
                                                     "approvalPolicyId": env.approval_policy_id})
        await session.commit()
        if req.status != "approved":
            return {"ok": True, "pendingApproval": True,
                    "request": release_control.request_api(req), "runs": []}

    runs = []
    for target in targets:
        key = f"{artifact.id}:{target.id}"
        latest = (await session.execute(select(am.DeploymentRun).where(
            am.DeploymentRun.idempotency_key == key
        ).order_by(am.DeploymentRun.attempt.desc()).limit(1))).scalar_one_or_none()
        if latest is not None and latest.state not in {"failed", "rolled_back", "rollback_failed", "cancelled"}:
            runs.append(latest)
            continue
        attempt = int(latest.attempt if latest else 0) + 1
        row = am.DeploymentRun(
            task_id=task.id, artifact_version_id=artifact.id,
            environment_id=env.id, target_id=target.id, state="queued",
            attempt=attempt, idempotency_key=key, commit_sha=artifact.manifest.get("mergeCommit")
            or artifact.commit_sha)
        session.add(row)
        await session.flush()
        task_events.record(session, task.id, "release.deploy_queued",
                           {"runId": row.id, "versionId": artifact.id,
                            "environmentId": env.id, "targetId": target.id,
                            "attempt": attempt}, actor=who)
        runs.append(row)
    await session.commit()
    for row in runs:
        await _publish_update(session, row)
        if row.state == "queued":
            before = _progress_signature(row)
            await _try_start(session, row)
            if _progress_signature(row) != before:
                await _publish_update(session, row)
    return {"ok": True, "pendingApproval": False,
            "runs": [run_api(x, env, next((t for t in targets if t.id == x.target_id), None))
                     for x in runs]}


async def queue_automatic(session: AsyncSession, task: models.Task, who: str = "SoduWork") -> dict:
    """Queue automatic environments whose prerequisites are satisfied, supporting arbitrary
    configured chain lengths.
    """
    org_id = await environment_service.task_org_id(session, task)
    envs = list((await session.execute(select(am.Environment).where(
        am.Environment.enabled.is_(True),
        (am.Environment.org_id == org_id) | am.Environment.org_id.is_(None)
    ).order_by(am.Environment.org_id.is_(None), am.Environment.sort))).scalars().all())
    envs = [x for x in envs if environment_service.promotion_policy(
        x.promotion_policy).get("autoStart") and await _targets(session, task, x.id)]
    if not envs:
        return {"ok": False, "skipped": "没有可自动进入的环境"}
    artifact = await release_control.latest_artifact(session, task.id)
    if artifact is None:
        return {"ok": False, "skipped": "还没有可发布版本"}
    results = []
    for env in envs:
        missing = await _missing_prerequisites(session, task, artifact.id, env)
        if missing:
            continue
        results.append({"environmentId": env.id, "environmentName": env.name,
                        **await request_environment(session, task, env.id, who)})
    return {"ok": True, "results": results,
            "runs": [run for result in results for run in (result.get("runs") or [])],
            "pendingApproval": any(x.get("pendingApproval") for x in results),
            **({"skipped": "自动环境仍在等待前置证据"} if not results else {})}


# Compatibility name; automatic environment selection is no longer specific to testing.
queue_default_test = queue_automatic


async def redeploy_target(session: AsyncSession, target: am.DeploymentTarget,
                          who: str = "") -> dict:
    """Explicitly redeploy the same version with a new attempt after scripts, variables, or
    machines change. Preserve existing version/environment approval, but verify it exists so
    redeployment cannot bypass approval.
    """
    if not target.enabled:
        return {"ok": False, "error": "部署目标已停用"}
    env = await session.get(am.Environment, target.environment_id)
    if env is None or not env.enabled:
        return {"ok": False, "error": "环境不存在或已停用"}
    last_ok = (await session.execute(select(am.DeploymentRun).where(
        am.DeploymentRun.target_id == target.id,
        am.DeploymentRun.state == "succeeded"
    ).order_by(am.DeploymentRun.created_at.desc()).limit(1))).scalar_one_or_none()
    if last_ok is None:
        return {"ok": False, "error": "这个目标还没有成功发布过，没有可重发的版本"}
    artifact = await session.get(am.ArtifactVersion, last_ok.artifact_version_id)
    task = await session.get(models.Task, last_ok.task_id)
    if artifact is None or task is None:
        return {"ok": False, "error": "原发布对应的版本或需求已经不存在"}
    key = f"{artifact.id}:{target.id}"
    latest = (await session.execute(select(am.DeploymentRun).where(
        am.DeploymentRun.idempotency_key == key
    ).order_by(am.DeploymentRun.attempt.desc()).limit(1))).scalar_one_or_none()
    if latest is not None and latest.state in {"queued", "running"}:
        return {"ok": False, "error": "这个目标当前有发布在进行中"}
    policy = environment_service.promotion_policy(env.promotion_policy)
    if policy.get("requiresApproval"):
        approved = (await session.execute(select(am.ApprovalRequest).where(
            am.ApprovalRequest.artifact_version_id == artifact.id,
            am.ApprovalRequest.environment_id == env.id,
            am.ApprovalRequest.action == "deploy",
            am.ApprovalRequest.status == "approved").limit(1))).scalar_one_or_none()
        if approved is None:
            return {"ok": False, "error": "这个版本进入该环境的发布批准已不存在，不能直接重发"}
    attempt = int(latest.attempt if latest else 0) + 1
    row = am.DeploymentRun(
        task_id=task.id, artifact_version_id=artifact.id,
        environment_id=env.id, target_id=target.id, state="queued",
        attempt=attempt, idempotency_key=key, commit_sha=last_ok.commit_sha,
        result={"redeploy": True, "requestedBy": who or "SoduWork"})
    session.add(row)
    await session.flush()
    task_events.record(session, task.id, "release.redeploy_requested",
                       {"runId": row.id, "versionId": artifact.id,
                        "environmentId": env.id, "targetId": target.id,
                        "attempt": attempt, "commit": last_ok.commit_sha},
                       actor=who or "SoduWork")
    await session.commit()
    await _publish_update(session, row)
    before = _progress_signature(row)
    await _try_start(session, row)
    if _progress_signature(row) != before:
        await _publish_update(session, row)
    return {"ok": True, "run": run_api(row, env, target)}


async def _spec(session: AsyncSession, run: am.DeploymentRun,
                env: am.Environment, target: am.DeploymentTarget, repo: models.Repo,
                task: models.Task) -> dict:
    descriptors = []
    for env_name, ref_id in dict(target.secret_refs or {}).items():
        ref = await session.get(am.SecretReference, str(ref_id))
        if ref is None or not ref.enabled:
            raise ValueError(f"密钥引用不可用：{ref_id}")
        descriptors.append({"env": str(env_name), "provider": ref.provider, "locator": ref.locator})
    cfg = dict(target.config or {})
    checks = [*list(env.health_checks or []), *list(target.health_checks or [])]
    rollback = environment_service.effective_rollback(env, target)
    owner = await session.get(models.Client, str(task.owner_client_id or ""))
    from . import code_creds
    runtime_env = dict(cfg.get("env") or {})
    redact = []
    upload_config = cfg.get("clientReleaseUpload")
    upload_enabled = bool(upload_config.get("enabled", True)) \
        if isinstance(upload_config, dict) else bool(upload_config)
    if upload_enabled:
        from urllib.parse import urlparse
        from ..auth import sign_claims
        from ..config import get_settings
        options = dict(upload_config) if isinstance(upload_config, dict) else {}
        base_url = str(options.get("baseUrl") or get_settings().hub_public_url or "").rstrip("/")
        parsed = urlparse(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("客户端安装包发布目标缺少可访问的 Hub 地址")
        token = sign_claims({
            "runId": run.id, "targetId": run.target_id,
            "artifactVersionId": run.artifact_version_id,
            "commit": str(run.commit_sha or ""),
        }, ttl_seconds=min(14400, max(1800, int(cfg.get("timeoutSeconds") or 900) + 900)),
            token_type="deployment-client-upload")
        runtime_env.update({
            "SODUWORK_CLIENT_RELEASE_UPLOAD_URL":
                f"{base_url}/api/v1/deployment-client-releases/{run.id}",
            "SODUWORK_CLIENT_RELEASE_UPLOAD_TOKEN": token,
            "SODUWORK_DEPLOY_RUN_ID": run.id,
            "SODUWORK_DEPLOY_COMMIT": str(run.commit_sha or ""),
        })
        redact.append(token)
    return {
        "runId": run.id, "repoId": repo.id, "gitUrl": repo.git_url or "",
        "branch": repo.merge_branch or repo.default_branch or "main",
        "environmentKey": env.key, "commit": run.commit_sha,
        "argv": list(cfg.get("argv") or []), "timeoutSeconds": cfg.get("timeoutSeconds") or 900,
        "env": runtime_env, "checks": checks, "rollback": rollback, "redact": redact,
        "secrets": descriptors, "git": code_creds.resolve(owner) if owner else {},
    }


def _apply_runner_status(run: am.DeploymentRun, res: dict, fallback_state: str = "") -> None:
    """Persist one Runner snapshot, including terminal snapshots returned by idempotent start."""
    run.state = str(res.get("state") or fallback_state or run.state)
    run.logs = str(res.get("log") or "")[-12000:]
    run.error = str(res.get("error") or "")[:1000]
    current = dict(run.result or {})
    sticky = {key: current[key] for key in ("clientRelease",) if key in current}
    run.result = {**dict(res.get("result") or {}), **sticky,
                  **({"stage": str(res["stage"])[:20]} if res.get("stage") else {})}
    if res.get("startedAt"):
        run.started_at = datetime.fromtimestamp(int(res["startedAt"]) / 1000, timezone.utc)
    if res.get("finishedAt"):
        run.finished_at = datetime.fromtimestamp(int(res["finishedAt"]) / 1000, timezone.utc)
    elif run.state in _TERMINAL and run.finished_at is None:
        # Older Runners may omit completion time; terminal runs must still leave the reconciliation queue.
        run.finished_at = _now()


async def _release_queue_gate(session: AsyncSession, run: am.DeploymentRun) -> dict:
    """Return the older active artifact group for the same repository and environment.

    Every target of one artifact belongs to the same release group and may start in parallel.
    A later artifact waits until every active run in the older group becomes terminal.  The
    repository is read from the target so this remains generic for every configured environment.
    """
    target = await session.get(am.DeploymentTarget, run.target_id)
    if target is None:
        return {}
    rows = list((await session.execute(
        select(am.DeploymentRun.artifact_version_id,
               am.DeploymentRun.created_at, am.DeploymentRun.id)
        .join(am.DeploymentTarget, am.DeploymentTarget.id == am.DeploymentRun.target_id)
        .where(
            am.DeploymentTarget.repo_id == target.repo_id,
            am.DeploymentRun.environment_id == run.environment_id,
            am.DeploymentRun.state.in_(_ACTIVE_RELEASE),
        )
        .order_by(am.DeploymentRun.created_at,
                  am.DeploymentRun.artifact_version_id, am.DeploymentRun.id)
    )).all())
    groups = []
    for artifact_id, _created_at, _run_id in rows:
        value = str(artifact_id or "")
        if value and value not in groups:
            groups.append(value)
    current = str(run.artifact_version_id or "")
    if not groups or groups[0] == current:
        return {}
    position = groups.index(current) + 1 if current in groups else len(groups) + 1
    return {
        "state": "waiting_previous_release",
        "message": f"同一项目和环境按版本顺序发布；前一版本完成后自动开始（队列第 {position} 位）",
        "position": position,
        "aheadArtifactVersionId": groups[0],
        "repoId": str(target.repo_id or ""),
        "environmentId": str(run.environment_id or ""),
    }


def _mark_release_waiting(run: am.DeploymentRun, gate: dict) -> bool:
    result = dict(run.result or {})
    queue = dict(gate or {})
    if dict(result.get("queue") or {}) == queue and not run.error:
        return False
    result["queue"] = queue
    run.result, run.error = result, ""
    return True


def _clear_release_waiting(run: am.DeploymentRun) -> bool:
    result = dict(run.result or {})
    if "queue" not in result:
        return False
    result.pop("queue", None)
    run.result = result
    return True


async def _try_start(session: AsyncSession, run: am.DeploymentRun) -> bool:
    """Start one queued deployment exactly once across Hub instances and release versions FIFO."""
    if str(run.state or "") != "queued":
        return False
    lease = None
    try:
        lease = await resource_leases.acquire(
            session, "deployment-start", run.id, owner=_DEPLOYMENT_OWNER,
            ttl_seconds=_START_LEASE_SECONDS,
            detail={"artifactVersionId": run.artifact_version_id,
                    "environmentId": run.environment_id, "targetId": run.target_id})
    except resource_leases.LeaseBusy:
        return False
    try:
        await session.refresh(run)
        if str(run.state or "") != "queued":
            return False
        gate = await _release_queue_gate(session, run)
        if gate:
            if _mark_release_waiting(run, gate):
                task_events.record(session, run.task_id, "release.deploy_waiting",
                                   {"runId": run.id, **gate}, actor="SoduWork")
                await session.commit()
            return False
        if _clear_release_waiting(run):
            await session.commit()
            await session.refresh(run)
        await _start(session, run)
        return str(run.state or "") != "queued"
    finally:
        if lease is not None:
            try:
                await resource_leases.release(session, lease)
            except Exception as exc:  # noqa: BLE001 - an expired lease is recoverable
                await session.rollback()
                try:
                    await resource_leases.release(session, lease)
                except Exception:  # noqa: BLE001
                    await session.rollback()
                    log.warning("release deployment lease failed: %s", type(exc).__name__)


async def _start(session: AsyncSession, run: am.DeploymentRun) -> None:
    env, target = await session.get(am.Environment, run.environment_id), await session.get(
        am.DeploymentTarget, run.target_id)
    task = await session.get(models.Task, run.task_id)
    repo = await task_code_targets.repo_view(
        session, task, await session.get(models.Repo, target.repo_id)) if target and task else None
    if not all((env, target, task, repo)):
        run.state, run.error, run.finished_at = "failed", "部署配置已经不存在", _now()
        await session.commit()
        return
    # Route publication through the selected deployment adapter; local Runner deployment is the default.
    # Share ordering, approval, health verification, acceptance, and delivery records across adapters.
    from . import release_providers
    if release_providers.handles(target):
        await release_providers.start(session, run, env, target, repo, task)
        return
    tags = list(dict(env.runner_selector or {}).get("tags") or [])
    runner_ids = list(dict(env.runner_selector or {}).get("runnerIds") or [])
    for tag in dict(target.runner_selector or {}).get("tags") or []:
        if tag not in tags:
            tags.append(tag)
    for runner_id in dict(target.runner_selector or {}).get("runnerIds") or []:
        if runner_id not in runner_ids:
            runner_ids.append(runner_id)
    allowed_clients = await environment_service.task_runner_clients(session, task)
    allowed_orgs = await environment_service.task_runner_orgs(session, task)
    runner = runner_hub.pick_by_tags(
        tags, task.owner_client_id or "", allowed_clients,
        required_capabilities=["repository", "terminal"],
        allowed_org_ids=allowed_orgs,
        allowed_runner_ids=set(runner_ids) if runner_ids else None)
    if runner is None:
        run.error = runner_hub.explain_no_tagged_runner(
            tags, allowed_clients, required_capabilities=["repository", "terminal"],
            allowed_org_ids=allowed_orgs,
            allowed_runner_ids=set(runner_ids) if runner_ids else None)[:1000]
        await session.commit()
        return
    try:
        spec = await _spec(session, run, env, target, repo, task)
    except ValueError as e:
        run.state, run.error, run.finished_at = "failed", str(e), _now()
        await session.commit()
        return
    old = run.state
    res = await asyncio.to_thread(runner_hub.call_sync, runner, "deploy.start", {"spec": spec}, 45)
    if res.get("ok"):
        run.runner_id = runner.id
        await session.refresh(run, attribute_names=["result"])
        _apply_runner_status(run, res, "running")
        if run.started_at is None and run.state != "queued":
            run.started_at = _now()
    else:
        run.error = str(res.get("error") or "执行机没接住部署")[:1000]
    if res.get("ok") and run.state in _TERMINAL and old not in _TERMINAL:
        await _after_terminal(session, run)
    else:
        await session.commit()


async def _capture_receipt(session: AsyncSession, run: am.DeploymentRun,
                           task: models.Task) -> None:
    """Behavior and constraints for this operation."""
    target = await session.get(am.DeploymentTarget, run.target_id)
    env = await session.get(am.Environment, run.environment_id)
    specs = [dict(item) for item in [*list((env.health_checks if env else []) or []),
                                    *list((target.health_checks if target else []) or [])]
             if isinstance(item, dict) and str(item.get("type") or "") == "screenshot"]
    if not specs:
        return
    result = dict(run.result or {})
    existing = [item for item in list(result.get("checks") or []) if isinstance(item, dict)]
    # Screenshot idempotency requires a captured attachmentId.
    # A Runner's screenshot placeholder only delegates capture to Hub.
    # Do not mistake that placeholder for an existing screenshot.
    if any(str(item.get("type") or "") == "screenshot" and item.get("attachmentId")
           for item in existing):
        return
    from . import receipt_shot
    variables = {"DEPLOY_COMMIT": str(run.commit_sha or ""),
                 "DEPLOY_COMMIT_SHORT": str(run.commit_sha or "")[:12]}
    shots: list[str] = []
    for spec in specs[:4]:
        row = await receipt_shot.shot_check(
            session, task, spec, variables=variables,
            source_ref=f"deploy:{run.id}", evidence_meta={
                "artifactVersionId": run.artifact_version_id,
                "environmentId": run.environment_id,
                "deploymentRunId": run.id,
                "targetId": run.target_id,
            })
        existing.append(row)
        if row.get("attachmentId"):
            shots.append(str(row["attachmentId"]))
    result["checks"] = existing
    if shots:
        result["screenshots"] = [*list(result.get("screenshots") or []), *shots]
    run.result = result
    failed = [item for item in existing
              if str(item.get("type") or "") == "screenshot" and not item.get("ok")]
    if failed:
        # A missing required receipt fails the run rather than allowing evidence-free acceptance.
        run.state = "failed"
        run.error = ("上线回执没拿到：" + str(failed[0].get("detail") or ""))[:500]
    await session.commit()


async def _discard_run_client_release(
    session: AsyncSession, run: am.DeploymentRun,
) -> bool:
    info = dict(run.result or {}).get("clientRelease")
    if not isinstance(info, dict) or not str(info.get("id") or ""):
        return False
    from . import client_updates
    release = await session.get(models.ClientRelease, str(info["id"]))
    if release is None:
        discarded = (str(info.get("state") or "") in {"staged", "discarded"}
                     and not bool(info.get("enabled")))
    elif release.enabled:
        discarded = False
    else:
        discarded = await client_updates.discard_staged_release(
            session, str(info["id"]))
    if discarded:
        result = dict(run.result or {})
        result["clientRelease"] = {**info, "state": "discarded", "enabled": False}
        run.result = result
        task_events.record(session, run.task_id, "release.client_discarded", {
            "runId": run.id, "releaseId": str(info["id"]),
            "version": str(info.get("version") or ""),
        }, actor="SoduWork")
    return discarded


async def _discard_environment_client_releases(
    session: AsyncSession, artifact_id: str, environment_id: str,
) -> int:
    """Discard every staged installer when any sibling target fails."""
    runs = (await session.execute(select(am.DeploymentRun).where(
        am.DeploymentRun.artifact_version_id == artifact_id,
        am.DeploymentRun.environment_id == environment_id,
    ))).scalars().all()
    discarded = 0
    for sibling in runs:
        discarded += int(await _discard_run_client_release(session, sibling))
    return discarded


async def _activate_environment_client_releases(
    session: AsyncSession,
    task: models.Task,
    artifact: am.ArtifactVersion,
    env: am.Environment,
) -> list[dict]:
    """Activate signed installers only after the complete environment gate passes."""
    activated = []
    for target in await _targets(session, task, env.id):
        latest = (await session.execute(select(am.DeploymentRun).where(
            am.DeploymentRun.artifact_version_id == artifact.id,
            am.DeploymentRun.target_id == target.id,
        ).order_by(am.DeploymentRun.attempt.desc()).limit(1))).scalar_one_or_none()
        if latest is None or latest.state != "succeeded":
            continue
        result = dict(latest.result or {})
        info = result.get("clientRelease")
        if not isinstance(info, dict) or not str(info.get("id") or ""):
            continue
        release = await session.get(models.ClientRelease, str(info["id"]))
        if release is None:
            raise ValueError("已构建的客户端安装包记录不存在")
        if not release.enabled:
            release.enabled = True
            activated.append({"id": release.id, "version": release.version})
        result["clientRelease"] = {**info, "state": "active", "enabled": True}
        latest.result = result
    for item in activated:
        task_events.record(session, task.id, "release.client_activated", {
            "artifactVersionId": artifact.id, "environmentId": env.id,
            "releaseId": item["id"], "version": item["version"],
        }, actor="SoduWork")
    return activated


async def _after_terminal(session: AsyncSession, run: am.DeploymentRun) -> None:
    artifact = await session.get(am.ArtifactVersion, run.artifact_version_id)
    env = await session.get(am.Environment, run.environment_id)
    task = await session.get(models.Task, run.task_id)
    if not all((artifact, env, task)):
        await session.commit()
        return
    task_events.record(session, run.task_id, "release.deploy_finished",
                       {"runId": run.id, "versionId": artifact.id,
                        "environmentId": env.id, "state": run.state,
                        "error": run.error}, actor="SoduWork")
    if run.state != "succeeded":
        await _discard_environment_client_releases(
            session, artifact.id, env.id)
        await session.commit()
        return
    await _capture_receipt(session, run, task)
    if run.state != "succeeded":
        await _discard_environment_client_releases(
            session, artifact.id, env.id)
        await session.commit()
        return
    # Mark an environment deployed only after every target succeeds.
    targets = await _targets(session, task, env.id)
    successful = 0
    failed_terminal = False
    for target in targets:
        last = (await session.execute(select(am.DeploymentRun).where(
            am.DeploymentRun.artifact_version_id == artifact.id,
            am.DeploymentRun.target_id == target.id
        ).order_by(am.DeploymentRun.attempt.desc()).limit(1))).scalar_one_or_none()
        successful += int(last is not None and last.state == "succeeded")
        failed_terminal = failed_terminal or bool(
            last is not None and last.state in _TERMINAL
            and last.state != "succeeded")
    if failed_terminal:
        await _discard_environment_client_releases(session, artifact.id, env.id)
        await session.commit()
        return
    if targets and successful == len(targets):
        policy = environment_service.promotion_policy(env.promotion_policy)
        accepted = True
        if policy.get("requiresAcceptance"):
            request = await _ensure_acceptance(session, task, artifact, env)
            accepted = request.status == "approved"
            if request.status == "pending":
                task_events.record(session, task.id, "release.acceptance_requested", {
                    "requestId": request.id, "versionId": artifact.id,
                    "environmentId": env.id,
                }, actor="SoduWork")
        # Recompute automatic successors from prerequisite relationships after the environment passes.
        if accepted:
            await _activate_environment_client_releases(session, task, artifact, env)
            await queue_automatic(session, task, who="SoduWork")
        if policy.get("marksDelivery") and await delivery_complete(session, task):
            artifact.state = "released"
            from . import code_delivery
            state = await code_delivery.read_state(session, task.id)
            await code_delivery.settle_delivered(session, task, state, who="SoduWork")
    await session.commit()


async def continue_after_acceptance(session: AsyncSession, task: models.Task,
                                    env_id: str, who: str) -> dict:
    """Continue the configured release chain after acceptance and complete the task only at the
    delivery boundary.
    """
    artifact = await release_control.latest_artifact(session, task.id)
    env = await environment_service.environment_for_task(
        session, task, environment_id=env_id)
    if artifact is None or env is None:
        return {"ok": False, "error": "验收对应的版本或环境已经不存在"}
    if not await _environment_succeeded(session, task, artifact.id, env.id):
        return {"ok": False, "error": "环境运行尚未成功，不能先通过验收"}
    request = await _acceptance_request(session, artifact.id, env.id)
    if request is None or request.status != "approved":
        return {"ok": False, "error": "环境验收尚未批准"}
    await _activate_environment_client_releases(session, task, artifact, env)
    await queue_automatic(session, task, who=who)
    if await delivery_complete(session, task):
        artifact.state = "released"
        from . import code_delivery
        state = await code_delivery.read_state(session, task.id)
        await code_delivery.settle_delivered(session, task, state, who=who)
        await session.commit()
    await session.commit()
    return await chain_status(session, task)


async def _poll(session: AsyncSession, run: am.DeploymentRun) -> None:
    target = await session.get(am.DeploymentTarget, run.target_id)
    from . import release_providers
    if target is not None and release_providers.handles(target):
        env = await session.get(am.Environment, run.environment_id)
        task = await session.get(models.Task, run.task_id)
        if env is not None and task is not None:
            await release_providers.poll(session, run, env, target, task)
        return
    runner = runner_hub.get(run.runner_id)
    if runner is None:
        run.error = "执行机离线，等待它恢复后继续核对"
        await session.commit()
        return
    res = await asyncio.to_thread(
        runner_hub.call_sync, runner, "deploy.status", {"runId": run.id}, 30)
    if not res.get("ok"):
        run.error = str(res.get("error") or "读取部署状态失败")[:1000]
        await session.commit()
        return
    old = run.state
    recovering = old in _TERMINAL and run.finished_at is None
    await session.refresh(run, attribute_names=["result"])
    _apply_runner_status(run, res)
    if run.state in _TERMINAL and (old not in _TERMINAL or recovering):
        await _after_terminal(session, run)
    else:
        await session.commit()


async def ingest_runner_snapshots(session: AsyncSession, runner, snapshots: list) -> list[dict]:
    """Accept Runner deployment snapshots only for runs assigned to that Runner."""
    updates = []
    seen: set[str] = set()
    for snap in list(snapshots or [])[:50]:
        if not isinstance(snap, dict):
            continue
        run_id = str(snap.get("id") or "")
        if not run_id or run_id in seen:
            continue
        seen.add(run_id)
        run = await session.get(am.DeploymentRun, run_id)
        if run is None or str(run.runner_id or "") != str(getattr(runner, "id", "") or ""):
            continue
        before = _progress_signature(run)
        old = run.state
        recovering = old in _TERMINAL and run.finished_at is None
        await session.refresh(run, attribute_names=["result"])
        _apply_runner_status(run, snap)
        if run.state in _TERMINAL and (old not in _TERMINAL or recovering):
            await _after_terminal(session, run)
        else:
            await session.commit()
        if _progress_signature(run) != before:
            task = await session.get(models.Task, run.task_id)
            updates.append({
                "clientId": str(task.owner_client_id or "") if task is not None else "",
                "taskId": run.task_id,
                "deployment": run_api(
                    run, await session.get(am.Environment, run.environment_id),
                    await session.get(am.DeploymentTarget, run.target_id)),
            })
    return updates


async def sweep(session: AsyncSession) -> dict:
    rows = list((await session.execute(select(am.DeploymentRun).where(or_(
        am.DeploymentRun.state.in_(("queued", "running")),
        (am.DeploymentRun.state.in_(tuple(_TERMINAL)) & am.DeploymentRun.finished_at.is_(None))
    )).order_by(am.DeploymentRun.created_at).limit(100))).scalars().all())
    for row in rows:
        before = _progress_signature(row)
        if row.state == "queued":
            await _try_start(session, row)
        else:
            await _poll(session, row)
        if _progress_signature(row) != before:
            await _publish_update(session, row)
    return {"checked": len(rows)}


async def sweep_loop() -> None:
    from ..db import SessionLocal
    while True:
        try:
            async with SessionLocal() as session:
                await sweep(session)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("环境发布巡检异常：%s", e)
        await asyncio.sleep(10)
