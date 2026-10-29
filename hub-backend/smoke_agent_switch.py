"""Regression checks for public module contracts."""
from __future__ import annotations

import inspect
import os
import sys

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///.smoke-agent-switch.db"
sys.path.insert(0, ".")

from app.services.workflow_runs import execution_route, execution_preferences  # noqa: E402
from app.api import plugins as plugin_api  # noqa: E402

passed = failed = 0


def ok(cond, name, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, " << ", str(detail)[:200])


def main() -> int:
    node_cfg = {
        "agentKind": "local:codex",
        "model": "m-node",
        "reasoningEffort": "max",
    }
    binding_cfg = {"execution": {"agentKind": "local:pi"}}

    # Without a manual override, use the node declaration.
    route = execution_route({}, binding_cfg, node_cfg, "implement")
    ok(route["reasoningEffort"] == "max",
       "Codex keeps its configured reasoning effort", route)
    ok(route["agentKind"] == "local:codex" and not route["manual"],
       "无手动层时节点声明生效", route)

    # Manual overrides carry the marker that disables pinning to the previous executor.
    ctx = {"executionOverrides": {"implement": {"agentKind": "local:opencode"}}}
    route = execution_route(ctx, binding_cfg, node_cfg, "implement")
    ok(route["reasoningEffort"] == "",
       "switching away from Codex clears Codex-only reasoning effort", route)
    ok(route["agentKind"] == "local:opencode" and route["manual"] is True,
       "手动层压过节点声明", route)
    ok(route["model"] == "m-node", "手动层没给 model 时沿用节点声明", route)

    # Only the selected node receives the override.
    route = execution_route(ctx, binding_cfg, node_cfg, "review")
    ok(route["agentKind"] == "local:codex" and not route["manual"],
       "别的节点不受手动层影响", route)

    # Project node overrides remain below manual overrides.
    binding_with_override = {**binding_cfg,
                             "nodeOverrides": {"implement": {"agentKind": "local:claude"}}}
    route = execution_route(ctx, binding_with_override, node_cfg, "implement")
    ok(route["agentKind"] == "local:opencode", "手动层也压过项目级节点覆盖", route)
    route = execution_route({}, binding_with_override, node_cfg, "implement")
    ok(route["agentKind"] == "local:claude", "无手动层时项目级覆盖照旧", route)

    # Reject invalid agent kinds through the same validation used by API execution preferences.
    try:
        execution_preferences({"agentKind": "runner:some-box; rm -rf /"})
        ok(False, "非法 agentKind 被拒绝")
    except ValueError as e:
        ok("不合法" in str(e), "非法 agentKind 被拒绝", e)

    admin_retry_source = inspect.getsource(plugin_api.admin_retry_gate)
    ok('execution=dict(body.get("execution") or {}) or None' in admin_retry_source,
       "admin retry forwards the selected agent to the workflow engine",
       admin_retry_source)

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
