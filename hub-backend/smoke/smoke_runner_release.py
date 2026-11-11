# -*- coding: utf-8 -*-
"""Runner release and health administration smoke; no live service or DB."""
import asyncio
import os
import pathlib
import sys
import time

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///.smoke-runner-release.db")
sys.path.insert(0, ".")

from app.api import runner_ws  # noqa: E402
from app.services import runner_hub, runner_release, runner_sources  # noqa: E402
import runner_main  # noqa: E402

ok = fail = 0
lines = []


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        lines.append("  PASS  " + name)
    else:
        fail += 1
        lines.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


def test_release_facts():
    # Assert version invariants rather than fixed release literals that fail after routine version bumps.
    # Keep release checks stable so failures indicate actual behavior regressions.
    current = runner_release.RUNNER_VERSION
    chk("release.current", runner_release.release_state(current)["state"] == "current")
    chk("release.upgrade", runner_release.release_state("1.8.9")["upgradeAvailable"] is True)
    chk("release.numeric_semver",
        runner_release.release_state("99.0.0")["state"] == "ahead")
    chk("release.unknown", runner_release.release_state("")["state"] == "unknown")
    chk("release.labels_survive_source_encoding",
        runner_release.release_state(current)["label"] == "\u7248\u672c\u4e00\u81f4")

    embedded = {"embedded": True, "authState": "", "shared": False}
    managed = {"embedded": False, "authState": "active", "shared": True}
    legacy = {"embedded": False, "authState": "", "shared": True}
    chk("source.client", runner_release.install_source(embedded)["key"] == "client")
    chk("source.managed", runner_release.install_source(managed)["key"] == "managed")
    chk("source.legacy", runner_release.install_source(legacy)["key"] == "legacy")

    now = int(time.time())
    rows = [
        {"runnerId": "ready", "online": True, "accepting": True, "busy": 0,
         "mode": "accepting", "lastSeen": now,
         "version": runner_release.RUNNER_VERSION, **embedded},
        {"runnerId": "busy", "online": True, "accepting": True, "busy": 2,
         "mode": "accepting", "lastSeen": now, "version": "1.8.0", **managed},
        {"runnerId": "off", "online": False, "accepting": False, "busy": 0,
         "mode": "accepting", "lastSeen": now - 90, "version": "", **legacy},
    ]
    model = runner_release.enrich(rows, now=now)
    chk("summary.independent_counts",
        model["summary"]["online"] == 2
        and model["summary"]["accepting"] == 2
        and model["summary"]["busy"] == 1, model["summary"])
    chk("summary.attention",
        model["summary"]["upgradeNeeded"] == 1
        and model["summary"]["attention"] == 2, model["summary"])
    chk("health.busy_vs_offline",
        rows[1]["health"]["state"] == "busy"
        and rows[2]["health"]["state"] == "offline", rows)


async def test_admin_read_model():
    old_allowed = runner_ws._admin_allowed
    old_orgs = runner_ws._admin_orgs
    old_options = runner_ws._org_options
    old_list = runner_ws.runner_registry.list_nodes
    old_packages = runner_ws.runner_enroll.packages_info

    async def allowed(_session, _user):
        return {"client-a"}

    async def orgs(_session, _user):
        return {"org-a"}

    async def options(_session, org_scope):
        chk("admin.org_options_scoped", org_scope == {"org-a"}, org_scope)
        return [{"id": "org-a", "name": "Team A", "parentId": ""}]

    async def nodes(_session, scope, org_scope, *, include_personal_admin=False):
        chk("admin.scope_reused", scope == {"client-a"}, scope)
        chk("admin.org_scope_reused", org_scope == {"org-a"}, org_scope)
        chk("admin.personal_inventory_explicitly_requested", include_personal_admin is True)
        return [{
            "runnerId": "runner-admin", "online": True, "accepting": True,
            "busy": 0, "mode": "accepting", "lastSeen": int(time.time()),
            "version": runner_release.RUNNER_VERSION, "embedded": False,
            "shared": True, "authState": "active",
        }]

    runner_ws._admin_allowed = allowed
    runner_ws._admin_orgs = orgs
    runner_ws._org_options = options
    runner_ws.runner_registry.list_nodes = nodes
    runner_ws.runner_enroll.packages_info = lambda: {
        "windows": {"available": True, "stale": False},
    }
    try:
        result = await runner_ws.admin_runners(user=object(), session=object())
    finally:
        runner_ws._admin_allowed = old_allowed
        runner_ws._admin_orgs = old_orgs
        runner_ws._org_options = old_options
        runner_ws.runner_registry.list_nodes = old_list
        runner_ws.runner_enroll.packages_info = old_packages

    item = result["items"][0]
    chk("admin.read_model",
        item["health"]["state"] == "healthy"
        and item["installSource"]["key"] == "managed"
        and item["release"]["state"] == "current", item)
    chk("admin.summary_release_packages",
        result["summary"]["total"] == 1
        and result["release"]["targetVersion"] == runner_release.RUNNER_VERSION
        and result["packages"]["windows"]["available"]
        and result["organizations"] == [
            {"id": "org-a", "name": "Team A", "parentId": ""}], result)


