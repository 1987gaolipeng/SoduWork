# -*- coding: utf-8 -*-
"""Current-device Agent dispatch regression without live data or real processes."""
from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
sys.path.insert(0, ".")

from app.services import ai_exec, ai_remote, runner_hub  # noqa: E402

ok = fail = 0


def chk(name, condition, detail=""):
    global ok, fail
    if condition:
        ok += 1
        print("  PASS ", name)
    else:
        fail += 1
        print("  FAIL ", name, (" :: " + str(detail)) if detail else "")


def fake_runner(client_id="device-me", *, mode="accepting", agents=None, tags=None):
    return SimpleNamespace(
        id="runner-" + client_id,
        client_id=client_id,
        org_id="org-1",
        host="PC-" + client_id,
        agents=list(agents if agents is not None else [
            {"key": "pi", "name": "Pi", "version": "1.0"}]),
        ready=True,
        inventory_ready=True,
        tags=list(tags if tags is not None else ["soduwork-client"]),
        capabilities={},
        dispatch_mode=mode,
        busy=0,
        connected_at=1,
        version="1.0",
        alive=lambda: True,
    )


def t_embedded_identity():
    embedded = fake_runner()
    shared_server = fake_runner("device-me", tags=["linux", "intranet"])
    shared_server.id = "runner-shared-server"
    real_online = runner_hub.online
    runner_hub.online = lambda: [shared_server, embedded]
    try:
        chk("same-client server is not treated as this computer",
            runner_hub.for_client("device-me") is embedded)
        runner_hub.online = lambda: [shared_server]
        chk("without an embedded Runner the client fails closed",
            runner_hub.for_client("device-me") is None)
    finally:
        runner_hub.online = real_online


def t_scope_and_roster():
    mine = fake_runner()
    captured = {}
    real_for_client = runner_hub.for_client
    real_can = runner_hub.can_dispatch
    real_list = ai_remote.list_assignees_sync
    real_provider_list = ai_exec._ai_local.list_assignees_sync

    def remote_list(cfg):
        captured.update(cfg)
        return {"agents": [{
            "id": "runner:runner-device-me:pi",
            "name": "我的电脑 · Pi",
            "type": "agent",
            "cli": "pi",
            "clientId": "device-me",
            "runnerId": "runner-device-me",
        }], "squads": []}

    def forbidden_local(_cfg):
        raise AssertionError("current-device mode must not list Hub-local Agents")

    runner_hub.for_client = lambda cid: mine if cid == "device-me" else None
    runner_hub.can_dispatch = lambda runner: runner is mine
    ai_remote.list_assignees_sync = remote_list
    ai_exec._ai_local.list_assignees_sync = forbidden_local
    try:
        ctx = ai_exec.with_client_runner_scope({"name": "local", "cfg": {}}, "device-me")
        roster = ai_exec.list_assignees_sync(ctx)
        chk("scope only contains the authenticated device",
            ctx["_runnerAllowedClients"] == ["device-me"]
            and ctx["_runnerAllowedOrgs"] == [], ctx)
        chk("Agent roster contains only this device",
            [x.get("clientId") for x in roster["agents"]] == ["device-me"], roster)
        default = ai_exec.default_assignee(ctx)
        chk("client default is a concrete online Runner seat",
            default == {"id": "runner:runner-device-me:pi", "type": "agent"}, default)
        chk("remote provider received device and exact Runner filters",
            captured.get("allowedClients") == ["device-me"]
            and captured.get("allowedOrgs") == []
            and captured.get("allowedRunners") == [mine.id], captured)
        chk("current device reports available only with its Runner",
            ai_exec.available(ctx))
        runner_hub.for_client = lambda _cid: None
        chk("no own Runner means unavailable, without Hub fallback",
            not ai_exec.available(ctx))
    finally:
        runner_hub.for_client = real_for_client
        runner_hub.can_dispatch = real_can
        ai_remote.list_assignees_sync = real_list
        ai_exec._ai_local.list_assignees_sync = real_provider_list


