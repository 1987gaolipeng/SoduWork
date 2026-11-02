"""Manual review must retain the producing conversation through rejection."""
import copy
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
# Completion touches project memories even when the task has no project.
from app import project_context_models as _project_context_models
from app.db import Base
from app.services import delivery_manifest, release_control, task_rework


def file_record(ref="conversation:original", **changes):
    return {"id": "output-1", "name": "report.md", "role": "output",
            "category": "primary", "sourceRef": ref, "sha256": "a" * 64,
            "validation": {"state": "passed"}, **changes}


class ManualReviewSource(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def fixture(self, session):
        session.add_all([
            models.User(id="worker", username="worker", display_name="执行人"),
            models.User(id="reviewer", username="reviewer", display_name="提出人"),
            models.Client(id="worker-device", name="执行机", user_ref="worker"),
            models.Client(id="review-device", name="验收机", user_ref="reviewer"),
        ])
        task = models.Task(id="manual-task", title="整理报告", status="doing",
                           triage_stage="ready", owner_client_id="worker-device",
                           created_by="reviewer", assignee_user_id="worker",
                           work_routing={"executionSubmissionMode": "manual",
                                         "conversationTurn": {"conversationId": "original",
                                                              "state": "completed"}})
        session.add(task)
        session.add(models.Attachment(id="output-1", task_id=task.id,
            filename="report.md", content_type="text/markdown", size=10,
            storage_key="test/report.md", backend="local", role="output",
            source_ref="conversation:original", uploaded_by="agent:conversation",
            evidence_meta={"sha256": "a" * 64, "round": 1,
                           "category": "primary", "verification": {"state": "passed"}}))
        await session.commit()
        return task

    async def test_manual_submit_and_reject_preserve_native_rework_entry(self):
        from app.api import approvals, tasks
        from app.realtime import hub
        async with self.sessions() as session:
            task = await self.fixture(session)
            with patch.object(hub, "publish", new=AsyncMock()):
                submitted = await tasks.submit_task_for_review(task.id, {},
                    await session.get(models.Client, "worker-device"), session)
                artifact = await session.scalar(select(am.ArtifactVersion))
                self.assertEqual(artifact.source_ref, "conversation:original")
                rejected = await approvals.decide(submitted["request"]["id"],
                    {"decision": "reject", "note": "补充修订说明"},
                    await session.get(models.Client, "review-device"), session)
            self.assertFalse(rejected["rework"]["started"])
            pending = task.work_routing["reworkPending"]
            self.assertEqual(pending["ref"], "conversation:original")
            self.assertEqual(pending["feedback"], "补充修订说明")

    async def test_empty_delivery_can_be_explicitly_submitted_but_not_automatically(self):
        from app.api import approvals, tasks
        from app.realtime import hub
        from app.services import gate_contract, task_acceptance_review, task_requirements, tasks as task_service
        async with self.sessions() as session:
            task = await self.fixture(session)
            await session.delete(await session.get(models.Attachment, "output-1"))
            task.work_routing = {**task.work_routing, "executionSubmissionMode": "auto",
                                 "outputContract": {"expectedArtifacts": ["report.html"]}}
            await session.commit()
            with self.assertRaises(ValueError):
                await release_control.ensure_current_output(session, task)
            worker = await session.get(models.Client, "worker-device")
            creator = await session.get(models.Client, "review-device")
            api = await task_requirements.decorate(session, worker, task,
                await task_service.task_to_api_live(session, task))
            self.assertTrue(api["canSubmitReview"])
            with self.assertRaises(HTTPException) as denied:
                await tasks.submit_task_for_review(task.id, {}, creator, session)
            self.assertEqual(denied.exception.status_code, 403)
            with patch.object(hub, "publish", new=AsyncMock()):
                submitted = await tasks.submit_task_for_review(task.id, {}, worker, session)
                retry = await tasks.submit_task_for_review(task.id, {}, worker, session)
            self.assertEqual(submitted["task"]["requirementStage"], "reviewing")
            self.assertTrue(retry["already"])
            versions = list(await session.scalars(select(am.ArtifactVersion)))
            self.assertEqual(len(versions), 1)
            self.assertTrue(versions[0].manifest["manual"])
            for client, review in [(creator, True), (worker, False)]:
                api = await task_requirements.decorate(session, client, task,
                    await task_service.task_to_api_live(session, task))
                self.assertEqual(api["canReview"], review)
                self.assertFalse(api["canSubmitReview"])
            task.acceptance_criteria = ["结果符合需求"]
            await session.commit()
            packet = await task_acceptance_review.context(session, creator, task.id)
            self.assertTrue(packet["readiness"]["canApprove"])
            self.assertTrue(packet["readiness"]["requiresHumanConfirmation"])
            self.assertEqual(packet["evidence"], [])
            with self.assertRaises(HTTPException) as automatic:
                await task_acceptance_review.apply(session, creator, task.id, {
                    "approvalId": packet["approvalId"], "artifactVersionId": packet["artifactVersionId"],
                    "requirementVersion": packet["requirementVersion"], "report": {
                        "verdict": "approve", "summary": "No files to check", "checks": [
                            {"criterion": "criterion-1", "result": "pass", "evidence": "Only the submission receipt exists"}]}})
            self.assertEqual(automatic.exception.status_code, 422)
            request = await session.get(am.ApprovalRequest, submitted["request"]["id"])
            request.context = {**request.context, "requiredEvidence": ["image"]}
            required = await gate_contract.packet(session, task, request, versions[0])
            self.assertFalse(required["readiness"]["canApprove"])
            request.context = {key: value for key, value in request.context.items() if key != "requiredEvidence"}
            with patch.object(hub, "publish", new=AsyncMock()):
                approved = await approvals.decide(request.id, {"decision": "approve", "note": "已人工核实实际结果"}, creator, session)
            self.assertTrue(approved["ok"])
            self.assertTrue(task.reviewed_at)
            self.assertEqual(task.status, "done")

    async def test_submission_rejects_live_or_unknown_execution_and_non_doing_tasks(self):
        from app.api import tasks
        async with self.sessions() as session:
            task = await self.fixture(session)
            worker = await session.get(models.Client, "worker-device")
            for state in ["queued", "running", "waiting", "paused", "unknown"]:
                task.work_routing = {"conversationTurn": {"conversationId": "original", "state": state}}
                await session.commit()
                with self.subTest(state=state), self.assertRaises(HTTPException) as denied:
                    await tasks.submit_task_for_review(task.id, {}, worker, session)
                self.assertEqual(denied.exception.status_code, 409)
            task.work_routing = {"conversationTurn": {"state": "completed"}}
            for status in ["todo", "paused", "done", "cancel"]:
                task.status = status
                await session.commit()
                with self.subTest(status=status), self.assertRaises(HTTPException) as denied:
                    await tasks.submit_task_for_review(task.id, {}, worker, session)
                self.assertEqual(denied.exception.status_code, 409)
            self.assertIsNone(await session.scalar(select(am.ApprovalRequest)))

    async def test_revised_html_is_the_only_current_output_in_manual_acceptance(self):
        from app.api import tasks
        from app.realtime import hub
        from app.services import task_acceptance_review
        async with self.sessions() as session:
            task = await self.fixture(session)
            session.add(models.Attachment(id="output-html", task_id=task.id,
                filename="report.html", content_type="text/html", size=20,
                storage_key="test/report.html", backend="local", role="output",
                source_ref="conversation:original", uploaded_by="agent:conversation",
                evidence_meta={"sha256": "b" * 64, "round": 2,
                               "category": "primary", "verification": {"state": "passed"}}))
            await session.commit()
            with patch.object(hub, "publish", new=AsyncMock()):
                await tasks.submit_task_for_review(task.id, {},
                    await session.get(models.Client, "worker-device"), session)
            packet = await task_acceptance_review.context(session,
                await session.get(models.Client, "review-device"), task.id)
            self.assertEqual(packet["attachmentIds"], ["output-html"])
            self.assertEqual([row["name"] for row in packet["artifact"]["manifest"]["files"]], ["report.html"])
            self.assertTrue(packet["canDecide"])
            self.assertNotIn("report.md", str(packet["evidence"]))
            # Legacy requests may have frozen every file from the conversation.
            # Read-time scoping must preserve the version without replaying old outputs.
            request = await session.scalar(select(am.ApprovalRequest))
            request.context = {**request.context, "gate": {**request.context["gate"],
                "evidenceRefs": ["output-1", "output-html"]}}
            await session.commit()
            packet = await task_acceptance_review.context(session,
                await session.get(models.Client, "review-device"), task.id)
            self.assertEqual(packet["attachmentIds"], ["output-html"])
            self.assertNotIn("report.md", str(packet["evidence"]))

    async def test_legacy_locked_manifest_recovers_without_mutating_version(self):
        from app.services import ai_exec
        async with self.sessions() as session:
            task = await self.fixture(session)
            manifest = {"complete": True, "files": [file_record()]}
            artifact = am.ArtifactVersion(id="legacy-v1", task_id=task.id,
                seq=1, kind="files", checksum="unchanged", source_ref="", manifest=manifest)
            session.add(artifact)
            await session.commit()
            before = copy.deepcopy(artifact.manifest)
            with patch.object(ai_exec, "last_dispatch_event", new=AsyncMock(
                    return_value=SimpleNamespace(detail={"ref": "runner:unrelated-newer"}))), \
                    patch.object(ai_exec, "say_sync", side_effect=AssertionError("Must not resume a different Runner")):
                result = await task_rework.resume_after_rejection(session, task,
                    "保留原文并补充修订说明", artifact_version_id=artifact.id, request_id="legacy-review")
            self.assertEqual(result.get("ref"), "conversation:original")
            self.assertEqual(task.work_routing["reworkPending"]["ref"], "conversation:original")
            self.assertEqual(artifact.source_ref, "")
            self.assertEqual(artifact.checksum, "unchanged")
            self.assertEqual(artifact.manifest, before)

    async def test_ambiguous_manifest_does_not_borrow_newer_dispatch(self):
        from app.services import ai_exec
        async with self.sessions() as session:
            task = await self.fixture(session)
            artifact = am.ArtifactVersion(id="mixed-v1", task_id=task.id, seq=1,
                kind="files", checksum="mixed", source_ref="", manifest={"complete": True,
                "files": [file_record(), file_record("conversation:other", id="output-2")]})
            session.add(artifact)
            await session.commit()
            with patch.object(ai_exec, "last_dispatch_event", new=AsyncMock(
                    return_value=SimpleNamespace(detail={"ref": "runner:unrelated-newer"}))), \
                    patch.object(ai_exec, "say_sync", side_effect=AssertionError("Ambiguous delivery cannot choose a Runner")):
                result = await task_rework.resume_after_rejection(session, task,
                    "修改成果", artifact_version_id=artifact.id, request_id="mixed-review")
            self.assertFalse(result["started"])
            self.assertFalse(result.get("ref"))

    async def test_legacy_rejected_task_projects_feedback_without_writing_history(self):
        from app.services import tasks
        async with self.sessions() as session:
            task = await self.fixture(session)
            now = datetime.now(timezone.utc)
            artifact = am.ArtifactVersion(id="old-v1", task_id=task.id, seq=1,
                kind="files", state="rejected", checksum="fixed", source_ref="",
                manifest={"complete": True, "files": [file_record()]})
            request = am.ApprovalRequest(id="old-review", task_id=task.id,
                artifact_version_id=artifact.id, action="review", status="rejected",
                required_count=1, resolved_at=now)
            decision = am.ApprovalDecision(request_id=request.id, user_id="reviewer",
                user_name="提出人", decision="reject", note="保留原文并补充修订说明", created_at=now)
            session.add_all([artifact, request, decision])
            # Rejection itself can reopen the task; that event is not a continuation.
            session.add(models.TaskEvent(task_id=task.id, kind="task.execution_started",
                detail={}, at=now+timedelta(milliseconds=1)))
            await session.commit()
            original_routing = copy.deepcopy(task.work_routing)
            api = await tasks.task_to_api_live(session, task)
            pending = api["workRouting"].get("reworkPending") or {}
            self.assertEqual(pending.get("feedback"), decision.note)
            self.assertEqual(pending.get("ref"), "conversation:original")
            self.assertEqual(pending.get("requestId"), request.id)
            self.assertEqual(task.work_routing, original_routing)
            self.assertEqual(artifact.source_ref, "")
            self.assertEqual(artifact.checksum, "fixed")
            self.assertFalse(session.dirty)
            # An explicit pool return must never be presented as automatic rework.
            pool_return = models.TaskEvent(task_id=task.id, kind="review.returned_to_backlog",
                detail={"requestId": request.id}, at=now+timedelta(seconds=1))
            session.add(pool_return)
            await session.commit()
            returned = await tasks.task_to_api_live(session, task)
            self.assertNotIn("reworkPending", returned["workRouting"])
            await session.delete(pool_return)
            await session.commit()
            # Even a rejected version cannot prove which native conversation to use if mixed.
            original_manifest = copy.deepcopy(artifact.manifest)
            artifact.manifest = {"complete": True, "files": [file_record(), file_record("conversation:other")]}
            await session.commit()
            ambiguous = await tasks.task_to_api_live(session, task)
            self.assertNotIn("reworkPending", ambiguous["workRouting"])
            artifact.manifest = original_manifest
            await session.commit()
            # A user continuation supersedes this historical UI context.
            session.add(models.TaskEvent(task_id=task.id, kind="conversation.turn",
                detail={"state": "queued", "conversationId": "other"},
                at=now+timedelta(seconds=1)))
            await session.commit()
            refreshed=await tasks.task_to_api_live(session, task)
            self.assertNotIn("reworkPending", refreshed["workRouting"])

    async def test_legacy_projection_does_not_override_new_review_or_existing_context(self):
        from app.services import tasks
        async with self.sessions() as session:
            task = await self.fixture(session)
            now = datetime.now(timezone.utc)
            artifact = am.ArtifactVersion(id="old-v1", task_id=task.id, seq=1,
                kind="files", state="rejected", checksum="fixed", source_ref="",
                manifest={"complete": True, "files": [file_record()]})
            old=am.ApprovalRequest(id="old-review", task_id=task.id,
                artifact_version_id=artifact.id, action="review", status="rejected",
                required_count=1, created_at=now-timedelta(seconds=1),resolved_at=now)
            session.add_all([artifact,old,am.ApprovalDecision(request_id=old.id,
                user_id="reviewer",decision="reject",note="old feedback",created_at=now)])
            await session.commit()
            task.work_routing={**task.work_routing,"reworkPending":{"feedback":"existing authoritative context"}}
            await session.commit()
            api=await tasks.task_to_api_live(session,task)
            self.assertEqual(api["workRouting"]["reworkPending"]["feedback"],"existing authoritative context")
            task.work_routing={"executionSubmissionMode":"manual"}
            session.add(am.ApprovalRequest(id="new-review",task_id=task.id,
                artifact_version_id=artifact.id,action="review",status="pending",required_count=1,
                created_at=now+timedelta(seconds=1)))
            await session.commit()
            api=await tasks.task_to_api_live(session,task)
            self.assertNotIn("reworkPending",api["workRouting"])


class ManifestSource(unittest.TestCase):
    def test_only_unique_verified_output_source_is_inferred(self):
        cases = [
            ({"complete": True, "files": [file_record()]}, "conversation:original"),
            ({"complete": True, "files": [file_record("runner:remote")]}, "runner:remote"),
            ({"complete": True, "files": [file_record(), file_record(id="output-2")]}, "conversation:original"),
            ({"complete": True, "files": [file_record(), file_record("conversation:other")]}, ""),
            ({"complete": True, "files": [file_record(), file_record("")]}, ""),
            ({"complete": True, "files": [file_record(role="input")]}, ""),
            ({"complete": True, "files": [file_record(validation={"state": "failed"})]}, ""),
            ({"complete": False, "files": [file_record()]}, ""),
            ({"complete": True, "files": [file_record(sha256="")]}, ""),
            ({"complete": True, "files": []}, ""),
        ]
        for manifest, expected in cases:
            with self.subTest(manifest=manifest):
                self.assertEqual(delivery_manifest.unique_output_source(manifest), expected)
