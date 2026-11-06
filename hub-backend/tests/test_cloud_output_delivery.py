"""Isolated cloud bytes, digest propagation and explicit Git dispatch contracts."""
import hashlib
import io
import base64
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models, automation_models  # register metadata, no production startup
from app.db import Base
from app.schemas import attachment_to_api
from app.services import artifact_ingest, cloud_code_delivery, cloud_conversations, delivery_manifest, storage


class GitContextTests(unittest.IsolatedAsyncioTestCase):
    def test_explicit_repositories_and_code_intent(self):
        for url in ["https://github.com/acme/project", "https://git.example.invalid/group/project.git",
                    "ssh://git@git.example.invalid/group/project.git", "git@git.example.invalid:group/project.git"]:
            with self.subTest(url=url):
                self.assertEqual(cloud_code_delivery.repository("修复这个项目的登录错误 " + url), url)
        self.assertEqual(cloud_code_delivery.repository("Implement the requested feature https://github.com/acme/project"),
                         "https://github.com/acme/project")

    def test_ordinary_links_readonly_requests_credentials_and_ambiguous_repositories_stay_out(self):
        for text in ["分析 https://github.com/acme/project", "下载 https://docs.example.invalid/report.pdf",
                     "开发文档参考 https://docs.example.invalid/how/to/code", "只分析不要修改 https://github.com/acme/project",
                     "Review https://github.com/acme/project", "fix https://user:secret@example.invalid/group/repo.git",
                     "fix https://github.com/a/one and https://github.com/a/two",
                     "fix https://[invalid/group/repo.git", "fix https://github.com/a/repo/issues/3"]:
            with self.subTest(text=text):
                self.assertEqual(cloud_code_delivery.repository(text), "")

    async def test_dispatch_uses_existing_git_workflow_in_a_task_owned_workspace_and_returns_summary_metadata(self):
        row = SimpleNamespace(id="handoff", task_id="task-123", owner_client_id="device",
                              options={"instruction": "修复登录 https://git.example.invalid/team/app.git", "inputs": []})
        files, context = await cloud_conversations.dispatch_inputs(None, row, {})
        self.assertEqual(files, [])
        self.assertEqual(context["deliveryMode"], "git")
        self.assertEqual(context["repo"], context["workspace"]["repo"])
        self.assertEqual(context["repo"]["localDir"], "cloud-code-task-123")
        self.assertEqual(context["repo"]["branch"], "")
        self.assertNotIn("git", context)
        self.assertNotIn("workRoot", context["workspace"])
        self.assertEqual(context["codeDelivery"]["state"], "pending")
        self.assertIn("HEAD", context["brief"])
        self.assertIn("不得宣称已提交", context["brief"])
        self.assertIn("task-123", context["brief"])

    async def test_non_code_dispatch_retains_plain_instruction_and_no_git_side_effect_request(self):
        row = SimpleNamespace(id="handoff", task_id="task", owner_client_id="device",
                              options={"instruction": "分析 https://github.com/acme/project", "inputs": []})
        files, context = await cloud_conversations.dispatch_inputs(None, row, {})
        self.assertEqual(context["brief"], row.options["instruction"])
        self.assertNotIn("workspace", context)
        self.assertNotIn("deliveryMode", context)


class AttachmentOriginTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.root = tempfile.TemporaryDirectory(prefix="soduwork-cloud-ingest-")
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.session.add(models.Task(id="task", title="Cloud report", status="doing"))
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()
        self.root.cleanup()

    async def collect(self, local=False):
        wd = Path(self.root.name)
        (wd / "report.md").write_bytes(b"unrelated Hub file" if not local else b"local plaintext")
        remote = SimpleNamespace(PREFIX=artifact_ingest.REMOTE_PREFIX,
                                 fetch_attachment_for_sync=Mock(return_value=b"authorized remote bytes"))
        provider = artifact_ingest._ai_local if local else remote
        with patch.object(artifact_ingest, "last_dispatch_event", AsyncMock(return_value=None)), \
             patch.object(artifact_ingest, "_by_ref_async", AsyncMock(return_value=provider)), \
             patch.object(artifact_ingest, "_cfg_of", return_value={}), \
             patch.object(artifact_ingest, "runner_info_sync", return_value={"workDirAbs": str(wd)}) as info, \
             patch.object(storage, "put", return_value="local") as put:
            result = await artifact_ingest.pull_artifacts(self.session, "task", {}, {
                "attachments": [{"id": "report.md", "filename": "report.md"}],
                "identifier": "execution", "workDirAbs": str(wd), "round": 2,
            }, ref="execution", settle=False)
            self.assertEqual(result["files"], 1)
            data = put.call_args.args[1]
            self.assertEqual(info.call_count, 1 if local else 0)
            self.assertEqual(remote.fetch_attachment_for_sync.call_count, 0 if local else 1)
        row = (await self.session.execute(select(models.Attachment))).scalar_one()
        expected = hashlib.sha256(data).hexdigest()
        self.assertEqual(row.evidence_meta["sha256"], expected)
        self.assertEqual(row.evidence_meta["round"], 2)
        self.assertEqual(row.evidence_meta["category"], "primary")
        self.assertEqual(row.role, "output")
        self.assertEqual(attachment_to_api(row)["sha256"], expected)
        self.assertEqual(attachment_to_api(row)["category"], "primary")
        self.assertEqual(delivery_manifest.item_from_attachment(row)["sha256"], expected)
        return data

    async def test_remote_runner_workdir_never_reads_coincidentally_matching_hub_file(self):
        self.assertEqual(await self.collect(), b"authorized remote bytes")

    async def test_local_executor_keeps_authorized_plaintext_path(self):
        self.assertEqual(await self.collect(local=True), b"local plaintext")


