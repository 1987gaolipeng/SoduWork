"""Stable execution-account snapshots and evidence-only legacy migration."""
import importlib.util
import os
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ.setdefault("AUTH_SECRET", "isolated-task-account-ownership-tests-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-admin-test-password")

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app import models, automation_models
from app.conversation_handoff_models import ConversationHandoff
from app.db import Base
from app.services import task_access, task_requirements


class TaskAccountOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.session = Session(self.engine, expire_on_commit=False)
        self.device = models.Client(id="device", user_ref="alice")
        self.other = models.Client(id="other-device", user_ref="carol")
        self.session.add_all([self.device, self.other])
        self.session.commit()

    def tearDown(self):
        self.session.close()
        self.engine.dispose()

    def test_creation_switch_and_transfer_freeze_execution_account(self):
        task = models.Task(id="private", owner_client_id=self.device.id,
                           owner_user_id="forged", created_by="alice", assignee_user_id="reviewer")
        self.session.add(task)
        self.session.commit()
        self.assertEqual(task.owner_user_id, "alice")
        self.assertTrue(task_access.is_owner(task, self.device))
        self.device.user_ref = "bob"
        task.note = "background update must not change ownership"
        self.session.commit()
        self.assertEqual(task.owner_user_id, "alice")
        self.assertFalse(task_access.is_owner(task, self.device))
        self.assertEqual(self.session.scalars(select(models.Task).where(
            task_access.owner_clause(self.device))).all(), [])
        self.assertEqual(task_access.my_roles(task, self.device), [])
        self.device.user_ref = "alice"
        self.assertTrue(task_access.is_owner(task, self.device))
        task.owner_client_id = self.other.id
        self.session.commit()
        self.assertEqual(task.owner_user_id, "carol")
        self.assertTrue(task_access.is_owner(task, self.other))
        task.owner_client_id = None
        self.session.commit()
        self.assertIsNone(task.owner_user_id)

    def test_unattributed_task_and_client_grant_do_not_follow_logged_in_account(self):
        self.device.user_ref = None
        self.session.commit()
        task = models.Task(id="anonymous", owner_client_id=self.device.id)
        grant = models.TaskRequirementAccess(task_id=task.id, source_id="legacy", principal_kind="client",
                                           principal_id=self.device.id, role="creator")
        self.session.add_all([task, grant])
        self.session.commit()
        self.assertTrue(task_access.is_owner(task, self.device))
        self.device.user_ref = "bob"
        self.session.commit()
        self.assertFalse(task_access.is_owner(task, self.device))
        self.assertFalse(task_access.is_creator(task, user_id="bob", client_id=self.device.id))
        self.assertEqual(self.session.scalars(select(models.TaskRequirementAccess).where(
            task_requirements.principal_clause(self.device))).all(), [])
        self.session.add(models.TaskRequirementAccess(task_id=task.id, source_id="legacy", principal_kind="user",
                                                     principal_id="alice", role="creator"))
        self.session.commit()
        self.device.user_ref = "alice"
        self.assertEqual(len(self.session.scalars(select(models.TaskRequirementAccess).where(
            task_requirements.principal_clause(self.device))).all()), 1)

    def test_concurrent_login_cannot_assign_an_inflight_task_to_the_new_account(self):
        # Another transaction changes the physical device after this request's
        # authentication loaded Alice. The identity map deliberately stays old.
        with self.engine.begin() as connection:
            connection.execute(models.Client.__table__.update().where(
                models.Client.id == self.device.id).values(user_ref="bob"))
        self.assertEqual(self.device.user_ref, "alice")
        self.session.add(models.Task(id="inflight", owner_client_id=self.device.id, created_by="alice"))
        with self.assertRaises(models.TaskOwnershipChanged):
            self.session.commit()
        self.session.rollback()
        self.assertIsNone(self.session.get(models.Task, "inflight"))

    def test_migration_uses_history_not_current_device_login_and_is_idempotent(self):
        self.device.user_ref = "bob"
        self.session.add_all([models.User(id=name, username=name) for name in ("alice", "bob", "carol")])
        self.session.commit()
        task_table = models.Task.__table__
        with self.engine.begin() as connection:
            connection.execute(task_table.insert(), [
                dict(id="assigned", owner_client_id="device", created_by="bob", assignee_user_id="alice"),
                dict(id="handoff", owner_client_id="device", created_by="bob", assignee_user_id="alice"),
                dict(id="unknown", owner_client_id="device", created_by=None, assignee_user_id=None),
            ])
            connection.execute(ConversationHandoff.__table__.insert().values(id="h", task_id="handoff",
                owner_client_id="device", owner_user_id="carol", transfer_id="transfer"))
            connection.execute(task_table.update().where(task_table.c.id == "assigned").values(
                legacy_requirements=[dict(id="source", created_by_user_id="alice", created_by_client_id="device")]))
            connection.execute(models.Attachment.__table__.insert(), [
                dict(id="known", task_id="assigned", uploaded_by="device"),
                dict(id="unknown-file", task_id="unknown", uploaded_by="device"),
                dict(id="direct-user", task_id="", uploaded_by="carol"),
            ])
            path = Path(__file__).parent / "migrations/versions/0065_task_account_ownership.py"
            spec = importlib.util.spec_from_file_location("ownership_migration", path)
            migration = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(migration)
            migration.migrate_data(connection)
            migration.migrate_data(connection)
            owners = dict(connection.execute(select(task_table.c.id, task_table.c.owner_user_id)).all())
            self.assertEqual(owners, {"assigned": "alice", "handoff": "carol", "unknown": None})
            files = dict(connection.execute(select(models.Attachment.id, models.Attachment.evidence_meta)).all())
            self.assertEqual(files["known"]["ownerUserId"], "alice")
            self.assertNotIn("ownerUserId", files["unknown-file"])
            self.assertEqual(files["direct-user"]["ownerUserId"], "carol")
            grants = connection.execute(select(models.TaskRequirementAccess.principal_kind,
                                               models.TaskRequirementAccess.principal_id)).all()
            self.assertEqual(grants, [("user", "alice")])


