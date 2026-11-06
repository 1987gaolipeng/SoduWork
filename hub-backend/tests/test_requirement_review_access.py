"""The task list carries personally actionable review rights with its stage."""
import unittest
from datetime import datetime, timedelta, timezone

from app import automation_models as am, models
from app.services import requirement_review_access, task_requirements
from test_unified_requirements import UnifiedRequirementTests


class RequirementReviewAccessTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = UnifiedRequirementTests.asyncSetUp
    asyncTearDown = UnifiedRequirementTests.asyncTearDown
    call = UnifiedRequirementTests.call

    async def seed(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.status = "doing"
            session.add_all([
                am.ArtifactVersion(id="output", task_id=task.id, kind="files", seq=1,
                                   state="candidate", checksum="output"),
                am.ApprovalRequest(id="review", task_id=task.id, artifact_version_id="output",
                                   action="review", status="pending"),
                am.ApprovalAssignment(request_id="review", user_id="owner", user_name="Owner"),
            ])
            device = models.Client(id="second-device", user_ref="owner", auth_state="active")
            self.clients[device.id] = device
            session.add(device)
            await session.commit()

    async def test_creator_can_review_running_status_on_both_devices_and_list(self):
        await self.seed()
        for who in ("owner", "second-device"):
            detail = await self.call("GET", "tasks/shared", who)
            self.assertEqual(detail.status_code, 200, detail.text)
            self.assertEqual(detail.json()["status"], "doing")
            self.assertEqual(detail.json()["requirementStage"], "reviewing")
            self.assertTrue(detail.json()["canReview"])
            listing = await self.call("GET", "tasks", who)
            item = next(row for row in listing.json() if row["id"] == "shared")
            self.assertTrue(item["canReview"])
        peer = await self.call("GET", "tasks/shared", "peer")
        self.assertFalse(peer.json()["canReview"])
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            prepared = await task_requirements.prepare_notifications(session, task, list(self.clients.values()))
            self.assertEqual(prepared["second-device"].reviewable, {"shared"})
            self.assertEqual(prepared["peer"].reviewable, set())

    async def test_own_decision_and_completed_delivery_remove_review_right(self):
        await self.seed()
        async with self.sessions() as session:
            session.add(am.ApprovalDecision(request_id="review", user_id="owner",
                                            user_name="Owner", decision="approve", note="Checked"))
            await session.commit()
        for who in ("owner", "second-device"):
            detail = await self.call("GET", "tasks/shared", who)
            self.assertFalse(detail.json()["canReview"], "A remaining co-sign gate is not another vote")
            listing = await self.call("GET", "tasks", who)
            item = next(row for row in listing.json() if row["id"] == "shared")
            self.assertFalse(item["canReview"])
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            prepared = await task_requirements.prepare_notifications(session, task, list(self.clients.values()))
            self.assertEqual(prepared["owner"].reviewable, set())
            self.assertEqual(prepared["second-device"].reviewable, set())
            self.assertEqual((await session.get(am.ApprovalRequest, "review")).status, "pending")
            task.status, task.reviewed_at = "done", datetime.now(timezone.utc)
            (await session.get(am.ApprovalRequest, "review")).status = "approved"
            await session.commit()
        detail = await self.call("GET", "tasks/shared")
        self.assertEqual(detail.json()["requirementStage"], "delivered")
        self.assertFalse(detail.json()["canReview"])

    async def test_direct_unreviewed_completion_keeps_creator_review_entry(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.status = "done"
            await session.commit()
        for who, allowed in (("owner", True), ("peer", False)):
            detail = await self.call("GET", "tasks/shared", who)
            self.assertEqual(detail.status_code, 200, detail.text)
            self.assertEqual(detail.json()["canReview"], allowed)

    async def test_stale_expired_unassigned_and_foreign_reviews_are_not_actionable(self):
        await self.seed()
        async with self.sessions() as session:
            self.assertEqual(await requirement_review_access.pending_task_ids(session, "peer", ["shared"]), set())
            self.assertEqual(await requirement_review_access.pending_task_ids(session, "owner", ["shared"]), {"shared"})
            request = await session.get(am.ApprovalRequest, "review")
            request.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await session.flush()
            self.assertEqual(await requirement_review_access.pending_task_ids(session, "owner", ["shared"]), set())
            request.expires_at = None
            session.add(am.ApprovalRequest(id="new-review", task_id="shared", artifact_version_id="output",
                                          action="review", status="rejected",
                                          created_at=datetime.now(timezone.utc) + timedelta(seconds=1)))
            await session.flush()
            self.assertEqual(await requirement_review_access.pending_task_ids(session, "owner", ["shared"]), set())
            session.add(am.ArtifactVersion(id="new-output", task_id="shared", kind="files", seq=2,
                                          state="candidate", checksum="new"))
            session.add(am.ApprovalRequest(id="unassigned", task_id="shared", artifact_version_id="new-output",
                                          action="review", status="pending"))
            await session.flush()
            self.assertEqual(await requirement_review_access.pending_task_ids(session, "owner", ["shared"]), set())