class RequirementReviewTests(AttachmentOriginTests):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.session.add(models.User(id="reviewer", username="reviewer", is_active=True))
        self.task = await self.session.get(models.Task, "task")
        self.task.created_by = "reviewer"
        self.task.work_routing = {"executionSubmissionMode": "auto",
                                  "outputContract": {"kind": "office-artifact"}}
        await self.session.commit()

    async def pull(self, *, name="output/result.txt", settle=True, done=True, **status):
        remote = SimpleNamespace(PREFIX=artifact_ingest.REMOTE_PREFIX,
                                 fetch_attachment_for_sync=Mock(return_value=b"verified result"))
        with patch.object(artifact_ingest, "last_dispatch_event", AsyncMock(return_value=None)), \
             patch.object(artifact_ingest, "_by_ref_async", AsyncMock(return_value=remote)), \
             patch.object(artifact_ingest, "_cfg_of", return_value={}), \
             patch.object(storage, "put", return_value="local"), \
             patch("app.services.code_delivery.notify_reviewer", new_callable=AsyncMock), \
             patch("app.services.task_access.publish_task", new_callable=AsyncMock), \
             patch("app.services.tasks.task_to_api_live", new_callable=AsyncMock, return_value={}):
            return await artifact_ingest.pull_artifacts(self.session, "task", {}, {
                "done": done, "attachments": [{"id": name, "filename": name}],
                "identifier": "execution", "round": 1, **status,
            }, ref="execution", settle=settle)

    async def reviews(self):
        return list((await self.session.scalars(select(automation_models.ApprovalRequest))).all())

    async def test_completed_nested_document_opens_one_review_and_keeps_human_acceptance(self):
        await self.pull()
        await self.pull()
        reviews = await self.reviews()
        self.assertEqual(len(reviews), 1)
        self.assertEqual(reviews[0].status, "pending")
        self.assertEqual(reviews[0].action, "review")
        self.assertEqual(self.task.status, "doing")
        self.assertIsNone(self.task.reviewed_at)
        from app.services import task_requirement_projection
        api = (await task_requirement_projection.decorate_many(
            self.session, [self.task], [{}]))[0]
        self.assertEqual(api["requirementStage"], "reviewing")
        versions = list((await self.session.scalars(select(automation_models.ArtifactVersion))).all())
        self.assertEqual(len(versions), 1)
        self.assertEqual(versions[0].manifest["primary"][0]["name"], "output/result.txt")

    async def test_existing_receipt_is_reconciled_without_uploading_again(self):
        await self.pull(settle=False)
        self.assertEqual(await self.reviews(), [])
        result = await self.pull()
        self.assertEqual(result["files"], 0)
        self.assertEqual(len(await self.reviews()), 1)
        self.assertEqual(len(list((await self.session.scalars(select(models.Attachment))).all())), 1)

    async def reject_current(self):
        from app.services import release_control
        artifact = await release_control.latest_artifact(self.session, self.task.id)
        reviewer = await self.session.get(models.User, "reviewer")
        result = await release_control.decide(self.session, self.task, reviewer,
            action="review", decision="reject", note="Revise the report",
            artifact_version_id=artifact.id)
        self.assertTrue(result["ok"], result)
        return artifact

    async def test_late_files_from_rejected_round_do_not_resubmit_on_status_refresh(self):
        await self.pull()
        rejected = await self.reject_current()
        for _ in range(2):
            await self.pull(name="output/late.txt")
        reviews = await self.reviews()
        self.assertEqual([(row.artifact_version_id, row.status) for row in reviews],
                         [(rejected.id, "rejected")])
        self.assertEqual(len(list((await self.session.scalars(
            select(automation_models.ArtifactVersion))).all())), 1)

    async def test_reported_new_round_without_authorized_execution_cannot_resubmit(self):
        await self.pull()
        rejected = await self.reject_current()
        await self.pull(round=2)
        self.assertEqual([(row.artifact_version_id, row.status) for row in await self.reviews()],
                         [(rejected.id, "rejected")])

    async def test_executor_acknowledgement_unblocks_only_new_delivery(self):
        from datetime import datetime, timezone, timedelta
        from app.services import task_rework
        await self.pull()
        artifact = await self.reject_current()
        review = (await self.reviews())[0]
        await task_rework.resume_after_rejection(self.session, self.task, "Revise",
            artifact_version_id=artifact.id, request_id=review.id, wait_for_executor=True)
        boundary = review.resolved_at.replace(tzinfo=timezone.utc)
        for ref, submitted_at in [("execution", boundary - timedelta(seconds=1)),
                                   ("wrong-source", datetime.now(timezone.utc))]:
            self.assertFalse(await task_rework.acknowledge_continuation(
                self.session, self.task.id, ref, submitted_at))
            self.assertIn("reworkPending", self.task.work_routing)
        await self.pull(round=2)
        self.assertEqual([row.status for row in await self.reviews()], ["rejected"])
        self.assertTrue(await task_rework.acknowledge_continuation(
            self.session, self.task.id, "execution", datetime.now(timezone.utc)))
        await self.session.commit()
        self.assertNotIn("reworkPending", self.task.work_routing)
        self.assertFalse(await task_rework.acknowledge_continuation(
            self.session, self.task.id, "execution", datetime.now(timezone.utc)))
        await self.pull(name="output/late.txt")
        self.assertEqual([row.status for row in await self.reviews()], ["rejected"])
        await self.pull(round=2)
        await self.pull(round=2)
        self.assertEqual(sorted(row.status for row in await self.reviews()), ["pending", "rejected"])

    async def test_controlled_runner_revision_collects_new_files_after_each_accepted_turn(self):
        from datetime import datetime, timezone
        from app.services import conversation_turns, task_rework
        await self.pull()
        self.task.work_routing = {**self.task.work_routing, "conversationTurn": {
            "conversationId": "chat", "turnId": "first", "executor": "dispatch", "state": "completed"}}
        self.session.add(models.TaskEvent(task_id=self.task.id, kind="ai.dispatched",
                                         detail={"ref": "execution"}))
        self.session.add(automation_models.ExecutionSession(task_id=self.task.id,
            ref="execution", state="done"))
        await self.session.commit()
        for index in (2, 3):
            artifact = await self.reject_current()
            review = next(row for row in await self.reviews() if row.artifact_version_id == artifact.id)
            await task_rework.resume_after_rejection(self.session, self.task, "Revise",
                artifact_version_id=artifact.id, request_id=review.id, wait_for_executor=True)
            body = {"action": "prepare", "conversationId": "chat", "turnId": f"revision-{index}",
                    "executor": "dispatch", "continuationRef": "execution"}
            await conversation_turns.apply(self.session, self.task, body)
            await self.session.commit()
            await self.pull(round=index)
            self.assertFalse(any(row.status == "pending" for row in await self.reviews()))
            await conversation_turns.apply(self.session, self.task, {**body, "action": "start"})
            self.assertTrue(await task_rework.acknowledge_continuation(
                self.session, self.task.id, "execution", datetime.now(timezone.utc),
                conversation_id="chat", turn_id=body["turnId"], message_id=f"send-{index}"))
            await self.session.commit()
            await self.pull(round=index - 1)
            self.assertFalse(any(row.status == "pending" for row in await self.reviews()))
            await self.pull(round=index)
            await self.pull(round=index)
            await conversation_turns.apply(self.session, self.task, {**body, "action": "complete"})
            reviews = await self.reviews()
            self.assertEqual(sum(row.status == "pending" for row in reviews), 1)
            self.assertEqual(len(reviews), index)
            latest = await self.session.get(automation_models.ArtifactVersion,
                next(row.artifact_version_id for row in reviews if row.status == "pending"))
            self.assertEqual(latest.manifest["primary"][0]["round"], index)
            self.assertEqual(latest.manifest["primary"][0]["sha256"],
                             hashlib.sha256(b"verified result").hexdigest())

    async def test_legacy_native_rejection_requires_admission_before_restored_runner_collection(self):
        from datetime import datetime, timezone
        from app.services import conversation_turns, task_rework, release_control
        await self.pull()
        await release_control.ensure_output_candidate(self.session, self.task,
            {"schemaVersion": delivery_manifest.SCHEMA_VERSION, "complete": True,
             "manual": True, "files": [], "primary": [], "supporting": [], "evidence": [],
             "internal": [], "problems": [], "summary": "Legacy manual submission"}, "conversation:chat")
        await self.session.commit()
        await self.reject_current()
        # Simulate a completed legacy native follow-up that consumed its marker
        # but wrote into the original Runner directory instead of its own cwd.
        self.task.work_routing = {**self.task.work_routing, "conversationTurn": {
            "conversationId": "chat", "turnId": "legacy", "executor": "native", "state": "completed"}}
        self.session.add(models.TaskEvent(task_id=self.task.id, kind="ai.dispatched",
                                         detail={"ref": "execution"}))
        self.session.add(automation_models.ExecutionSession(task_id=self.task.id,
            ref="execution", state="done"))
        await self.session.commit()
        body = {"action": "prepare", "conversationId": "chat", "turnId": "restore",
                "executor": "dispatch", "continuationRef": "execution"}
        await conversation_turns.apply(self.session, self.task, body)
        await self.session.commit()
        await self.pull(round=2)
        self.assertFalse(any(row.status == "pending" for row in await self.reviews()))
        await conversation_turns.apply(self.session, self.task, {**body, "action": "start"})
        submitted_at = datetime.now(timezone.utc)
        self.assertTrue(await task_rework.acknowledge_continuation(
            self.session, self.task.id, "execution", submitted_at,
            conversation_id="chat", turn_id="restore", message_id="restore-send"))
        await self.session.commit()
        await self.pull(round=1)
        self.assertFalse(any(row.status == "pending" for row in await self.reviews()))
        await self.pull(round=2)
        self.assertEqual(sum(row.status == "pending" for row in await self.reviews()), 1)
        await self.reject_current()
        self.assertFalse(await task_rework.acknowledge_continuation(
            self.session, self.task.id, "execution", submitted_at,
            conversation_id="chat", turn_id="restore", message_id="restore-send"))
        await self.pull(round=3)
        self.assertFalse(any(row.status == "pending" for row in await self.reviews()))

    async def start_rework(self, ref="execution"):
        self.session.add(models.TaskEvent(task_id=self.task.id, kind="ai.rework",
                                          detail={"ref": ref}))
        await self.session.commit()

    async def test_started_rework_requires_new_round_and_submits_exactly_once(self):
        await self.pull()
        rejected = await self.reject_current()
        await self.start_rework()
        await self.pull(name="output/late.txt")
        self.assertEqual([row.status for row in await self.reviews()], ["rejected"])
        await self.pull(round=2)
        await self.pull(round=2)
        reviews = await self.reviews()
        self.assertEqual(sorted(row.status for row in reviews), ["pending", "rejected"])
        self.assertEqual(next(row for row in reviews if row.status == "rejected").artifact_version_id, rejected.id)

    async def test_newer_execution_prevents_previous_source_from_resubmitting(self):
        await self.pull()
        await self.reject_current()
        await self.start_rework()
        await self.start_rework(ref="different-execution")
        await self.pull(round=2)
        self.assertEqual([row.status for row in await self.reviews()], ["rejected"])

    async def test_pending_rework_blocks_new_receipts_even_after_older_start(self):
        await self.pull()
        await self.reject_current()
        await self.start_rework()
        self.task.work_routing = {**self.task.work_routing,
                                  "reworkPending": {"state": "failed", "feedback": "Revise"}}
        await self.session.commit()
        await self.pull(round=2)
        self.assertEqual([row.status for row in await self.reviews()], ["rejected"])

    async def test_explicit_manual_submission_after_rejection_is_still_allowed(self):
        from app.services import release_control
        await self.pull()
        await self.reject_current()
        await self.pull(name="output/revised.txt", settle=False, round=2)
        await release_control.ensure_current_output(self.session, self.task, source_ref="execution", who="executor")
        self.assertEqual(sorted(row.status for row in await self.reviews()), ["pending", "rejected"])

    async def test_manual_submission_keeps_outputs_without_review(self):
        self.task.work_routing = {**self.task.work_routing, "executionSubmissionMode": "manual"}
        await self.session.commit()
        await self.pull()
        self.assertEqual(await self.reviews(), [])

    async def test_partial_or_missing_output_does_not_open_review(self):
        await self.pull(done=False)
        self.assertEqual(await self.reviews(), [])
        await self.pull(artifactsDropped=1)
        self.assertEqual(await self.reviews(), [])

    async def test_assets_and_evidence_alone_are_not_primary_deliverables(self):
        for name in ("assets/theme.css", "assets/photo.png", "proof/result.txt", ".cache/result.txt"):
            with self.subTest(name=name):
                await self.pull(name=name)
                self.assertEqual(await self.reviews(), [])

    async def website(self, *, settle=True, files=None):
        files = files or {"index.html": b"<!doctype html><html><body>Site</body></html>",
                          "src/partials/header.html": b"<header><nav>Home</nav></header>",
                          "src/partials/footer.html": b"<footer>Contact</footer>",
                          "shots/home.png": base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")}
        self.blobs = getattr(self, "blobs", {})
        def put(key, data, _type):
            self.blobs[key] = data
            return "local"
        remote = SimpleNamespace(PREFIX=artifact_ingest.REMOTE_PREFIX,
                                 fetch_attachment_for_sync=lambda _cfg, _ref, name: files[name])
        with patch.object(artifact_ingest, "last_dispatch_event", AsyncMock(return_value=None)), \
             patch.object(artifact_ingest, "_by_ref_async", AsyncMock(return_value=remote)), \
             patch.object(artifact_ingest, "_cfg_of", return_value={}), \
             patch.object(storage, "put", side_effect=put), \
             patch.object(storage, "open_stream", side_effect=lambda key, _backend: io.BytesIO(self.blobs[key])), \
             patch("app.services.code_delivery.notify_reviewer", new_callable=AsyncMock), \
             patch("app.services.task_access.publish_task", new_callable=AsyncMock), \
             patch("app.services.task_access.publish_owner", new_callable=AsyncMock), \
             patch("app.services.tasks.task_to_api_live", new_callable=AsyncMock, return_value={}):
            return await artifact_ingest.pull_artifacts(self.session, "task", {}, {
                "done": True, "round": 1, "attachments": [{"id": name, "filename": name} for name in files],
            }, ref="website", settle=settle)

    async def test_website_components_pass_but_screenshots_are_not_deliverables(self):
        result = await self.website()
        self.assertEqual(result["invalid"], [])
        self.assertEqual(len(await self.reviews()), 1)
        artifact = await self.session.scalar(select(automation_models.ArtifactVersion))
        self.assertEqual({item["name"] for item in artifact.manifest["primary"]}, {"index.html"})
        self.assertEqual({item["name"] for item in artifact.manifest["supporting"]},
                         {"src/partials/header.html", "src/partials/footer.html"})
        shot = await self.session.scalar(select(models.Attachment).where(models.Attachment.filename == "shots/home.png"))
        self.assertEqual(shot.role, "verification")
        self.assertEqual(self.task.status, "doing", "Review never accepts the task automatically")

    async def seed_legacy_component_failure(self):
        await self.website(settle=False)
        row = await self.session.scalar(select(models.Attachment).where(models.Attachment.filename == "src/partials/header.html"))
        failure = {"state": "failed", "reason": "HTML 缺少可识别的页面结构"}
        row.evidence_meta = {**row.evidence_meta, "verification": failure}
        event = await self.session.scalar(select(models.TaskEvent).where(models.TaskEvent.kind == artifact_ingest.EV_ARTIFACTS))
        event.detail = {**event.detail, "invalid": [{"name": row.filename, "reason": failure["reason"]}]}
        await self.session.commit()
        return row

    async def test_existing_false_negative_rechecks_persisted_bytes_and_settles_once(self):
        row = await self.seed_legacy_component_failure()
        result = await self.website()
        self.assertEqual(result["files"], 0)
        self.assertEqual(result["invalid"], [])
        self.assertEqual(row.evidence_meta["verification"]["state"], "passed")
        self.assertEqual(row.evidence_meta["previousVerification"]["state"], "failed")
        await self.website()
        self.assertEqual(len(await self.reviews()), 1)

    async def test_repair_does_not_trust_changed_bytes_or_manual_submission(self):
        row = await self.seed_legacy_component_failure()
        self.blobs[row.storage_key] = b"<header>Changed bytes</header>"
        result = await self.website()
        self.assertTrue(result["submissionError"])
        self.assertEqual(row.evidence_meta["verification"]["state"], "failed")
        self.assertEqual(await self.reviews(), [])
        await self.website()
        failures = list((await self.session.scalars(select(models.TaskEvent).where(
            models.TaskEvent.kind == "artifact.delivery_rejected"))).all())
        self.assertEqual(len(failures), 1, "Background retries must not repeat the same warning")

    async def test_primary_page_and_archives_still_require_valid_structure(self):
        for name, data in [("index.html", b"<header>Not a full page</header>"), ("site.zip", b"not a ZIP")]:
            result = await self.website(files={name: data})
            self.assertTrue(result["invalid"])
            self.assertTrue(result["submissionError"])
            self.assertEqual(await self.reviews(), [])

    async def test_component_recheck_keeps_failed_verification_when_storage_is_unavailable(self):
        from app.services import delivery_validation
        from urllib3.exceptions import HTTPError
        row = await self.seed_legacy_component_failure()
        with patch.object(storage, "open_stream", side_effect=HTTPError("Storage unavailable")):
            self.assertEqual(await delivery_validation.recheck_components(self.session, self.task.id), set())
        self.assertEqual(row.evidence_meta["verification"]["state"], "failed")
        self.assertEqual(await self.reviews(), [])

    async def test_valid_components_do_not_override_explicit_manual_mode(self):
        self.task.work_routing = {**self.task.work_routing, "executionSubmissionMode": "manual"}
        await self.session.commit()
        await self.website()
        self.assertEqual(await self.reviews(), [])

    def test_explicit_primary_html_cannot_use_component_validation(self):
        data = b"<header>Component</header>"
        self.assertEqual(delivery_manifest.validate_bytes("src/header.html", data)["state"], "passed")
        self.assertEqual(delivery_manifest.validate_bytes("src/header.html", data, category="primary")["state"], "failed")
        self.assertEqual(delivery_manifest.validate_bytes("src/header.html", b"<!-- <header> -->")["state"], "failed")


if __name__ == "__main__":
    unittest.main()
