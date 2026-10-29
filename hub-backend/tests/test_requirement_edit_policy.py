"""Requirement definitions freeze after authoritative execution has begun."""
import unittest
from datetime import datetime, timedelta, timezone

from app import automation_models as am, models
from app.services import ai_exec
from test_unified_requirements import UnifiedRequirementTests


class RequirementEditPolicyTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = UnifiedRequirementTests.asyncSetUp
    asyncTearDown = UnifiedRequirementTests.asyncTearDown
    call = UnifiedRequirementTests.call

    async def test_started_and_historical_requirements_reject_definition_edits(self):
        now = datetime.now(timezone.utc)
        fixtures = {
            "doing": {"status": "doing"},
            "paused": {"status": "paused"},
            "done": {"status": "done"},
            "reverted": {"actual_start_at": now},
            "reviewed": {"reviewed_at": now},
            "session": {}, "workflow": {}, "dispatch": {}, "conversation": {}, "delivery": {},
        }
        async with self.sessions() as session:
            for key, extra in fixtures.items():
                values = {"status": "todo", **extra}
                session.add(models.Task(id="frozen-" + key, title="Original", note="Original details",
                    owner_client_id="owner", created_by="owner", requester_user_id="peer", **values))
            session.add(am.ExecutionSession(task_id="frozen-session", ref="edit-failed",
                                            state="failed", started_at=now))
            session.add(am.WorkflowRun(task_id="frozen-workflow", plugin_id="fixture",
                                       plugin_version_id="fixture", state="failed", started_at=now))
            session.add(models.TaskEvent(task_id="frozen-dispatch", kind=ai_exec.EV_DISPATCHED,
                                         at=now - timedelta(days=1), detail={"ref": "old-run"}))
            session.add(models.TaskEvent(task_id="frozen-conversation", kind="conversation.turn",
                                         detail={"state": "running", "turnId": "old-turn"}))
            session.add(am.ArtifactVersion(task_id="frozen-delivery", kind="delivery", seq=1,
                                           checksum="fixture", state="rejected"))
            await session.commit()
        for key in fixtures:
            path = "tasks/frozen-" + key
            with self.subTest(fact=key):
                detail = (await self.call("GET", path)).json()
                self.assertFalse(detail["canEditRequirement"])
                self.assertTrue(detail["hasExecutionHistory"])
                for who in ("owner", "peer"):
                    reply = await self.call("PATCH", path, who, json={
                        "title": "Changed", "tags": ["changed"], "requirementVersion": 1})
                    self.assertEqual(reply.status_code, 409, reply.text)
                saved = (await self.call("GET", path)).json()
                self.assertEqual(saved["title"], "Original")
                self.assertEqual(saved["requirementVersion"], 1)

    async def test_preflight_failure_is_editable_but_unconfirmed_dispatch_is_not(self):
        now = datetime.now(timezone.utc)
        async with self.sessions() as session:
            for key in ("failed", "pending"):
                session.add(models.Task(id="preflight-" + key, title="Original",
                    owner_client_id="owner", created_by="owner", status="todo"))
                session.add(models.TaskEvent(task_id="preflight-" + key,
                    kind=ai_exec.EV_DISPATCH_STARTED, at=now - timedelta(hours=1),
                    detail={"attemptId": key, "expectedRef": "attempt-" + key}))
            session.add(models.TaskEvent(task_id="preflight-failed", kind=ai_exec.EV_DISPATCH_FAILED,
                at=now, detail={"attemptId": "failed", "phase": "configuration"}))
            await session.commit()
        allowed = await self.call("PATCH", "tasks/preflight-failed", json={"title": "Clarified"})
        self.assertEqual(allowed.status_code, 200, allowed.text)
        self.assertTrue(allowed.json()["canEditRequirement"])
        pending = await self.call("PATCH", "tasks/preflight-pending", json={"title": "Changed"})
        self.assertEqual(pending.status_code, 409, pending.text)

    async def test_stale_edit_cannot_reopen_after_manual_execution_and_timestamp_reset(self):
        before = (await self.call("GET", "tasks/private")).json()
        self.assertTrue(before["canEditRequirement"])
        start = await self.call("PATCH", "tasks/private", json={"status": "doing"})
        self.assertEqual(start.status_code, 200, start.text)
        reset = await self.call("PATCH", "tasks/private", json={"status": "todo", "actualStart": None})
        self.assertEqual(reset.status_code, 200, reset.text)
        reply = await self.call("PATCH", "tasks/private", json={
            "title": "Stale draft", "requirementVersion": before["requirementVersion"]})
        self.assertEqual(reply.status_code, 409, reply.text)
        self.assertFalse((await self.call("GET", "tasks/private")).json()["canEditRequirement"])

    async def test_closed_unstarted_requirement_requires_restore_before_editing(self):
        async with self.sessions() as session:
            session.add_all([
                models.Task(id="cancelled-draft", title="Original", owner_client_id="owner",
                            created_by="owner", status="cancel"),
                models.Task(id="archived-draft", title="Original", owner_client_id="owner",
                            created_by="owner", status="todo", archived_at=datetime.now(timezone.utc)),
            ])
            await session.commit()
        for tid in ("cancelled-draft", "archived-draft"):
            detail = (await self.call("GET", "tasks/" + tid)).json()
            self.assertFalse(detail["canEditRequirement"])
            self.assertFalse(detail["hasExecutionHistory"])
            denied = await self.call("PATCH", "tasks/" + tid, json={"title": "Changed"})
            self.assertEqual(denied.status_code, 409, denied.text)
            restored = await self.call("PATCH", "tasks/" + tid, json={"archivedAt": None, "status": "todo"})
            self.assertEqual(restored.status_code, 200, restored.text)
            changed = await self.call("PATCH", "tasks/" + tid, json={"title": "Clarified"})
            self.assertEqual(changed.status_code, 200, changed.text)

    async def test_clearing_legacy_actual_timestamp_does_not_erase_execution_history(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "private")
            task.actual_start_at = datetime.now(timezone.utc)
            await session.commit()
        reset = await self.call("PATCH", "tasks/private", json={"actualStart": None})
        self.assertEqual(reset.status_code, 200, reset.text)
        changed = await self.call("PATCH", "tasks/private", json={"tags": ["Changed"]})
        self.assertEqual(changed.status_code, 409, changed.text)

    async def test_preparation_permissions_and_runtime_capabilities_remain_separate(self):
        denied = await self.call("PATCH", "tasks/shared", "peer", json={"title": "Viewer edit"})
        self.assertEqual(denied.status_code, 403, denied.text)
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.requester_user_id = "peer"
            await session.commit()
        for stage in ("intake", "clarifying", "ready"):
            changed = await self.call("PATCH", "tasks/shared", "peer", json={
                "triageStage": stage, "title": "Clarified " + stage, "tags": [stage]})
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertTrue(changed.json()["canEditRequirement"])
        started = await self.call("PATCH", "tasks/shared", json={"status": "doing"})
        self.assertEqual(started.status_code, 200, started.text)
        detail = (await self.call("GET", "tasks/shared", "peer")).json()
        self.assertFalse(detail["canEditRequirement"])
        for key in ("canManageRequirementMaterials", "canSubmitReview", "canManageRequirementAutomation"):
            self.assertTrue(detail[key])
        progress = await self.call("PATCH", "tasks/shared", json={"progress": [{"text": "Working"}]})
        self.assertEqual(progress.status_code, 200, progress.text)
        ready = await self.call("PATCH", "tasks/shared", json={"status": "todo", "triageStage": "ready"})
        self.assertEqual(ready.status_code, 200, ready.text)
        self.assertFalse(ready.json()["canEditRequirement"])

    async def test_http_aliases_and_offline_put_cannot_rewrite_executed_definitions(self):
        started = await self.call("PATCH", "tasks/private", json={"status": "doing"})
        self.assertEqual(started.status_code, 200, started.text)
        columns = ("title", "note", "acceptance_criteria", "assignee_user_id", "requester_user_id",
                   "requester_name", "requester_contact", "project_id", "repo_id", "domain_id",
                   "work_scenario_key", "shared_org_id", "requirement_content", "legacy_requirements")
        async with self.sessions() as session:
            task = await session.get(models.Task, "private")
            before = {key: getattr(task, key) for key in columns}
        aliases = {
            "acceptance_criteria": ["Changed"], "assignee_user_id": "peer", "requester_user_id": "peer",
            "requester_name": "Changed", "requester_contact": "Changed", "project_id": "Changed",
            "repo_id": "Changed", "domain_id": "Changed", "work_scenario_key": "Changed",
            "shared_org_id": "Changed", "requirement_content": {"title": "Changed", "note": "Changed"},
            "legacy_requirements": [{"id": "Changed", "title": "Changed"}],
        }
        ignored = await self.call("PATCH", "tasks/private", json=aliases)
        self.assertEqual(ignored.status_code, 200, ignored.text)
        replay = await self.call("PUT", "tasks/private", json={"title": "Offline draft", "note": "Changed"})
        self.assertEqual(replay.status_code, 409, replay.text)
        async with self.sessions() as session:
            task = await session.get(models.Task, "private")
            self.assertEqual({key: getattr(task, key) for key in columns}, before)

    async def test_pending_start_serializes_before_a_stale_shared_edit_on_file_sqlite(self):
        import asyncio
        from pathlib import Path
        from unittest.mock import patch
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
        from app.db import Base
        from app.services import task_status

        previous = self.engine
        self.engine = create_async_engine("sqlite+aiosqlite:///" + (Path(self.temp.name) / "edit-race.db").as_posix())
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add(models.OrgUnit(id="company", name="Company"))
            for uid in ("owner", "peer"):
                session.add(models.User(id=uid, username=uid, org_id="company", is_active=True))
                session.add(models.Client(id=uid, user_ref=uid, auth_state="active"))
            session.add(models.Task(id="shared", title="Original", owner_client_id="owner", created_by="owner",
                                    requester_user_id="peer", status="todo"))
            await session.commit()
        await previous.dispose()
        reached, resume = asyncio.Event(), asyncio.Event()
        original = task_status.engine_owns

        async def pause_start(session, ids):
            reached.set()
            await resume.wait()
            return await original(session, ids)

        with patch.object(task_status, "engine_owns", pause_start):
            starting = asyncio.create_task(self.call("PATCH", "tasks/shared", json={"status": "doing"}))
            await asyncio.wait_for(reached.wait(), 5)
            editing = asyncio.create_task(self.call("PATCH", "tasks/shared", "peer",
                                                   json={"title": "Stale draft", "requirementVersion": 1}))
            try:
                await asyncio.wait_for(asyncio.shield(editing), 1)
                blocked = False
            except asyncio.TimeoutError:
                blocked = True
            finally:
                resume.set()
            started, edited = await asyncio.gather(starting, editing)
        self.assertTrue(blocked, "The edit must wait for the in-flight start transaction")
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(edited.status_code, 409, edited.text)
        self.assertEqual((await self.call("GET", "tasks/shared")).json()["title"], "Original")
