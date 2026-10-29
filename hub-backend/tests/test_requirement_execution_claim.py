"""Assigned people can explicitly prepare idle work on their authenticated device."""
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

os.environ.setdefault("AUTH_SECRET", "isolated-execution-claim-test-key")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app import models, automation_models as am
from test_unified_requirements import UnifiedRequirementTests


class RequirementExecutionClaimTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = UnifiedRequirementTests.asyncSetUp
    asyncTearDown = UnifiedRequirementTests.asyncTearDown
    call = UnifiedRequirementTests.call

    async def test_pending_owner_start_serializes_with_assignee_claim_on_file_sqlite(self):
        import asyncio
        from pathlib import Path
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
        from app.db import Base
        from app.services import task_status

        previous = self.engine
        self.engine = create_async_engine("sqlite+aiosqlite:///" + (Path(self.temp.name) / "claim-race.db").as_posix())
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add(models.OrgUnit(id="company", name="Company"))
            for uid in ("owner", "peer"):
                session.add(models.User(id=uid, username=uid, org_id="company", is_active=True))
                session.add(models.Client(id=uid, user_ref=uid, auth_state="active"))
            session.add(models.Task(id="shared", title="Shared", owner_client_id="owner", created_by="owner",
                assignee_user_id="peer", status="todo", triage_stage="ready"))
            await session.commit()
        await previous.dispose()
        reached, resume = asyncio.Event(), asyncio.Event()
        original = task_status.engine_owns

        async def pause_owner(session, ids):
            reached.set()
            await resume.wait()
            return await original(session, ids)

        with patch.object(task_status, "engine_owns", pause_owner):
            starting = asyncio.create_task(self.call("PATCH", "tasks/shared", "owner", json={"status": "doing"}))
            await asyncio.wait_for(reached.wait(), 5)
            claiming = asyncio.create_task(self.call("POST", "tasks/shared/prepare-execution", "peer", json={}))
            try:
                await asyncio.wait_for(asyncio.shield(claiming), 2)
                blocked = False
            except asyncio.TimeoutError:
                blocked = True
            resume.set()
            started, claimed = await asyncio.gather(starting, claiming)
        self.assertTrue(blocked, "the claim must wait for the authenticated owner's pending write")
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(claimed.status_code, 409, claimed.text)
        async with self.sessions() as session:
            row = await session.get(models.Task, "shared")
            self.assertEqual((row.owner_client_id, row.status), ("owner", "doing"))

    async def test_claim_rejects_reassignment_or_execution_committed_after_initial_check(self):
        from app.services import tasks
        original = tasks.task_to_api_live
        for mutation in ("assignment", "routing", "dispatch", "execution"):
            await self.assign(status="todo", owner_client_id="owner")
            changed = False

            async def interleave(session, task):
                nonlocal changed
                result = await original(session, task)
                if not changed and task.id == "shared":
                    changed = True
                    async with self.sessions() as other:
                        if mutation == "assignment":
                            fresh = await other.get(models.Task, task.id)
                            fresh.assignee_user_id = "owner"
                            fresh.requirement_version = int(fresh.requirement_version or 1) + 1
                        elif mutation == "routing":
                            fresh = await other.get(models.Task, task.id)
                            fresh.work_routing = {"conversationTurn": {"state": "queued"}}
                        elif mutation == "dispatch":
                            from app.services import dispatch_attempts
                            await dispatch_attempts.start(other, task.id, "owner")
                        else:
                            other.add(am.ExecutionSession(task_id=task.id, ref="race", state="running"))
                        await other.commit()
                return result

            with patch.object(tasks, "task_to_api_live", interleave):
                result = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
            self.assertEqual(result.status_code, 409, (mutation, result.text))
            async with self.sessions() as session:
                self.assertEqual((await session.get(models.Task, "shared")).owner_client_id, "owner")
                row = await session.get(models.Task, "shared")
                row.work_routing = {}
                from sqlalchemy import delete
                await session.execute(delete(models.TaskEvent).where(models.TaskEvent.task_id == "shared"))
                await session.commit()

    async def test_workflow_lease_cannot_switch_to_a_new_owner_before_start(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        from app.services import workflow_runs
        await self.assign()
        for entry in ("start", "start_from_evidence"):
            await self.assign(owner_client_id="owner")
            async with self.sessions() as session:
                task = await session.get(models.Task, "shared")

                async def moved_during_lease(*args, **kwargs):
                    task.owner_client_id = "peer"
                    await session.commit()
                    return SimpleNamespace(id="lease")

                with patch.object(workflow_runs.resource_leases, "acquire", moved_during_lease), \
                     patch.object(workflow_runs.resource_leases, "release", AsyncMock()):
                    with self.assertRaisesRegex(ValueError, "执行归属已变化"):
                        if entry == "start":
                            await workflow_runs.start(session, task, SimpleNamespace(id="binding"), {})
                        else:
                            await workflow_runs.start_from_evidence(session, task, SimpleNamespace(id="binding"), {},
                                SimpleNamespace(id="previous-run"), "work")

    async def assign(self, **changes):
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.assignee_user_id = "peer"
            task.triage_stage = "ready"
            for key, value in changes.items():
                setattr(task, key, value)
            await session.commit()

    async def test_assignee_claim_preserves_requirement_and_grants_only_device_execution(self):
        await self.assign()
        before = (await self.call("GET", "tasks/shared", "peer")).json()
        self.assertTrue(before["readOnly"])
        self.assertTrue(before.get("canClaimExecution"))
        listed = next(row for row in (await self.call("GET", "tasks", "peer")).json()
                      if row["id"] == "shared")
        for key in ("readOnly", "myRoles", "canViewExecution", "canClaimExecution"):
            self.assertEqual(listed[key], before[key], key)
        self.assertIn("assignee", listed["myRoles"])
        from sqlalchemy.dialects import postgresql
        from sqlalchemy.ext.asyncio import AsyncSession
        from sqlalchemy.sql.dml import Update
        execute = AsyncSession.execute
        claim_statements = []

        async def inspect_statement(session, statement, *args, **kwargs):
            if isinstance(statement, Update) and statement.table.name == models.Task.__tablename__:
                claim_statements.append(str(statement.compile(dialect=postgresql.dialect())))
            return await execute(session, statement, *args, **kwargs)

        with patch.object(AsyncSession, "execute", inspect_statement):
            result = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len(claim_statements), 1)
        self.assertNotIn("work_routing", claim_statements[0], "PostgreSQL JSON has no equality operator")
        task = result.json()
        self.assertFalse(task["readOnly"])
        self.assertEqual(task["status"], "todo")
        self.assertEqual(task["createdBy"], "owner")
        self.assertEqual(task["assigneeUserId"], "peer")
        self.assertEqual(task["ownerClientId"], "peer")
        pushed = [call.args[1]["task"] for call in self.published.await_args_list
                  if call.args[0] == "peer" and call.args[1].get("type") == "task.updated"]
        self.assertEqual(len(pushed), 1)
        self.assertFalse(pushed[0]["readOnly"])
        self.assertIn("executor", pushed[0]["myRoles"])
        self.assertFalse(pushed[0]["canClaimExecution"])
        async with self.sessions() as session:
            row = await session.get(models.Task, "shared")
            self.assertEqual(row.owner_user_id, "peer")
        again = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
        self.assertEqual(again.status_code, 200, again.text)
        self.assertTrue((await self.call("GET", "tasks/shared", "owner")).json()["readOnly"])
        self.assertEqual((await self.call("POST", "tasks/shared/ai-dispatch", "owner", json={})).status_code, 404)
        async with self.sessions() as session:
            from sqlalchemy import select
            events = (await session.scalars(select(models.TaskEvent).where(models.TaskEvent.task_id == "shared", models.TaskEvent.kind == "claim"))).all()
            self.assertEqual(len(events), 1)
            row = await session.get(models.Task, "shared")
            self.assertEqual(row.owner_user_id, "peer")
            device = await session.get(models.Client, "peer")
            device.user_ref = "outsider"
            await session.commit()
            self.assertEqual(row.owner_user_id, "peer", "login changes must not transfer execution")
            from app.services import task_access
            self.assertFalse(task_access.is_owner(row, device))

    async def test_same_device_new_account_can_claim_only_its_explicit_assignment(self):
        from sqlalchemy import update
        await self.assign(owner_client_id="peer")
        async with self.sessions() as session:
            await session.execute(update(models.Task).where(models.Task.id == "shared")
                                  .values(owner_user_id="owner"))
            await session.commit()
        before = (await self.call("GET", "tasks/shared", "peer")).json()
        self.assertTrue(before["readOnly"])
        self.assertTrue(before["canClaimExecution"])
        claimed = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
        self.assertEqual(claimed.status_code, 200, claimed.text)
        self.assertFalse(claimed.json()["readOnly"])
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            self.assertEqual((task.owner_client_id, task.owner_user_id), ("peer", "peer"))

    async def test_same_device_new_account_cannot_inherit_other_assignment_or_conversation(self):
        from sqlalchemy import update
        for assignee, routing, status in (
                ("owner", {}, 403),
                ("peer", {"conversationTurn": {"state": "completed", "conversationId": "old"}}, 409)):
            await self.assign(owner_client_id="peer", assignee_user_id=assignee, work_routing=routing)
            async with self.sessions() as session:
                await session.execute(update(models.Task).where(models.Task.id == "shared")
                                      .values(owner_user_id="owner"))
                await session.commit()
            result = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
            self.assertEqual(result.status_code, status, result.text)
            async with self.sessions() as session:
                self.assertEqual((await session.get(models.Task, "shared")).owner_user_id, "owner")

    async def test_claim_rejects_device_account_switch_after_initial_authorization(self):
        from app.services import tasks
        await self.assign()
        original = tasks.task_to_api_live
        changed = False

        async def switch_account(session, task):
            nonlocal changed
            result = await original(session, task)
            if not changed:
                changed = True
                async with self.sessions() as other:
                    device = await other.get(models.Client, "peer")
                    device.user_ref = "outsider"
                    device.auth_version = int(device.auth_version or 0) + 1
                    await other.commit()
            return result

        with patch.object(tasks, "task_to_api_live", switch_account):
            result = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
        self.assertEqual(result.status_code, 409, result.text)
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            self.assertEqual((task.owner_client_id, task.owner_user_id), ("owner", "owner"))

    async def test_shared_viewer_and_creator_cannot_claim_someone_elses_assignment(self):
        await self.assign(assignee_user_id="outsider")
        self.assertFalse((await self.call("GET", "tasks/shared", "peer")).json().get("canClaimExecution", False))
        self.assertEqual((await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})).status_code, 403)
        await self.assign(owner_client_id="peer", assignee_user_id="peer")
        self.assertEqual((await self.call("POST", "tasks/shared/prepare-execution", "owner", json={})).status_code, 403)

    async def test_claim_rechecks_authoritative_stage_and_execution_facts(self):
        for changes in ({"triage_stage": "intake"}, {"triage_stage": "clarifying"},
                        {"status": "doing"}, {"status": "paused"}, {"status": "done"},
                        {"archived_at": datetime.now(timezone.utc)},
                        {"work_routing": {"conversationTurn": {"state": "queued"}}}):
            await self.assign(status="todo", archived_at=None, work_routing={})
            await self.assign(**changes)
            result = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
            self.assertEqual(result.status_code, 409, (changes, result.text))
            async with self.sessions() as session:
                self.assertEqual((await session.get(models.Task, "shared")).owner_client_id, "owner")

    async def test_claim_rejects_live_workflow_even_when_task_still_todo(self):
        await self.assign()
        async with self.sessions() as session:
            session.add(am.WorkflowRun(id="running", task_id="shared", plugin_id="fixture", plugin_version_id="fixture", state="waiting_human"))
            await session.commit()
        result = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
        self.assertEqual(result.status_code, 409, result.text)

    async def test_claim_rejects_execution_session_pending_review_and_historical_conversation(self):
        for case in ("execution", "review", "conversation"):
            tid = "claim-" + case
            async with self.sessions() as session:
                session.add(models.Task(id=tid, title=tid, owner_client_id="owner", created_by="owner",
                    assignee_user_id="peer", status="todo", triage_stage="ready",
                    work_routing={"conversationTurn": {"state": "completed", "conversationId": "old-chat"}} if case == "conversation" else {}))
                if case == "execution":
                    session.add(am.ExecutionSession(task_id=tid, ref=tid, state="preparing"))
                if case == "review":
                    session.add(am.ArtifactVersion(id=tid, task_id=tid, kind="files", seq=1, state="submitted", checksum="fixture"))
                    session.add(am.ApprovalRequest(id=tid, task_id=tid, artifact_version_id=tid,
                        action="review", status="pending"))
                await session.commit()
            result = await self.call("POST", "tasks/" + tid + "/prepare-execution", "peer", json={})
            self.assertEqual(result.status_code, 409, (case, result.text))

    async def test_ready_transition_is_explicit_before_claim_and_never_starts_execution(self):
        await self.assign(triage_stage="intake")
        before = (await self.call("GET", "tasks/shared", "peer")).json()
        self.assertFalse(before["canClaimExecution"])
        result = await self.call("PATCH", "tasks/shared", "peer", json={"triageStage": "ready", "requirementVersion": before["requirementVersion"]})
        self.assertEqual(result.status_code, 200, result.text)
        ready = (await self.call("GET", "tasks/shared", "peer")).json()
        self.assertEqual(ready["status"], "todo")
        self.assertEqual(ready["ownerClientId"], "owner")
        self.assertTrue(ready["canClaimExecution"])
        result = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["status"], "todo")

    async def test_claim_rejects_stale_assignment_and_inactive_account(self):
        await self.assign()
        self.assertTrue((await self.call("GET", "tasks/shared", "peer")).json().get("canClaimExecution"))
        await self.assign(assignee_user_id="owner")
        self.assertEqual((await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})).status_code, 403)
        await self.assign()
        async with self.sessions() as session:
            (await session.get(models.User, "peer")).is_active = False
            await session.commit()
        self.assertEqual((await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})).status_code, 403)
