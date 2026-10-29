"""Automation execution validation, capability checks and machine preflight."""
from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from .schedule_repo_scope import resolve_repo
from .schedule_timing import validate as validate_timing
from .schedule_run_contracts import (
    clean_plugin_inputs, clean_required_capabilities,
    normalize_personal_plugin_snapshot,
)


# A schedule declares business capabilities, never a concrete automation library.
# The Runner passport decides whether one machine can actually accept the work.
CAPABILITY_SKILLS = {
    "browser": "browser-use", "computer": "computer-use", "office": "office",
}

def required_skill_names(raw) -> list[str]:
    return [CAPABILITY_SKILLS[key] for key in clean_required_capabilities(raw)
            if key in CAPABILITY_SKILLS]


def _capability_remediation(runner, verdict) -> tuple[str, str]:
    """Classify capability remediation as grant, upgrade, or install and return an actionable
    message plus UI routing key.
    """
    from . import execution_capabilities
    host = str(getattr(runner, "host", "") or "") or "这台执行机"
    report = dict(verdict.get("report") or {})
    facts = {str(item.get("key") or ""): item
             for item in report.get("items") or [] if isinstance(item, dict)}
    missing = [str(key) for key in verdict.get("missing") or []]
    if any((facts.get(key) or {}).get("installed") is True
           and (facts.get(key) or {}).get("authorized") is False
           for key in missing):
        return "grant", execution_capabilities.error_message(verdict, host)
    if not int(report.get("reportedAt") or 0):
        return "upgrade", ("这台 SoduWork 的 Runner 版本过旧，没有上报本机能力，"
                           "请升级 SoduWork 客户端后重试")
    return "install", execution_capabilities.error_message(verdict, host)


def capability_save_blocker(s) -> str:
    """Precheck capability contracts before save or enable. Permit offline devices for future
    execution, but reject confirmed missing capabilities or grants on an online reporting
    Runner.
    """
    required = clean_required_capabilities(
        getattr(s, "required_capabilities", None))
    if not required:
        return ""
    from . import runner_hub
    runner = runner_hub.for_client(str(getattr(s, "owner_client_id", "") or ""))
    if runner is None:
        return ""
    verdict = runner_hub.capability_verdict(runner, required)
    if verdict.get("ok"):
        return ""
    _remedy, message = _capability_remediation(runner, verdict)
    return message


async def validate_direct_execution(session: AsyncSession, s):
    """Validate policy and Skill availability without requiring a Runner online."""
    capabilities = clean_required_capabilities(
        getattr(s, "required_capabilities", None))
    s.required_capabilities = capabilities
    if not capabilities:
        return []
    client_id = str(getattr(s, "owner_client_id", "") or "")
    client = await session.get(models.Client, client_id) if client_id else None
    if client is None:
        raise ValueError("请先选择任务归属的 SoduWork")
    from . import skills
    return await skills.resolve_named(
        session, required_skill_names(capabilities), client)


async def preflight_execution(session: AsyncSession, s,
                              org_ids: set[str] | None = None) -> dict:
    """Hub owns runtime policy; device-only dependencies need a separate check."""
    result = await _preflight_execution(session, s, org_ids=org_ids)
    if result.get("mode") != "personal" or result.get("state") == "blocked":
        return result
    # Installation, setup and platform credentials are private to the owner
    # device. An online Runner is not evidence that these dependencies work.
    execution_ready = result.get("state") == "ready"
    result["executionReady"] = execution_ready
    result["deviceDependencies"] = {
        "state": "waiting",
        "ownerClientId": str(getattr(s, "owner_client_id", "") or ""),
        "plugin": normalize_personal_plugin_snapshot(s),
    }
    result["checks"] = [
        row for row in result.get("checks", []) if row.get("key") != "plugin"
    ] + [{"key": "device-dependencies", "state": "waiting",
          "label": "个人插件和连接器待本机验证"}]
    if execution_ready:
        result["state"] = "waiting"
        result["message"] = "执行机已就绪；个人插件和连接器待本机验证"
    return result


