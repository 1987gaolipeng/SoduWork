"""Regressions for requirement-version locking, automatic AI delivery review submission, and
visible collection failures. Only requirement-definition edits advance the version, and locked
edits must not increment twice. Invalid output structures must produce actionable receipts
rather than silent failures or misleading conflict errors.
"""

import json
import tempfile
import unittest
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.db import Base
from app.services import conversation_turns, release_control, storage, tasks as task_service


class VersionBumpTests(unittest.IsolatedAsyncioTestCase):
    """Advance requirement_version only for definition edits, without double-counting locked or
    execution updates.
    """

    async def _session(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        return engine, sessions

    async def test_locked_content_edit_bumps_version_once(self):
        engine, sessions = await self._session()
        try:
            async with sessions() as session:
                session.add(models.Client(id="device-owner", name="本机", user_ref="u-1"))
                session.add(models.Task(id="essay-task", title="写一篇作文", status="todo",
                                        owner_client_id="device-owner", requirement_version=7))
                await session.commit()
                await task_service.update_task(session, "device-owner", "essay-task",
                                               {"title": "写一篇命题作文", "requirementVersion": 7})
                task = (await session.execute(
                    select(models.Task).where(models.Task.id == "essay-task"))).scalar_one()
                # The optimistic-lock claim already increments the version; update_task must not increment again.
                self.assertEqual(task.requirement_version, 8)
        finally:
            await engine.dispose()

    async def test_execution_patch_keeps_version(self):
        engine, sessions = await self._session()
        try:
            async with sessions() as session:
                session.add(models.Client(id="device-owner", name="本机", user_ref="u-1"))
                session.add(models.Task(id="essay-task", title="写一篇作文", status="todo",
                                        owner_client_id="device-owner", requirement_version=7))
                await session.commit()
                await task_service.update_task(session, "device-owner", "essay-task",
                                               {"status": "doing", "progress": [{"text": "开写"}]})
                task = (await session.execute(
                    select(models.Task).where(models.Task.id == "essay-task"))).scalar_one()
                self.assertEqual(task.requirement_version, 7)
        finally:
            await engine.dispose()

    async def test_content_edit_without_lock_still_bumps(self):
        engine, sessions = await self._session()
        try:
            async with sessions() as session:
                session.add(models.Client(id="device-owner", name="本机", user_ref="u-1"))
                session.add(models.Task(id="essay-task", title="写一篇作文", status="todo",
                                        owner_client_id="device-owner", requirement_version=7))
                await session.commit()
                await task_service.update_task(session, "device-owner", "essay-task",
                                               {"title": "写一篇散文"})
                task = (await session.execute(
                    select(models.Task).where(models.Task.id == "essay-task"))).scalar_one()
                self.assertEqual(task.requirement_version, 8)
        finally:
            await engine.dispose()


class AutoSubmitTests(unittest.IsolatedAsyncioTestCase):
    """AI delivery submits review automatically and exposes structural validation failures."""

    async def _prepared(self):
        # Artifact bytes stay private to this test, alongside its memory database.
        storage_root = self.enterContext(tempfile.TemporaryDirectory(prefix="soduwork-stage-review-"))
        self.enterContext(patch.object(storage, "_LOCAL_DIR", storage_root))
        engine, sessions = await VersionBumpTests._session(self)
        try:
            session = sessions()
            await session.__aenter__()
            session.add(models.Client(id="device-owner", name="本机", user_ref="u-exec"))
            session.add(models.User(id="u-requester", username="requester",
                                    display_name="王振义", is_active=True))
            session.add(models.User(id="u-exec", username="executor", is_active=True))
            await session.flush()
            session.add(models.Task(
                id="essay-task", title="写一篇作文", status="doing",
                owner_client_id="device-owner", requester_user_id="u-requester",
                created_by="u-requester",
                work_routing={"conversationTurn": {"turnId": "turn-1", "conversationId": "conv-1",
                                                   "state": "running"},
                              "outputContract": {"kind": "office-artifact"}}))
            await session.commit()
            return engine, sessions, session, await session.get(models.Task, "essay-task")
        except BaseException:
            await engine.dispose()
            raise

    async def test_valid_delivery_auto_submits_review(self):
        engine, sessions, session, task = await self._prepared()
        try:
            result = await conversation_turns.deliver_artifacts(
                session, task,
                conversation_id="conv-1", turn_id="turn-1", provider="conversation",
                files=[("作文.md", "写作文".encode("utf-8"), "text/markdown")])
            self.assertTrue(result.get("ok"))
            requests = (await session.execute(select(am.ApprovalRequest).where(
                am.ApprovalRequest.task_id == "essay-task"))).scalars().all()
            # Valid delivery creates a review gate while retaining human approval.
            self.assertEqual([r.action for r in requests], ["review"])
            self.assertEqual([r.status for r in requests], ["pending"])
            assignments = (await session.scalars(select(am.ApprovalAssignment).where(
                am.ApprovalAssignment.request_id == requests[0].id))).all()
            self.assertEqual([row.user_id for row in assignments], ["u-requester"])
            kinds = [row[0] for row in (await session.execute(
                select(models.TaskEvent.kind).where(
                    models.TaskEvent.task_id == "essay-task"))).all()]
            self.assertIn("artifact.submitted_for_review", kinds)
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

    async def test_inferred_markdown_without_contract_opens_review_and_retry_is_idempotent(self):
        engine, sessions, session, task = await self._prepared()
        try:
            task.work_routing = {"conversationTurn": dict(task.work_routing["conversationTurn"]),
                                 "executionSubmissionChoice": "infer", "executionSubmissionMode": "manual"}
            await session.commit()
            args = dict(conversation_id="conv-1", turn_id="turn-1",
                        files=[("雪落无声.md", b"# Winter\nSnow falls.", "text/markdown")])
            first = await conversation_turns.deliver_artifacts(session, task, **args)
            self.assertEqual(first["submissionMode"], "auto")
            self.assertFalse(first["pendingSubmission"])
            self.assertEqual(task.work_routing["executionSubmissionChoice"], "infer")
            self.assertEqual(task.work_routing["executionSubmissionMode"], "auto")
            retry = await conversation_turns.deliver_artifacts(session, task, **args)
            self.assertTrue(retry["already"])
            self.assertFalse(retry["pendingSubmission"])
            for model in (models.Attachment, am.ArtifactVersion, am.ApprovalRequest):
                self.assertEqual(len((await session.scalars(select(model).where(model.task_id == task.id))).all()), 1)
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

    async def test_inferred_delivery_requires_a_valid_completed_primary(self):
        for category, content, outcome in (("primary", b"not-json", "completed"),
                                            ("supporting", b"{}", "completed"),
                                            ("primary", b"{}", "incomplete")):
            with self.subTest(category=category, outcome=outcome):
                engine, sessions, session, task = await self._prepared()
                try:
                    task.work_routing = {"conversationTurn": dict(task.work_routing["conversationTurn"]),
                                         "executionSubmissionChoice": "infer", "executionSubmissionMode": "manual"}
                    await session.commit()
                    result = await conversation_turns.deliver_artifacts(session, task,
                        conversation_id="conv-1", turn_id="turn-1", outcome=outcome,
                        categories={"result.json": category}, files=[("result.json", content, "application/json")])
                    self.assertEqual((await session.scalars(select(am.ApprovalRequest))).all(), [])
                    self.assertEqual(task.work_routing["executionSubmissionMode"], "manual")
                    if outcome == "completed":
                        self.assertTrue(result.get("deliveryBlocked"))
                        self.assertTrue(result.get("reason"))
                finally:
                    await session.__aexit__(None, None, None)
                    await engine.dispose()

    async def test_lost_upload_response_retry_keeps_one_attachment_version_and_review(self):
        engine, sessions, session, task = await self._prepared()
        try:
            args = dict(conversation_id='conv-1', turn_id='turn-1', provider='conversation',
                        files=[('cafe\u0301.md', b'# Frozen result', 'text/markdown')])
            first = await conversation_turns.deliver_artifacts(session, task, **args)
            retry = await conversation_turns.deliver_artifacts(session, task, **args)
            self.assertTrue(first['ok'])
            self.assertTrue(retry['already'])
            for model in (models.Attachment, am.ArtifactVersion, am.ApprovalRequest):
                rows = (await session.scalars(select(model).where(model.task_id == task.id))).all()
                self.assertEqual(len(rows), 1, model.__name__)
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

    async def test_requester_receives_auto_review_without_creator(self):
        engine, sessions, session, task = await self._prepared()
        try:
            task.created_by = None
            await session.commit()
            await conversation_turns.deliver_artifacts(
                session, task,
                conversation_id="conv-1", turn_id="turn-1", provider="conversation",
                files=[("review.md", b"Complete report", "text/markdown")])
            requests = (await session.scalars(select(am.ApprovalRequest).where(
                am.ApprovalRequest.task_id == task.id))).all()
            self.assertEqual([row.status for row in requests], ["pending"])
            assignments = (await session.scalars(select(am.ApprovalAssignment).where(
                am.ApprovalAssignment.request_id == requests[0].id))).all()
            self.assertEqual([row.user_id for row in assignments], [task.requester_user_id])
            kinds = (await session.scalars(select(models.TaskEvent.kind).where(
                models.TaskEvent.task_id == task.id))).all()
            self.assertNotIn("approval.unassigned", kinds)
            self.assertIn("artifact.submitted_for_review", kinds)
            self.assertNotIn("deliveryIssue", task.work_routing["conversationTurn"])
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

    async def test_retry_unassigned_delivery_uses_repaired_policy_on_the_same_ticket(self):
        engine, sessions, session, task = await self._prepared()
        try:
            task.created_by = task.requester_user_id = None
            await session.commit()
            await conversation_turns.deliver_artifacts(session, task, conversation_id="conv-1", turn_id="turn-1",
                files=[("review.md", b"Complete report", "text/markdown")])
            request = (await session.scalars(select(am.ApprovalRequest))).one()
            self.assertEqual((await task_service.task_to_api_live(session, task))["requirementStage"], "delivering")
            session.add(am.ApprovalPolicy(id=release_control.POLICY_REVIEW, key="review", name="Review",
                rules={"approvers": [{"type": "user", "ids": ["u-requester"]}]}))
            preview = await release_control.preview_review_routing(session, task)
            self.assertEqual([row["userId"] for row in preview["candidates"]], ["u-requester"])
            artifact = await session.get(am.ArtifactVersion, request.artifact_version_id)
            retry = await release_control.ensure_request(session, task, artifact, "review")
            self.assertEqual(retry.id, request.id)
            self.assertEqual((await session.scalars(select(am.ApprovalAssignment.user_id))).all(), ["u-requester"])
            self.assertEqual((await task_service.task_to_api_live(session, task))["requirementStage"], "reviewing")
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

    async def test_restored_creator_clears_only_current_review_assignment_issue(self):
        from app.services import approval_routing
        engine, sessions, session, task = await self._prepared()
        try:
            creator = await session.get(models.User, task.created_by)
            creator.is_active = False
            await session.commit()
            await conversation_turns.deliver_artifacts(session, task,
                conversation_id="conv-1", turn_id="turn-1",
                files=[("review.md", b"Complete report", "text/markdown")])
            request = (await session.scalars(select(am.ApprovalRequest))).one()
            current = task.work_routing["conversationTurn"]
            issue = dict(current["deliveryIssue"])
            self.assertEqual(issue.get("artifactVersionId"), request.artifact_version_id)
            self.assertIn(creator.display_name, issue["reason"])
            self.assertIn("已停用", issue["reason"])
            self.assertEqual((await task_service.task_to_api_live(session, task))["requirementStage"], "delivering")
            creator.is_active = True
            for existing_assignment in (False, True):
                with self.subTest(existing_assignment=existing_assignment):
                    task.work_routing = {**task.work_routing, "conversationTurn": {**current, "deliveryIssue": issue}}
                    rows = await approval_routing.ensure_assignments(session, task, request)
                    self.assertEqual([row.user_id for row in rows], [creator.id])
                    self.assertNotIn("deliveryIssue", task.work_routing["conversationTurn"])
                    self.assertEqual(request.status, "pending")
                    self.assertEqual((await task_service.task_to_api_live(session, task))["requirementStage"], "reviewing")
                    await session.commit()
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

    async def test_restored_assignment_cannot_clear_other_version_or_conversation_issue(self):
        from app.services import approval_routing
        engine, sessions, session, task = await self._prepared()
        try:
            await conversation_turns.deliver_artifacts(session, task,
                conversation_id="conv-1", turn_id="turn-1",
                files=[("review.md", b"Complete report", "text/markdown")])
            request = (await session.scalars(select(am.ApprovalRequest))).one()
            current = task.work_routing["conversationTurn"]
            for version, conversation in (("another-version", "conv-1"), (request.artifact_version_id, "another-conversation")):
                with self.subTest(version=version, conversation=conversation):
                    issue = {"code": "review_unassigned", "reason": "Current review is blocked", "artifactVersionId": version}
                    task.work_routing = {**task.work_routing, "conversationTurn": {
                        **current, "conversationId": conversation, "deliveryIssue": issue}}
                    rows = await approval_routing.ensure_assignments(session, task, request)
                    self.assertEqual(len(rows), 1)
                    self.assertEqual(task.work_routing["conversationTurn"]["deliveryIssue"], issue)
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

    async def test_restored_assignment_refreshes_turn_before_clearing_stale_issue(self):
        from sqlalchemy import update
        from app.services import approval_routing
        engine, sessions, session, task = await self._prepared()
        try:
            await conversation_turns.deliver_artifacts(session, task,
                conversation_id="conv-1", turn_id="turn-1",
                files=[("review.md", b"Complete report", "text/markdown")])
            request = (await session.scalars(select(am.ApprovalRequest))).one()
            old_turn = {**task.work_routing["conversationTurn"], "deliveryIssue": {
                "code": "review_unassigned", "reason": "Old review", "artifactVersionId": request.artifact_version_id}}
            task.work_routing = {**task.work_routing, "conversationTurn": old_turn}
            await session.commit()
            newer = {**task.work_routing, "conversationTurn": {
                "conversationId": "new-conversation", "turnId": "new-turn", "state": "running"}}
            # An independently committed prepare leaves the reader's ORM task stale.
            await session.execute(update(models.Task).where(models.Task.id == task.id)
                .values(work_routing=newer).execution_options(synchronize_session=False))
            await session.commit()
            self.assertEqual(task.work_routing["conversationTurn"], old_turn)
            await approval_routing.ensure_assignments(session, task, request)
            await session.commit()
            await session.refresh(task)
            self.assertEqual(task.work_routing, newer)
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

    async def test_manual_delivery_waits_for_explicit_submission(self):
        """Manual submission mode collects artifacts without automatically creating a pending
        review.
        """
        engine, sessions, session, task = await self._prepared()
        try:
            task.work_routing = {
                **dict(task.work_routing or {}),
                "executionSubmissionMode": "manual",
            }
            result = await conversation_turns.deliver_artifacts(
                session, task,
                conversation_id="conv-1", turn_id="turn-1", provider="conversation",
                files=[("作文.md", "写作文".encode("utf-8"), "text/markdown")])
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("submissionMode"), "manual")
            self.assertTrue(result.get("pendingSubmission"))
            requests = (await session.execute(select(am.ApprovalRequest).where(
                am.ApprovalRequest.task_id == "essay-task"))).scalars().all()
            self.assertEqual(requests, [])
            versions = (await session.execute(select(am.ArtifactVersion).where(
                am.ArtifactVersion.task_id == "essay-task"))).scalars().all()
            self.assertEqual(versions, [])
            details = (await session.execute(select(models.TaskEvent.detail).where(
                models.TaskEvent.task_id == "essay-task",
                models.TaskEvent.kind == "artifact.delivery_waiting_manual"))).scalars().all()
            self.assertEqual(len(details), 1)
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

    async def test_manual_submission_without_deliverable_creates_reviewable_marker(self):
        """A conversational/manual requirement can be sent for acceptance without inventing a file."""
        engine, sessions, session, task = await self._prepared()
        try:
            task.work_routing = {
                "conversationTurn": {"turnId": "turn-1", "conversationId": "conv-1", "state": "completed"},
                "executionSubmissionMode": "manual",
            }
            artifact, created = await release_control.ensure_current_output(
                session, task, source_ref="conversation:conv-1", who="conversation")
            self.assertTrue(created)
            self.assertEqual(artifact.kind, "manual")
            self.assertTrue((artifact.manifest or {}).get("manual"))
            self.assertTrue((artifact.manifest or {}).get("complete"))
            request = (await session.execute(select(am.ApprovalRequest).where(
                am.ApprovalRequest.task_id == task.id,
                am.ApprovalRequest.artifact_version_id == artifact.id,
                am.ApprovalRequest.action == "review"))).scalar_one()
            self.assertEqual(request.status, "pending")
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

    async def test_no_contract_defaults_to_manual_review_marker(self):
        engine, sessions, session, task = await self._prepared()
        try:
            task.work_routing = {
                "conversationTurn": {"turnId": "turn-1", "conversationId": "conv-1", "state": "completed"},
            }
            artifact, created = await release_control.ensure_current_output(session, task, who="conversation")
            self.assertTrue(created)
            self.assertEqual(artifact.kind, "manual")
            self.assertTrue((artifact.manifest or {}).get("manual"))
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

    async def test_declared_output_still_rejects_empty_manual_candidate(self):
        engine, sessions, session, task = await self._prepared()
        try:
            with self.assertRaisesRegex(ValueError, "还没有可审阅的产出"):
                await release_control.ensure_current_output(session, task, who="conversation")
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

    async def test_broken_delivery_notifies_instead_of_silence(self):
        engine, sessions, session, task = await self._prepared()
        try:
            # Retain a structurally corrupted DOCX as evidence.
            # Do not create its candidate version or review; record an explicit rejection receipt.
            result = await conversation_turns.deliver_artifacts(
                session, task,
                conversation_id="conv-1", turn_id="turn-1", provider="conversation",
                files=[("修身养性作文.docx", b"not a zip",
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document")])
            self.assertTrue(result.get("files"))
            self.assertTrue(result.get("invalid"))
            requests = (await session.execute(select(am.ApprovalRequest).where(
                am.ApprovalRequest.task_id == "essay-task"))).scalars().all()
            self.assertEqual(requests, [])
            kinds = [row[0] for row in (await session.execute(
                select(models.TaskEvent.kind).where(
                    models.TaskEvent.task_id == "essay-task"))).all()]
            self.assertIn("artifact.delivery_rejected", kinds)
            # Rejection receipts must provide an actionable next step.
            # Under transparent encryption, changing formats may be necessary rather than retrying DOCX generation.
            detail = (await session.execute(
                select(models.TaskEvent.detail).where(
                    models.TaskEvent.task_id == "essay-task",
                    models.TaskEvent.kind == "artifact.delivery_rejected"))).scalar_one()
            self.assertIn("改用纯文本/Markdown", str(detail))
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()


    async def test_partly_broken_delivery_still_delivers_valid_part(self):
        """Keep a corrupt file as evidence while valid same-turn outputs create a candidate version
        and review.
        """
        engine, sessions, session, task = await self._prepared()
        try:
            result = await conversation_turns.deliver_artifacts(
                session, task,
                conversation_id="conv-1", turn_id="turn-1", provider="conversation",
                files=[("修身养性作文.md", "正文八百字".encode("utf-8"), "text/markdown"),
                       ("修身养性作文.docx", b"not a zip",
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document")])
            self.assertTrue(result.get("ok"))
            requests = (await session.execute(select(am.ApprovalRequest).where(
                am.ApprovalRequest.task_id == "essay-task"))).scalars().all()
            self.assertEqual([r.action for r in requests], ["review"])
            self.assertEqual([r.status for r in requests], ["pending"])
            assignments = (await session.scalars(select(am.ApprovalAssignment).where(
                am.ApprovalAssignment.request_id == requests[0].id))).all()
            self.assertEqual([row.user_id for row in assignments], ["u-requester"])
            # Include valid files in the candidate manifest and retain corrupt files only as evidence.
            artifact = (await session.execute(select(am.ArtifactVersion).where(
                am.ArtifactVersion.task_id == "essay-task",
                am.ArtifactVersion.kind == "files"))).scalars().first()
            self.assertIsNotNone(artifact)
            names = json.dumps(artifact.manifest or {}, ensure_ascii=False)
            self.assertIn("修身养性作文.md", names)
            self.assertNotIn("修身养性作文.docx", names)
            kinds = [row[0] for row in (await session.execute(
                select(models.TaskEvent.kind).where(
                    models.TaskEvent.task_id == "essay-task"))).all()]
            self.assertIn("artifact.submitted_for_review", kinds)
            self.assertNotIn("artifact.delivery_rejected", kinds)
            # Record corrupt files accurately in the receipt for diagnosis.
            artifacts_event = (await session.execute(
                select(models.TaskEvent.detail).where(
                    models.TaskEvent.task_id == "essay-task",
                    models.TaskEvent.kind == "ai.artifacts"))).scalar_one()
            self.assertIn("压缩结构损坏", str(artifacts_event))
        finally:
            await session.__aexit__(None, None, None)
            await engine.dispose()

class ReworkPendingTests(unittest.IsolatedAsyncioTestCase):
    """Manual rework injects feedback and settles the pending card."""

    async def test_rework_pending_cleared_when_human_starts_new_turn(self):
        engine, sessions = await VersionBumpTests._session(self)
        try:
            async with sessions() as session:
                session.add(models.Client(id="device-owner", name="本机", user_ref="u-exec"))
                session.add(models.Task(
                    id="essay-task", title="写一篇作文", status="doing",
                    owner_client_id="device-owner",
                    work_routing={
                        "conversationTurn": {"turnId": "turn-1", "conversationId": "conv-1",
                                             "state": "completed", "executor": "native"},
                        "reworkPending": {"feedback": "AI味过于强烈，不够直白。", "actor": "王振义",
                                          "error": "这个本地会话已经不在了"}}))
                await session.commit()
                task = await session.get(models.Task, "essay-task")
                current = await conversation_turns.apply(session, task, {
                    "action": "prepare", "turnId": "turn-2", "conversationId": "conv-1",
                    "executor": "native"}, actor="native")
                self.assertEqual(current.get("state"), "queued")
                routing = dict((await session.get(models.Task, "essay-task")).work_routing or {})
                # Once manual rework starts, clear the card and begin the new turn normally.
                self.assertNotIn("reworkPending", routing)
                self.assertEqual(routing["conversationTurn"]["turnId"], "turn-2")
                kinds = [row[0] for row in (await session.execute(
                    select(models.TaskEvent.kind).where(
                        models.TaskEvent.task_id == "essay-task"))).all()]
                self.assertIn("ai.rework_taken", kinds)
        finally:
            await engine.dispose()


if __name__ == "__main__":
    unittest.main()
