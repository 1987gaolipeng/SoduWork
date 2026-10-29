"""Legacy upload proof stays account-bound and agrees in SQL and Python."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ.setdefault("AUTH_SECRET", "isolated-attachment-owner-test-secret-over-32-characters")
os.environ.setdefault("ADMIN_PASS", "isolated-attachment-owner-password")

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.services import attachment_ownership, task_execution_options, usage_ledger


class AttachmentOwnershipCompatibilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_sql_and_object_ownership_use_only_immutable_user_evidence(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(lambda sync: models.Attachment.__table__.create(sync))
        rows = [
            models.Attachment(id="explicit", task_id="t", filename="f", uploaded_by="user:first", evidence_meta={}),
            models.Attachment(id="device", task_id="t", filename="f", uploaded_by="shared-device", evidence_meta={}),
            models.Attachment(id="snapshot", task_id="t", filename="f", uploaded_by="shared-device", evidence_meta={"ownerUserId": "first"}),
            models.Attachment(id="conflict", task_id="t", filename="f", uploaded_by="user:first", evidence_meta={"ownerUserId": "second"}),
        ]
        try:
            async with async_sessionmaker(engine, expire_on_commit=False)() as session:
                session.add_all(rows)
                await session.commit()
                for user, expected in (("first", {"explicit", "snapshot"}), ("second", {"conflict"}), (None, set())):
                    client = SimpleNamespace(id="shared-device", user_ref=user)
                    with self.subTest(user=user):
                        actual = set((await session.scalars(select(models.Attachment.id).where(
                            attachment_ownership.owner_clause(client)))).all())
                        self.assertEqual(actual, expected)
                        self.assertEqual({row.id for row in rows if attachment_ownership.owns_attachment(row, client)}, expected)
        finally:
            await engine.dispose()

    async def test_shared_device_participant_cannot_arrange_previous_owners_execution(self):
        client = SimpleNamespace(id="shared-device", user_ref="second")
        task = SimpleNamespace(owner_client_id=client.id, owner_user_id="first")
        with patch.object(task_execution_options.task_access, "view_task", new=AsyncMock(return_value=task)), \
             patch.object(task_execution_options, "_visible_repos", new_callable=AsyncMock) as repos:
            with self.assertRaises(ValueError):
                await task_execution_options.build(SimpleNamespace(), client, {"taskId": "old-task"})
            repos.assert_not_awaited()

    async def test_usage_report_cannot_attribute_new_account_usage_to_previous_task(self):
        client = SimpleNamespace(id="shared-device", user_ref="second")
        task = SimpleNamespace(owner_client_id=client.id, owner_user_id="first", assignee_user_id="first")
        user = SimpleNamespace(org_id="org")
        session = SimpleNamespace(get=AsyncMock(side_effect=lambda model, ident: task if model is models.Task else user),
                                  scalar=AsyncMock(return_value=None))
        with patch.object(usage_ledger, "upsert_cumulative", new=AsyncMock(return_value="saved")) as upsert:
            await usage_ledger.from_client(session, client, {
                "sourceType": "task", "sourceId": "private-session", "taskId": "old-task",
                "workflowRunId": "old-workflow", "nodeRunId": "old-node", "usage": {"totalTokens": 4}})
            values = upsert.await_args.args[2]
            self.assertEqual(values["task_id"], "")
            self.assertEqual(values["source_type"], "chat")
            self.assertEqual(values["workflow_run_id"], "")
            self.assertEqual(values["billing_user_id"], "second")


if __name__ == "__main__":
    unittest.main()
