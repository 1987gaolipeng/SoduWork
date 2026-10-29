"""Verify deployment facts after publication. CICD requires SUCCESS and the merged SHA; environment
chains require matching successful runs and complete configured checks. Reprobe HTTP assertions,
use persisted command-check evidence, and never claim unperformed business checks or
screenshots.
"""
from __future__ import annotations

import json
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from . import http_assertions
from .delivery_evidence import require_evidence

log = logging.getLogger("uvicorn.error")

_TIMEOUT = 15


def wants_deploy_verify(node: dict | None) -> bool:
    return bool(dict((node or {}).get("config") or {}).get("deployVerify"))


def _dep_with(deps: dict, key: str) -> dict:
    for output in (deps or {}).values():
        if isinstance(output, dict) and output.get(key) not in (None, "", [], {}):
            return output
    return {}


def _dep_declaring(deps: dict, key: str) -> dict:
    """Return declared direct predecessors, preserving empty lists so wiring errors remain visible.

    """
    for output in (deps or {}).values():
        if isinstance(output, dict) and key in output:
            return output
    return {}


def _probe(spec: dict, variables: dict | None = None) -> dict:
    """Run one assertion with configured retries while the service becomes ready."""
    return http_assertions.probe(http_assertions.materialize(spec, variables))


def _target_ids(published: dict) -> list[str]:
    """Normalize single CICD publications and aggregated environment-chain receipts."""
    direct = str(published.get("targetId") or "")
    values = [direct] if direct else [
        str(item.get("targetId") or "")
        for item in list(published.get("runs") or []) if isinstance(item, dict)
    ]
    return list(dict.fromkeys(value for value in values if value))


async def _configured_specs(session: AsyncSession, published: dict) -> list[dict]:
    """Read environment-level and deployment-entry assertions for this publication target."""
    from .. import automation_models as am

    specs, seen = [], set()
    for target_id in _target_ids(published):
        target = await session.get(am.DeploymentTarget, target_id)
        if target is None:
            continue
        env = await session.get(am.Environment, target.environment_id)
        for item in [*list((env.health_checks if env else []) or []),
                     *list(target.health_checks or [])]:
            if not isinstance(item, dict):
                continue
            # Run environment-level assertions once even when the environment has multiple deployment entries.
            fingerprint = json.dumps(item, ensure_ascii=False, sort_keys=True, default=str)
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            specs.append(dict(item))
    return specs


def _chain_checks(published: dict, want_sha: str) -> tuple[list[dict], str, str, bool, int]:
    """Normalize generic environment-chain receipts to the same verification facts as CICD."""
    runs = [dict(item) for item in list(published.get("runs") or [])
            if isinstance(item, dict)]
    states = [str(item.get("state") or "") for item in runs]
    commits = [str(item.get("commit") or "") for item in runs]
    all_succeeded = bool(runs) and all(state == "succeeded" for state in states)
    sha_match = bool(runs and want_sha) and all(commit == want_sha for commit in commits)
    verification = [dict(item.get("verification") or {}) for item in runs]
    incomplete = [item for item in verification
                  if str(item.get("state") or "") in {
                      "failed", "incomplete", "running", "pending", "not_run"}]
    health_complete = bool(runs) and not incomplete
    checks = [
        {
            "name": "企业发布链已到交付边界",
            "ok": bool(published.get("complete")),
            "detail": "已完成" if published.get("complete") else "发布链尚未完成",
        },
        {
            "name": "发布链全部部署成功",
            "ok": all_succeeded,
            "detail": ("%d 个部署运行全部成功" % len(runs)) if all_succeeded else
                      ("部署状态：" + "、".join(states or ["没有部署运行"])),
        },
        {
            "name": "部署运行版本与合并版本一致",
            "ok": sha_match,
            "detail": "合并 %s / 部署 %s" % (
                want_sha[:12] or "（没拿到）",
                "、".join(dict.fromkeys(value[:12] or "（没拿到）" for value in commits))
                or "（没有部署运行）"),
        },
        {
            "name": "部署内置健康检查完整",
            "ok": health_complete,
            "detail": ("所有已配置检查均已完成" if health_complete else
                       "%d 个部署运行的检查未完成或失败" % len(incomplete)),
        },
    ]
    embedded = 0
    for run in runs:
        target_name = str(run.get("targetName") or run.get("targetId") or "部署入口")
        for item in list(dict(run.get("verification") or {}).get("checks") or []):
            if not isinstance(item, dict):
                continue
            embedded += 1
            checks.append({
                "name": ("%s · %s" % (target_name, item.get("name") or "上线检查"))[:160],
                "ok": bool(item.get("ok")),
                "detail": str(item.get("detail") or "")[:1000],
            })
    got_sha = want_sha if sha_match else "、".join(dict.fromkeys(commits))
    return checks, ("SUCCESS" if all_succeeded else "FAILED"), got_sha, sha_match, embedded