class FakeProbeRunner:
    def __init__(self):
        self.calls = []

    def alive(self):
        return True

    async def call(self, op, data, timeout=0):
        self.calls.append((op, data, timeout))
        return {"ok": True, "data": {
            "runnerId": "runner-probe", "version": runner_release.RUNNER_VERSION,
            "busy": 0, "freeBytes": 1024,
        }}


async def test_admin_probe():
    old_admin_runner = runner_ws._admin_runner
    saved = dict(runner_hub._RUNNERS)

    async def allow(_session, _user, runner_id):
        return {"id": runner_id}

    fake = FakeProbeRunner()
    runner_ws._admin_runner = allow
    runner_hub._RUNNERS.clear()
    runner_hub._RUNNERS["runner-probe"] = fake
    try:
        result = await runner_ws.admin_runner_probe(
            "runner-probe", user=object(), session=object())
        chk("probe.real_rpc", fake.calls == [("runner.probe", {}, 12)], fake.calls)
        chk("probe.facts_and_latency",
            result["ok"] is True and result["data"]["freeBytes"] == 1024
            and result["latencyMs"] >= 0, result)

        runner_hub._RUNNERS.clear()
        offline = await runner_ws.admin_runner_probe(
            "runner-probe", user=object(), session=object())
        chk("probe.offline_fast_result",
            offline["ok"] is False and "\u79bb\u7ebf" in offline["error"], offline)
    finally:
        runner_ws._admin_runner = old_admin_runner
        runner_hub._RUNNERS.clear()
        runner_hub._RUNNERS.update(saved)


def test_contract():
    paths = {getattr(route, "path", "") for route in runner_ws.router.routes}
    chk("contract.admin_probe_route",
        "/api/v1/admin/runners/{runner_id}/probe" in paths, paths)
    chk("contract.single_version_constant",
        runner_main.RUNNER_VERSION == runner_release.RUNNER_VERSION)

    root = pathlib.Path(__file__).resolve().parent.parent.parent
    bridge = root / "skills/mcp-tools/scripts/mcp.mjs"
    chk("packaging.mcp_bridge_is_a_shared_skill_input",
        bridge.is_file() and bridge in runner_sources.skill_files(root)
        and bridge in runner_sources.build_inputs(root / "hub-backend", root))
    jsx = (root / "hub-frontend/src/screens/RunnerBoard.jsx").read_text(encoding="utf-8")
    css = (root / "hub-frontend/src/screens/runner-board.css").read_text(encoding="utf-8")
    api = (root / "hub-frontend/src/api.js").read_text(encoding="utf-8")
    chk("ui.summary_source_health_release",
        all(token in jsx for token in (
            "rb-summary", "\u6765\u6e90\u4e0e\u5f52\u5c5e",
            "healthOf", "releaseOf", "'attention'")), jsx[:300])
    chk("ui.real_inline_probe",
        "adminRunnerProbe" in api and "onClick={() => probe(r)}" in jsx)
    chk("ui.no_fake_upgrade_action",
        "adminRunnerUpgrade" not in api and "upgradeRunner(" not in jsx)
    chk("ui.compact_responsive_table",
        ".rb-summary" in css and ".rb-machine-id" in css and "@media(max-width:620px)" in css)
    chk("ui.organization_scope_management",
        all(token in jsx for token in (
            "organizations", "orgId", "服务范围", "待归属", "登记并发钥匙"))
        and ".rb-scope" in css and "公用资源" not in jsx)


async def main():
    test_release_facts()
    await test_admin_read_model()
    await test_admin_probe()
    test_contract()
    print("\n".join(lines))
    print("\n%d passed / %d failed" % (ok, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