def t_runner_load_semantics():
    mine = fake_runner(agents=[
        {"key": "pi", "name": "Pi", "version": "1.0"},
        {"key": "codex", "name": "Codex", "version": "2.0"},
    ])
    mine.busy = 3
    real_dispatchable = runner_hub.dispatchable
    runner_hub.dispatchable = lambda: [mine]
    try:
        roster = ai_remote.list_assignees_sync({
            "allowedClients": ["device-me"], "allowedOrgs": [],
            "allowedRunners": [mine.id],
        })["agents"]
        chk("machine load is exposed separately from Agent seat state",
            len(roster) == 2
            and all(item.get("busy") is False for item in roster)
            and all(item.get("runnerBusy") == 3 for item in roster), roster)
    finally:
        runner_hub.dispatchable = real_dispatchable


def t_resolve_and_dispatch():
    mine = fake_runner()
    calls = {"peer_pick": 0, "dispatch": 0}
    real_for_client = runner_hub.for_client
    real_pick = runner_hub.pick_for
    real_resolve = ai_remote.resolve_assignee_sync
    real_dispatch = ai_remote.dispatch_sync
    real_supports = runner_hub.supports_capabilities

    def peer_pick(*_args, **_kwargs):
        calls["peer_pick"] += 1
        return fake_runner("device-peer")

    def resolve(_cfg, aid, _atype=""):
        return {
            "id": aid,
            "name": "我的电脑 · Pi",
            "type": "agent",
            "cli": "pi",
            "clientId": "device-me",
            "runnerId": mine.id,
        }

    def dispatch(_cfg, _task, _files=None, _assignee=None, _extra=None):
        calls["dispatch"] += 1
        return {"ok": True, "issueId": "job-1"}

    runner_hub.for_client = lambda cid: mine if cid == "device-me" else None
    runner_hub.pick_for = peer_pick
    runner_hub.supports_capabilities = lambda _runner, _required=None: True
    ai_remote.resolve_assignee_sync = resolve
    ai_remote.dispatch_sync = dispatch
    try:
        ctx = ai_exec.with_client_runner_scope({"name": "local", "cfg": {}}, "device-me")
        picked = ai_exec.resolve_kind(ctx, "local:pi", "device-me")
        chk("portable Agent kind resolves to this embedded Runner",
            picked and picked.get("runnerId") == mine.id, picked)
        chk("current-device routing never asks for a colleague Runner",
            calls["peer_pick"] == 0, calls)

        runner_hub.for_client = lambda _cid: None
        missing = ai_exec.resolve_kind(ctx, "local:pi", "device-me")
        chk("missing local Agent fails closed", missing is None, missing)
        chk("missing local Agent never falls back to a peer",
            calls["peer_pick"] == 0, calls)

        own = {
            "id": "runner:runner-device-me:pi",
            "type": "agent",
            "clientId": "device-me",
            "runnerId": mine.id,
        }
        same_client_server = {
            "id": "runner:runner-shared-server:pi",
            "type": "agent",
            "clientId": "device-me",
            "runnerId": "runner-shared-server",
        }
        peer = {
            "id": "runner:runner-device-peer:pi",
            "type": "agent",
            "clientId": "device-peer",
            "runnerId": "runner-device-peer",
        }
        blocked_local = ai_exec.dispatch_sync(
            ctx, SimpleNamespace(id="t1"), None,
            {"id": "local:pi", "type": "agent"}, {})
        blocked_server = ai_exec.dispatch_sync(
            ctx, SimpleNamespace(id="t1"), None, same_client_server, {})
        blocked_peer = ai_exec.dispatch_sync(
            ctx, SimpleNamespace(id="t1"), None, peer, {})
        accepted = ai_exec.dispatch_sync(
            ctx, SimpleNamespace(id="t1"), None, own, {})
        chk("Hub-local Agent cannot receive employee work",
            not blocked_local.get("ok"), blocked_local)
        chk("same-client shared server cannot receive employee work",
            not blocked_server.get("ok"), blocked_server)
        chk("a colleague device cannot receive employee work",
            not blocked_peer.get("ok"), blocked_peer)
        chk("this embedded Runner Agent can receive work",
            accepted.get("ok") and calls["dispatch"] == 1, (accepted, calls))
    finally:
        runner_hub.for_client = real_for_client
        runner_hub.pick_for = real_pick
        runner_hub.supports_capabilities = real_supports
        ai_remote.resolve_assignee_sync = real_resolve
        ai_remote.dispatch_sync = real_dispatch


