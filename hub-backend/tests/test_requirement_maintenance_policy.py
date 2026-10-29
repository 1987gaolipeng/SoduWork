"""HTTP regressions for creator maintenance and exact terminal receipts."""
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-requirement-policy-test-key")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app import automation_models as am, models
from test_unified_requirements import UnifiedRequirementTests


class RequirementMaintenancePolicyTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = UnifiedRequirementTests.asyncSetUp
    asyncTearDown = UnifiedRequirementTests.asyncTearDown
    call = UnifiedRequirementTests.call

    async def test_prestart_maintenance_belongs_to_creator_not_assignee_or_executor(self):
        for stage in ("intake", "clarifying", "ready"):
            async with self.sessions() as session:
                task = await session.get(models.Task, "shared")
                task.created_by, task.assignee_user_id, task.requester_user_id = "peer", "owner", "owner"
                task.triage_stage = stage
                await session.commit()
            detail = (await self.call("GET", "tasks/shared")).json()
            self.assertTrue(detail["canEditRequirement"])
            self.assertFalse(detail["canArchiveRequirement"], stage)
            self.assertFalse(detail["canDeleteRequirement"], stage)
            for method, body in (("PATCH", {"archivedAt": 1}), ("DELETE", None)):
                result = await self.call(method, "tasks/shared", **({"json": body} if body else {}))
                self.assertEqual(result.status_code, 403, result.text)
            creator = (await self.call("GET", "tasks/shared", "peer")).json()
            self.assertTrue(creator["canArchiveRequirement"])
            self.assertTrue(creator["canDeleteRequirement"])
        self.assertEqual((await self.call("PATCH", "tasks/shared", "peer", json={"archivedAt": 1})).status_code, 200)

    async def test_archived_and_cancelled_requirements_delete_without_restore_but_keep_acl(self):
        now = datetime.now(timezone.utc)
        for status, archived in (("todo", now), ("doing", now), ("done", now), ("cancel", None)):
            tid = "closed-" + status
            async with self.sessions() as session:
                session.add(models.Task(id=tid, title=tid, owner_client_id="owner", created_by="owner",
                    shared_org_id="company", status=status, archived_at=archived))
                await session.commit()
            self.assertEqual((await self.call("DELETE", "tasks/" + tid, "peer")).status_code, 403)
            self.assertEqual((await self.call("DELETE", "tasks/" + tid, "outsider")).status_code, 404)
            result = await self.call("DELETE", "tasks/" + tid)
            self.assertEqual(result.status_code, 200, result.text)

    async def test_cancel_cannot_bypass_creator_stage_or_live_execution_guards(self):
        for method in ("PATCH", "PUT", "batch"):
            for condition, expected in (("noncreator", 403), ("doing", 409), ("workflow", 409)):
                tid = method.lower() + "-" + condition
                async with self.sessions() as session:
                    session.add(models.Task(id=tid, title=tid, owner_client_id="owner",
                        created_by="peer" if condition == "noncreator" else "owner",
                        status="doing" if condition == "doing" else "todo"))
                    if condition == "workflow":
                        session.add(am.WorkflowRun(id=tid, task_id=tid, plugin_id="fixture",
                            plugin_version_id="fixture", state="waiting_human"))
                    await session.commit()
                result = (await self.call("POST", "tasks/batch-update", json={"ids": [tid], "patch": {"status": "cancel"}})
                    if method == "batch" else await self.call(method, "tasks/" + tid, json={"status": "cancel"}))
                self.assertEqual(result.status_code, expected, (method, condition, result.text))
                async with self.sessions() as session:
                    self.assertNotEqual((await session.get(models.Task, tid)).status, "cancel")
        result = await self.call("PATCH", "tasks/shared", json={"status": "cancel"})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual((await self.call("DELETE", "tasks/shared")).status_code, 200)

    async def test_team_status_cancel_reuses_maintenance_rules_under_task_lock(self):
        from fastapi import HTTPException
        from app.services import team
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.created_by = "peer"
            await session.commit()
            members = [await session.get(models.User, uid) for uid in ("owner", "peer")]
            with (patch.object(team, "_can_manage", AsyncMock(return_value=True)),
                  patch.object(team, "_team_members", AsyncMock(return_value=(members, {}, {})))):
                with self.assertRaises(HTTPException) as caught:
                    await team.set_team_task_status(session, self.clients["owner"], "shared", "cancel")
            self.assertEqual(caught.exception.status_code, 403)
            self.assertEqual((await session.get(models.Task, "shared")).status, "todo")

    async def test_exact_latest_turn_terminal_event_releases_stale_routing_receipt_only(self):
        now = datetime.now(timezone.utc)
        for variant, blocked in (("same", False), ("other-turn", True), ("other-conversation", True),
                                 ("other-executor", True), ("reopened", True), ("unknown", True), ("unknown-receipt", True)):
            tid = "turn-" + variant
            receipt = {"conversationId": "conversation", "turnId": "current-turn", "state": "running", "executor": "native"}
            terminal = {**receipt, "state": "completed"}
            if variant == "other-turn":
                terminal["turnId"] = "previous-turn"
            elif variant == "other-conversation":
                terminal["conversationId"] = "other-conversation"
            elif variant == "unknown":
                terminal["state"] = "future-wait"
            elif variant == "other-executor":
                terminal["executor"] = "workflow"
            elif variant == "unknown-receipt":
                receipt["state"] = "future-wait"
            async with self.sessions() as session:
                session.add(models.Task(id=tid, title=tid, owner_client_id="owner", created_by="owner",
                    status="done", reviewed_at=now, work_routing={"conversationTurn": receipt}))
                session.add_all([
                    models.TaskEvent(task_id=tid, kind="conversation.turn", detail=receipt, at=now - timedelta(minutes=1)),
                    models.TaskEvent(task_id=tid, kind="conversation.turn", detail=terminal, at=now),
                ])
                if variant == "reopened":
                    session.add(models.TaskEvent(task_id=tid, kind="conversation.turn",
                        detail={**receipt, "state": "queued"}, at=now + timedelta(seconds=1)))
                await session.commit()
            detail = (await self.call("GET", "tasks/" + tid)).json()
            self.assertEqual(detail["maintenanceBlocked"], blocked, variant)
            self.assertEqual((await self.call("DELETE", "tasks/" + tid)).status_code, 409 if blocked else 200)

    async def test_accepted_or_archived_label_never_overrides_real_inflight_execution(self):
        now = datetime.now(timezone.utc)
        for kind in ("workflow", "execution", "uncertain-dispatch"):
            tid = "live-" + kind
            async with self.sessions() as session:
                session.add(models.Task(id=tid, title=tid, owner_client_id="owner", created_by="owner",
                    status="done", reviewed_at=now, archived_at=now))
                if kind == "workflow":
                    session.add(am.WorkflowRun(id=tid, task_id=tid, plugin_id="fixture", plugin_version_id="fixture", state="waiting_human"))
                elif kind == "execution":
                    session.add(am.ExecutionSession(task_id=tid, ref=tid, state="running"))
                else:
                    session.add(models.TaskEvent(task_id=tid, kind="ai.dispatch_uncertain", detail={"expectedRef": tid}, at=now - timedelta(days=1)))
                await session.commit()
            self.assertTrue((await self.call("GET", "tasks/" + tid)).json()["maintenanceBlocked"])
            self.assertEqual((await self.call("DELETE", "tasks/" + tid)).status_code, 409)

    async def test_same_time_turn_events_require_unanimous_exact_terminal_evidence(self):
        from app.services import task_maintenance
        now = datetime.now(timezone.utc)
        receipt = {"conversationId": "conversation", "turnId": "current-turn", "state": "running", "executor": "native"}
        async with self.sessions() as session:
            for variant, blocked in (("mixed", True), ("different-turn", True), ("terminal", False)):
                tid = "tie-" + variant
                task = models.Task(id=tid, title=tid, owner_client_id="owner", created_by="owner",
                    status="done", reviewed_at=now, work_routing={"conversationTurn": receipt})
                other = {**receipt, "state": "completed" if variant != "mixed" else "running"}
                if variant == "different-turn":
                    other["turnId"] = "another-turn"
                session.add_all([task,
                    models.TaskEvent(id="a-" + variant, task_id=tid, kind="conversation.turn", detail=other, at=now),
                    models.TaskEvent(id="z-" + variant, task_id=tid, kind="conversation.turn", detail={**receipt, "state": "completed"}, at=now),
                ])
                await session.flush()
                reasons = await task_maintenance.blocked_reasons(session, [task])
                self.assertEqual(tid in reasons, blocked, variant)

    async def test_shared_review_time_survives_detail_list_and_push_without_execution_secrets(self):
        from app.services import task_access
        now = datetime.now(timezone.utc)
        async with self.sessions() as session:
            (await session.get(models.User, "peer")).is_super = True
            task = await session.get(models.Task, "shared")
            task.status, task.reviewed_at, task.reviewed_by_name = "done", now, "private-reviewer"
            await session.commit()
        detail = (await self.call("GET", "tasks/shared", "peer")).json()
        listing = next(row for row in (await self.call("GET", "tasks", "peer")).json() if row["id"] == "shared")
        self.published.reset_mock()
        async with self.sessions() as session:
            await task_access.publish_task(session, await session.get(models.Task, "shared"), "task.updated")
        pushed = next(call.args[1]["task"] for call in self.published.await_args_list if call.args[0] == "peer")
        for api in (detail, listing, pushed):
            self.assertTrue(api["readOnly"])
            self.assertFalse(api["canViewExecution"])
            self.assertTrue(api["canArchiveRequirement"])
            self.assertTrue(api["canDeleteRequirement"])
            self.assertEqual(api["requirementStage"], "delivered")
            self.assertTrue(api.get("reviewedAt"), "公开验收时间必须与delivered阶段一致")
            for private in ("reviewedBy", "reviewedByName", "reviewNote", "result", "workRouting"):
                self.assertNotIn(private, api)
        async with self.sessions() as session:
            (await session.get(models.Task, "shared")).reviewed_at = None
            await session.commit()
        self.assertFalse((await self.call("GET", "tasks/shared", "peer")).json().get("reviewedAt"))

    async def test_creator_compatibility_covers_same_user_anonymous_local_and_all_source_creators(self):
        async with self.sessions() as session:
            for cid, uid in (("second-device", "owner"), ("anonymous", None)):
                self.clients[cid] = models.Client(id=cid, user_ref=uid, auth_state="active")
                session.add(self.clients[cid])
            session.add(models.Task(id="anonymous-task", title="anonymous", owner_client_id="anonymous", origin="local"))
            source = await session.get(models.Task, "legacy")
            source.legacy_requirements = [{"id": "source-a", "title": "source-a"}, {"id": "source-b", "title": "source-b"}]
            session.add_all([models.TaskRequirementAccess(task_id="legacy", source_id=sid,
                principal_kind="user", principal_id="peer", role="creator") for sid in ("source-a", "source-b")])
            await session.commit()
        for tid, who in (("shared", "second-device"), ("anonymous-task", "anonymous"), ("legacy", "peer")):
            api = (await self.call("GET", "tasks/" + tid, who)).json()
            self.assertIn("creator", api["myRoles"])
            self.assertTrue(api["canDeleteRequirement"])
            self.assertTrue(api["canArchiveRequirement"])
        async with self.sessions() as session:
            from sqlalchemy import select
            access = await session.scalar(select(models.TaskRequirementAccess).where(models.TaskRequirementAccess.source_id == "source-b"))
            access.role = "requester"
            await session.commit()
        api = (await self.call("GET", "tasks/legacy", "peer")).json()
        self.assertTrue(api["canEditRequirement"])
        self.assertFalse(api["canArchiveRequirement"])
        self.assertFalse(api["canDeleteRequirement"])

    async def test_execution_participant_all_source_creator_has_consistent_maintenance_role(self):
        from app.services import task_access
        async with self.sessions() as session:
            for label in ("all", "partial"):
                tid = "source-executor-" + label
                sources = [tid + "-a", tid + "-b"]
                session.add(models.Task(id=tid, title=tid, owner_client_id="peer", created_by="owner",
                    status="todo", triage_stage="ready", shared_org_id="company",
                    legacy_requirements=[{"id": sid, "title": sid} for sid in sources]))
                session.add_all([models.TaskRequirementAccess(task_id=tid, source_id=sid,
                    principal_kind="user", principal_id="peer",
                    role="requester" if label == "partial" and index else "creator")
                    for index, sid in enumerate(sources)])
            await session.commit()
        listing = {row["id"]: row for row in (await self.call("GET", "tasks", "peer")).json()}
        for label in ("all", "partial"):
            tid = "source-executor-" + label
            detail = (await self.call("GET", "tasks/" + tid, "peer")).json()
            self.published.reset_mock()
            async with self.sessions() as session:
                await task_access.publish_task(session, await session.get(models.Task, tid), "task.updated")
            pushed = next(call.args[1]["task"] for call in self.published.await_args_list if call.args[0] == "peer")
            for api in (detail, listing[tid], pushed):
                self.assertTrue(api["canViewExecution"], "保留原执行参与者权限")
                self.assertTrue(api["canComment"])
                self.assertFalse(api["readOnly"])
                self.assertIn("executor", api["myRoles"])
                self.assertEqual(api["canArchiveRequirement"], label == "all")
                self.assertEqual(api["canDeleteRequirement"], label == "all")
                self.assertEqual("creator" in api["myRoles"], label == "all")


if __name__ == "__main__":
    unittest.main()