async def _preflight_execution(session: AsyncSession, s,
                               org_ids: set[str] | None = None) -> dict:
    """Explain whether an automation is valid and whether a machine is ready now."""
    validate_timing(s)
    await resolve_repo(session, s, org_ids=org_ids)
    personal_key = str(getattr(s, "personal_plugin_key", "") or "")
    binding_id = str(getattr(s, "plugin_binding_id", "") or "")
    if binding_id and personal_key:
        return {"state": "blocked", "mode": "personal",
                "message": "企业插件绑定与个人插件只能二选一",
                "checks": [{"key": "configuration", "state": "blocked",
                            "label": "只能选择一种插件运行方式"}]}
    personal = {}
    if personal_key:
        try:
            personal = normalize_personal_plugin_snapshot(s)
        except ValueError as exc:
            return {"state": "blocked", "mode": "personal",
                    "message": str(exc)[:240],
                    "checks": [{"key": "plugin", "state": "blocked",
                                "label": str(exc)[:120]}]}
    if binding_id:
        await validate_execution(session, s, org_ids=org_ids)
        return {"state": "ready", "mode": "plugin",
                "message": "插件、工作流与运行权限已通过预检",
                "checks": [{"key": "workflow", "state": "ready",
                            "label": "企业工作流绑定有效"}]}
    # Personal plugins use direct dispatch with device-local method context and the same capability probes.
    mode = "personal" if personal_key else "direct"
    skills = await validate_direct_execution(session, s)
    required = clean_required_capabilities(
        getattr(s, "required_capabilities", None))
    client_id = str(getattr(s, "owner_client_id", "") or "")
    client = await session.get(models.Client, client_id) if client_id else None
    aid = str(getattr(s, "assignee_id", "") or "")
    if client is None:
        return {"state": "blocked", "mode": mode,
                "message": "请先选择任务归属的 SoduWork",
                "checks": [{"key": "runner", "state": "blocked",
                            "label": "尚未选择执行设备"}]}
    if not aid:
        return {"state": "blocked", "mode": mode,
                "message": "请先选择执行 Agent",
                "checks": [{"key": "agent", "state": "blocked",
                            "label": "尚未选择执行 Agent"}]}
    from . import ai_exec
    try:
        ctx = await ai_exec.load(session, force=True)
    except Exception as exc:  # noqa: BLE001
        return {"state": "blocked", "mode": mode,
                "message": ("读取 Agent 配置失败：" + str(exc))[:240]}
    import asyncio
    try:
        picked = await asyncio.to_thread(
            ai_exec.resolve_requested_sync, ctx, aid,
            str(getattr(s, "assignee_type", "") or "agent"),
            client.id, "", required)
    except Exception as exc:  # noqa: BLE001
        return {"state": "waiting", "mode": mode,
                "message": ("暂时无法探测执行机：" + str(exc))[:240],
                "requiredCapabilities": required}
    if picked is None:
        # When an online Runner cannot satisfy requirements, report the actual cause.
        # Distinguish missing grants, components, and outdated capability reporting.
        if required:
            from . import runner_hub
            mine = runner_hub.for_client(client.id)
            if mine is not None:
                verdict = runner_hub.capability_verdict(mine, required)
                if not verdict.get("ok"):
                    remedy, message = _capability_remediation(mine, verdict)
                    return {"state": "waiting", "mode": mode,
                            "message": message,
                            "requiredCapabilities": required,
                            "requiredSkills": [item.get("name") for item in skills],
                            "remedy": remedy,
                            "checks": [{"key": "capability", "state": "waiting",
                                        "label": message}]}
        labels = "、".join(required_skill_names(required)) or "所选 Agent"
        return {"state": "waiting", "mode": mode,
                "message": "配置有效；等待具备 %s 的 Runner 在线" % labels,
                "requiredCapabilities": required,
                "requiredSkills": [item.get("name") for item in skills],
                "checks": [{"key": "runner", "state": "waiting",
                            "label": "等待可用 Runner"}]}
    policy = str(personal.get("versionPolicy") or "")
    plugin_message = ("固定 v" + str(personal.get("version") or "")
                      if policy == "pinned" else "跟随本机当前版本")
    return {
        "state": "ready", "mode": mode,
        "message": (("执行条件已就绪；个人插件" + plugin_message)
                    if personal_key else "执行条件已就绪"),
        "requiredCapabilities": required,
        "requiredSkills": [item.get("name") for item in skills],
        "pluginSnapshot": personal,
        "checks": ([{"key": "plugin", "state": "ready",
                     "label": "个人插件" + plugin_message}]
                   if personal_key else []) + [
            {"key": "runner", "state": "ready", "label": "Runner 已在线"},
            {"key": "capability", "state": "ready", "label": "能力授权满足"},
        ],
        "machine": {
            "id": str(picked.get("runnerId") or picked.get("id") or ""),
            "name": str(picked.get("host") or picked.get("name") or "可用执行机"),
            "agent": str(picked.get("cli") or picked.get("name") or ""),
        },
    }


