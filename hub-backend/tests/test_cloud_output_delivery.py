"""Isolated cloud bytes, digest propagation and explicit Git dispatch contracts."""
import hashlib
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


if __name__ == "__main__":
    unittest.main()
