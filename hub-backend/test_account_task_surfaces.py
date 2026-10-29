"""Account switches on one device cannot inherit task execution or file access."""
import io
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ.setdefault("AUTH_SECRET", "isolated-account-task-surface-secret-over-32-characters")
os.environ.setdefault("ADMIN_PASS", "isolated-account-task-surface-password")

from fastapi import HTTPException, UploadFile
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import attachments, plugin_client_runs, trace, usage
from app.db import Base
from app.services import (aidesk_cleanup, attachment_ownership, execution_sessions,
                          live_view_cache, task_read_models, team)


class AccountTaskSurfaceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.client = models.Client(id="same-device", user_ref="first-user", auth_state="active")
        self.session.add_all([
            models.User(id="first-user", username="first"),
            models.User(id="second-user", username="second"), self.client,
        ])
        await self.session.flush()
        self.task = models.Task(id="private-task", owner_client_id=self.client.id,
                               owner_user_id="first-user", created_by="first-user")
        self.file = models.Attachment(id="private-file", task_id=self.task.id,
                                      filename="private.txt", uploaded_by=self.client.id,
                                      evidence_meta={"ownerUserId": "first-user"})
        self.session.add_all([self.task, self.file,
            models.TaskEvent(task_id=self.task.id, kind="ai.dispatched",
                             detail={"assigneeName": "test-agent"}),
            am.ExecutionSession(task_id=self.task.id, ref="private-ref", state="running"),
        ])
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()
        live_view_cache.reset_for_tests()

    async def switch_account(self):
        self.client.user_ref = "second-user"
        self.client.auth_version = int(self.client.auth_version or 0) + 1
        await self.session.commit()

    async def assert_hidden(self, action):
        with self.assertRaises(HTTPException) as error:
            await action
        self.assertEqual(error.exception.status_code, 404)

    async def test_new_account_cannot_read_or_mutate_old_task_surfaces(self):
        await self.switch_account()
        with patch.object(usage.usage_stats, "task_usage", new_callable=AsyncMock) as stats, \
             patch.object(plugin_client_runs.workflow_engine, "list_runs", new_callable=AsyncMock) as runs, \
             patch.object(attachments.storage, "delete") as delete:
            for action in (
                usage.my_task_usage(self.task.id, self.client, self.session),
                trace._my_task(self.session, self.client, self.task.id),
                plugin_client_runs.client_runs(self.task.id, self.client, self.session),
                attachments.list_attachments(self.task.id, self.client, self.session),
                attachments.refresh_attachment_access(self.file.id, self.client, self.session),
                attachments.delete_attachment(self.file.id, self.client, self.session),
            ):
                await self.assert_hidden(action)
            stats.assert_not_awaited()
            runs.assert_not_awaited()
            delete.assert_not_called()

    async def test_original_account_still_reaches_owned_services(self):
        with patch.object(usage.usage_stats, "task_usage", new=AsyncMock(return_value={"tokens": 7})), \
             patch.object(plugin_client_runs.workflow_engine, "list_runs", new=AsyncMock(return_value=[])):
            self.assertEqual(await usage.my_task_usage(self.task.id, self.client, self.session), {"tokens": 7})
            self.assertIs(await trace._my_task(self.session, self.client, self.task.id), self.task)
            self.assertEqual(await plugin_client_runs.client_runs(self.task.id, self.client, self.session), {"items": []})
        self.assertTrue((await attachments.refresh_attachment_access(
            self.file.id, self.client, self.session))["url"])

    async def test_participant_keeps_read_access_but_not_previous_upload_ownership(self):
        self.task.requester_user_id = "second-user"
        await self.switch_account()
        view = await attachments.list_attachments(self.task.id, self.client, self.session)
        self.assertEqual([item["id"] for item in view], [self.file.id])
        self.assertFalse(view[0]["canDelete"])
        self.assertTrue((await attachments.refresh_attachment_access(
            self.file.id, self.client, self.session))["url"])
        await self.assert_hidden(attachments.delete_attachment(self.file.id, self.client, self.session))
        self.file.evidence_meta = {}
        await self.session.commit()
        await self.assert_hidden(attachments.delete_attachment(self.file.id, self.client, self.session))

    async def test_upload_captures_the_authenticated_account(self):
        with patch.object(attachments.storage, "put_stream", return_value="memory"):
            uploaded = await attachments._save_attachment(
                self.session, self.client, self.task.id,
                UploadFile(filename="new.txt", file=io.BytesIO(b"evidence")),
                evidence_meta={"ownerUserId": "forged-user", "kind": "requirement_input"})
        self.assertEqual(uploaded.evidence_meta["ownerUserId"], "first-user")
        self.assertEqual(uploaded.evidence_meta["kind"], "requirement_input")
        self.assertTrue(attachment_ownership.owns_attachment(uploaded, self.client))

    async def test_ai_and_console_lists_and_cleanup_do_not_inherit_old_tasks(self):
        before, total, _ = await task_read_models.agent_task_page(
            self.session, self.client.id, "", "", 0, 10)
        self.assertEqual(total, 1)
        self.assertEqual([task.id for task, _ in before], [self.task.id])
        self.assertEqual(len(await execution_sessions.console_rows(self.session, self.client.id)), 1)
        await self.switch_account()
        self.assertEqual(await task_read_models.agent_task_page(
            self.session, self.client.id, "", "", 0, 10), ([], 0, {}))
        self.assertEqual(await execution_sessions.console_rows(self.session, self.client.id), [])
        with patch.object(aidesk_cleanup.task_status, "mark", new_callable=AsyncMock) as mark:
            result = await aidesk_cleanup.cleanup_abnormal(self.session, self.client, {
                "tasks": [{"id": self.task.id, "phase": "failed"}]})
            self.assertEqual(result["cleaned"], [])
            self.assertEqual(result["skipped"], [self.task.id])
            mark.assert_not_awaited()

    async def test_team_scope_uses_frozen_task_user_not_current_device_user(self):
        await self.switch_account()
        second_user = await self.session.get(models.User, "second-user")
        with patch.object(team, "_can_manage", new=AsyncMock(return_value=True)), \
             patch.object(team, "_team_members", new=AsyncMock(return_value=(
                 [second_user], {second_user.id: "blue"}, {second_user.id: "Second"}))):
            self.assertEqual((await team.team_tasks(self.session, self.client))["tasks"], [])
            for action in (
                team.set_team_task_status(self.session, self.client, self.task.id, "done"),
                team.reassign_team_task(self.session, self.client, self.task.id, second_user.id),
                team.nudge_team_task(self.session, self.client, self.task.id),
            ):
                self.assertEqual(await action, {"ok": False, "reason": "out_of_scope"})
        self.assertEqual(self.task.owner_user_id, "first-user")
        self.assertEqual(self.task.status, "todo")


if __name__ == "__main__":
    unittest.main()
