"""Connector execution placement and probe results; personal HTTP connectors always run on the
current device's Runner.
"""
import asyncio


def probe_sync(spec: dict, timeout: int = 25) -> dict:
    """Start one MCP and list its tools through the same bridge used by tasks.

    Credentials stay in the child-process environment and never touch a probe file.
    """
    from . import mcp_servers as mcp
    mcp.validate_controls(spec)
    mcp.validate_size(spec)
    one = mcp._clean_one(spec)
    startup_timeout = min(
        max(3, int(timeout or 25)), one["startupTimeoutSeconds"])
    if one.get("type") == "http":
        if not one["url"]:
            return {"ok": False, "error": "HTTP \u578b\u8981\u586b url"}
        from . import mcp_http
        try:
            tools = mcp_http.list_tools(one, startup_timeout)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": mcp.redact_diagnostic(str(exc), one)[:600]}
        policy = mcp.tool_policy_result([tool["name"] for tool in tools], one)
        if policy["missingEnabledTools"]:
            return {
                "ok": False,
                "connected": True,
                "error": "启用清单包含服务未公开的工具：" +
                         "、".join(policy["missingEnabledTools"][:10]),
                **policy,
            }
        selected = set(policy["tools"])
        return {
            "ok": True,
            **policy,
            "raw": "\n".join(
                f"## {tool['name']}\n{tool['description']}" for tool in tools
                if tool["name"] in selected)[:4000],
        }

    if not one["name"] or not one["command"]:
        return {"ok": False, "error": "\u540d\u5b57\u548c\u542f\u52a8\u547d\u4ee4\u90fd\u5f97\u586b"}
    payload = {key: one[key] for key in ("command", "args", "env")}
    if one.get("apiDefinition"):
        payload["apiDefinition"] = one["apiDefinition"]
    try:
        discovered = mcp.bridge_list_sync(one["name"], payload, timeout=startup_timeout)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": mcp.redact_diagnostic(str(exc), one)[:600]}
    tools = [tool["name"] for tool in discovered]
    policy = mcp.tool_policy_result(tools, one)
    if policy["missingEnabledTools"]:
        return {
            "ok": False,
            "connected": True,
            "error": "启用清单包含服务未公开的工具：" +
                     "、".join(policy["missingEnabledTools"][:10]),
            **policy,
        }
    from . import connector_health
    health = connector_health.probe(one, startup_timeout)
    return {**policy, "raw": "\n".join(policy["tools"])[:4000], **health}


async def probe_managed(spec: dict, timeout: int = 25,
                        preferred_runner=None, run_on_runner=False) -> dict:
    """Probe an organization MCP where it will really run.

    Streamable HTTP is a Hub connector, while stdio is a local process and must
    be started by an online Runner. Keeping this decision here prevents the
    admin API and future callers from accidentally testing a desktop command on
    the server host.
    """
    from . import connector_health, mcp_servers as mcp
    try:
        mcp.validate_controls(spec)
        mcp.validate_size(spec)
        one = mcp._clean_one(spec)
    except ValueError as exc:
        return {**connector_health.result("error"), "ok": False, "error": str(exc)}
    timeout = min(
        max(3, min(120, int(timeout or 25))),
        one["startupTimeoutSeconds"])
    if one.get("type") == "http" and not run_on_runner:
        result = await asyncio.to_thread(mcp.probe_sync, one, timeout)
        return {**connector_health.metadata(result), **result, "runOn": "hub", "target": "SoduWork Hub"}

    from . import runner_hub
    runner = preferred_runner or runner_hub.pick_for("")
    if runner is None:
        return {
            "ok": False,
            "runOn": "runner",
            "error": "当前没有可接单的 Runner 在线，无法实测本地进程型 MCP",
            **connector_health.result("offline"),
        }
    try:
        response = await runner.call(
            "mcp.probe", {"spec": one, "timeout": timeout},
            timeout=min(150, timeout + 15))
    except Exception as exc:  # noqa: BLE001 - remote boundary must be actionable
        return {
            "ok": False,
            "runOn": "runner",
            "runnerId": runner.id,
            "runnerHost": runner.host,
            "error": mcp.redact_diagnostic(str(exc), one)[:600],
        }
    if not response.get("ok"):
        return {
            "ok": False,
            "runOn": "runner",
            "runnerId": runner.id,
            "runnerHost": runner.host,
            "error": mcp.redact_diagnostic(
                str(response.get("error") or "Runner MCP 探测失败"), one)[:600],
        }
    data = dict(response.get("data") or {})
    discovered = data.get("discoveredTools") or data.get("tools") or []
    policy = mcp.tool_policy_result(
        [str(item)[:200] for item in discovered][:100], one)
    missing = policy["missingEnabledTools"]
    health = connector_health.metadata(data)
    return {
        **health,
        "ok": not missing and data.get("ok", True) and health["ok"],
        "connected": True,
        **policy,
        "runOn": "runner",
        "runnerId": runner.id,
        "runnerHost": runner.host,
        **({"error": "启用清单包含服务未公开的工具：" +
                     "、".join(missing[:10])} if missing else {}),
    }
