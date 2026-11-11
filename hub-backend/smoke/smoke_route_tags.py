"""Regression checks for public module contracts."""
from __future__ import annotations

import os
import sys
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///.smoke-route-tags.db"
sys.path.insert(0, ".")

from app.services import agent_route_selection, ai_exec  # noqa: E402

passed = failed = 0


def ok(cond, name, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, " << ", str(detail)[:300])


def main() -> int:
    calls: list = []

    def fake_resolve_kind(ctx, kind, client_id="", prefer_runner="",
                          required_capabilities=None, runner_tags=None):
        tags = list(runner_tags or [])
        calls.append((kind, tags))
        # Use one local Pi Runner without the preferred docker tag.
        if kind == "local:pi" and not tags:
            return {"id": "runner:local:pi", "cli": "pi", "runnerId": "local"}
        return None

    ready = {"ok": True, "model": "", "detail": ""}
    with patch.object(ai_exec, "resolve_kind", fake_resolve_kind), \
         patch.object(agent_route_selection, "model_readiness", lambda *_a, **_k: ready):
        # Best-effort tries tagged runtimes before relaxing tags.
        calls.clear()
        r = agent_route_selection.resolve_sync(
            {}, "local:pi", "c1", runner_tags=["docker"], fallback_mode="best-effort")
        ok(r["ok"] and r["agent"]["runnerId"] == "local" and r["relaxedTags"] == ["docker"],
           "★best-effort：没有带 docker 的执行机 → 放宽标签落到本机，并标明 relaxedTags", r)
        ok(calls[0] == ("local:pi", ["docker"]) and ("local:pi", []) in calls
           and calls.index(("local:pi", [])) > max(i for i, c in enumerate(calls) if c[1] == ["docker"]),
           "先保标签换底座、再放宽标签（(标签,底座) 字典序）", calls)

        # Strict mode never relaxes required tags.
        calls.clear()
        r = agent_route_selection.resolve_sync(
            {}, "local:pi", "c1", runner_tags=["docker"], fallback_mode="strict")
        ok(not r["ok"] and all(c[1] == ["docker"] for c in calls),
           "★strict：标签硬门槛，找不到就失败，绝不放宽", (r["ok"], calls))

        # No tags retain ordinary selection behavior.
        calls.clear()
        r = agent_route_selection.resolve_sync({}, "local:pi", "c1", runner_tags=[])
        ok(r["ok"] and r["relaxedTags"] == [] and len(calls) == 1, "没写标签：原行为不变", calls)

        # Choose an available matching-tag executor before fallback.
        def tagged_world(ctx, kind, client_id="", prefer_runner="",
                         required_capabilities=None, runner_tags=None):
            if kind == "local:pi" and list(runner_tags or []) == ["docker"]:
                return {"id": "runner:trial:pi", "cli": "pi", "runnerId": "runner-trial"}
            return None
        with patch.object(ai_exec, "resolve_kind", tagged_world):
            r = agent_route_selection.resolve_sync(
                {}, "local:pi", "c1", runner_tags=["docker"], fallback_mode="best-effort")
            ok(r["ok"] and r["agent"]["runnerId"] == "runner-trial" and r["relaxedTags"] == [],
               "带标签的执行机在线：优先命中它，不放宽", r)

    print(f"route tags smoke: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
