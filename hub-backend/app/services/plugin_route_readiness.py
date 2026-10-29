"""Side-effect-free per-node Agent/model readiness for capability packages."""
from __future__ import annotations

import asyncio

from . import agent_route_selection, plugin_runtime


def _unique(items) -> list[str]:
    return list(dict.fromkeys(str(item) for item in items if str(item)))


async def context_for_task(session, task) -> dict:
    """Load one scoped Agent directory for every candidate binding in a request."""
    from . import ai_exec

    try:
        return ai_exec.with_client_runner_scope(
            await ai_exec.load(session, force=True),
            str(task.owner_client_id or ""))
    except Exception:  # noqa: BLE001 - catalog and start must fail closed, not return 500
        return {"_routeContextError":
                "执行机目录暂时不可用，请检查 Hub 与 Runner 连接后重试"}


async def check(session, version, *, binding_config: dict | None = None,
                run_context: dict | None = None, agent_kind: str = "",
                ctx: dict | None = None, client_id: str = "", task=None,
                node_keys: set[str] | None = None) -> dict:
    """Resolve every AI node exactly as the durable engine would, without dispatching."""
    from . import ai_exec
    from .workflow_runs import execution_route, normalize_binding_execution

    nodes = list(dict(version.workflow or {}).get("nodes") or [])[:100]
    wanted = {str(key) for key in node_keys} if node_keys is not None else None
    ai_nodes = [node for node in nodes
                if str(node.get("type") or "") in {"ai", "ai_review"}
                and (wanted is None or str(node.get("key") or "") in wanted)]
    raw_context = dict(run_context or {})
    if agent_kind:
        execution = dict(raw_context.get("execution") or {})
        execution["agentKind"] = str(agent_kind).strip()
        raw_context["execution"] = execution
    blockers: list[str] = []
    warnings: list[str] = []
    try:
        route_config = normalize_binding_execution(
            dict(binding_config or {}), version.workflow or {})
    except ValueError as exc:
        route_config = {}
        blockers.append(str(exc))
    if not ai_nodes:
        return {
            "ok": not blockers, "blockers": _unique(blockers), "warnings": [],
            "routes": [], "agent": None,
            "check": {"key": "agent", "label": "逐节点 Agent 与模型", "ok": not blockers,
                      "detail": "这条流程不需要 AI 执行机"},
        }

    routes: list[dict] = []
    first_agent = None
    probe_error = ""
    try:
        if isinstance(ctx, dict) and ctx.get("_routeContextError"):
            raise RuntimeError(str(ctx["_routeContextError"]))
        runtime_ctx = ctx if ctx is not None else await ai_exec.load(session, force=True)
        cache: dict[tuple, dict] = {}
        for node in ai_nodes:
            node_key = str(node.get("key") or "")
            route = execution_route(
                raw_context, route_config, dict(node.get("config") or {}), node_key)
            selected = plugin_runtime.node_capabilities(
                node, dict(version.capability_report or {}))
            required = list(selected["runtime"])
            if task is not None:
                required = ai_exec.required_capabilities(task, {
                    "requiredAgentCapabilities": required,
                })
            cache_key = (
                route["agentKind"], tuple(route["runnerTags"]),
                route["fallbackMode"], tuple(required), route["model"],
            )
            if cache_key not in cache:
                cache[cache_key] = await asyncio.to_thread(
                    agent_route_selection.resolve_sync, runtime_ctx,
                    route["agentKind"], client_id, "", required,
                    route["runnerTags"], route["fallbackMode"], route["model"])
            selection = cache[cache_key]
            picked = selection.get("agent")
            fallback_kind = str(selection.get("fallbackKind") or "")
            node_name = str(node.get("name") or node_key or "AI 节点")
            resolved_kind = str(selection.get("resolvedKind") or "")
            model_errors = list(selection.get("modelErrors") or [])
            row_ok = bool(picked)
            row = {
                "nodeKey": node_key, "nodeName": node_name,
                "requested": {**route, "runtime": required},
                "resolved": ({
                    "agentKind": resolved_kind,
                    "id": picked.get("id"), "name": picked.get("name") or resolved_kind,
                    "runnerId": picked.get("runnerId") or "", "host": picked.get("host") or "",
                    "model": route.get("model") or "",
                } if picked else {}),
                "ok": row_ok, "fallback": bool(fallback_kind),
            }
            routes.append(row)
            if not picked:
                if model_errors:
                    blockers.append(f"节点「{node_name}」：{model_errors[0]}")
                else:
                    blockers.append(f"节点「{node_name}」找不到符合路由要求的在线 Agent")
            else:
                if first_agent is None:
                    first_agent = {
                        "id": picked.get("id"), "name": picked.get("name"),
                        "kind": resolved_kind,
                    }
                if fallback_kind:
                    warnings.append(
                        f"节点「{node_name}」指定的 {route['agentKind']} 当前不可用，"
                        f"将降级为 {fallback_kind}")
    except Exception as exc:  # noqa: BLE001 - readiness must explain infrastructure failure
        message = str(exc)
        probe_error = message if message.startswith("执行机目录") else "执行机探测失败：" + type(exc).__name__
        blockers.append(probe_error)

    route_ok = (not probe_error and len(routes) == len(ai_nodes)
                and all(row["ok"] for row in routes))
    detail = (f"{len(routes)} 个 AI 节点的 Agent、模型与能力路由均可解析"
              if route_ok else "部分 AI 节点找不到可用的 Agent、模型或 Runner 能力")
    return {
        "ok": not blockers, "blockers": _unique(blockers),
        "warnings": _unique(warnings), "routes": routes, "agent": first_agent,
        "check": {"key": "agent", "label": "逐节点 Agent 与模型",
                  "ok": route_ok, "detail": detail},
    }


async def catalog_check(session, version, project, org_id, *, secret_refs=None,
                        binding_config=None, ctx=None, client_id="", task=None,
                        run_context=None, node_keys: set[str] | None = None) -> dict:
    """Combine project/dependency checks with dynamic per-node route readiness."""
    from .plugin_readiness import scoped_binding_readiness

    base = await scoped_binding_readiness(
        session, version, project, org_id, secret_refs=secret_refs,
        binding_config=binding_config, node_keys=node_keys)
    route = await check(
        session, version, binding_config=binding_config, ctx=ctx,
        client_id=client_id, task=task, run_context=run_context,
        node_keys=node_keys)
    blockers = _unique(list(base.get("blockers") or []) + route["blockers"])
    warnings = _unique(list(base.get("warnings") or []) + route["warnings"])
    return {
        "ok": not blockers, "blockers": blockers, "warnings": warnings,
        "checks": list(base.get("checks") or []) + [route["check"]],
        "agentRoutes": route["routes"],
    }


__all__ = ["catalog_check", "check", "context_for_task"]
