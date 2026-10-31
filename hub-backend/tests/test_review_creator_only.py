"""Requirement-pool delivery review is owned by the requirement creator only."""

import unittest

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import approvals as approvals_api
from app.db import Base
from app.services import approval_routing


class ReviewCreatorOnlyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.creator = models.User(id="creator", username="creator", display_name="创建人",
                                   is_active=True)
        self.executor = models.User(id="executor", username="executor", display_name="执行人",
                                    is_active=True)
        self.creator_client = models.Client(id="creator-device", name="创建人设备",
                                            user_ref=self.creator.id)
        self.executor_client = models.Client(id="executor-device", name="执行人设备",
                                             user_ref=self.executor.id)
        self.task = models.Task(
            id="review-task", title="需求池交付", status="done", created_by=self.creator.id,
            assignee_user_id=self.executor.id, acceptance_criteria=["结果可用"],
        )
        self.artifact = am.ArtifactVersion(
            id="review-artifact", task_id=self.task.id, seq=1, kind="code",
            state="candidate", checksum="review-checksum",
            manifest={"complete": True, "files": [{"name": "result.md"}]},
        )
        self.request = am.ApprovalRequest(
            id="review-request", task_id=self.task.id,
            artifact_version_id=self.artifact.id, action="review", status="pending",
            required_count=2,
            # Deliberately retain a legacy/custom policy which names the executor.
            policy_snapshot={"required": 2, "separationOfDuties": False,
                             "approvers": [{"type": "task_assignee"},
                                           {"type": "permission", "key": "delivery.review"}]},
        )
        self.session.add_all([
            self.creator, self.executor, self.creator_client, self.executor_client,
            self.task, self.artifact, self.request,
            am.ApprovalAssignment(request_id=self.request.id, user_id=self.executor.id,
                                  user_name=self.executor.display_name),
        ])
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()

    async def test_pending_review_reassigns_to_creator_and_denies_executor(self):
        assignments = await approval_routing.ensure_assignments(
            self.session, self.task, self.request)
        self.assertEqual([row.user_id for row in assignments], [self.creator.id])
        self.assertEqual(self.request.required_count, 2,
                         "routing must not silently rewrite an existing countersignature policy")

        executor_allowed, executor_reason = await approval_routing.can_decide(
            self.session, self.task, self.request, self.executor)
        creator_allowed, creator_reason = await approval_routing.can_decide(
            self.session, self.task, self.request, self.creator)
        self.assertFalse(executor_allowed)
        self.assertIn("创建人", executor_reason)
        self.assertTrue(creator_allowed, creator_reason)

        # Creator-owned review remains valid when the creator also happens to
        # be the executor; separation-of-duties must not reintroduce a second
        # reviewer for this requirement-pool gate.
        self.task.assignee_user_id = self.creator.id
        self.request.policy_snapshot = {"separationOfDuties": True}
        await self.session.flush()
        self.assertTrue(await approval_routing.can_decide(
            self.session, self.task, self.request, self.creator))

    async def test_preview_and_policy_candidates_are_creator_only(self):
        preview = await approval_routing.preview_assignments(
            self.session, self.task, "review", self.request.policy_snapshot)
        self.assertEqual(preview["required"], 2)
        self.assertEqual([row["userId"] for row in preview["candidates"]], [self.creator.id])
        self.assertTrue(await approval_routing.preview_can_decide(
            self.session, self.task, self.request, self.creator, self.artifact))
        self.assertFalse(await approval_routing.preview_can_decide(
            self.session, self.task, self.request, self.executor, self.artifact))

    async def test_inbox_reconciles_legacy_executor_assignment_before_listing_creator(self):
        executor_inbox = await approvals_api.inbox(
            client=self.executor_client, session=self.session)
        self.assertEqual(executor_inbox["pendingCount"], 0)
        creator_inbox = await approvals_api.inbox(
            client=self.creator_client, session=self.session)
        self.assertEqual(creator_inbox["pendingCount"], 1)
        self.assertEqual(creator_inbox["items"][0]["assignment"]["userId"], self.creator.id)

        with self.assertRaises(HTTPException) as caught:
            await approvals_api.decide(
                self.request.id, {"decision": "approve"},
                self.executor_client, self.session)
        self.assertEqual(caught.exception.status_code, 403)

    async def test_other_approval_actions_keep_their_assignment_policy(self):
        request = am.ApprovalRequest(
            id="baseline-request", task_id=self.task.id,
            artifact_version_id=self.artifact.id, action="baseline", status="pending",
            policy_snapshot={"separationOfDuties": False,
                             "approvers": [{"type": "task_assignee"}]},
        )
        self.session.add(request)
        await self.session.flush()
        assignments = await approval_routing.ensure_assignments(self.session, self.task, request)
        self.assertEqual([row.user_id for row in assignments], [self.executor.id])


if __name__ == "__main__":
    unittest.main()