class ScheduleTaskAccountTests(unittest.IsolatedAsyncioTestCase):
    async def test_owner_change_is_a_controlled_http_conflict(self):
        import httpx
        from fastapi import FastAPI
        from app.main import task_ownership_conflict_handler
        app = FastAPI()
        app.add_exception_handler(models.TaskOwnershipChanged, task_ownership_conflict_handler)

        @app.post("/test-create")
        async def create():
            raise models.TaskOwnershipChanged("执行设备的登录账号已变更，请刷新后重试")

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
            response = await http.post("/test-create")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "执行设备的登录账号已变更，请刷新后重试"})

    async def test_switched_personal_schedule_cannot_create_task_or_notify_new_account(self):
        from app.services import schedules
        device = models.Client(id="device", user_ref="bob")
        creator = models.User(id="alice", username="alice", is_active=True, is_super=False)
        session = AsyncMock()
        session.get.side_effect = lambda model, key, **kw: device if model is models.Client else creator
        schedule = SimpleNamespace(id="private", owner_client_id="device", owner_user_id="alice", created_by="alice", last_error="")
        with patch.object(schedules, "resolve_repo", new_callable=AsyncMock) as resolve, \
             patch("app.realtime.hub.publish", new_callable=AsyncMock) as publish:
            result = await schedules.run_one(session, schedule)
            await schedules._notify_failure(session, schedule, {"error": "private error"})
        self.assertEqual(result["code"], "SCHEDULE_OWNER_CHANGED")
        resolve.assert_not_awaited()
        publish.assert_not_awaited()

    async def test_schedule_preserves_frozen_account_and_explicit_admin_delegation(self):
        from app.services import schedules
        device = models.Client(id="device", user_ref="alice")
        creator = models.User(id="alice", username="alice", is_active=True, is_super=False, role_id="dispatcher")
        role = models.Role(id="dispatcher", name="Dispatcher", permissions=["task.dispatch"])
        schedule = SimpleNamespace(owner_client_id="device", owner_user_id="alice", created_by="alice")
        session = AsyncMock()
        session.get.side_effect = lambda model, key, **kw: creator if model is models.User else role
        self.assertTrue(await schedules._account_can_run(session, schedule, device))
        session.get.assert_not_awaited()
        device.user_ref = "bob"
        self.assertFalse(await schedules._account_can_run(session, schedule, device))
        schedule.owner_user_id = "bob"  # Explicit delegation freezes the receiving account at creation.
        self.assertTrue(await schedules._account_can_run(session, schedule, device))
        device.user_ref = "alice"
        self.assertFalse(await schedules._account_can_run(session, schedule, device))


if __name__ == "__main__":
    unittest.main()
