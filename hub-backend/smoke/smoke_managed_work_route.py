"""Managed project delivery smoke tests without starting a real Agent process."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import os
import sys
import uuid


DB_PATH = os.path.abspath(".smoke-managed-work-route.db")
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB_PATH.replace("\\", "/")
sys.path.insert(0, ".")

from fastapi import HTTPException  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app import automation_models as am, models  # noqa: E402
from app.api import tasks as task_api  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import (  # noqa: E402
    delivery_truth,
    managed_work_route,
    plugin_route_readiness,
    task_status,
    tasks as task_service,
    workflow_runs,
)


passed = failed = 0


def check(name: str, condition, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, " << ", str(detail)[:300])


async def run() -> None:
    await init_db()
    async with SessionLocal() as session:
        org = models.OrgUnit(name="Managed delivery org")
        session.add(org)
        await session.flush()
        user = models.User(
            username="managed-owner", display_name="Managed owner",
            org_id=org.id, is_active=True,
        )
        session.add(user)
        await session.flush()
        client = models.Client(
            id="u-smoke-managed", name="Managed owner computer",
            user_ref=user.id, auth_state="active",
        )
        project = models.Project(
            name="Managed project", org_id=org.id, owner_user_id=user.id,
        )
        session.add_all([client, project])
        await session.flush()
        repo = models.Repo(
            project_id=project.id, org_id=org.id, name="managed-web",
            kind="frontend", git_url="https://example.invalid/managed-web.git",
            default_branch="main",
        )
        plugin = am.Plugin(
            org_id=org.id, key="managed-release", name="Managed release",
            enabled=True, created_by=user.id,
        )
        session.add_all([repo, plugin])
        await session.flush()
        version = am.PluginVersion(
            plugin_id=plugin.id, version="1.0.0", checksum="a" * 64,
            manifest={"entrypoints": {"task": True}},
            workflow={"nodes": []},
            capability_report={"hasWorkflow": True},
            trust_state="approved", visibility="organization", enabled=True,
            created_by=user.id,
        )
        session.add(version)
        await session.flush()
        binding = am.PluginBinding(
            plugin_id=plugin.id, version_id=version.id, org_id=org.id,
            project_id=project.id, config={}, secret_refs={}, enabled=True,
        )
        session.add(binding)
        await session.flush()
        session.add(am.ProjectAutomationProfile(
            project_id=project.id, binding_id=binding.id, enabled=True,
            configured_by=user.id,
        ))
        await session.commit()

        unmanaged_completion = models.Task(
            id=str(uuid.uuid4()), title="Legacy direct project task",
            owner_client_id=client.id, status="todo", origin="server",
            project_id=project.id, repo_id=repo.id,
            work_routing={"outputContract": {"kind": "repository-change"}},
        )
        session.add(unmanaged_completion)
        await session.commit()
        truth = await delivery_truth.evaluate(session, unmanaged_completion)
        check(
            "managed project cannot complete from a direct/manual path",
            truth["canComplete"] is False
            and any(x["code"] == "managed_workflow_required"
                    for x in truth["blockers"]),
            truth,
        )
        changed = await task_status.mark(
            session, unmanaged_completion, "done", why="managed smoke",
        )
        check(
            "task status guard rejects managed completion without workflow",
            changed is False and unmanaged_completion.status == "todo",
            unmanaged_completion.status,
        )

        item = await task_service.create_task(session, client.id, {
            "title": "Fix the production page",
            "kind": "bug",
            "note": "The page action cannot be used after release.",
            "acceptanceCriteria": ["The action works", "Release health check passes"],
            "status": "todo",
            "priority": "high",
            "source": "production feedback",
            "projectId": project.id,
            "repoId": repo.id,
        })

        start_calls = []
        original_context = plugin_route_readiness.context_for_task
        original_start = workflow_runs.start

        async def fake_context(_session, _task):
            return {}

        async def fake_start(run_session, run_task, run_binding, _inputs, **kwargs):
            start_calls.append({
                "taskId": run_task.id,
                "repoId": kwargs.get("repo_id"),
                "execution": dict(kwargs.get("execution") or {}),
            })
            row = am.WorkflowRun(
                task_id=run_task.id, plugin_id=run_binding.plugin_id,
                plugin_version_id=run_binding.version_id,
                binding_id=run_binding.id, state="running",
                input={}, output={}, context={"execution": kwargs.get("execution") or {}},
                initiated_by=str(kwargs.get("actor_id") or ""),
                started_at=datetime.now(timezone.utc),
            )
            run_session.add(row)
            await run_session.commit()
            await run_session.refresh(row)
            return row

        plugin_route_readiness.context_for_task = fake_context
        workflow_runs.start = fake_start
        try:
            task = await session.get(models.Task, item["id"])
            result = await managed_work_route.start(session, task, binding_id=binding.id,
                execution={"agentKind": "local:codex"}, repo_id=repo.id)
            delivery = {"task": item, "workflow": result}
        finally:
            workflow_runs.start = original_start
            plugin_route_readiness.context_for_task = original_context

        task = await session.get(models.Task, delivery["task"]["id"])
        runs = list((await session.execute(select(am.WorkflowRun).where(
            am.WorkflowRun.task_id == task.id
        ))).scalars().all())
        check(
            "unified requirement starts its own managed workflow",
            delivery["workflow"]["ok"] is True
            and task.repo_id == repo.id
            and len(runs) == 1
            and len(start_calls) == 1,
            {"delivery": delivery.get("workflow"), "runs": len(runs), "calls": start_calls},
        )
        check(
            "workflow receives portable substrate preference and repository",
            start_calls[0]["repoId"] == repo.id
            and start_calls[0]["execution"].get("agentKind") == "local:codex",
            start_calls,
        )

        result = await managed_work_route.start(session, task, binding_id=binding.id,
            execution={"agentKind": "local:codex"}, repo_id=repo.id)
        reused = {"reused": True, "task": item, "workflow": result}
        run_count = len(list((await session.execute(select(am.WorkflowRun).where(
            am.WorkflowRun.task_id == task.id
        ))).scalars().all()))
        check(
            "repeated create click reuses both task and workflow",
            reused["reused"] is True
            and reused["task"]["id"] == task.id
            and reused["workflow"]["reused"] is True
            and run_count == 1,
            reused,
        )

        runs[0].state = "succeeded"
        runs[0].finished_at = datetime.now(timezone.utc)
        await session.commit()
        completed = await task_status.mark(
            session, task, "done", engine=True, why="workflow succeeded",
        )
        await session.commit()
        linked = await session.get(models.Task, item["id"])
        check(
            "requirement is delivered only after authoritative workflow success",
            completed is True and linked.status == "done" and linked.actual_end_at,
            {"task": task.status, "item": linked.status},
        )

        foreign_project = models.Project(
            name="Foreign project", org_id=org.id, owner_user_id=user.id,
        )
        session.add(foreign_project)
        await session.flush()
        foreign_repo = models.Repo(
            project_id=foreign_project.id, org_id=org.id, name="foreign",
            git_url="https://example.invalid/foreign.git",
        )
        session.add(foreign_repo)
        await session.commit()
        try:
            await managed_work_route.prepare(
                session, task, binding_id=binding.id, repo_id=foreign_repo.id,
            )
        except managed_work_route.ManagedWorkflowError:
            mismatch_rejected = True
        else:
            mismatch_rejected = False
        check("repository from another project is rejected", mismatch_rejected)

        blocked_task = models.Task(
            id=str(uuid.uuid4()), title="API fail closed",
            owner_client_id=client.id, status="todo", origin="server",
            project_id=project.id, repo_id=repo.id,
            work_routing={"outputContract": {"kind": "repository-change"}},
        )
        session.add(blocked_task)
        await session.commit()
        original_route_start = managed_work_route.start

        async def blocked_start(*_args, **_kwargs):
            raise managed_work_route.ManagedWorkflowError("readiness blocked")

        managed_work_route.start = blocked_start
        try:
            try:
                await task_api.ai_dispatch_task(
                    blocked_task.id,
                    {"assigneeId": "runner:any:codex", "assigneeType": "agent"},
                    client,
                    session,
                )
            except HTTPException as exc:
                api_rejected = exc.status_code == 409
            else:
                api_rejected = False
        finally:
            managed_work_route.start = original_route_start
        direct_sessions = list((await session.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.task_id == blocked_task.id
        ))).scalars().all())
        check(
            "managed dispatch failure never falls back to direct Agent execution",
            api_rejected and not direct_sessions,
            {"apiRejected": api_rejected, "directSessions": len(direct_sessions)},
        )


async def main() -> None:
    try:
        await run()
    finally:
        await engine.dispose()
    print(f"\nmanaged work route smoke: {passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    finally:
        if os.path.exists(DB_PATH):
            os.remove(DB_PATH)
