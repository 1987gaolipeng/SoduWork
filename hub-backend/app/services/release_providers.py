"""Public module behavior and service contracts."""
from __future__ import annotations

import asyncio
import json
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from . import optional_internal_features

log = logging.getLogger("uvicorn.error")

# deployment_run_id -> {"job": asyncio.Task}
_JOBS: dict[str, dict] = {}

CICD = "cicd-mcp"
RUNNER = "runner-command"


def provider_of(target) -> str:
    return str(getattr(target, "provider", "") or RUNNER).strip() or RUNNER


def handles(target) -> bool:
    """Check whether this module handles the deployment target; runner-command retains its original
    path.
    """
    return provider_of(target) in _PROVIDERS


def capabilities(provider: str) -> dict:
    """Return the provider capability contract for configuration and preflight. Screenshots are
    supported across providers because Hub captures them after deployment; executors acknowledge
    that declaration without claiming capture.
    """
    if provider == CICD:
        return {"healthCheckTypes": ["http", "screenshot"], "automaticRollback": False}
    if provider == RUNNER:
        return {"healthCheckTypes": ["http", "command", "screenshot"],
                "automaticRollback": True}
    return {"healthCheckTypes": ["screenshot"], "automaticRollback": False}


def kinds() -> list[dict]:
    """List registered release providers for administration and preflight without frontend-specific
    provider definitions.
    """
    rows = [
        {"key": RUNNER, "name": "执行机就地部署",
         "hint": "目标服务器上的 Runner 直接执行部署脚本（trial 这条就是它）",
         "capabilities": capabilities(RUNNER),
         "fields": [{"key": "argv", "label": "部署命令", "required": True}]},
        {"key": CICD, "name": "公司 CICD",
         "hint": "调公司 CICD 建产品版本并部署，制品 SHA 会与合并版本核对",
         "capabilities": capabilities(CICD),
         "fields": [{"key": "customer", "label": "客户/环境名", "required": True},
                    {"key": "environment", "label": "环境名（可留空自动推导）"},
                    {"key": "services", "label": "服务列表（可留空按工程推）"}]},
    ]
    return [row for row in rows if row["key"] != CICD or optional_internal_features.available("cicd")]


def describe(target) -> str:
    """Describe the deployment destination consistently for lists and readiness checks."""
    cfg = dict(getattr(target, "config", None) or {})
    if provider_of(target) == CICD:
        return "公司 CICD → %s%s" % (cfg.get("customer") or "（没配客户）",
                                    ("·" + cfg["environment"]) if cfg.get("environment") else "")
    argv = list(cfg.get("argv") or [])
    return "执行机就地部署" + ("：" + " ".join(str(x) for x in argv[:4]) if argv else "（没配命令）")


def validate(provider: str, config: dict) -> str:
    """Validate executable configuration, returning empty on success or an actionable message."""
    cfg = dict(config or {})
    if provider == CICD:
        if reason := optional_internal_features.missing_reason("cicd"):
            return reason
        if not str(cfg.get("customer") or "").strip():
            return "公司 CICD 通路必须填客户/环境名（发布绝不猜目标）"
        services = cfg.get("services")
        if services is not None and not isinstance(services, list):
            return "服务列表要么不填（按工程推），要么是一个列表"
        return ""
    if provider == RUNNER:
        return "" if list(cfg.get("argv") or []) else "执行机部署要配部署命令（argv）"
    return "不认识的发布通路：%s" % provider


def _services(cfg: dict, repo) -> list[tuple[str, str]]:
    """Use explicitly configured services or derive the repository name and target branch."""
    out: list[tuple[str, str]] = []
    for item in (cfg.get("services") or []):
        if isinstance(item, dict) and item.get("service"):
            out.append((str(item["service"]), str(item.get("branch") or "")))
        elif isinstance(item, (list, tuple)) and item:
            out.append((str(item[0]), str(item[1]) if len(item) > 1 else ""))
    branch = str(getattr(repo, "merge_branch", "") or
                 getattr(repo, "default_branch", "") or "develop")
    if out:
        return [(svc, br or branch) for svc, br in out]
    url = str(getattr(repo, "git_url", "") or "").rstrip("/")
    name = url.rsplit("/", 1)[-1] if url else (str(getattr(repo, "local_dir", "") or "")
                                               or str(getattr(repo, "name", "") or ""))
    return [(name, branch)]


def _health_specs(env, target) -> list[dict]:
    return [dict(item) for item in [*list(getattr(env, "health_checks", None) or []),
                                          *list(getattr(target, "health_checks", None) or [])]
            if isinstance(item, dict)]


