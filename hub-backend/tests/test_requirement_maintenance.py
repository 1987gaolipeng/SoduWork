"""Real HTTP/database checks for requirement maintenance and lifecycle locks."""
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-requirement-maintenance-test-key")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app import automation_models as am, models
from app.services import tasks as service
from test_unified_requirements import UnifiedRequirementTests


class RequirementMaintenanceTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = UnifiedRequirementTests.asyncSetUp
    asyncTearDown = UnifiedRequirementTests.asyncTearDown
    call = UnifiedRequirementTests.call

    async def test_archive_delete_require_allowed_board_stage_even_without_live_execution(self):
        now = datetime.now(timezone.utc)
        cases = (
            ("intake", "todo", "intake", None, None, True),
            ("clarifying", "todo", "clarifying", None, None, True),
            ("ready", "todo", "ready", None, None, True),
            ("delivered", "done", "ready", now, None, True),
            ("stopped", "doing", "ready", None, None, False),
            ("paused", "paused", "ready", None, None, False),
            ("submitted", "done", "ready", None, None, False),
            ("pending-review", "todo", "ready", None, None, False),
            ("cancelled", "cancel", "ready", None, None, False),
            ("archived", "todo", "ready", None, now, False),
        )
        async with self.sessions() as session:
            for name, status, triage, reviewed, archived, _allowed in cases:
                for action in ("archive", "delete"):
                    tid = name + "-" + action
                    session.add(models.Task(id=tid, title=tid, status=status, triage_stage=triage,
                                            owner_client_id="owner", created_by="owner",
                                            reviewed_at=reviewed, archived_at=archived))
                    if name == "pending-review":
                        session.add(am.ArtifactVersion(id=tid, task_id=tid, kind="files", seq=1,
                                                       state="candidate", checksum="fixture"))
                        session.add(am.ApprovalRequest(id=tid, task_id=tid, action="review",
                                                       artifact_version_id=tid, status="pending"))
            await session.commit()
        for name, _status, _triage, _reviewed, _archived, allowed in cases:
            for action in ("archive", "delete"):
                expected = allowed or (action == "delete" and name in {"archived", "cancelled"})
                tid = name + "-" + action
                with self.subTest(stage=name, action=action):
                    response = await self.call("PATCH" if action == "archive" else "DELETE",
                                               "tasks/" + tid,
                                               **({"json": {"archivedAt": 1}} if action == "archive" else {}))
                    self.assertEqual(response.status_code, 200 if expected else 409, response.text)
                    if not expected:
                        self.assertIn("收集箱", response.text)
                        async with self.sessions() as session:
                            task = await session.get(models.Task, tid)
                            self.assertIsNotNone(task)
                            self.assertEqual(bool(task.archived_at), name == "archived")
        restored = await self.call("PATCH", "tasks/archived-archive", json={"archivedAt": None})
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual((await self.call("DELETE", "tasks/archived-archive")).status_code, 200)

    async def test_latest_review_on_same_delivery_controls_stage_and_destructive_operations(self):
        now = datetime.now(timezone.utc)
        for old, latest, allowed in (("cancelled", "pending", False),
                                     ("approved", "pending", False),
                                     ("pending", "rejected", True)):
            for action in ("archive", "delete"):
                tid = old + "-" + latest + "-" + action
                async with self.sessions() as session:
                    session.add(models.Task(id=tid, title=tid, status="todo", triage_stage="ready",
                                            owner_client_id="owner", created_by="owner"))
                    session.add(am.ArtifactVersion(id=tid, task_id=tid, kind="files", seq=1,
                                                   state="candidate", checksum="fixture"))
                    session.add_all([
                        am.ApprovalRequest(id=tid + "-old", task_id=tid, action="review",
                                           artifact_version_id=tid, status=old,
                                           created_at=now - timedelta(minutes=1)),
                        am.ApprovalRequest(id=tid + "-new", task_id=tid, action="review",
                                           artifact_version_id=tid, status=latest, created_at=now),
                    ])
                    await session.commit()
                with self.subTest(old=old, latest=latest, action=action):
                    detail = await self.call("GET", "tasks/" + tid)
                    self.assertEqual(detail.json()["requirementStage"], "ready" if allowed else "reviewing")
                    listing = await self.call("GET", "tasks")
                    self.assertEqual(next(t for t in listing.json() if t["id"] == tid)["requirementStage"],
                                     "ready" if allowed else "reviewing")
                    result = await self.call("PATCH" if action == "archive" else "DELETE",
                                             "tasks/" + tid,
                                             **({"json": {"archivedAt": 1}} if action == "archive" else {}))
                    self.assertEqual(result.status_code, 200 if allowed else 409, result.text)

    async def test_user_edit_permission_survives_device_and_origin_changes(self):
        async with self.sessions() as session:
            device = models.Client(id="other-device", user_ref="owner", auth_state="active")
            self.clients["other-device"] = device
            session.add(device)
            task = await session.get(models.Task, "shared")
            task.origin, task.requester_user_id = "dispatch", "peer"
            await session.commit()
        for who in ("other-device", "peer"):
            detail = await self.call("GET", "tasks/shared", who)
            self.assertTrue(detail.json()["readOnly"])
            self.assertTrue(detail.json()["canEditRequirement"])
            self.assertEqual(detail.json()["canDeleteRequirement"], who == "other-device")
            self.assertEqual(detail.json()["canArchiveRequirement"], who == "other-device")
            archived = await self.call("PATCH", "tasks/shared", who, json={"archivedAt": 1})
            self.assertEqual(archived.status_code, 200 if who == "other-device" else 403, archived.text)
            if who == "peer":
                continue
            restored = await self.call("PATCH", "tasks/shared", who, json={"archivedAt": None})
            self.assertEqual(restored.status_code, 200, restored.text)
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.status = "cancel"
            await session.commit()
        restored = await self.call("PATCH", "tasks/shared", "peer",
                                   json={"archivedAt": None, "status": "todo"})
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(restored.json()["status"], "todo")
        denied = await self.call("PATCH", "tasks/shared", "peer", json={"status": "doing"})
        self.assertEqual(denied.status_code, 403, denied.text)
        deleted = await self.call("DELETE", "tasks/shared", "other-device")
        self.assertEqual(deleted.status_code, 200, deleted.text)

    async def test_team_visibility_never_grants_maintenance_permission(self):
        detail = (await self.call("GET", "tasks/shared", "peer")).json()
        self.assertFalse(detail["canEditRequirement"])
        self.assertFalse(detail["canDeleteRequirement"])
        self.assertFalse(detail["canArchiveRequirement"])
        for method, body in (("PATCH", {"archivedAt": 1}), ("DELETE", None)):
            response = await self.call(method, "tasks/shared", "peer", **({"json": body} if body else {}))
            self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual((await self.call("DELETE", "tasks/private", "peer")).status_code, 404)
        self.assertEqual((await self.call("DELETE", "tasks/shared", "outsider")).status_code, 404)

    async def test_all_unfinished_workflows_block_archive_delete_and_projection(self):
        async with self.sessions() as session:
            session.add(am.WorkflowRun(id="live", task_id="shared", plugin_id="fixture",
                                       plugin_version_id="fixture", state="queued"))
            await session.commit()
        for state in ("queued", "running", "waiting_human", "waiting_external",
                      "paused", "preparing", "starting", "dispatching", "future_wait"):
            async with self.sessions() as session:
                run = await session.get(am.WorkflowRun, "live")
                run.state = state
                await session.commit()
            detail = (await self.call("GET", "tasks/shared")).json()
            self.assertTrue(detail["maintenanceBlocked"], state)
            self.assertTrue(detail["canDeleteRequirement"])
            self.assertTrue(detail["maintenanceBlockReason"])
            listing = (await self.call("GET", "tasks")).json()
            self.assertTrue(next(item for item in listing if item["id"] == "shared")["maintenanceBlocked"])
            for method, body in (("PATCH", {"archivedAt": 1}), ("DELETE", None)):
                response = await self.call(method, "tasks/shared", **({"json": body} if body else {}))
                self.assertEqual(response.status_code, 409, state + response.text)
            async with self.sessions() as session:
                self.assertIsNotNone(await session.get(models.Task, "shared"))
                self.assertIsNotNone(await session.get(models.Attachment, "input"))

    async def test_terminal_workflows_allow_both_operations_in_ready_stage(self):
        for index, state in enumerate(("succeeded", "failed", "cancelled")):
            tid = "terminal-" + str(index)
            async with self.sessions() as session:
                session.add(models.Task(id=tid, title=tid, status="todo",
                                        owner_client_id="owner", created_by="owner"))
                session.add(am.WorkflowRun(id=tid, task_id=tid, plugin_id="fixture",
                                           plugin_version_id="fixture", state=state))
                await session.commit()
            detail = (await self.call("GET", "tasks/" + tid)).json()
            self.assertFalse(detail["maintenanceBlocked"])
            archived = await self.call("PATCH", "tasks/" + tid, json={"archivedAt": 1})
            self.assertEqual(archived.status_code, 200, archived.text)
            restored = await self.call("PATCH", "tasks/" + tid, json={"archivedAt": None})
            self.assertEqual(restored.status_code, 200, restored.text)
            deleted = await self.call("DELETE", "tasks/" + tid)
            self.assertEqual(deleted.status_code, 200, deleted.text)

    async def test_preparation_lease_and_unfinished_execution_are_not_terminal(self):
        async with self.sessions() as session:
            session.add(am.ResourceLease(id="start", resource_kind="workflow-start", resource_key="shared",
                                         token="fixture-token", lease_until=datetime.now(timezone.utc) + timedelta(minutes=1)))
            await session.commit()
        for method, body in (("PATCH", {"archivedAt": 1}), ("DELETE", None)):
            response = await self.call(method, "tasks/shared", **({"json": body} if body else {}))
            self.assertEqual(response.status_code, 409, response.text)
        async with self.sessions() as session:
            lease = await session.get(am.ResourceLease, "start")
            lease.lease_until = datetime.now(timezone.utc) - timedelta(minutes=1)
            session.add(am.ExecutionSession(id="execution", task_id="shared", ref="fixture", state="preparing"))
            await session.commit()
        for state in ("queued", "preparing", "starting", "paused", "waiting_human", "running"):
            async with self.sessions() as session:
                execution = await session.get(am.ExecutionSession, "execution")
                execution.state = state
                await session.commit()
            self.assertEqual((await self.call("PATCH", "tasks/shared", json={"archivedAt": 1})).status_code, 409)
            self.assertEqual((await self.call("DELETE", "tasks/shared")).status_code, 409)
        async with self.sessions() as session:
            execution = await session.get(am.ExecutionSession, "execution")
            execution.state = "completed"
            await session.commit()
        self.assertEqual((await self.call("PATCH", "tasks/shared", json={"archivedAt": 1})).status_code, 200)

    async def test_bulk_delete_checks_every_task_before_deleting_any(self):
        async with self.sessions() as session:
            for tid in ("shared", "private"):
                task = await session.get(models.Task, tid)
                task.status = "done"
                task.reviewed_at = datetime.now(timezone.utc)
            session.add(am.WorkflowRun(id="waiting", task_id="shared", plugin_id="fixture",
                                       plugin_version_id="fixture", state="waiting_human"))
            await session.commit()
        response = await self.call("POST", "tasks/clear-done")
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual((await self.call("GET", "tasks/private")).status_code, 200)
        self.assertEqual((await self.call("GET", "tasks/shared")).status_code, 200)
        async with self.sessions() as session:
            run = await session.get(am.WorkflowRun, "waiting")
            run.state = "succeeded"
            await session.commit()
        response = await self.call("POST", "tasks/clear-done")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["removed"], 2)

    async def test_bulk_delete_requires_review_but_archived_completed_requirements_need_no_restore(self):
        now = datetime.now(timezone.utc)
        async with self.sessions() as session:
            shared = await session.get(models.Task, "shared")
            private = await session.get(models.Task, "private")
            shared.status, shared.reviewed_at = "done", now
            private.status = "done"
            await session.commit()
        response = await self.call("POST", "tasks/clear-done")
        self.assertEqual(response.status_code, 409, response.text)
        for tid in ("shared", "private"):
            self.assertEqual((await self.call("GET", "tasks/" + tid)).status_code, 200)
        async with self.sessions() as session:
            private = await session.get(models.Task, "private")
            private.reviewed_at, private.archived_at = now, now
            await session.commit()
        deleted = await self.call("POST", "tasks/clear-done")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(deleted.json()["removed"], 2)

    async def test_stale_identity_map_cannot_bypass_a_new_conversation_turn(self):
        async with self.sessions() as stale:
            await stale.get(models.Task, "shared")
            async with self.sessions() as current:
                task = await current.get(models.Task, "shared")
                task.work_routing = {"conversationTurn": {"state": "waiting"}}
                await current.commit()
            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as caught:
                await service.delete_task(stale, "owner", "shared")
            self.assertEqual(caught.exception.status_code, 409)

    async def test_archived_or_deleted_requirement_cannot_restart_a_terminal_workflow(self):
        from app.services import workflow_runs
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.archived_at = datetime.now(timezone.utc)
            run = am.WorkflowRun(id="retry", task_id="shared", plugin_id="fixture",
                                 plugin_version_id="fixture", state="failed")
            session.add(run)
            await session.commit()
            with self.assertRaisesRegex(ValueError, "恢复"):
                await workflow_runs._retry_failed_gate(session, run, "owner", {"ai"})
            await session.delete(task)
            await session.commit()
            with self.assertRaisesRegex(ValueError, "不存在"):
                await workflow_runs._retry_failed_gate(session, run, "owner", {"ai"})

    async def test_evidence_restart_rechecks_archive_committed_before_start_lease(self):
        from app.services import workflow_runs, resource_leases
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            binding = am.PluginBinding(id="binding", plugin_id="fixture", version_id="fixture")
            source = am.WorkflowRun(id="old", task_id="shared", plugin_id="fixture",
                                    plugin_version_id="fixture", state="failed")
            session.add_all([binding, source])
            await session.commit()
            acquire = resource_leases.acquire

            async def archive_then_acquire(*args, **kwargs):
                # Preserve the real lease service; control only the interleaving.
                response = await self.call("PATCH", "tasks/shared", json={"archivedAt": 1})
                self.assertEqual(response.status_code, 200, response.text)
                return await acquire(*args, **kwargs)

            with patch.object(resource_leases, "acquire", archive_then_acquire):
                with self.assertRaisesRegex(ValueError, "恢复"):
                    await workflow_runs.start_from_evidence(session, task, binding, {}, source, "next")
            await session.refresh(task)
            self.assertIsNotNone(task.archived_at)

    async def test_evidence_restart_reports_concurrent_deletion_without_server_error(self):
        await self._evidence_restart_after_deletion(configured=True)

    async def test_evidence_restart_reports_deletion_while_saving_default_submission_mode(self):
        await self._evidence_restart_after_deletion(configured=False)

    async def _evidence_restart_after_deletion(self, *, configured):
        import httpx
        from sqlalchemy import select
        from app.api import plugin_client_runs
        from app.deps import current_ai_client
        from app.services import device_auth, plugin_service, resource_leases

        self.app.dependency_overrides.pop(current_ai_client, None)
        self.app.include_router(plugin_client_runs.router)
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            if configured:
                task.work_routing = {"executionSubmissionMode": "task"}
            binding = am.PluginBinding(id="binding", plugin_id="fixture", version_id="fixture")
            session.add_all([binding, am.WorkflowRun(
                id="old", task_id="shared", plugin_id="fixture",
                plugin_version_id="fixture", state="failed")])
            await session.commit()
        acquire = resource_leases.acquire

        async def delete_then_acquire(*args, **kwargs):
            deleted = await self.call("DELETE", "tasks/shared")
            self.assertEqual(deleted.status_code, 200, deleted.text)
            return await acquire(*args, **kwargs)

        async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app, raise_app_exceptions=False),
                base_url="http://fixture") as http:
            with (patch.object(plugin_service, "resolve_binding", AsyncMock(return_value=binding)),
                  patch.object(resource_leases, "acquire", delete_then_acquire)):
                # AI admission authenticates the real device session independently
                # of the ordinary business-read override used by this fixture.
                denied = await http.post("/api/v1/tasks/shared/plugin-runs",
                                         json={"resumeFromRunId": "old", "startAtNode": "next"})
                self.assertEqual(denied.status_code, 401, denied.text)
                response = await http.post("/api/v1/tasks/shared/plugin-runs",
                                           headers={"Authorization": "Device " +
                                               device_auth.issue_session(self.clients["owner"])[0]},
                                           json={"resumeFromRunId": "old", "startAtNode": "next"})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("需求已不存在", response.json()["detail"])
        async with self.sessions() as session:
            self.assertIsNone(await session.get(models.Task, "shared"))
            self.assertIsNone(await session.get(am.WorkflowRun, "old"))
            lease = await session.scalar(select(am.ResourceLease).where(
                am.ResourceLease.resource_kind == "workflow-start",
                am.ResourceLease.resource_key == "shared"))
            self.assertIsNotNone(lease)
            self.assertEqual(lease.token, "")

    async def test_direct_dispatch_preparation_and_uncertain_ack_block_maintenance(self):
        from app.services import dispatch_attempts
        async with self.sessions() as session:
            attempt = await dispatch_attempts.start(session, "shared", "owner", "local:pi")
            self.assertTrue((await dispatch_attempts.existing(session, "shared", "todo"))["pending"])
        for uncertain in (False, True):
            if uncertain:
                async with self.sessions() as session:
                    dispatch_attempts.uncertain(session, "shared", "owner", attempt, "ACK timeout", "local:pi")
                    await session.commit()
                    # An indeterminate ACK must not expire like a pre-RPC intent.
                    from sqlalchemy import select
                    events = await session.scalars(select(models.TaskEvent).where(
                        models.TaskEvent.task_id == "shared"))
                    for event in events:
                        event.at -= timedelta(minutes=20)
                    await session.commit()
            detail = (await self.call("GET", "tasks/shared")).json()
            self.assertTrue(detail["maintenanceBlocked"], str(uncertain))
            rows = (await self.call("GET", "tasks")).json()
            self.assertTrue(next(row for row in rows if row["id"] == "shared")["maintenanceBlocked"])
            for method, body in (("PATCH", {"archivedAt": 1}), ("DELETE", None)):
                response = await self.call(method, "tasks/shared", **({"json": body} if body else {}))
                self.assertEqual(response.status_code, 409, response.text)
        async with self.sessions() as session:
            for tid in ("private", "shared"):
                (await session.get(models.Task, tid)).status = "done"
            await session.commit()
        self.assertEqual((await self.call("POST", "tasks/clear-done")).status_code, 409)
        self.assertEqual((await self.call("GET", "tasks/private")).status_code, 200)

    async def test_final_and_expired_dispatch_facts_release_maintenance(self):
        from app.services import ai_exec, dispatch_attempts
        now = datetime.now(timezone.utc)
        cases = [
            (ai_exec.EV_DISPATCH_FAILED, now, ""),
            (ai_exec.EV_ARTIFACTS, now, ""),
            (ai_exec.EV_DISPATCH_STARTED, now - timedelta(minutes=11), ""),
            (ai_exec.EV_DISPATCHED, now - timedelta(minutes=11), ""),
        ] + [(ai_exec.EV_DISPATCHED, now, state) for state in
             ("success", "error", "errored", "failure", "aborted", " COMPLETED ")] + [
            (ai_exec.EV_DISPATCH_UNCERTAIN, now, "success")]
        for index, (kind, at, state) in enumerate(cases):
            tid, ref = "final-" + str(index), "dispatch-final-" + str(index)
            async with self.sessions() as session:
                session.add(models.Task(id=tid, title=tid, status="todo",
                                        owner_client_id="owner", created_by="owner"))
                # A newer final record, not an arbitrary historical start, is authoritative.
                session.add(models.TaskEvent(task_id=tid, kind=ai_exec.EV_DISPATCH_STARTED,
                                             at=now - timedelta(minutes=30)))
                session.add(models.TaskEvent(task_id=tid, kind=kind, at=at,
                                             detail={"ref": ref, "expectedRef": ref}))
                if state:
                    session.add(am.ExecutionSession(task_id=tid, ref=ref, state=state))
                await session.commit()
            detail = (await self.call("GET", "tasks/" + tid)).json()
            self.assertFalse(detail["maintenanceBlocked"], (kind, state))
            async with self.sessions() as session:
                self.assertIsNone(await dispatch_attempts.existing(session, tid, "todo"), (kind, state))
            response = await self.call("PATCH", "tasks/" + tid, json={"archivedAt": 1})
            self.assertEqual(response.status_code, 200, response.text)
            restored = await self.call("PATCH", "tasks/" + tid, json={"archivedAt": None})
            self.assertEqual(restored.status_code, 200, restored.text)
            response = await self.call("DELETE", "tasks/" + tid)
            self.assertEqual(response.status_code, 200, response.text)

    async def test_dispatch_projection_uses_fixed_batch_queries(self):
        from sqlalchemy import event, select
        from app.services import ai_exec, task_maintenance
        async with self.sessions() as session:
            for index in range(30):
                tid = "batch-" + str(index)
                session.add(models.Task(id=tid, title=tid, owner_client_id="owner", created_by="owner"))
                session.add(models.TaskEvent(task_id=tid, kind=ai_exec.EV_DISPATCHED,
                                             detail={"ref": tid}))
                session.add(am.ExecutionSession(task_id=tid, ref=tid, state="success"))
            await session.commit()
            rows = list(await session.scalars(select(models.Task).where(models.Task.id.like("batch-%"))))
            statements = []
            def count(_conn, _cursor, statement, _parameters, _context, _many):
                if statement.lstrip().upper().startswith("SELECT"):
                    statements.append(statement)
            event.listen(self.engine.sync_engine, "before_cursor_execute", count)
            try:
                self.assertEqual(await task_maintenance.blocked_reasons(session, rows[:1]), {})
                one = len(statements)
                statements.clear()
                self.assertEqual(await task_maintenance.blocked_reasons(session, rows), {})
                self.assertEqual(len(statements), one)
                self.assertLessEqual(one, 5)
            finally:
                event.remove(self.engine.sync_engine, "before_cursor_execute", count)

    async def test_direct_dispatch_rechecks_archive_after_route_transaction_commits(self):
        from unittest.mock import AsyncMock
        from app.services import dispatch_attempts, zero_work_route
        try_route = zero_work_route.try_route

        async def route_then_archive(session, task, **kwargs):
            routed = await try_route(session, task, **kwargs)
            self.assertIsNone(routed)
            # The real plugin fallback commits its audit record before returning.
            # Control that boundary while retaining the same ORM identity map.
            await session.commit()
            response = (await self.call("PATCH", "tasks/shared", json={"archivedAt": 1})
                        if task.id == "shared" else await self.call("DELETE", "tasks/" + task.id))
            self.assertEqual(response.status_code, 200, response.text)
            return routed

        with patch.object(zero_work_route, "try_route", route_then_archive), patch.object(
            dispatch_attempts, "start", AsyncMock(side_effect=AssertionError("must not start archived work")),
        ) as start:
            for tid, expected in (("shared", 409), ("private", 404)):
                response = await self.call("POST", "tasks/" + tid + "/ai-dispatch",
                                           json={"assigneeId": "local:pi", "assigneeType": "agent"})
                self.assertEqual(response.status_code, expected, response.text)
            start.assert_not_called()

    async def test_executed_definitions_remain_frozen_for_all_authorized_editors(self):
        async with self.sessions() as session:
            device = models.Client(id="tag-device", user_ref="owner", auth_state="active")
            self.clients[device.id] = device
            session.add(device)
            for phase in ("doing", "done", "archived"):
                session.add(models.Task(
                    id="tags-" + phase, title="Original", note="Original instructions",
                    status="doing" if phase == "doing" else "done", owner_client_id="owner",
                    created_by="owner", requester_user_id="peer", shared_org_id="company",
                    archived_at=datetime.now(timezone.utc) if phase == "archived" else None,
                ))
            await session.commit()
        for phase, protected in (("doing", {"title": "Changed"}), ("done", {"note": "Changed"}),
                                 ("archived", {"priority": "high"})):
            for who in ("tag-device", "peer"):
                path = "tasks/tags-" + phase
                before = (await self.call("GET", path, who)).json()
                self.assertTrue(before["readOnly"])
                self.assertFalse(before["canEditRequirement"])
                self.assertTrue(before["canManageRequirementMaterials"])
                version = before["requirementVersion"]
                tags = [phase, who]
                changed = await self.call("PATCH", path, who,
                                          json={"tags": tags, "requirementVersion": version})
                self.assertEqual(changed.status_code, 409, changed.text)
                content = await self.call("PATCH", path, who, json={
                    "tags": ["mixed"], **protected, "requirementVersion": version})
                self.assertEqual(content.status_code, 409, content.text)
                saved = (await self.call("GET", path, who)).json()
                self.assertEqual(saved["tags"], before["tags"])
                self.assertEqual(saved["requirementVersion"], version)
        reader = await self.call("PATCH", "tasks/legacy", "peer", json={"tags": ["unauthorized"]})
        self.assertEqual(reader.status_code, 403, reader.text)
