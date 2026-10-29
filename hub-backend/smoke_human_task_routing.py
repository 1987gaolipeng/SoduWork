# -*- coding: utf-8 -*-
"""Offline regression for human ownership -> own device -> portable Agent routing."""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
DB = BACKEND / ".smoke-human-task-routing.db"
for suffix in ("", "-shm", "-wal"):
    try:
        Path(str(DB) + suffix).unlink()
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.as_posix()
sys.path.insert(0, str(BACKEND))

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import (ai_exec, task_assignment, team,  # noqa: E402
                          workflow_runs)

passed = failed = 0


def check(name: str, condition: bool, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, "<<", str(detail)[:400])


async def main() -> None:
    await init_db()
    now = datetime.now(timezone.utc)
    async with SessionLocal() as session:
        org = models.OrgUnit(id="org-dev", name="Development", sort=0)
        manager = models.User(
            id="u-manager", username="manager", display_name="Manager",
            org_id=org.id, is_super=True, is_active=True)
        hu = models.User(
            id="u-hu", username="gengyong.hu", display_name="Hu Gengyong",
            org_id=org.id, is_active=True)
        peer = models.User(
            id="u-peer", username="peer", display_name="Peer",
            org_id=org.id, is_active=True)
        manager_box = models.Client(
            id="box-manager", name="Manager PC", user_ref=manager.id,
            auth_state="active", last_seen_at=now)
        hu_current = models.Client(
            id="box-hu-current", name="Hu current PC", user_ref=hu.id,
            auth_state="active", last_seen_at=now - timedelta(hours=2))
        hu_recent = models.Client(
            id="box-hu-recent", name="Hu other PC", user_ref=hu.id,
            auth_state="active", last_seen_at=now)
        hu_revoked = models.Client(
            id="box-hu-revoked", name="Hu revoked PC", user_ref=hu.id,
            auth_state="revoked", revoked_at=now, last_seen_at=now)
        peer_box = models.Client(
            id="box-peer", name="Peer PC", user_ref=peer.id,
            auth_state="active", last_seen_at=now)
        project = models.Project(
            id="project-soduwork", name="SoduWork", org_id=org.id,
            owner_user_id=hu.id, created_by=manager.id)
        profile = am.ProjectAutomationProfile(
            project_id=project.id, mode="validation", enabled=True,
            config={"executionClientId": hu_current.id,
                    "agentKind": "local:codex"},
            configured_by=manager.id)
        session.add_all([
            org, manager, hu, peer, manager_box, hu_current, hu_recent,
            hu_revoked, peer_box, project, profile,
        ])
        await session.commit()

        route = await task_assignment.project_route(session, project.id)
        check("project route keeps owner, device and Codex",
              route == {"clientId": hu_current.id,
                        "agentKind": "local:codex",
                        "ownerUserId": hu.id}, route)

        picked_hu = await task_assignment.pick_device(
            session, hu.id, project_id=project.id)
        check("project owner uses configured device, not most recently seen device",
              picked_hu is not None and picked_hu.id == hu_current.id,
              getattr(picked_hu, "id", None))

        picked_peer = await task_assignment.pick_device(
            session, peer.id, project_id=project.id)
        check("task transferred to another person uses that person's own device",
              picked_peer is not None and picked_peer.id == peer_box.id,
              getattr(picked_peer, "id", None))

        cross = await task_assignment.pick_device(
            session, hu.id, preferred_client_id=peer_box.id)
        check("explicit cross-person device choice fails closed", cross is None, cross)

        self_created = await team.create_team_task(
            session, manager_box,
            {"title": "Manager self task", "assigneeUserId": manager.id,
             "projectId": project.id})
        check("creator can assign a task to self",
              self_created.get("ok") and self_created.get("created") == 1
              and self_created["tasks"][0]["ownerClientId"] == manager_box.id,
              self_created)

        created = await team.create_team_task(
            session, manager_box,
            {"title": "SoduWork production issue", "assigneeUserId": hu.id,
             "projectId": project.id})
        check("assigning one person creates exactly one task even with two devices",
              created.get("ok") and created.get("created") == 1
              and created.get("assignees") == 1, created)
        task_id = created["tasks"][0]["id"]
        task = await session.get(models.Task, task_id)
        check("SoduWork task belongs to Hu and his configured current device",
              task is not None and task.assignee_user_id == hu.id
              and task.owner_client_id == hu_current.id,
              {"assignee": getattr(task, "assignee_user_id", None),
               "device": getattr(task, "owner_client_id", None)})

        moved = await team.reassign_team_task(
            session, manager_box, task_id, peer.id)
        task = await session.get(models.Task, task_id)
        check("reassignment moves ownership to the target person's device",
              moved.get("ok") and task.assignee_user_id == peer.id
              and task.owner_client_id == peer_box.id, moved)

        hu_current.auth_state = "revoked"
        hu_current.revoked_at = now
        await session.commit()
        blocked = await task_assignment.pick_device(
            session, hu.id, project_id=project.id)
        check("configured owner device becoming invalid does not drift to another PC",
              blocked is None, getattr(blocked, "id", None))

        layered = task_assignment.apply_project_agent_default(
            {}, route, "implement")
        resolved = workflow_runs.execution_route(
            {}, layered, {"execution": {"agentKind": "local:pi"}},
            "implement")
        check("all project workflows inherit the project Codex default",
              resolved["agentKind"] == "local:codex", resolved)

        explicit = task_assignment.apply_project_agent_default(
            {"nodeOverrides": {"review": {
                "execution": {"agentKind": "local:claude"}}}},
            route, "review")
        explicit_route = workflow_runs.execution_route(
            {}, explicit, {"execution": {"agentKind": "local:pi"}},
            "review")
        check("an explicit per-node project override remains authoritative",
              explicit_route["agentKind"] == "local:claude", explicit_route)

        original_default = ai_exec.default_assignee
        original_list = ai_exec.list_assignees_sync
        original_resolve = ai_exec.resolve_requested_sync
        calls = []
        ai_exec.default_assignee = lambda _ctx: {"id": "local:pi"}
        ai_exec.list_assignees_sync = lambda _ctx: {
            "agents": [{"id": "runner:other:pi"}], "squads": []}

        def fake_resolve(_ctx, requested, _atype, client_id, *_args):
            calls.append((requested, client_id))
            if requested == "local:codex" and client_id == hu_current.id:
                return {"id": "runner:hu:codex", "clientId": client_id}
            return None

        ai_exec.resolve_requested_sync = fake_resolve
        try:
            agent = ai_exec.resolve_default_sync(
                {}, hu_current.id, route["agentKind"], ["repository"])
        finally:
            ai_exec.default_assignee = original_default
            ai_exec.list_assignees_sync = original_list
            ai_exec.resolve_requested_sync = original_resolve
        check("omitted Agent selection resolves project Codex on Hu's device first",
              agent and agent["id"] == "runner:hu:codex"
              and agent["selection"]["source"] == "project"
              and calls[0] == ("local:codex", hu_current.id),
              {"agent": agent, "calls": calls})

    await engine.dispose()


try:
    asyncio.run(main())
finally:
    for suffix in ("", "-shm", "-wal"):
        try:
            Path(str(DB) + suffix).unlink()
        except FileNotFoundError:
            pass

print(f"\nhuman task routing smoke: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