async def _verify_cicd(env, target, commit: str) -> list[dict]:
    """Run the adapter-supported post-deploy checks and return durable evidence."""
    from . import http_assertions

    variables = {"DEPLOY_COMMIT": commit, "DEPLOY_COMMIT_SHORT": commit[:12]}
    checks = []
    for spec in _health_specs(env, target):
        kind = str(spec.get("type") or "http")
        if kind == "screenshot":
            # Hub's receipt_shot captures screenshots during verification.
            # Allow that declared check through provider validation.
            # Do not misclassify deferred screenshot capture as an unsupported command check.
            checks.append({"name": str(spec.get("name") or "上线回执截图"), "type": kind,
                           "ok": True, "detail": "由 Hub 侧在上线核对关抓取（deploy_screenshot）"})
            continue
        if kind != "http":
            checks.append({"name": str(spec.get("name") or "上线检查"), "type": kind,
                           "ok": False, "detail": "CICD 适配器不支持在服务端执行命令检查"})
            continue
        prepared = http_assertions.materialize(spec, variables)
        result = dict(await asyncio.to_thread(http_assertions.probe, prepared) or {})
        result.setdefault("name", str(spec.get("name") or "HTTP 上线检查"))
        result["type"] = "http"
        checks.append(result)
    return checks


# ---------------------------------------------------------------- cicd-mcp
async def _start_cicd(session: AsyncSession, run: am.DeploymentRun, env, target,
                      repo, task) -> None:
    from . import cicd_publish
    from .deployments import _now

    cfg = dict(target.config or {})
    why = validate(CICD, cfg)
    if why:
        run.state, run.error, run.finished_at = "failed", why, _now()
        run.result = {**dict(run.result or {}), "provider": CICD, "failureKind": "configuration"}
        await session.commit()
        return
    services = _services(cfg, repo)
    customer = str(cfg["customer"]).strip()
    environment = str(cfg.get("environment") or env.name or "").strip()
    url = str(cfg.get("mcpUrl") or "").strip() or cicd_publish.DEFAULT_CICD_MCP
    # Persist what was submitted at submission time.
    # After process loss, operators need that evidence to inspect CICD without automatic redeployment.
    run.state, run.started_at = "running", run.started_at or _now()
    run.result = {"provider": CICD, "stage": "submitted", "customer": customer,
                  "environment": environment,
                  "services": [{"service": s, "branch": b} for s, b in services],
                  "expectSha": run.commit_sha or "", "mcpUrl": url}
    run.error = ""
    await session.commit()

    mcp = cicd_publish.CicdMcp(url)

    def _wait_then_publish():
        """Wait for the artifact matching the merged commit before creating a version and
        deploying.
        """
        expect = str(run.commit_sha or "")
        if expect and services:
            ready = cicd_publish.await_artifact(
                mcp, customer, environment, services[0][0], expect)
            if not ready.get("ok"):
                raise RuntimeError(str(ready.get("detail") or "制品还没就绪"))
        return cicd_publish.execute_upgrade(mcp, customer, services, environment)

    _JOBS[run.id] = {"job": asyncio.create_task(asyncio.to_thread(_wait_then_publish))}
    log.info("CICD 发布已提交：%s → %s（部署运行 %s）", customer, environment or "自动推导",
             run.id[:8])


async def _poll_cicd(session: AsyncSession, run: am.DeploymentRun, env, target, task) -> None:
    from . import cicd_publish
    from .deployments import _now

    entry = _JOBS.get(run.id)
    if entry is None:
        # If restart loses the receipt, do not resubmit and create another real deployment.
        run.state, run.error, run.finished_at = "failed", (
            "后端重启时这次 CICD 发布的回执丢了：已经提交给 CICD 的那一单请人工核对，"
            "确认没发成再重发"), _now()
        run.result = {**dict(run.result or {}), "stage": "lost", "failureKind": "infrastructure"}
        await session.commit()
        return
    job = entry["job"]
    if not job.done():
        return
    _JOBS.pop(run.id, None)
    try:
        raw = dict(job.result() or {})
    except Exception as e:  # noqa: BLE001
        run.state, run.error, run.finished_at = "failed", ("CICD 发布出错：%s" % e)[:1000], _now()
        run.result = {**dict(run.result or {}), "stage": "error"}
        await session.commit()
        return
    prior = dict(run.result or {})
    services = [(x["service"], x["branch"]) for x in prior.get("services") or []]
    got_sha = cicd_publish.deployed_sha(raw, services[0][0] if services else "")
    expect = str(prior.get("expectSha") or "")
    sha_ok = (not expect) or (got_sha == expect)
    status = str(raw.get("deploy_status") or "")
    deployed = status == "SUCCESS" and sha_ok
    checks = await _verify_cicd(env, target, expect) if deployed else []
    failed_checks = [item for item in checks if not item.get("ok")]
    ok = deployed and not failed_checks
    run.result = {**prior, "stage": "done", "version": raw.get("new_version"),
                  "buildStatus": raw.get("build_status"), "deployStatus": status,
                  "deploymentId": raw.get("deployment_id"), "artifactSha": got_sha,
                  "shaOk": sha_ok, "steps": list(raw.get("steps") or []),
                  "product": services[0][0] if services else "",
                  "checksPlanned": len(checks),
                  "checksPassed": sum(1 for item in checks if item.get("ok")),
                  "checks": checks}
    run.logs = json.dumps(raw.get("steps") or [], ensure_ascii=False)[-12000:]
    run.state, run.finished_at = ("succeeded" if ok else "failed"), _now()
    if failed_checks:
        run.error = "上线健康检查未通过：" + "；".join(
            "%s（%s）" % (item.get("name") or "检查", item.get("detail") or "未通过")
            for item in failed_checks[:4])
    elif not ok:
        run.error = ("CICD 部署状态 %s" % (status or "未知")) + (
            "" if sha_ok else "；制品 SHA 与合并版本对不上（发上去的不是这条修复）")
    await session.commit()
    from .deployments import _after_terminal
    await _after_terminal(session, run)