async def validate_execution(session: AsyncSession, s,
                             org_ids: set[str] | None = None):
    """Validate the selected immutable automation binding at save and run time."""
    validate_timing(s)
    binding_id = str(getattr(s, "plugin_binding_id", "") or "")
    personal_key = str(getattr(s, "personal_plugin_key", "") or "")
    if personal_key and binding_id:
        raise ValueError("企业插件绑定与个人插件只能二选一")
    repo = await resolve_repo(session, s, org_ids=org_ids)
    if personal_key:
        # Hub validates metadata; the owner Runner verifies the exact local body.
        # This preserves device privacy while making each scheduled run reproducible.
        normalize_personal_plugin_snapshot(s)
        if not str(getattr(s, "assignee_id", "") or ""):
            raise ValueError("个人插件自动化还需要选择执行 Agent")
        s.plugin_inputs = clean_plugin_inputs(getattr(s, "plugin_inputs", {}) or {})
        await validate_direct_execution(session, s)
        return None
    if not binding_id:
        await validate_direct_execution(session, s)
        return None
    client_id = str(getattr(s, "owner_client_id", "") or "")
    client = await session.get(models.Client, client_id) if client_id else None
    if client is None:
        raise ValueError("请先选择任务归属的 SoduWork")
    task = SimpleNamespace(
        owner_client_id=client.id,
        project_id=(repo.project_id if repo else None),
        repo_id=(repo.id if repo else None),
    )
    from .. import automation_models as am
    from . import plugin_service
    binding = await plugin_service.resolve_binding(
        session, task, binding_id=binding_id, org_ids=org_ids,
        entrypoint="automation")
    version = await session.get(am.PluginVersion, binding.version_id)
    fields = plugin_service.public_inputs((version.manifest if version else {}) or {})
    source = clean_plugin_inputs(getattr(s, "plugin_inputs", {}) or {})
    allowed = {item["key"]: item for item in fields}
    values = {key: value for key, value in source.items() if key in allowed}
    for key, field in allowed.items():
        if key not in values and "default" in field:
            values[key] = field["default"]
        if field["type"] == "boolean" and key in values:
            raw = values[key]
            values[key] = raw if isinstance(raw, bool) else str(raw).lower() in {
                "1", "true", "yes", "on"}
        if field["type"] == "number" and key in values and values[key] not in ("", None):
            try:
                values[key] = float(values[key])
            except (TypeError, ValueError) as exc:
                raise ValueError("插件输入必须是数字：" + field["label"]) from exc
        if field["type"] == "select" and key in values and values[key] not in ("", None):
            options = {str(x.get("value")) for x in field.get("options") or []}
            if str(values[key]) not in options:
                raise ValueError("插件输入选项已失效：" + field["label"])
            values[key] = str(values[key])
        if field["required"] and (key not in values or values[key] in ("", None)):
            raise ValueError("请填写插件必填项：" + field["label"])
    s.plugin_inputs = values
    return binding
