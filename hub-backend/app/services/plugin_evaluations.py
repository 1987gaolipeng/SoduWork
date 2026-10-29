"""Durable, side-effect-bounded publication evaluations for immutable plugin versions."""
from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime, timezone
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import (agent_route_selection, ai_exec, environment_service,
               plugin_runtime, workflow_inputs)


ACTIVE_STATES = {"queued", "running"}
FINAL_STATES = {"completed", "failed", "cancelled"}
DECISIONS = {"passed", "failed"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _ms(value) -> int | None:
    return int(value.timestamp() * 1000) if value else None


def _cases(version: am.PluginVersion) -> list[dict]:
    return [dict(item) for item in
            dict(version.capability_report or {}).get("evaluationCases") or []
            if isinstance(item, dict)]


def _case(version: am.PluginVersion, key: str) -> dict:
    found = next((item for item in _cases(version)
                  if str(item.get("key") or "") == str(key or "")), None)
    if found is None:
        raise ValueError("这个插件版本没有这项发布评测")
    return found


def run_api(row: am.PluginEvaluationRun) -> dict:
    return {
        "id": row.id, "pluginId": row.plugin_id, "versionId": row.version_id,
        "caseKey": row.case_key, "orgId": row.org_id,
        "state": row.state, "verdict": row.verdict,
        "externalRef": row.external_ref, "agentKind": row.agent_kind,
        "model": row.model, "case": row.case_snapshot or {},
        "executor": row.executor or {}, "result": row.result or {},
        "error": row.error, "createdBy": row.created_by,
        "reviewedBy": row.reviewed_by, "reviewNote": row.review_note,
        "createdAt": _ms(row.created_at), "startedAt": _ms(row.started_at),
        "completedAt": _ms(row.completed_at), "reviewedAt": _ms(row.reviewed_at),
    }


def _ready_for_release_review(row: am.PluginEvaluationRun | None) -> bool:
    """A completed run with a satisfied contract can be accepted with version review.

    The administrator already performs one explicit, audited approval when the
    immutable plugin version is released. Requiring a second "confirm passed"
    click for the same evidence added friction without adding another reviewer.
    """
    if row is None or row.state != "completed" or row.verdict != "pending":
        return False
    return bool(dict(dict(row.result or {}).get("contract") or {}).get("ok"))


class _EvaluationTask:
    """Provider-compatible work item that never enters the formal task table."""

    def __init__(self, row: am.PluginEvaluationRun, case: dict, actor: str,
                 owner_client_id: str):
        self.id = "plugin-eval-" + row.id
        self.title = "插件发布评测 · " + str(case.get("name") or case.get("key") or "")
        self.note = str(case.get("instruction") or "")
        self.result = ""
        self.priority = "normal"
        self.source = "plugin-evaluation"
        self.created_by_name = actor
        self.owner_client_id = owner_client_id
        self.work_routing = {}
        self.repo_id = ""


async def _allowed_clients(session: AsyncSession, org_id: str | None,
                           actor_id: str) -> tuple[list[str], str]:
    user_ids = [actor_id]
    if org_id:
        user_ids = list((await session.execute(select(models.User.id).where(
            models.User.org_id == org_id,
            models.User.is_active.is_(True),
        ))).scalars().all())
    rows = list((await session.execute(select(models.Client).where(
        models.Client.user_ref.in_(user_ids or {"__none__"}),
        models.Client.auth_state == "active",
    ).order_by(models.Client.id))).scalars().all())
    own = next((item for item in rows if str(item.user_ref or "") == actor_id), None)
    preferred = str((own or (rows[0] if rows else None)).id) if rows else ""
    return [str(item.id) for item in rows], preferred


def _expected_specs(version: am.PluginVersion, case: dict) -> list[dict]:
    by_id = {str(item.get("id") or ""): dict(item)
             for item in dict(version.capability_report or {}).get("resultContract") or []
             if isinstance(item, dict)}
    selected = [by_id[key] for key in case.get("expectedOutputs") or [] if key in by_id]
    files = [item for item in selected if item.get("kind") in {"file", "decision"}
             and item.get("path")]
    if not any(str(item.get("path") or "") == "evaluation-result.md" for item in files):
        files.append({
            "key": "evaluation_result", "kind": "file",
            "label": "发布评测报告", "path": "evaluation-result.md", "required": True,
        })
    return files


def _prompt(version: am.PluginVersion, case: dict) -> str:
    report = dict(version.capability_report or {})
    contract = {str(item.get("id") or ""): dict(item)
                for item in report.get("resultContract") or []
                if isinstance(item, dict)}
    expected = [contract[key] for key in case.get("expectedOutputs") or [] if key in contract]
    return """你正在执行 SoduWork 插件发布评测，不是正式业务任务。

【安全边界】
- 只验证当前插件版本声明的工作能力；不得执行审批、合并、部署、发消息、改生产数据等副作用。
- 只使用本次明确下发的 Skill、MCP 与运行能力；不要寻找或读取其他凭据。
- 不要向用户提问。信息不足时记录假设与限制，不要越权补数据。
- 所有验证在当前隔离工作目录完成，不创建正式 SoduWork 任务。

【插件说明】
%s

【代表性任务】
%s

【无凭据输入】
%s

【验收标准】
%s

【声明的预期结果】
%s

必须生成 evaluation-result.md，写清：执行摘要、逐条标准的证据、产出映射、实际使用的能力、限制与未执行的副作用。声明了文件路径的结果必须使用精确文件名生成。""" % (
        str(dict(version.manifest or {}).get("instructions") or "按插件声明的能力完成代表性任务"),
        str(case.get("instruction") or ""),
        json.dumps(case.get("inputs") or {}, ensure_ascii=False, indent=2),
        "\n".join("- " + str(item) for item in case.get("criteria") or []),
        json.dumps(expected, ensure_ascii=False, indent=2),
    )


def _contract_check(version: am.PluginVersion, case: dict, status: dict,
                    artifacts: list[dict]) -> dict:
    names = {str(item.get("filename") or "").replace("\\", "/").lstrip("/")
             for item in artifacts if item.get("fetched")}
    contract = {str(item.get("id") or ""): dict(item)
                for item in dict(version.capability_report or {}).get("resultContract") or []
                if isinstance(item, dict)}
    items, blockers = [], []
    report_ok = "evaluation-result.md" in names
    if not report_ok:
        blockers.append("缺少 evaluation-result.md")
    for output_id in case.get("expectedOutputs") or []:
        spec = contract.get(str(output_id))
        if spec is None:
            continue
        kind = str(spec.get("kind") or "")
        required = bool(spec.get("required", True))
        value, ok, exercised = "", True, True
        if kind in {"file", "decision"}:
            value = str(spec.get("path") or "")
            ok = value in names
        elif kind == "evidence":
            value = str(len(names))
            ok = bool(names)
        elif kind == "url":
            value = str(status.get("artifactUrl") or "")
            ok, exercised = bool(value), bool(value)
        elif kind == "git":
            value = str(status.get("gitHead") or "")
            ok, exercised = bool(value), bool(value)
        if kind in {"git", "url"} and not exercised:
            ok = not required
            detail = "能力评测不触发仓库或发布副作用"
            if required:
                blockers.append(
                    str(spec.get("label") or output_id) +
                    " 需要专用沙箱验证，不能用未执行结果通过发布门禁")
            items.append({**spec, "ok": ok, "status": "not-exercised",
                          "value": "", "detail": detail})
            continue
        if required and not ok:
            blockers.append(str(spec.get("label") or output_id) + " 未交付")
        items.append({**spec, "ok": ok, "status": "verified" if ok else "missing",
                      "value": value})
    return {"ok": report_ok and not blockers, "items": items,
            "artifacts": sorted(names), "blockers": blockers}


async def start(session: AsyncSession, version: am.PluginVersion, case_key: str,
                actor, body: dict | None = None) -> am.PluginEvaluationRun:
    body = dict(body or {})
    case = _case(version, case_key)
    active = (await session.execute(select(am.PluginEvaluationRun).where(
        am.PluginEvaluationRun.version_id == version.id,
        am.PluginEvaluationRun.case_key == case_key,
        am.PluginEvaluationRun.state.in_(ACTIVE_STATES),
    ).order_by(am.PluginEvaluationRun.created_at.desc(),
               am.PluginEvaluationRun.id.desc()).limit(1))).scalar_one_or_none()
    if active is not None:
        return active

    plugin = await session.get(am.Plugin, version.plugin_id)
    # Built-ins are global catalog entries (`plugin.org_id` is null), but an
    # evaluation is still an organization-scoped execution.  Falling through
    # to null here filtered every shared Runner out of the tenant boundary.
    plugin_org_id = str(getattr(plugin, "org_id", "") or "")
    actor_org_id = str(getattr(actor, "org_id", "") or "")
    org_id = plugin_org_id or actor_org_id or None
    report = dict(version.capability_report or {})
    external = bool(report.get("network") or report.get("mcpServers")
                    or set(report.get("runtime") or []).intersection({"browser", "computer"}))
    if external and not body.get("confirmExternalAccess"):
        raise ValueError("这项评测会使用网络、MCP、浏览器或电脑能力，请明确确认本次外部访问")

    actor_id = str(getattr(actor, "id", "") or "")
    actor_name = str(getattr(actor, "display_name", "") or
                     getattr(actor, "username", "") or actor_id)
    row = am.PluginEvaluationRun(
        plugin_id=version.plugin_id, version_id=version.id,
        case_key=str(case.get("key") or case_key), org_id=org_id,
        active_key=version.id + ":" + str(case.get("key") or case_key),
        case_snapshot=case, created_by=actor_id, created_at=_now(),
    )
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        existing = (await session.execute(select(am.PluginEvaluationRun).where(
            am.PluginEvaluationRun.active_key ==
            version.id + ":" + str(case.get("key") or case_key),
        ).limit(1))).scalar_one_or_none()
        if existing is not None:
            return existing
        raise

    try:
        allowed, preferred = await _allowed_clients(session, org_id, actor_id)
        nodes = [dict(item) for item in dict(version.workflow or {}).get("nodes") or []
                 if isinstance(item, dict) and item.get("type") in {"ai", "ai_review"}]
        first = nodes[0] if nodes else {}
        node_cfg = dict(first.get("config") or {})
        requested = str(body.get("agentKind") or node_cfg.get("agentKind") or "local:pi")[:100]
        requested_runner = str(body.get("runnerId") or "").strip()[:64]
        model = str(body.get("model") or node_cfg.get("model") or "")[:160]
        runtime = list(report.get("runtime") or [])
        runner_tags = list(body.get("runnerTags") or node_cfg.get("runnerTags") or [])[:12]
        ctx = await ai_exec.load(session, force=True)
        ctx["_runnerAllowedClients"] = allowed
        ctx["_runnerAllowedOrgs"] = sorted(
            await environment_service.runner_orgs_for_org(session, org_id))
        selection = await asyncio.to_thread(
            agent_route_selection.resolve_sync, ctx, requested, preferred, requested_runner,
            runtime, runner_tags,
            "strict" if body.get("agentKind") else "best-effort", model)
        picked = selection.get("agent")
        fallback = str(selection.get("fallbackKind") or "")
        if picked is None:
            model_errors = list(selection.get("modelErrors") or [])
            if model_errors:
                raise ValueError(model_errors[0])
            raise ValueError("没有满足该插件运行能力要求的在线 Agent")
        picked_runner = str(picked.get("runnerId") or "")
        if requested_runner and picked_runner != requested_runner:
            raise ValueError(
                "\u6307\u5b9a\u6267\u884c\u673a\u5f53\u524d\u4e0d\u53ef\u7528\uff0c\u6216\u7f3a\u5c11\u6240\u9009 Agent / \u63d2\u4ef6\u8fd0\u884c\u80fd\u529b\uff1b"
                "\u8bf7\u6362\u4e00\u53f0\u6267\u884c\u673a\uff0c\u6216\u6539\u7528\u81ea\u52a8\u9009\u62e9")
        if model:
            ctx = ai_exec.with_model(ctx, model)

        skills = await workflow_inputs.plugin_skills(session, version)
        secret_refs = {str(k): str(v) for k, v in
                       dict(body.get("secretRefs") or {}).items() if v}
        binding = SimpleNamespace(secret_refs=secret_refs, org_id=org_id)
        runtime_secrets = await plugin_runtime.resolve_secret_sources(
            session, binding, list(report.get("secrets") or []))
        extra = {
            "brief": _prompt(version, case),
            "skills": skills,
            "networkAllowed": bool(report.get("network")),
            "requiredAgentCapabilities": runtime,
            "deliveryMode": "files",
            "expectedOutputs": _expected_specs(version, case),
            "pluginNodeName": "发布评测 · " + str(case.get("name") or case_key),
            "workspacePolicy": {"isolated": True, "isolationKey": row.id},
        }
        if runtime_secrets:
            extra["runtimeSecrets"] = runtime_secrets
        required_mcp = list(report.get("mcpServers") or [])
        if required_mcp:
            from . import mcp_servers
            extra["mcpServers"], extra["mcpConfig"] = await mcp_servers.runtime_for_dispatch(
                session, required_mcp, scope="evaluation-" + version.id)
        task = _EvaluationTask(row, case, actor_name, preferred)
        ctx = await ai_exec.with_task_git(
            session, ctx, task, lock_to_client=False)
        result = await asyncio.to_thread(ai_exec.dispatch_sync, ctx, task, [], picked, extra)
        if not result.get("ok") or not result.get("issueId"):
            raise ValueError(str(result.get("error") or "Agent 没能启动发布评测"))
        row.state = "running"
        row.started_at = _now()
        row.external_ref = str(result.get("issueId") or "")[:180]
        row.agent_kind = fallback or requested
        row.model = str(result.get("model") or model)[:160]
        row.executor = {
            "provider": str(result.get("provider") or ""),
            "assigneeId": str(result.get("assigneeId") or picked.get("id") or ""),
            "assigneeName": str(result.get("assigneeName") or picked.get("name") or ""),
            "runnerId": str(result.get("runnerId") or picked.get("runnerId") or ""),
            "host": str(result.get("host") or picked.get("host") or ""),
            "requestedAgentKind": requested, "resolvedAgentKind": fallback or requested,
            "requestedRunnerId": requested_runner,
            "requiredRuntime": runtime, "runnerTags": runner_tags,
        }
        row.error = ""
    except Exception as exc:  # noqa: BLE001 - dispatch failures are durable evidence
        row.state = "failed"
        row.active_key = None
        row.completed_at = _now()
        row.error = str(exc)[:1200]
    await session.commit()
    return row


async def refresh(session: AsyncSession, row: am.PluginEvaluationRun) -> am.PluginEvaluationRun:
    if row.state not in ACTIVE_STATES or not row.external_ref:
        return row
    ctx = await ai_exec.load(session)
    executor = dict(row.executor or {})
    if executor.get("provider") == "runner" and executor.get("runnerId"):
        from . import ai_remote
        ai_remote.remember(row.external_ref, str(executor["runnerId"]))
    status = await asyncio.to_thread(ai_exec.status_sync, ctx, row.external_ref)
    if not status.get("ok"):
        row.result = {**dict(row.result or {}), "lastProbe": {
            "ok": False, "error": str(status.get("error") or "")[:500], "at": _ms(_now())}}
        await session.commit()
        return row
    row.result = {**dict(row.result or {}), "lastProbe": {
        "ok": True, "status": str(status.get("status") or ""),
        "running": bool(status.get("running")), "at": _ms(_now())}}
    if not status.get("done"):
        await session.commit()
        return row
    if status.get("error") or str(status.get("status") or "") in {"failed", "interrupted"}:
        row.state, row.completed_at = "failed", _now()
        row.active_key = None
        row.error = str(status.get("error") or "发布评测执行失败")[:1200]
        await session.commit()
        return row

    artifacts = []
    for item in list(status.get("attachments") or [])[:40]:
        attachment_id = str(item.get("id") or "")
        filename = str(item.get("filename") or attachment_id)[:300]
        raw = await asyncio.to_thread(
            ai_exec.fetch_attachment_for_sync, ctx, row.external_ref, attachment_id)
        artifacts.append({
            "id": attachment_id, "filename": filename, "fetched": raw is not None,
            "size": len(raw) if raw is not None else 0,
            "sha256": hashlib.sha256(raw).hexdigest() if raw is not None else "",
        })
    version = await session.get(am.PluginVersion, row.version_id)
    case = dict(row.case_snapshot or {})
    contract = _contract_check(version, case, status, artifacts) if version else {
        "ok": False, "items": [], "artifacts": [], "blockers": ["插件版本不存在"]}
    row.state, row.completed_at, row.error = "completed", _now(), ""
    row.active_key = None
    row.result = {
        "status": {
            "deliveryKind": str(status.get("deliveryKind") or ""),
            "artifactUrl": str(status.get("artifactUrl") or "")[:600],
            "gitHead": str(status.get("gitHead") or "")[:80],
            "artifactsDropped": int(status.get("artifactsDropped") or 0),
        },
        "artifacts": artifacts, "contract": contract,
    }
    await session.commit()
    return row


async def list_runs(session: AsyncSession, version: am.PluginVersion,
                    refresh_active: bool = True) -> dict:
    rows = list((await session.execute(select(am.PluginEvaluationRun).where(
        am.PluginEvaluationRun.version_id == version.id,
    ).order_by(am.PluginEvaluationRun.created_at.desc(),
               am.PluginEvaluationRun.id.desc()).limit(200))).scalars().all())
    if refresh_active:
        for row in rows:
            if row.state in ACTIVE_STATES:
                await refresh(session, row)
    gate = await publication_gate(session, version, confirm_without_evaluation=False,
                                  refresh_active=False)
    return {"items": [run_api(row) for row in rows], "gate": gate}


async def review(session: AsyncSession, row: am.PluginEvaluationRun, decision: str,
                 actor: str, note: str = "") -> am.PluginEvaluationRun:
    if row.state in ACTIVE_STATES:
        await refresh(session, row)
    decision = str(decision or "").strip().lower()
    if decision not in DECISIONS:
        raise ValueError("评测结论只能是通过或不通过")
    if row.state != "completed":
        raise ValueError("只有执行完成的评测才能给出结论")
    contract = dict(dict(row.result or {}).get("contract") or {})
    if decision == "passed" and not contract.get("ok"):
        raise ValueError("产出没有满足结果契约，不能标记为通过")
    row.verdict = decision
    row.reviewed_by = str(actor or "")[:64]
    row.review_note = str(note or "")[:1200]
    row.reviewed_at = _now()
    await session.commit()
    return row


async def accept_ready_with_release_review(
        session: AsyncSession, version: am.PluginVersion, actor: str,
) -> int:
    """Accept contract-complete evaluations as part of version approval.

    This does not bypass evaluation. It only merges two adjacent human clicks:
    the immutable evidence must exist and satisfy the declared result contract,
    then the administrator's version approval becomes the recorded conclusion.
    """
    rows = list((await session.execute(select(am.PluginEvaluationRun).where(
        am.PluginEvaluationRun.version_id == version.id,
    ).order_by(am.PluginEvaluationRun.created_at.desc(),
               am.PluginEvaluationRun.id.desc()).limit(500))).scalars().all())
    latest = {}
    for row in rows:
        latest.setdefault(row.case_key, row)
    changed = 0
    for case in _cases(version):
        row = latest.get(str(case.get("key") or ""))
        if not _ready_for_release_review(row):
            continue
        row.verdict = "passed"
        row.reviewed_by = str(actor or "")[:64]
        row.review_note = "随插件版本发布审核一并确认"
        row.reviewed_at = _now()
        changed += 1
    if changed:
        await session.commit()
    return changed


async def cancel(session: AsyncSession, row: am.PluginEvaluationRun,
                 actor: str) -> am.PluginEvaluationRun:
    if row.state not in ACTIVE_STATES:
        return row
    if row.external_ref:
        ctx = await ai_exec.load(session)
        await asyncio.to_thread(ai_exec.stop_sync, ctx, row.external_ref)
    row.state, row.completed_at = "cancelled", _now()
    row.active_key = None
    row.error = "由 %s 取消" % (actor or "管理员")
    await session.commit()
    return row


async def publication_gate(session: AsyncSession, version: am.PluginVersion,
                           confirm_without_evaluation: bool = False,
                           refresh_active: bool = True) -> dict:
    cases = _cases(version)
    if not cases:
        return {
            "ok": bool(confirm_without_evaluation), "state": "undeclared",
            "caseCount": 0, "passedCount": 0,
            "blockers": ([] if confirm_without_evaluation else
                         ["插件没有声明代表性发布评测，需要管理员明确确认风险"]),
            "cases": [],
        }
    rows = list((await session.execute(select(am.PluginEvaluationRun).where(
        am.PluginEvaluationRun.version_id == version.id,
    ).order_by(am.PluginEvaluationRun.created_at.desc(),
               am.PluginEvaluationRun.id.desc()).limit(500))).scalars().all())
    latest = {}
    for row in rows:
        latest.setdefault(row.case_key, row)
    if refresh_active:
        for row in latest.values():
            if row.state in ACTIVE_STATES:
                await refresh(session, row)
    items, blockers = [], []
    for case in cases:
        key = str(case.get("key") or "")
        row = latest.get(key)
        ok = bool(row and row.state == "completed" and row.verdict == "passed")
        ready = _ready_for_release_review(row)
        if row is None:
            state = "not-run"
        elif row.verdict == "passed":
            state = "passed"
        elif row.verdict == "failed":
            state = "review-failed"
        elif ready:
            state = "ready"
        else:
            state = row.state
        if not ok and not ready:
            blockers.append("%s：%s" % (case.get("name") or key, {
                "not-run": "尚未运行", "queued": "正在排队", "running": "正在执行",
                "completed": "等待审核", "failed": "执行失败", "cancelled": "已取消",
                "review-failed": "未通过",
            }.get(state, "未通过")))
        items.append({
            "key": key, "name": str(case.get("name") or key),
            "ok": ok, "ready": ready, "state": state,
            "latestRun": run_api(row) if row else None,
        })
    ready_for_approval = not blockers and all(
        item["ok"] or item["ready"] for item in items)
    passed_count = sum(1 for item in items if item["ok"])
    ready_count = sum(1 for item in items if item["ready"])
    return {
        "ok": passed_count == len(cases),
        "readyForApproval": ready_for_approval,
        "state": ("passed" if passed_count == len(cases) else
                  "ready" if ready_for_approval else "blocked"),
        "caseCount": len(cases), "passedCount": passed_count,
        "readyCount": ready_count,
        "blockers": blockers, "cases": items,
    }