_PROVIDERS = {CICD: (_start_cicd, _poll_cicd)}


# Connection testing.
async def probe(session: AsyncSession, target, repo, *,
                allowed_clients=None, allowed_orgs=None) -> dict:
    """Provide a read-only configuration test: CICD uses plan_upgrade; Runner targets check for an
    online matching executor. Return actionable errors rather than raw tracebacks.
    """
    provider = provider_of(target)
    cfg = dict(getattr(target, "config", None) or {})
    why = validate(provider, cfg)
    if why:
        return {"ok": False, "detail": why}
    if provider == RUNNER:
        from . import runner_hub
        tags = list(dict(getattr(target, "runner_selector", None) or {}).get("tags") or [])
        runner = runner_hub.pick_by_tags(
            tags, "", allowed_clients,
            required_capabilities=["repository", "terminal"],
            allowed_org_ids=allowed_orgs)
        if runner is None:
            return {"ok": False, "detail": "没有对得上标签且具备代码仓库和命令能力的执行机在线" +
                    ("（要求标签：" + "、".join(tags) + "）" if tags else "")}
        return {"ok": True, "detail": "执行机 %s 在线，命令：%s" % (
            getattr(runner, "host", "") or runner.id,
            " ".join(str(x) for x in (cfg.get("argv") or [])[:4]))}
    if provider == CICD:
        from . import cicd_publish
        mcp = cicd_publish.CicdMcp(str(cfg.get("mcpUrl") or "").strip()
                                   or cicd_publish.DEFAULT_CICD_MCP)
        services = _services(cfg, repo)
        try:
            plan = await asyncio.to_thread(
                cicd_publish.plan_upgrade, mcp, str(cfg["customer"]), services,
                str(cfg.get("environment") or ""))
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "detail": "连不上公司 CICD 或参数不对：%s" % str(e)[:200]}
        plan = plan if isinstance(plan, dict) else {}
        return {"ok": True, "detail": "通了。下一个版本号 %s；待升级服务 %s" % (
            plan.get("next_version") or plan.get("new_version") or "（由 CICD 计算）",
            "、".join(s for s, _b in services)), "plan": plan}
    return {"ok": False, "detail": "这条通路还不支持测试"}


async def start(session: AsyncSession, run: am.DeploymentRun, env, target,
                repo: models.Repo, task: models.Task) -> None:
    if provider_of(target) == CICD and await _missing_adapter(session, run):
        return
    await _PROVIDERS[provider_of(target)][0](session, run, env, target, repo, task)


async def poll(session: AsyncSession, run: am.DeploymentRun, env, target,
               task: models.Task) -> None:
    if provider_of(target) == CICD and await _missing_adapter(session, run):
        return
    await _PROVIDERS[provider_of(target)][1](session, run, env, target, task)


async def _missing_adapter(session, run) -> bool:
    reason = optional_internal_features.missing_reason("cicd")
    if not reason:
        return False
    if run.state not in {"succeeded", "failed", "cancelled", "rolled_back", "rollback_failed"}:
        from datetime import datetime, timezone
        run.state, run.error, run.finished_at = "failed", reason, datetime.now(timezone.utc)
        run.result = {**dict(run.result or {}), "provider": CICD,
                      "stage": "component-unavailable", "failureKind": "configuration"}
        await session.commit()
    return True
