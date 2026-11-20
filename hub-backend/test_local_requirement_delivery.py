"""Real HTTP/SQLite delivery and creator-owned review without private model metadata."""
import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from sqlalchemy import delete, event, select

import test_unified_requirements as fixture
from app import automation_models as am, models
from app.services import storage


class LocalRequirementDeliveryTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.UnifiedRequirementTests.asyncTearDown
    call = fixture.UnifiedRequirementTests.call

    async def asyncSetUp(self):
        await fixture.UnifiedRequirementTests.asyncSetUp(self)
        directory = self.enterContext(tempfile.TemporaryDirectory(prefix="soduwork-local-review-"))
        self.enterContext(patch.object(storage, "_LOCAL_DIR", directory))

    async def create_running(self, mode):
        response = await self.call("POST", "tasks", json={
            "title": "Single-account delivery", "note": "Create a reviewable report",
            "acceptanceCriteria": ["Includes the completed report"], "triageStage": "ready"})
        self.assertEqual(response.status_code, 200, response.text)
        tid = response.json()["id"]
        async with self.sessions() as session:
            task = await session.get(models.Task, tid)
            self.assertEqual(task.created_by, "owner")
            self.assertEqual(task.assignee_user_id, "owner")
            task.status = "doing"
            task.work_routing = {"executionSubmissionMode": mode, "conversationTurn": {
                "turnId": "turn", "conversationId": "chat", "executor": "native", "state": "running"}}
            await session.commit()
        return tid

    async def deliver(self, tid, model=""):
        result = await self.call("POST", "tasks/" + tid + "/conversation-delivery",
            data={"conversationId": "chat", "turnId": "turn", "paths": "report.md",
                  "categories": "primary", "outcome": "completed", "model": model},
            files={"files": ("report.md", b"Complete report with verification evidence", "text/markdown")})
        if result.status_code == 200:
            settled = await self.call("POST", "tasks/" + tid + "/conversation-turn", json={
                "conversationId": "chat", "turnId": "turn", "executor": "native", "action": "complete"})
            self.assertEqual(settled.status_code, 200, settled.text)
        return result

    async def assert_pending_creator_review(self, tid):
        detail = await self.call("GET", "tasks/" + tid)
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["requirementStage"], "reviewing")
        self.assertTrue(detail.json()["canReview"])
        async with self.sessions() as session:
            request = await session.scalar(select(am.ApprovalRequest).where(am.ApprovalRequest.task_id == tid))
            self.assertEqual((request.action, request.status, request.required_count), ("review", "pending", 1))
            assignments = (await session.scalars(select(am.ApprovalAssignment).where(
                am.ApprovalAssignment.request_id == request.id))).all()
            self.assertEqual([row.user_id for row in assignments], ["owner"])
            self.assertIsNone((await session.get(models.Task, tid)).reviewed_at)
            self.assertIsNone(await session.scalar(select(am.ApprovalDecision.id).where(
                am.ApprovalDecision.request_id == request.id)))
        foreign = await self.call("POST", "tasks/" + tid + "/review", "peer", json={})
        self.assertIn(foreign.status_code, (403, 404), foreign.text)

    async def test_single_account_auto_delivery_is_identical_for_private_and_managed_models(self):
        for model in ("", "managed-model"):
            with self.subTest(model=model):
                tid = await self.create_running("auto")
                response = await self.deliver(tid, model)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json()["ok"])
                await self.assert_pending_creator_review(tid)

    async def test_new_default_html_requirement_without_declared_criteria_reaches_review(self):
        created = await self.call("POST", "tasks", json={"title": "HTML greeting",
            "note": "Create an HTML file displaying hello", "triageStage": "ready"})
        self.assertEqual(created.status_code, 200, created.text)
        tid = created.json()["id"]
        scope = {"conversationId": "chat", "turnId": "turn", "executor": "native"}
        for action in ("prepare", "start"):
            response = await self.call("POST", "tasks/" + tid + "/conversation-turn", json={
                **scope, "action": action, **({"submissionChoice": "infer"} if action == "prepare" else {})})
            self.assertEqual(response.status_code, 200, response.text)
        delivered = await self.call("POST", "tasks/" + tid + "/conversation-delivery",
            data={"conversationId": "chat", "turnId": "turn", "paths": "index.html",
                  "categories": "primary", "outcome": "completed"},
            files={"files": ("index.html", b"<!doctype html><html><body>hello</body></html>", "text/html")})
        self.assertEqual(delivered.status_code, 200, delivered.text)
        self.assertEqual(delivered.json()["submissionMode"], "auto")
        settled = await self.call("POST", "tasks/" + tid + "/conversation-turn", json={**scope, "action": "complete"})
        self.assertEqual(settled.status_code, 200, settled.text)
        await self.assert_pending_creator_review(tid)

    async def test_single_account_manual_submission_keeps_creator_eligible(self):
        tid = await self.create_running("manual")
        delivered = await self.deliver(tid)
        self.assertEqual(delivered.status_code, 200, delivered.text)
        self.assertTrue(delivered.json()["pendingSubmission"])
        async with self.sessions() as session:
            self.assertIsNone(await session.scalar(select(am.ApprovalRequest.id).where(
                am.ApprovalRequest.task_id == tid)))
        response = await self.call("POST", "tasks/" + tid + "/submit-review", json={"note": "Ready for review"})
        self.assertEqual(response.status_code, 200, response.text)
        await self.assert_pending_creator_review(tid)

    async def test_waiting_output_can_be_completed_in_the_same_turn(self):
        tid = await self.create_running("manual")
        async with self.sessions() as session:
            task = await session.get(models.Task, tid)
            task.work_routing = {**task.work_routing, "executionSubmissionChoice": "infer"}
            await session.commit()
        body = {"conversationId": "chat", "turnId": "turn", "paths": "report.md",
                "categories": "primary", "outcome": "incomplete"}
        pending = await self.call("POST", "tasks/" + tid + "/conversation-delivery", data=body,
            files={"files": ("report.md", b"Draft report", "text/markdown")})
        self.assertEqual(pending.status_code, 200, pending.text)
        self.assertTrue(pending.json()["deferred"])
        waiting = await self.call("POST", "tasks/" + tid + "/conversation-turn", json={
            "conversationId": "chat", "turnId": "turn", "executor": "native", "action": "wait"})
        self.assertEqual(waiting.status_code, 200, waiting.text)
        # Receipts written by the previous version had no explicit outcome.
        async with self.sessions() as session:
            for event in await session.scalars(select(models.TaskEvent).where(
                    models.TaskEvent.task_id == tid, models.TaskEvent.kind == "ai.artifacts")):
                event.detail = {key: value for key, value in event.detail.items() if key != "outcome"}
            await session.commit()
        completed = await self.deliver(tid)
        self.assertEqual(completed.status_code, 200, completed.text)
        await self.assert_pending_creator_review(tid)
        async with self.sessions() as session:
            files = list(await session.scalars(select(models.Attachment).where(models.Attachment.task_id == tid)))
            self.assertEqual(sorted(file.role for file in files), ["output", "process"])
            final = next(file for file in files if file.role == "output")
            self.assertEqual(final.filename, "report.md")
            self.assertEqual(final.evidence_meta["round"], 2)
            final_bytes = b"Complete report with verification evidence"
            self.assertEqual(storage.get(final.storage_key, final.backend), final_bytes)
            artifact = await session.scalar(select(am.ArtifactVersion).where(am.ArtifactVersion.task_id == tid))
            frozen = [item for item in artifact.manifest["files"] if item["category"] == "primary"]
            self.assertEqual([(item["id"], item["sha256"]) for item in frozen],
                             [(final.id, hashlib.sha256(final_bytes).hexdigest())])

    async def test_explicit_manual_resumed_completion_does_not_create_an_automatic_review(self):
        tid = await self.create_running("manual")
        first = await self.call("POST", "tasks/" + tid + "/conversation-delivery",
            data={"conversationId": "chat", "turnId": "turn", "paths": "report.md",
                  "categories": "primary", "outcome": "incomplete"},
            files={"files": ("report.md", b"Draft report", "text/markdown")})
        self.assertEqual(first.status_code, 200, first.text)
        finished = await self.deliver(tid)
        self.assertEqual(finished.status_code, 200, finished.text)
        self.assertTrue(finished.json()["pendingSubmission"])
        self.assertFalse(finished.json().get("already", False))
        async with self.sessions() as session:
            self.assertIsNone(await session.scalar(select(am.ApprovalRequest).where(am.ApprovalRequest.task_id == tid)))
            self.assertIsNone(await session.scalar(select(am.ArtifactVersion).where(am.ArtifactVersion.task_id == tid)))

    async def test_auto_delivery_commits_review_before_any_notification_transport(self):
        from app.services import task_access, task_notifications
        tid = await self.create_running("auto")
        async with self.sessions() as session:
            await session.execute(delete(models.TaskNotificationOutbox))
            await session.commit()
        with patch.object(task_access.hub, "publish", new=AsyncMock()) as send:
            result = await self.call("POST", "tasks/" + tid + "/conversation-delivery",
                data={"conversationId": "chat", "turnId": "turn", "paths": "report.md",
                      "categories": "primary", "outcome": "completed"},
                files={"files": ("report.md", b"Complete report", "text/markdown")})
            self.assertEqual(result.status_code, 200, result.text)
            send.assert_not_awaited()
        await self.assert_pending_creator_review(tid)
        with patch.object(task_access.hub, "publish", new=AsyncMock()) as send:
            self.assertTrue(await task_notifications.run_once(self.sessions))
            notices = [call.args[1] for call in send.await_args_list if call.args[1].get("type") == "notice"]
            self.assertEqual([notice["taskId"] for notice in notices], [tid])

    async def test_delayed_delivery_notification_does_not_invite_review_of_a_closed_gate(self):
        from app.services import task_access, task_notifications
        tid = await self.create_running("auto")
        async with self.sessions() as session:
            await session.execute(delete(models.TaskNotificationOutbox))
            await session.commit()
        self.assertEqual((await self.deliver(tid)).status_code, 200)
        async with self.sessions() as session:
            request = await session.scalar(select(am.ApprovalRequest).where(am.ApprovalRequest.task_id == tid))
            request.status = "cancelled"
            await session.commit()
        with patch.object(task_access.hub, "publish", new=AsyncMock()) as send:
            self.assertTrue(await task_notifications.run_once(self.sessions))
            self.assertFalse(any(call.args[1].get("type") == "notice" for call in send.await_args_list))

    async def test_notification_failure_keeps_committed_review_and_retries_without_duplicate_gate(self):
        from app.services import task_access, task_notifications
        tid = await self.create_running("auto")
        async with self.sessions() as session:
            await session.execute(delete(models.TaskNotificationOutbox))
            await session.commit()
        self.assertEqual((await self.deliver(tid)).status_code, 200)
        with patch.object(task_access.hub, "publish", new=AsyncMock(side_effect=RuntimeError("offline"))):
            with self.assertLogs("uvicorn.error", level="ERROR"):
                self.assertTrue(await task_notifications.run_once(self.sessions))
        await self.assert_pending_creator_review(tid)
        async with self.sessions() as session:
            job = await session.scalar(select(models.TaskNotificationOutbox))
            self.assertIsNotNone(job)
            job.available_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await session.commit()
        with patch.object(task_access.hub, "publish", new=AsyncMock()):
            self.assertTrue(await task_notifications.run_once(self.sessions))
        async with self.sessions() as session:
            self.assertIsNone(await session.scalar(select(models.TaskNotificationOutbox)))
            self.assertEqual(len(list(await session.scalars(select(am.ApprovalRequest).where(
                am.ApprovalRequest.task_id == tid)))), 1)

    async def test_manual_submission_receipt_does_not_wait_for_notification_and_retry_is_idempotent(self):
        from app.services import task_access, task_notifications
        tid = await self.create_running("manual")
        self.assertEqual((await self.deliver(tid)).status_code, 200)
        async with self.sessions() as session:
            # Isolate this operation from the fixture's earlier creation notice.
            await session.execute(delete(models.TaskNotificationOutbox))
            await session.commit()
        with patch.object(task_access.hub, "publish", new=AsyncMock(side_effect=RuntimeError("transport unavailable"))) as send:
            response = await self.call("POST", "tasks/" + tid + "/submit-review", json={})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()["ok"])
            self.assertEqual(response.json()["task"]["requirementStage"], "reviewing")
            send.assert_not_awaited()
            retry = await self.call("POST", "tasks/" + tid + "/submit-review", json={})
            self.assertTrue(retry.json()["already"])
            async with self.sessions() as session:
                self.assertEqual(len(list(await session.scalars(select(am.ApprovalRequest).where(
                    am.ApprovalRequest.task_id == tid)))), 1)
                self.assertEqual(len(list(await session.scalars(select(am.ArtifactVersion).where(
                    am.ArtifactVersion.task_id == tid)))), 1)
                jobs = list(await session.scalars(select(models.TaskNotificationOutbox)))
                self.assertEqual([(job.task_id, job.event_type) for job in jobs], [(tid, "task.updated")])
            with self.assertLogs("uvicorn.error", level="ERROR"):
                self.assertTrue(await task_notifications.run_once(self.sessions))
        async with self.sessions() as session:
            job = await session.scalar(select(models.TaskNotificationOutbox))
            self.assertEqual(job.attempts, 1)
            self.assertIsNone(job.lease_token)
            job.available_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await session.commit()
        with patch.object(task_access.hub, "publish", new=AsyncMock()) as send:
            self.assertTrue(await task_notifications.run_once(self.sessions))
            self.assertEqual([(call.args[0], call.kwargs["user_id"]) for call in send.await_args_list], [("owner", "owner")])
            self.assertEqual(send.await_args.args[1]["task"]["requirementStage"], "reviewing")
        self.assertFalse(await task_notifications.run_once(self.sessions))

    async def test_manual_submission_and_notification_are_atomic_when_outbox_storage_fails(self):
        tid = await self.create_running("manual")
        self.assertEqual((await self.deliver(tid)).status_code, 200)
        async with self.sessions() as session:
            await session.execute(delete(models.TaskNotificationOutbox))
            await session.commit()
        def fail_outbox(_connection, _cursor, sql, _parameters, _context, _many):
            if sql.startswith("INSERT INTO task_notification_outbox"):
                raise RuntimeError("isolated notification storage failure")
        event.listen(self.engine.sync_engine, "before_cursor_execute", fail_outbox)
        try:
            with self.assertRaisesRegex(RuntimeError, "notification storage failure"):
                await self.call("POST", "tasks/" + tid + "/submit-review", json={})
        finally:
            event.remove(self.engine.sync_engine, "before_cursor_execute", fail_outbox)
        async with self.sessions() as session:
            self.assertIsNone(await session.scalar(select(am.ApprovalRequest).where(am.ApprovalRequest.task_id == tid)))
            self.assertIsNone(await session.scalar(select(models.TaskNotificationOutbox)))
        detail = await self.call("GET", "tasks/" + tid)
        self.assertEqual(detail.json()["requirementStage"], "delivering")
        response = await self.call("POST", "tasks/" + tid + "/submit-review", json={})
        self.assertEqual(response.status_code, 200, response.text)

    async def test_legacy_device_references_are_not_persisted_with_deliverables(self):
        for model in ("local:model-" + "a" * 32, "local:private:wire-model",
                      "image::device:private::local:model-" + "b" * 32):
            with self.subTest(model=model):
                tid = await self.create_running("auto")
                response = await self.deliver(tid, model)
                self.assertEqual(response.status_code, 200, response.text)
                await self.assert_pending_creator_review(tid)
                async with self.sessions() as session:
                    events = (await session.scalars(select(models.TaskEvent).where(models.TaskEvent.task_id == tid))).all()
                    attachments = (await session.scalars(select(models.Attachment).where(models.Attachment.task_id == tid))).all()
                    captured = json.dumps([[(row.actor, row.detail) for row in events],
                                           [(row.uploaded_by, row.evidence_meta) for row in attachments]])
                    self.assertNotIn(model, captured)
                    self.assertNotIn("local:", captured)

    async def test_missing_creator_is_not_inferred_from_the_current_executor(self):
        tid = await self.create_running("manual")
        async with self.sessions() as session:
            task = await session.get(models.Task, tid)
            task.created_by = None
            await session.commit()
        delivered = await self.deliver(tid)
        self.assertEqual(delivered.status_code, 200, delivered.text)
        denied = await self.call("POST", "tasks/" + tid + "/submit-review", json={})
        self.assertEqual(denied.status_code, 409, denied.text)
        self.assertIn("当前只能分配给 0 人", denied.json()["detail"])
        async with self.sessions() as session:
            self.assertIsNone((await session.get(models.Task, tid)).created_by)
            self.assertIsNone(await session.scalar(select(am.ApprovalAssignment.id)))


if __name__ == "__main__":
    unittest.main()
