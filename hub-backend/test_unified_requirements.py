"""Real HTTP/SQLite tests for the unified requirement and execution boundary."""
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models
from app.api import tasks, attachments, retired_endpoints
from app.db import Base, get_session
from app.deps import current_client
from app.services import device_auth, org_memory, task_access, task_requirements, task_status, task_notifications
from app.memory_record_models import MemoryRecord
from app import automation_models, library_models, session_memory_models, conversation_handoff_models
from tests.sqlite_schema import create_fresh_sqlite_schema


class UnifiedRequirementTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-requirements-test-")
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await create_fresh_sqlite_schema(connection, Base.metadata)
        self.clients = {}
        async with self.sessions() as session:
            session.add_all([models.OrgUnit(id="company", name="Company"), models.OrgUnit(id="other", name="Other")])
            for uid, oid in (("owner", "company"), ("peer", "company"), ("outsider", "other")):
                session.add(models.User(id=uid, username=uid, org_id=oid, is_active=True))
                self.clients[uid] = models.Client(id=uid, user_ref=uid, auth_state="active")
                session.add(self.clients[uid])
            session.add_all([
                models.Task(id="private", title="Private", note="private note", owner_client_id="owner", created_by="owner"),
                models.Task(id="shared", title="Shared", note="Public requirement", owner_client_id="owner", created_by="owner",
                            shared_org_id="company", status="todo", result="private result", work_routing={"secret": "private route"}),
                models.Task(id="legacy", title="Private execution title", note="private instructions", owner_client_id="owner", created_by="owner",
                            shared_org_id="company", requirement_content={"title": "Public original", "note": "Public background"}),
                models.Attachment(id="input", task_id="shared", filename="public.md", uploaded_by="owner", role="input",
                                  evidence_meta={"kind": "requirement_input"}),
                models.Attachment(id="output", task_id="shared", filename="private-output.md", uploaded_by="owner", role="output"),
            ])
            await session.commit()
        self.app = app = FastAPI()
        for router in (tasks.router, attachments.router, retired_endpoints.router):
            app.include_router(router)
        async def identity(request: __import__('fastapi').Request):
            return self.clients[request.headers.get("X-Test-Identity", "owner")]
        async def db():
            async with self.sessions() as session:
                yield session
        app.dependency_overrides[current_client] = identity
        app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture")
        self.publish = patch("app.realtime.hub.publish", new_callable=AsyncMock)
        self.published = self.publish.start()

    async def asyncTearDown(self):
        self.publish.stop()
        await self.http.aclose()
        await self.engine.dispose()
        self.temp.cleanup()

    async def call(self, method, path, who="owner", **kwargs):
        headers = {"X-Test-Identity": who}
        # Anonymous policy fixtures override current_client and must not receive fabricated user sessions.
        if self.clients[who].user_ref:
            headers["Authorization"] = "Device " + device_auth.issue_session(self.clients[who])[0]
        return await self.http.request(method, "/api/v1/" + path, headers=headers, **kwargs)

    async def test_shared_list_and_detail_are_safe_projections(self):
        response = await self.call("GET", "tasks", "peer")
        self.assertEqual(response.status_code, 200, response.text)
        rows = {row["id"]: row for row in response.json()}
        self.assertEqual(set(rows), {"shared", "legacy"})
        self.assertNotIn("workRouting", rows["shared"])
        self.assertNotIn("result", rows["shared"])
        self.assertFalse(rows["shared"]["canViewExecution"])
        self.assertTrue(rows["shared"]["readOnly"])
        detail = (await self.call("GET", "tasks/legacy", "peer")).json()
        self.assertEqual(detail["note"], "Public background")
        self.assertNotIn("private", str(detail).lower())
        self.assertEqual((await self.call("GET", "tasks/shared", "outsider")).status_code, 404)
        self.assertEqual((await self.call("GET", "tasks/private", "peer")).status_code, 404)

    async def test_company_reader_cannot_open_execution_or_comments(self):
        for tail in ("events", "comments", "ai-session"):
            response = await self.call("GET", "tasks/shared/" + tail, "peer")
            self.assertEqual(response.status_code, 404, response.text)
        response = await self.call("POST", "tasks/shared/ai-dispatch", "peer", json={})
        self.assertEqual(response.status_code, 404, response.text)

    async def test_only_public_requirement_input_is_visible(self):
        rows = (await self.call("GET", "tasks/shared/attachments", "peer")).json()
        self.assertEqual([row["id"] for row in rows], ["input"])
        self.assertEqual((await self.call("POST", "attachments/output/access", "peer")).status_code, 404)
        self.assertEqual((await self.call("POST", "attachments/input/access", "peer")).status_code, 200)

    async def test_upload_requires_explicit_public_purpose_and_keeps_other_inputs_private(self):
        with patch("app.services.storage.put", return_value="local"):
            private = await self.call("POST", "tasks/shared/attachments",
                files={"file": ("private.md", b"Private instructions", "text/markdown")})
            self.assertEqual(private.status_code, 200, private.text)
            blocked = await self.call("POST", "tasks/shared/attachments", "peer",
                files={"file": ("source.md", b"Public source", "text/markdown")})
            self.assertEqual(blocked.status_code, 403, blocked.text)
            blocked_public = await self.call("POST", "tasks/shared/attachments", "peer",
                data={"purpose": "requirement_input"},
                files={"file": ("forbidden.md", b"Not an editor", "text/markdown")})
            self.assertEqual(blocked_public.status_code, 403, blocked_public.text)
            public = await self.call("POST", "tasks/shared/attachments", "owner",
                data={"purpose": "requirement_input", "field": "acceptance", "criterionText": "Acceptance"},
                files={"file": ("source.md", b"Public source", "text/markdown")})
            self.assertEqual(public.status_code, 200, public.text)
        rows = (await self.call("GET", "tasks/shared/attachments", "peer")).json()
        self.assertIn(public.json()["id"], [row["id"] for row in rows])
        self.assertNotIn(private.json()["id"], [row["id"] for row in rows])

    async def test_shared_events_are_redacted_and_scope_revocation_removes_cached_card(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            await task_access.publish_task(session, task, "task.updated")
        events = {call.args[0]: call.args[1] for call in self.published.await_args_list}
        self.assertIn("result", events["owner"]["task"])
        self.assertNotIn("result", events["peer"]["task"])
        self.assertNotIn("workRouting", events["peer"]["task"])
        self.assertNotIn("outsider", events)
        self.published.reset_mock()
        result = await self.call("PATCH", "tasks/shared", json={"visibility": "related"})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(self.published.await_count, 0)
        self.assertTrue(await task_notifications.run_once(self.sessions))
        events = {call.args[0]: call.args[1] for call in self.published.await_args_list}
        self.assertEqual(events["peer"], {"type": "task.deleted", "id": "shared"})
        self.assertEqual((await self.call("GET", "tasks/shared", "peer")).status_code, 404)

    async def test_shared_edit_retains_live_ai_and_applies_each_viewers_acl(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.status = "doing"
            task.requester_user_id = "peer"
            session.add(models.User(id="observer", username="observer", org_id="company", is_active=True))
            self.clients["observer"] = models.Client(id="observer", user_ref="observer", auth_state="active")
            session.add(self.clients["observer"])
            session.add(models.AiSchedule(id="shared-schedule", title="Follow up", owner_client_id="peer"))
            session.add(models.TaskEvent(task_id=task.id, kind="ai.dispatched",
                detail={"ref": "isolated:shared-edit", "assigneeName": "Pi"}))
            await session.commit()

        response = await self.call("PATCH", "tasks/shared", "peer",
            json={"automationScheduleId": "shared-schedule", "requirementVersion": 1})
        self.assertEqual(response.status_code, 200, response.text)
        saved = response.json()
        self.assertTrue(saved["projectionPending"])
        self.assertNotIn("ai", saved, "save does not await the complete live projection")
        self.assertEqual(saved["automationScheduleId"], "shared-schedule")
        self.assertTrue(saved["readOnly"])
        self.assertTrue(saved["canViewExecution"])
        self.assertEqual(self.published.await_count, 0)
        current = (await self.call("GET", "tasks/shared", "peer")).json()
        expected_ai = {"state": "running", "name": "Pi"}
        self.assertEqual(current["ai"], expected_ai)
        self.assertEqual(current["automationScheduleId"], "shared-schedule")
        self.assertTrue(current["readOnly"])
        self.assertTrue(current["canViewExecution"])
        self.assertTrue(await task_notifications.run_once(self.sessions))
        events = {call.args[0]: call.args[1] for call in self.published.await_args_list
                  if call.args[1].get("type") == "task.updated"}
        self.assertEqual(set(events), {"owner", "peer", "observer"})
        for recipient in ("owner", "peer"):
            self.assertEqual(events[recipient]["task"]["ai"], expected_ai)
            self.assertEqual(events[recipient]["task"]["automationScheduleId"], "shared-schedule")
        observer = events["observer"]["task"]
        self.assertFalse(observer["canViewExecution"])
        for field in ("ai", "result", "workRouting"):
            self.assertNotIn(field, observer)
        refreshed = (await self.call("GET", "tasks/shared", "peer")).json()
        self.assertEqual(refreshed["ai"], current["ai"])

    async def test_creation_default_private_and_explicit_shared(self):
        for extra, expected in (({}, "related"), ({"visibility": "organization", "triageStage": "intake"}, "organization")):
            result = await self.call("POST", "tasks", json={"title": "Created requirement", **extra})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["visibility"], expected)
            self.assertEqual(result.json()["requirementStage"], extra.get("triageStage", "ready"))

    async def test_preparation_version_conflict_and_forbidden_execution_fields(self):
        blocked = await self.call("PATCH", "tasks/shared", "peer", json={"triageStage": "clarifying", "requirementVersion": 1})
        self.assertEqual(blocked.status_code, 403, blocked.text)
        result = await self.call("PATCH", "tasks/shared", "owner", json={"triageStage": "clarifying", "requirementVersion": 1})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["requirementStage"], "clarifying")
        stale = await self.call("PATCH", "tasks/shared", "owner", json={"note": "lost edit", "requirementVersion": 1})
        self.assertEqual(stale.status_code, 409)
        forbidden = await self.call("PATCH", "tasks/shared", "peer", json={"status": "done"})
        self.assertEqual(forbidden.status_code, 403)
        scope = await self.call("PATCH", "tasks/shared", "peer", json={"visibility": "related"})
        self.assertEqual(scope.status_code, 403)
        escalation = await self.call("PATCH", "tasks/shared", "peer", json={"requesterUserId": "peer"})
        self.assertEqual(escalation.status_code, 403)
        self.assertEqual((await self.call("GET", "tasks/shared/events", "peer")).status_code, 404)

    async def test_active_execution_cannot_be_archived_or_moved(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.status = "doing"
            task.work_routing = {"conversationTurn": {"state": "running"}}
            await session.commit()
        for body in ({"triageStage": "intake"}, {"archivedAt": 1234567890000}):
            response = await self.call("PATCH", "tasks/shared", json=body)
            self.assertEqual(response.status_code, 409, response.text)

    async def test_delete_rejects_running_and_queued_tasks_without_losing_records(self):
        for status, routing in (("doing", {"conversationTurn": {"state": "running"}}),
                                ("todo", {"conversationTurn": {"state": "queued"}})):
            async with self.sessions() as session:
                task = await session.get(models.Task, "shared")
                task.status, task.work_routing = status, routing
                await session.commit()
            response = await self.call("DELETE", "tasks/shared")
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual((await self.call("GET", "tasks/shared")).status_code, 200)

    async def test_stopped_rework_stays_protected_until_returned_to_ready(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.status = "doing"
            task.work_routing = {"reworkPending": {"feedback": "继续修正"}}
            session.add(automation_models.ExecutionSession(id="live", task_id="shared", ref="test-live", state="running"))
            await session.commit()
        self.assertEqual((await self.call("DELETE", "tasks/shared")).status_code, 409)
        async with self.sessions() as session:
            execution = await session.get(automation_models.ExecutionSession, "live")
            execution.state = "completed"
            await session.commit()
        response = await self.call("DELETE", "tasks/shared")
        self.assertEqual(response.status_code, 409, response.text)
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.status = "todo"
            await session.commit()
        response = await self.call("DELETE", "tasks/shared")
        self.assertEqual(response.status_code, 200, response.text)

    async def test_local_requirements_can_be_deleted_directly_or_after_restore(self):
        for tid, archived, restore_before_delete in (
            ("private", False, False),
            ("legacy", True, False),
            ("shared", True, True),
        ):
            if archived:
                response = await self.call("PATCH", "tasks/" + tid, json={"archivedAt": 1234567890000})
                self.assertEqual(response.status_code, 200, response.text)
            denied = await self.call("DELETE", "tasks/" + tid, "peer")
            self.assertEqual(denied.status_code, 404 if tid == "private" else 403)
            if restore_before_delete:
                restored = await self.call("PATCH", "tasks/" + tid, json={"archivedAt": None})
                self.assertEqual(restored.status_code, 200, restored.text)
            response = await self.call("DELETE", "tasks/" + tid)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual((await self.call("GET", "tasks/" + tid)).status_code, 404)

    async def test_submit_review_creates_authoritative_pending_review_stage(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.status = "doing"
            await session.commit()
        from types import SimpleNamespace
        artifact = SimpleNamespace(id="artifact-review")
        request = SimpleNamespace(id="request-review")
        with patch("app.services.release_control.ensure_current_output",
                   new_callable=AsyncMock, return_value=(artifact, False)) as ensure_output, \
             patch("app.services.release_control.ensure_request",
                   new_callable=AsyncMock, return_value=request) as ensure_request, \
             patch("app.services.release_control.request_api", return_value={"id": request.id}), \
             patch("app.services.tasks.task_to_api_live", new_callable=AsyncMock,
                   return_value={"id": "shared", "status": "doing", "requirementStage": "reviewing"}), \
             patch("app.services.task_access.publish_task", new_callable=AsyncMock):
            response = await self.call("POST", "tasks/shared/submit-review", json={"note": "已完成自检"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["request"], {"id": "request-review"})
        self.assertEqual(response.json()["task"]["requirementStage"], "reviewing")
        ensure_output.assert_awaited_once()
        ensure_request.assert_awaited_once_with(
            ensure_output.await_args.args[0], ensure_output.await_args.args[1], artifact, "review")

    async def test_submit_review_rejects_non_running_requirement(self):
        response = await self.call("POST", "tasks/shared/submit-review", json={})
        self.assertEqual(response.status_code, 409, response.text)

    async def test_archive_preserves_completed_delivery_and_can_restore(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.status = "done"
            task.actual_end_at = datetime.now(timezone.utc)
            task.reviewed_at = task.actual_end_at
            await session.commit()
        response = await self.call("PATCH", "tasks/shared", json={"archivedAt": 1234567890000})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "done")
        self.assertEqual(response.json()["requirementStage"], "closed")
        response = await self.call("PATCH", "tasks/shared", json={"archivedAt": None})
        self.assertEqual(response.json()["requirementStage"], "delivered")

    async def test_archived_requirement_cannot_enter_any_executor_until_restored(self):
        from app.services import ai_exec, agent_runner, conversation_turns, workflow_runs
        response = await self.call("PATCH", "tasks/shared", json={"archivedAt": 1234567890000})
        self.assertEqual(response.status_code, 200, response.text)
        for path, body in (("ai-dispatch", {}), ("conversation-turn", {
                "action": "prepare", "turnId": "test-turn", "conversationId": "test-chat"})):
            blocked = await self.call("POST", "tasks/shared/" + path, json=body)
            self.assertEqual(blocked.status_code, 409, blocked.text)
            self.assertIn("恢复", blocked.text)
        status = await self.call("PATCH", "tasks/shared", json={"status": "doing"})
        self.assertEqual(status.json()["statusTransition"]["code"], "requirement_archived")
        self.assertEqual(status.json()["status"], "todo")
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            self.assertFalse(ai_exec.dispatch_sync({}, task)["ok"])
            for invoke in (
                lambda: agent_runner.start(session, task, "tester"),
                lambda: workflow_runs.start(session, task, None, {}),
                lambda: workflow_runs.start_from_evidence(session, task, None, {}, None, "node"),
            ):
                with self.assertRaisesRegex(ValueError, "恢复"):
                    await invoke()
        restored = await self.call("PATCH", "tasks/shared", json={"archivedAt": None})
        self.assertEqual(restored.status_code, 200, restored.text)
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            conversation_turns.ensure_available(task)
            task.status = "cancel"
            # The archive guard must not change preexisting cancelled-task retry semantics.
            task_requirements.ensure_executable(task)

    async def test_waiting_conversation_cannot_be_archived(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.work_routing = {"conversationTurn": {"state": "waiting"}}
            await session.commit()
        response = await self.call("PATCH", "tasks/shared", json={"archivedAt": 1234567890000})
        self.assertEqual(response.status_code, 409, response.text)

    async def test_shared_memory_excludes_private_execution_and_reopening_removes_fact(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "legacy")
            task.status = "done"
            task.actual_end_at = datetime.now(timezone.utc)
            await session.flush()
            memory = await org_memory.refresh(session, "company")
            self.assertIn("Public background", memory.summary)
            self.assertNotIn("private instructions", memory.summary)
            await task_status.mark(session, task, "todo")
            await session.commit()
            self.assertNotIn("Public background", memory.summary)

    async def test_retired_endpoints_fail_explicitly_without_new_task(self):
        for method, path in (("GET", "work-items"), ("POST", "work-items/delivery-task"), ("PATCH", "work-items/old")):
            result = await self.call(method, path, json={})
            self.assertEqual(result.status_code, 410, result.text)

    def test_six_swimlane_mapping(self):
        from types import SimpleNamespace
        for status, triage, archived, expected in (
            ("todo", "intake", None, "intake"), ("todo", "clarifying", None, "clarifying"),
            ("todo", "ready", None, "ready"), ("doing", "ready", None, "delivering"),
            ("done", "ready", None, "delivered"), ("cancel", "ready", None, "closed"),
            ("done", "ready", datetime.now(), "closed")):
            self.assertEqual(task_requirements.stage(SimpleNamespace(status=status, triage_stage=triage, archived_at=archived)), expected)


if __name__ == "__main__":
    unittest.main()