def t_remote_final_guard():
    real_get = runner_hub.get
    real_call = runner_hub.call_sync
    calls = []
    runner_hub.call_sync = lambda *_args, **_kwargs: calls.append(True) or {"ok": True}
    try:
        runner_hub.get = lambda _rid: fake_runner(mode="paused")
        paused = ai_remote.dispatch_sync(
            {"allowedClients": ["device-me"], "allowedOrgs": [],
             "allowedRunners": ["runner-device-me"]},
            SimpleNamespace(id="t1"), None,
            {"id": "runner:runner-device-me:pi"}, {})
        chk("paused Runner is rejected at final adapter boundary",
            not paused.get("ok") and not calls, paused)

        shared = fake_runner("device-me", tags=["linux"])
        shared.id = "runner-shared-server"
        runner_hub.get = lambda _rid: shared
        blocked = ai_remote.dispatch_sync(
            {"allowedClients": ["device-me"], "allowedOrgs": [],
             "allowedRunners": ["runner-device-me"]},
            SimpleNamespace(id="t1"), None,
            {"id": "runner:runner-shared-server:pi"}, {})
        chk("same-client server is rejected by exact Runner filter",
            not blocked.get("ok") and not calls, blocked)

        runner_hub.get = lambda _rid: fake_runner("device-peer")
        peer = ai_remote.dispatch_sync(
            {"allowedClients": ["device-me"], "allowedOrgs": [],
             "allowedRunners": ["runner-device-me"]},
            SimpleNamespace(id="t1"), None,
            {"id": "runner:runner-device-peer:pi"}, {})
        chk("client mismatch is rejected at final adapter boundary",
            not peer.get("ok") and not calls, peer)

        runner_hub.get = lambda _rid: fake_runner(agents=[{"key": "pi"}])
        missing = ai_remote.dispatch_sync(
            {"allowedClients": ["device-me"], "allowedOrgs": [],
             "allowedRunners": ["runner-device-me"]},
            SimpleNamespace(id="t1"), None,
            {"id": "runner:runner-device-me:codex"}, {})
        chk("missing CLI is rejected before RPC",
            not missing.get("ok") and not calls, missing)
    finally:
        runner_hub.get = real_get
        runner_hub.call_sync = real_call


def t_entrypoint_contracts():
    root = Path(__file__).resolve().parent.parent
    read = lambda rel: (root / rel).read_text(encoding="utf-8")
    tasks_api = read("hub-backend/app/api/tasks.py")
    dispatch_service = read("hub-backend/app/services/task_dispatch.py")
    admin_api = read("hub-backend/app/api/admin.py")
    options = read("hub-backend/app/services/task_execution_options.py")
    readiness = read("hub-backend/app/services/plugin_route_readiness.py")
    workflow = read("hub-backend/app/services/workflow_engine.py")
    compose = read("client/components/panels/panels-compose-draft.js")
    add = read("client/components/panels/panels-add.js")

    chk("Agent directory and AI Team share current-device scope",
        tasks_api.count("with_client_runner_scope") >= 2)
    chk("client dispatch without a selected seat resolves the project default",
        "return await dispatch(tid, body, client, session)" in tasks_api
        and "ai_exec.resolve_default_sync" in dispatch_service
        and "task_assignment.project_route" in dispatch_service)
    chk("management dispatch stays on the task owner's device and default Agent",
        "session.get(Client, task.owner_client_id)" in admin_api
        and "return await dispatch(tid, {}, owner, session, actor=user)" in admin_api)
    chk("create-task options use current-device scope",
        "with_client_runner_scope(await ai_exec.load(session, force=True), client.id)" in options)
    chk("workflow preflight uses task owner's current device",
        "with_client_runner_scope(" in readiness
        and "task.owner_client_id" in readiness
        and "task_runner_clients" not in readiness)
    chk("dialogue creation does not optimistically mark running",
        "t.status = 'doing'" not in compose)
    chk("add-task window persists AI-bound tasks as todo",
        "status: go ? 'todo' : st" in add)
    chk("terminal workflow failure restores todo",
        '"todo", engine=True, why="run.failed"' in workflow)
    chk("old-client first dispatch failure restores todo",
        'why="首次 AI 安排执行失败"' in dispatch_service)


if __name__ == "__main__":
    t_embedded_identity()
    t_scope_and_roster()
    t_runner_load_semantics()
    t_resolve_and_dispatch()
    t_remote_final_guard()
    t_entrypoint_contracts()
    print()
    print("current-device dispatch smoke: PASS=%d FAIL=%d" % (ok, fail))
    raise SystemExit(1 if fail else 0)