async def verify(session: AsyncSession, task, nr, node: dict) -> dict:
    """Verify the released version, terminal state, and all available health-check evidence."""
    import asyncio

    cfg = dict(node.get("config") or {})
    deps = dict((nr.input or {}).get("dependencies") or {})
    published = _dep_with(deps, "deployStatus") or _dep_declaring(deps, "runs")
    merged = _dep_with(deps, "commit")
    want_sha = str(merged.get("commit") or "")
    checks: list[dict] = []

    if cfg.get("shaCheck", True) and not want_sha:
        from . import workflow_contracts
        raise workflow_contracts.WorkflowContractError(
            "上线核对拿不到合并版本：请让核对关同时依赖合并关（dependsOn 带上 merge）")

    chain_mode = "runs" in published
    embedded_assertions = 0
    if chain_mode:
        chain_checks, status, got_sha, sha_match, embedded_assertions = \
            _chain_checks(published, want_sha)
        checks.extend(chain_checks if cfg.get("shaCheck", True) else
                      [item for item in chain_checks
                       if item["name"] != "部署运行版本与合并版本一致"])
    else:
        got_sha = str(published.get("artifactSha") or "")
        sha_match = bool(got_sha) and got_sha == want_sha
        if cfg.get("shaCheck", True):
            checks.append({
                "name": "制品 SHA 与合并版本一致",
                "ok": sha_match,
                "detail": "制品 %s / 合并 %s" % (
                    got_sha[:12] or "（没拿到）", want_sha[:12] or "（没拿到）"),
            })
        status = str(published.get("deployStatus") or "")
        checks.append({
            "name": "部署终态 SUCCESS",
            "ok": status == "SUCCESS",
            "detail": status or "（没拿到部署状态）",
        })

    # Node-local assertions support legacy plugins; current configuration belongs to environments and deployment entries.
    specs = [item for item in list(cfg.get("http") or []) if isinstance(item, dict)]
    configured = await _configured_specs(session, published)
    # Capture screenshot receipts here for both publication paths.
    # Deployment executors may lack browsers, and CICD may expose no executor.
    # Hub stores the screenshot as a task attachment referenced by the approval request.
    shots = [item for item in configured if str(item.get("type") or "") == "screenshot"]
    skipped = [] if chain_mode else [
        item for item in configured
        if str(item.get("type") or "http") not in ("http", "screenshot")
    ]
    specs += [item for item in configured if str(item.get("type") or "http") == "http"]
    variables = {
        "DEPLOY_COMMIT": want_sha,
        "DEPLOY_COMMIT_SHORT": want_sha[:12],
    }
    for spec in specs[:12]:
        checks.append(await asyncio.to_thread(_probe, spec, variables))
    screenshot_ids: list[str] = []
    if shots:
        from . import receipt_shot
        for spec in shots[:4]:
            row = await receipt_shot.shot_check(
                session, task, spec, variables=variables,
                run_id=str(nr.run_id or ""), node_run_id=str(nr.id or ""),
                source_ref=f"verify:{nr.id}", evidence_meta={
                    "workflowRunId": str(nr.run_id or ""),
                    "nodeRunId": str(nr.id or ""),
                    "environmentKey": str(published.get("environment") or ""),
                    "artifactCommit": want_sha,
                })
            checks.append(row)
            if row.get("attachmentId"):
                screenshot_ids.append(str(row["attachmentId"]))

    output = {
        "checks": checks,
        "shaMatch": sha_match,
        "deployStatus": status,
        "artifactSha": got_sha,
        "mergedCommit": want_sha,
        "version": published.get("version"),
        "customer": published.get("customer"),
        "mode": "environment-chain" if chain_mode else "cicd",
        "assertions": len(specs) + embedded_assertions,
        "screenshots": screenshot_ids,
        "skippedChecks": [str(item.get("name") or "") for item in skipped],
    }
    # Persist failure evidence before raising so workflow rollback cannot erase it.
    nr.output = output
    await session.commit()
    failed = [item for item in checks if not item["ok"]]
    if failed:
        raise ValueError("上线核对没过：" + "；".join(
            "%s（%s）" % (item["name"], item["detail"]) for item in failed[:4]))
    return require_evidence("verify", output)
