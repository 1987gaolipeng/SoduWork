"""Real HTTP/SQLite checks for cancellation through the explicit handoff entry."""
import os
import unittest
from unittest.mock import AsyncMock, Mock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-handoff-maintenance-test-key")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from fastapi import Request
from sqlalchemy import select

from app import automation_models as am, models, project_context_models  # noqa: F401
from app.api import trace
from app.deps import current_user
from test_unified_requirements import UnifiedRequirementTests


class HandoffMaintenanceBoundaryTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = UnifiedRequirementTests.asyncTearDown
    call = UnifiedRequirementTests.call

    async def asyncSetUp(self):
        await UnifiedRequirementTests.asyncSetUp(self)
        self.app.include_router(trace.router)
        self.app.include_router(trace.admin_router)
        self.admin_permissions = {"task.dispatch"}
        async with self.sessions() as session:
            for uid in ("owner", "peer"):
                user = await session.get(models.User, uid)
                user.is_super = True
            await session.commit()

        async def administrator(request: Request):
            async with self.sessions() as session:
                user = await session.get(models.User, request.headers.get("X-Test-Identity", "owner"))
                user._perms = set(self.admin_permissions)
                return user
        self.app.dependency_overrides[current_user] = administrator
        self.notices = patch("app.services.notify.notify_task", new_callable=AsyncMock)
        self.notices.start()
        self.addCleanup(self.notices.stop)

    async def seed(self, tid, *, creator="owner", owner="owner", status="todo", triage="ready", reviewing=False):
        async with self.sessions() as session:
            session.add(models.Task(id=tid, title="Isolated handoff", owner_client_id=owner,
                                    created_by=creator, status=status, triage_stage=triage, origin="local"))
            if reviewing:
                session.add(am.ArtifactVersion(id=tid, task_id=tid, kind="files", seq=1,
                                               state="candidate", checksum="fixture"))
                session.add(am.ApprovalRequest(id=tid, task_id=tid, action="review",
                                               artifact_version_id=tid, status="pending"))
            await session.commit()

    async def test_noncreator_cannot_use_either_handoff_entry_to_cancel_prestart_work(self):
        from app.services import handoff
        for entry in ("client", "admin"):
            for triage in ("intake", "clarifying", "ready"):
                tid = entry + "-" + triage
                await self.seed(tid, creator="peer" if entry == "client" else "owner", triage=triage)
                with self.subTest(entry=entry, triage=triage), patch.object(
                    handoff, "_end_runs", AsyncMock(return_value=[])
                ) as end, patch.object(handoff, "_stop_direct_ai", AsyncMock(return_value=[])) as stop:
                    response = await self.call("POST", ("tasks/" + tid + "/manual-handoff")
                        if entry == "client" else ("admin/tasks/" + tid + "/handoff"),
                        "owner" if entry == "client" else "peer", json={"status": "cancel"})
                    self.assertEqual(response.status_code, 403, response.text)
                    end.assert_not_called()
                    stop.assert_not_called()
                    async with self.sessions() as session:
                        self.assertEqual((await session.get(models.Task, tid)).status, "todo")
                        self.assertEqual(list(await session.scalars(select(models.TaskEvent).where(
                            models.TaskEvent.task_id == tid))), [])

    async def test_creator_can_cancel_prestart_from_client_and_real_admin_identity(self):
        for entry in ("client", "admin"):
            tid = "creator-" + entry
            await self.seed(tid)
            response = await self.call("POST", ("tasks/" + tid + "/manual-handoff")
                if entry == "client" else ("admin/tasks/" + tid + "/handoff"), json={"status": "cancel"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["status"], "cancel")

    async def test_creator_on_another_owned_device_and_anonymous_local_creator_still_work(self):
        for device_id, uid, creator in (("owner-second", "owner", "owner"), ("anonymous", None, None)):
            async with self.sessions() as session:
                device = models.Client(id=device_id, user_ref=uid, auth_state="active")
                session.add(device)
                self.clients[device_id] = device
                await session.commit()
            await self.seed(device_id, creator=creator, owner=device_id)
            response = await self.call("POST", "tasks/" + device_id + "/manual-handoff",
                                       device_id, json={"status": "cancel"})
            self.assertEqual(response.status_code, 200, response.text)
        await self.seed("admin-no-device", creator=None)
        response = await self.call("POST", "admin/tasks/admin-no-device/handoff", json={"status": "cancel"})
        self.assertEqual(response.status_code, 403, "an administrator must not impersonate the owning device")

    async def test_noncreator_can_still_stop_started_work_with_the_real_handoff_service(self):
        for entry in ("client", "admin"):
            tid = "started-" + entry
            await self.seed(tid, creator="peer" if entry == "client" else "owner", status="doing")
            async with self.sessions() as session:
                session.add(models.TaskEvent(task_id=tid, kind="ai.dispatched",
                                              detail={"ref": "fixture-" + tid, "provider": "local"}))
                await session.commit()
            with patch("app.services.ai_exec.load", AsyncMock(return_value={})), patch(
                "app.services.ai_exec.stop_sync", Mock(return_value={"ok": True})
            ) as stop:
                response = await self.call("POST", ("tasks/" + tid + "/manual-handoff")
                    if entry == "client" else ("admin/tasks/" + tid + "/handoff"),
                    "owner" if entry == "client" else "peer", json={"status": "cancel"})
                self.assertEqual(response.status_code, 200, response.text)
                stop.assert_called_once_with({}, "fixture-" + tid)
            async with self.sessions() as session:
                self.assertEqual((await session.get(models.Task, tid)).status, "cancel")
                kinds = list(await session.scalars(select(models.TaskEvent.kind).where(models.TaskEvent.task_id == tid)))
                self.assertIn("task.handoff", kinds)
                self.assertIn("ai.dispatched", kinds, "handoff retains the execution evidence")

    async def test_pending_review_is_not_misclassified_as_prestart_and_done_handoff_is_unchanged(self):
        await self.seed("pending-review", creator="peer", reviewing=True)
        await self.seed("default-done", creator="owner")
        for tid, body, expected in (("pending-review", {"status": "cancel"}, "cancel"),
                                    ("default-done", {}, "done")):
            response = await self.call("POST", "tasks/" + tid + "/manual-handoff", json=body)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["status"], expected)

    async def test_noncreator_cannot_bypass_prestart_guard_with_done_or_invalid_handoff(self):
        for entry in ("client", "admin"):
            for status in (None, "done", "unexpected"):
                tid = "done-bypass-" + entry + "-" + str(status)
                await self.seed(tid, creator="peer" if entry == "client" else "owner")
                with self.subTest(entry=entry, status=status):
                    response = await self.call("POST", ("tasks/" + tid + "/manual-handoff")
                        if entry == "client" else ("admin/tasks/" + tid + "/handoff"),
                        "owner" if entry == "client" else "peer", json={} if status is None else {"status": status})
                    self.assertEqual(response.status_code, 403, response.text)
                    async with self.sessions() as session:
                        self.assertEqual((await session.get(models.Task, tid)).status, "todo")
                        self.assertEqual(list(await session.scalars(select(models.TaskEvent).where(
                            models.TaskEvent.task_id == tid))), [])

    async def test_stale_todo_does_not_prevent_noncreator_stopping_a_real_execution(self):
        for entry in ("client", "admin"):
            tid = "stale-todo-" + entry
            await self.seed(tid, creator="peer" if entry == "client" else "owner")
            async with self.sessions() as session:
                session.add(am.ExecutionSession(task_id=tid, ref=tid, state="running"))
                session.add(models.TaskEvent(task_id=tid, kind="ai.dispatched", detail={"ref": tid}))
                await session.commit()
            with self.subTest(entry=entry), patch("app.services.ai_exec.load", AsyncMock(return_value={})), patch(
                "app.services.ai_exec.stop_sync", Mock(return_value={"ok": True})
            ) as stop:
                response = await self.call("POST", ("tasks/" + tid + "/manual-handoff")
                    if entry == "client" else ("admin/tasks/" + tid + "/handoff"),
                    "owner" if entry == "client" else "peer", json={"status": "cancel"})
                self.assertEqual(response.status_code, 200, response.text)
                stop.assert_called_once_with({}, tid)
                self.assertEqual(response.json()["status"], "cancel")
                self.assertTrue(response.json()["task"]["maintenanceBlocked"],
                                "handoff does not forge a terminal execution receipt for deletion")

    async def test_existing_device_admin_permission_and_resource_scope_checks_still_apply(self):
        await self.seed("private-creator", creator="peer")
        self.assertEqual((await self.call("POST", "tasks/private-creator/manual-handoff", "peer",
                                          json={"status": "cancel"})).status_code, 404)
        self.assertEqual((await self.call("POST", "admin/tasks/private-creator/handoff", "outsider",
                                          json={"status": "cancel"})).status_code, 403)
        self.admin_permissions.clear()
        self.assertEqual((await self.call("POST", "admin/tasks/private-creator/handoff", "peer",
                                          json={"status": "cancel"})).status_code, 403)


if __name__ == "__main__":
    unittest.main()
