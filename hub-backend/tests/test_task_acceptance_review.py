"""AI acceptance requires itemized evidence; attachment existence alone does not establish success.

"""
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import tasks as api
from app.db import Base


class AcceptanceReviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.actor = models.User(id="reviewer", username="reviewer", display_name="验收人")
        self.client = models.Client(id="review-device", user_ref="reviewer")
        self.task = models.Task(id="review-task", title="写作文", status="done",
                                created_by="reviewer", owner_client_id="review-device",
                                acceptance_criteria=["包含主题", "字数达标"])
        self.artifact = am.ArtifactVersion(id="artifact-1", task_id=self.task.id, seq=1,
            kind="output", checksum="fixed-checksum", state="candidate",
            manifest={"schemaVersion": "soduwork.delivery/1", "complete": True,
                      "primary": [], "problems": [], "text": "一篇待审阅的作文"})
        self.request = am.ApprovalRequest(id="approval-1", task_id=self.task.id,
            artifact_version_id=self.artifact.id, action="review", status="pending",
            required_count=1, policy_snapshot={"separationOfDuties": False},
            context={"acceptanceCriteria": ["包含主题", "字数达标"]})
        self.session.add_all([self.actor, self.client, self.task, self.artifact, self.request,
            am.ApprovalAssignment(request_id=self.request.id, user_id=self.actor.id)])
        await self.session.commit()
        self.publish = patch("app.services.task_access.publish_task", new_callable=AsyncMock)
        self.notify = patch("app.services.receipts.notify_on_close", new_callable=AsyncMock)
        self.publish_mock = self.publish.start()
        self.notify_mock = self.notify.start()

    async def asyncTearDown(self):
        self.publish.stop()
        self.notify.stop()
        await self.session.close()
        await self.engine.dispose()

    def body(self, verdict="approve"):
        return {"approvalId": "approval-1", "artifactVersionId": "artifact-1",
                "requirementVersion": 1, "report": {"verdict": verdict,
                    "summary": "已逐项复核作文", "checks": [
                        {"criterion": "criterion-1", "result": "pass", "evidence": "正文第 1 段围绕主题展开"},
                        {"criterion": "criterion-2", "result": "pass" if verdict == "approve" else "fail",
                         "evidence": "统计正文汉字得到 410 字"}]}}

    async def test_missing_report_never_approves_existing_file(self):
        with self.assertRaises(HTTPException) as caught:
            await api.auto_review_task_artifact(self.task.id, {}, self.client, self.session)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(self.request.status, "pending")
        self.assertIsNone(self.task.reviewed_at)

    async def context(self):
        return await api.task_acceptance_context(self.task.id, self.client, self.session)

    async def test_context_is_read_only_and_carries_fixed_version(self):
        before = len((await self.session.execute(select(am.ApprovalRequest))).scalars().all())
        value = await self.context()
        self.assertEqual(value["approvalId"], "approval-1")
        self.assertEqual(value["artifactVersionId"], "artifact-1")
        self.assertEqual([x["label"] for x in value["criteria"]], ["包含主题", "字数达标"])
        self.assertTrue(value["canDecide"])
        self.assertEqual(before, len((await self.session.execute(select(am.ApprovalRequest))).scalars().all()))
        self.assertIsNone(self.task.reviewed_at)

    async def test_direct_creator_context_does_not_create_ticket(self):
        await self.session.delete(self.request)
        await self.session.commit()
        value = await self.context()
        self.assertEqual(value["approvalId"], "direct:review-task")
        self.assertEqual(len((await self.session.execute(select(am.ApprovalRequest))).scalars().all()), 0)
        body = self.body()
        body["approvalId"] = value["approvalId"]
        result = await api.auto_review_task_artifact(self.task.id, body, self.client, self.session)
        self.assertEqual(result["verdict"], "approved")

    async def test_reject_records_evidence_and_uses_default_ai_rework(self):
        result = await api.auto_review_task_artifact(self.task.id, self.body("reject"), self.client, self.session)
        self.assertEqual(result["verdict"], "rejected")
        # Without a reachable original session, retain a retryable rework card.
        # With a real conversation/reference, resume_after_rejection returns the task to doing.
        self.assertEqual(result["rework"]["fallback"], "rework_pending")
        self.assertTrue(self.task.work_routing.get("reworkPending"))
        self.assertIsNone(self.task.reviewed_at)
        events = (await self.session.execute(select(models.TaskEvent).where(
            models.TaskEvent.kind == "artifact.auto_reviewed"))).scalars().all()
        self.assertEqual(events[0].detail["report"]["verdict"], "reject")

    async def test_approve_publishes_reviewed_task_snapshot_for_source_conversation(self):
        result = await api.auto_review_task_artifact(self.task.id, self.body(), self.client, self.session)
        self.assertEqual(result["verdict"], "approved")
        self.assertTrue(self.publish_mock.await_args, "auto acceptance must publish a task update")
        args = self.publish_mock.await_args.args
        self.assertEqual(args[1].id, self.task.id)
        self.assertEqual(args[2], "task.updated")
        payload = self.publish_mock.await_args.args[3]
        self.assertIsNotNone(payload.get("reviewedAt"),
                             "the source conversation needs the reviewed marker to hide its card")
        self.assertEqual(payload.get("status"), "done")

    async def test_approve_is_idempotent_for_same_reviewer(self):
        result = await api.auto_review_task_artifact(self.task.id, self.body(), self.client, self.session)
        self.assertEqual(result["verdict"], "approved")
        self.assertIsNotNone(self.task.reviewed_at)
        repeated = await api.auto_review_task_artifact(self.task.id, self.body(), self.client, self.session)
        self.assertTrue(repeated["already"])
        self.assertEqual(len((await self.session.execute(select(am.ApprovalDecision))).scalars().all()), 1)

    async def test_report_requires_exact_criteria_and_evidence(self):
        for change in ("missing", "empty-evidence", "contradictory", "unknown", "duplicate"):
            with self.subTest(change=change):
                body = self.body()
                checks = body["report"]["checks"]
                if change == "missing": checks.pop()
                elif change == "empty-evidence": checks[0]["evidence"] = " "
                elif change == "contradictory": checks[0]["result"] = "fail"
                elif change == "unknown": checks[0]["criterion"] = "未约定标准"
                else: checks[1]["criterion"] = checks[0]["criterion"]
                with self.assertRaises(HTTPException) as caught:
                    await api.auto_review_task_artifact(self.task.id, body, self.client, self.session)
                self.assertEqual(caught.exception.status_code, 422)
                self.assertEqual(self.request.status, "pending")

    async def test_stale_definition_or_artifact_cannot_be_approved(self):
        for field, value in (("requirementVersion", 999), ("artifactVersionId", "older"), ("approvalId", "another")):
            with self.subTest(field=field):
                body = self.body()
                body[field] = value
                with self.assertRaises(HTTPException) as caught:
                    await api.auto_review_task_artifact(self.task.id, body, self.client, self.session)
                self.assertEqual(caught.exception.status_code, 409)
                self.assertIsNone(self.task.reviewed_at)

    async def test_unrelated_user_cannot_reuse_approved_result(self):
        await api.auto_review_task_artifact(self.task.id, self.body(), self.client, self.session)
        stranger = models.User(id="stranger", username="stranger")
        device = models.Client(id="stranger-device", user_ref="stranger")
        self.session.add_all([stranger, device])
        await self.session.commit()
        with self.assertRaises(HTTPException) as caught:
            await api.auto_review_task_artifact(self.task.id, self.body(), device, self.session)
        self.assertEqual(caught.exception.status_code, 403)

    async def test_cancelled_task_cannot_be_reviewed(self):
        self.task.status = "cancel"
        await self.session.commit()
        with self.assertRaises(HTTPException) as caught:
            await api.auto_review_task_artifact(self.task.id, self.body(), self.client, self.session)
        self.assertEqual(caught.exception.status_code, 409)

    async def test_countersign_does_not_close_on_one_vote(self):
        self.request.required_count = 2
        await self.session.commit()
        result = await api.auto_review_task_artifact(self.task.id, self.body(), self.client, self.session)
        self.assertEqual(result["verdict"], "pending")
        self.assertFalse(result["closed"])
        self.assertIsNone(self.task.reviewed_at)

    async def test_direct_alias_cannot_take_over_existing_ticket(self):
        body = self.body()
        body["approvalId"] = "direct:" + self.task.id
        with self.assertRaises(HTTPException) as caught:
            await api.auto_review_task_artifact(self.task.id, body, self.client, self.session)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.request.status, "pending")

    async def test_context_excludes_historical_outputs_even_with_same_filename(self):
        rows = [models.Attachment(id=aid, task_id=self.task.id, filename="作文.md", content_type="text/markdown",
                                  size=12, role=role, uploaded_by=by, storage_key=aid)
                for aid, role, by in (("input", "input", "review-device"), ("current", "output", "agent:pi"),
                                      ("history", "output", "agent:pi"), ("legacy", "input", "agent:pi"))]
        self.session.add_all(rows)
        self.artifact.manifest = {**self.artifact.manifest, "primary": [{"id": "current"}]}
        await self.session.commit()
        value = await self.context()
        self.assertEqual(set(value["attachmentIds"]), {"current"})
        self.assertIn("input", {row["id"] for row in value["optionalAttachments"]})
        self.assertTrue(all("ticket=" in row["url"] for row in value["attachments"]))

    async def test_team_visibility_does_not_grant_acceptance_evidence(self):
        user = models.User(id="colleague", username="colleague", org_id="team")
        device = models.Client(id="colleague-device", user_ref="colleague")
        self.task.shared_org_id = "team"
        self.session.add_all([user, device])
        await self.session.commit()
        with self.assertRaises(HTTPException) as caught:
            await api.task_acceptance_context(self.task.id, device, self.session)
        self.assertEqual(caught.exception.status_code, 403)

    async def test_done_is_not_acceptance_and_approved_orphan_cannot_reapprove(self):
        self.assertIsNone(self.task.reviewed_at)
        result = await api.auto_review_task_artifact(self.task.id, self.body(), self.client, self.session)
        self.assertTrue(result["closed"])
        await self.session.delete(self.request)
        await self.session.commit()
        with self.assertRaises(HTTPException) as caught:
            await self.context()
        self.assertEqual(caught.exception.status_code, 409)

    async def test_older_pending_ticket_blocks_direct_shortcut(self):
        self.artifact.seq = 2
        self.request.artifact_version_id = "historical-artifact"
        await self.session.commit()
        with self.assertRaises(HTTPException) as caught:
            await self.context()
        self.assertEqual(caught.exception.status_code, 409)

    async def test_empty_criteria_requires_manual_review(self):
        self.task.acceptance_criteria = []
        self.request.context = {}
        await self.session.commit()
        self.assertEqual((await self.context())["criteria"], [])
        with self.assertRaises(HTTPException) as caught:
            await api.auto_review_task_artifact(self.task.id, self.body(), self.client, self.session)
        self.assertEqual(caught.exception.status_code, 422)

    async def test_review_bundle_uses_only_fixed_deliverables_and_keeps_context_read_only(self):
        import hashlib
        import io
        import zipfile
        from app.api.delivery import artifacts_zip
        contents = {'html': b'<html><body>Final</body></html>', 'css': b'body{color:red}'}
        rows = [models.Attachment(id=key, task_id=self.task.id,
                    filename='index.html' if key == 'html' else 'assets/style.css',
                    content_type='text/html' if key == 'html' else 'text/css',
                    size=len(data), role='output', storage_key=key, uploaded_by='agent:pi',
                    evidence_meta={'sha256': hashlib.sha256(data).hexdigest(), 'verification': {'state':'passed'}})
                for key, data in contents.items()]
        rows += [models.Attachment(id=key, task_id=self.task.id, filename=key+'.png',
                    content_type='image/png', size=4, role=role, storage_key=key)
                 for key, role in [('capture','verification'),('process','process'),('input','input')]]
        self.session.add_all(rows)
        manifest = {**self.artifact.manifest, 'primary':[{'id':'html'}], 'supporting':[{'id':'css'}]}
        self.artifact.manifest = manifest
        await self.session.commit()
        before = len((await self.session.execute(select(models.Attachment))).scalars().all())
        value = await self.context()
        self.assertEqual(set(value['attachmentIds']), {'html','css'})
        self.assertEqual({row['id'] for row in value['optionalAttachments']}, {'capture','process','input'})
        self.assertEqual(value['deliveryBundle']['artifactVersionId'],self.artifact.id)
        self.assertEqual(value['deliveryBundle']['fileCount'],2)
        with patch('app.services.storage.get',side_effect=lambda key, backend: contents[key]):
            response = await artifacts_zip(self.task.id,self.artifact.id,self.client,self.session)
            data = b''.join([chunk async for chunk in response.body_iterator])
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertEqual(set(archive.namelist()), {'index.html','assets/style.css'})
            self.assertEqual(archive.read('index.html'), contents['html'])
        self.assertEqual(response.headers['X-Artifact-SHA256'],hashlib.sha256(data).hexdigest())
        self.assertEqual(before,len((await self.session.execute(select(models.Attachment))).scalars().all()))
        self.assertEqual(self.artifact.manifest,manifest)

    async def test_missing_frozen_file_never_silently_reduces_review_input(self):
        self.artifact.manifest = {**self.artifact.manifest,'primary':[{'id':'deleted'}]}
        await self.session.commit()
        with self.assertRaises(HTTPException) as caught:
            await self.context()
        self.assertEqual(caught.exception.status_code,502)
    async def test_frozen_legacy_role_default_remains_a_deliverable(self):
        self.session.add(models.Attachment(id='legacy-fixed',task_id=self.task.id,
            filename='screenshot.png',role='input',uploaded_by='agent:legacy',size=4,storage_key='old'))
        self.artifact.manifest={**self.artifact.manifest,'primary':[{'id':'legacy-fixed'}]}
        await self.session.commit()
        self.assertEqual((await self.context())['attachmentIds'],['legacy-fixed'])


class DeliveryCategoryApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_windows_paths_keep_explicit_delivery_categories(self):
        import io
        from fastapi import UploadFile
        from unittest.mock import MagicMock

        session = MagicMock()
        session.execute = AsyncMock(return_value=MagicMock())
        task = models.Task(id='category-task', owner_client_id='category-client')
        session.execute.return_value.scalar_one_or_none.return_value = task
        with patch('app.services.conversation_turns.deliver_artifacts', new_callable=AsyncMock) as ingest:
            await api.conversation_task_delivery(
                task.id, files=[UploadFile(io.BytesIO(b'final report'), filename='test-report.txt')],
                conversation_id='conversation', turn_id='turn', paths=['assets\\test-report.txt'],
                categories=['primary'], model='test', outcome='completed',
                client=models.Client(id='category-client'), session=session)
        self.assertEqual(ingest.await_args.kwargs['categories'], {'assets/test-report.txt': 'primary'})
        self.assertEqual(ingest.await_args.kwargs['files'][0][0], 'assets/test-report.txt')

    async def test_invalid_category_cannot_reach_ingestion(self):
        import io
        from fastapi import UploadFile
        from unittest.mock import MagicMock

        session = MagicMock()
        session.execute = AsyncMock(return_value=MagicMock())
        session.execute.return_value.scalar_one_or_none.return_value = models.Task(id='category-task')
        with patch('app.services.conversation_turns.deliver_artifacts', new_callable=AsyncMock) as ingest:
            with self.assertRaises(HTTPException) as caught:
                await api.conversation_task_delivery(
                    'category-task', files=[UploadFile(io.BytesIO(b'final'), filename='result.txt')],
                    conversation_id='conversation', turn_id='turn', paths=['result.txt'],
                    categories=['unknown'], model='test', outcome='completed',
                    client=models.Client(id='category-client'), session=session)
        self.assertEqual(caught.exception.status_code, 422)
        ingest.assert_not_awaited()
