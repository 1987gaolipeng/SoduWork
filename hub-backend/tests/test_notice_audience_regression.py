"""Completion receipts notify actual participants, never implicit managers."""
import os
import importlib
import atexit
import sqlite3
import shutil
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-notice-audience-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-notice-audience-admin")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models, realtime
from app.services import receipts, notify


# Standalone execution needs the same registered foreign-key targets as the app.
for model_file in (Path(__file__).resolve().parents[1] / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


_SCHEMA_ROOT = Path(tempfile.mkdtemp(prefix="soduwork-notice-audience-schema-"))
_SCHEMA_TEMPLATE = _SCHEMA_ROOT / "schema.db"


def _schema_template():
    if not _SCHEMA_TEMPLATE.exists():
        schema_engine = create_engine("sqlite:///" + _SCHEMA_TEMPLATE.as_posix())
        try:
            with schema_engine.connect() as connection:
                connection.exec_driver_sql("BEGIN")
                models.Base.metadata.create_all(connection)
                connection.commit()
        finally:
            schema_engine.dispose()
    return _SCHEMA_TEMPLATE


atexit.register(lambda: shutil.rmtree(_SCHEMA_ROOT, ignore_errors=True))


class NoticeAudienceRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-notice-audience-test-")
        self.addCleanup(self.directory.cleanup)
        memory_name = "soduwork_notice_audience_" + uuid.uuid4().hex
        self._schema_anchor = sqlite3.connect(
            f"file:{memory_name}?mode=memory&cache=shared", uri=True,
        )
        self.addCleanup(self._schema_anchor.close)
        with sqlite3.connect(_schema_template()) as source:
            source.backup(self._schema_anchor)
        database_url = f"sqlite+aiosqlite:///file:{memory_name}?mode=memory&cache=shared&uri=true"
        self.engine = create_async_engine(database_url)
        self.addAsyncCleanup(self.engine.dispose)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.addAsyncCleanup(self.session.close)
        self.session.add_all([models.User(id=uid, username=uid, is_active=True)
                              for uid in ("executor", "requester", "leader")])
        self.session.add_all([models.Client(id=cid, user_ref=uid, auth_state="active")
                              for cid, uid in (("e1", "executor"), ("e2", "executor"),
                                               ("r1", "requester"), ("l1", "leader"))])
        await self.session.commit()
        self.publish = AsyncMock()
        for target, value in (("app.realtime.hub.publish", self.publish),
                              ("app.services.team.direct_leaders", AsyncMock(return_value=["leader"]))):
            guard = patch(target, value)
            guard.start()
            self.addCleanup(guard.stop)

    async def close(self, **fields):
        task = models.Task(id="completed", title="Participant task", status="done",
                           origin="assigned", owner_client_id="e1", **fields)
        self.session.add(task)
        await self.session.commit()
        await receipts.notify_on_close(self.session, task, "e1")
        return [(call.args[0], call.args[1]) for call in self.publish.await_args_list]

    async def test_unrelated_direct_leader_does_not_receive_completion_notice(self):
        self.assertEqual(await self.close(), [])

    async def test_requester_keeps_receipt_with_explicit_recipient_and_task(self):
        notices = await self.close(requester_user_id="requester")
        self.assertEqual([cid for cid, _ in notices], ["r1"])
        self.assertEqual(notices[0][1].get("recipientId"), "requester")
        self.assertEqual(notices[0][1].get("taskId"), "completed")
        self.assertEqual(notices[0][1].get("kind"), "task_receipt")
        self.assertEqual(self.publish.await_args.kwargs["user_id"], "requester")

    async def test_external_request_keeps_creator_relay_without_manager_copy(self):
        notices = await self.close(created_by="requester", requester_name="Customer")
        self.assertEqual([cid for cid, _ in notices], ["r1"])
        self.assertEqual(notices[0][1].get("recipientId"), "requester")
        self.assertIn("Customer", notices[0][1]["text"])
        self.assertEqual(self.publish.await_args.kwargs["user_id"], "requester")

    async def test_task_notice_does_not_follow_device_to_another_account(self):
        task = models.Task(id="private", title="Executor private", status="doing", owner_client_id="e1")
        self.session.add(task)
        await self.session.commit()
        client = await self.session.get(models.Client, "e1")
        client.user_ref = "requester"
        await self.session.commit()
        self.assertEqual(await notify.notify_task(self.session, task, "Private result"), 0)
        self.publish.assert_not_awaited()
        client.user_ref = "executor"
        await self.session.commit()
        self.assertEqual(await notify.notify_task(self.session, task, "Own result"), 1)
        self.assertEqual(self.publish.await_args.args[0], "e1")
        self.assertEqual(self.publish.await_args.kwargs["user_id"], "executor")

    async def test_late_runner_updates_require_frozen_account(self):
        from app.api import runner_ws
        task = models.Task(id="runner-private", title="Private run", status="doing", owner_client_id="e1")
        self.session.add(task)
        await self.session.commit()
        event = {"type": "execution.updated", "taskId": task.id, "session": {"text": "Private output"}}
        factory = async_sessionmaker(self.engine, expire_on_commit=False)
        with patch.object(runner_ws, "SessionLocal", factory):
            await runner_ws._publish_task_owner(task.id, event)
            self.assertEqual(self.publish.await_args.kwargs["user_id"], "executor")
            self.publish.reset_mock()
            client = await self.session.get(models.Client, "e1")
            client.user_ref = "requester"
            await self.session.commit()
            await runner_ws._publish_task_owner(task.id, event)
            self.publish.assert_not_awaited()

    async def test_own_completion_does_not_become_a_notice_on_another_device(self):
        with patch("app.services.receipts.box_of_user", AsyncMock(return_value="e2")):
            self.assertEqual(await self.close(requester_user_id="executor"), [])

    async def test_dispatch_retry_and_runner_completion_update_both_account_devices(self):
        from app import automation_models as am
        from app.api import runner_ws
        from app.services import dispatch_reconcile, task_dispatch_context, tasks

        task = models.Task(id="retry", title="Cloud requirement", status="doing",
                           owner_client_id="e1", owner_user_id="executor", created_by="executor")
        self.session.add(task)
        await self.session.commit()
        now = datetime.now(timezone.utc)

        def assert_cards(state):
            sent = {call.args[0]: call for call in self.publish.await_args_list}
            self.assertEqual(set(sent), {"e1", "e2"})
            self.assertEqual(len(self.publish.await_args_list), 2)
            for call in sent.values():
                self.assertEqual(call.kwargs["user_id"], "executor")
                self.assertEqual(call.args[1]["type"], "task.updated")
                card = call.args[1]["task"]
                self.assertEqual(card["ai"]["state"], state)
                self.assertIn("myRoles", card)
                if state != "failed":
                    self.assertNotIn("error", card["ai"])
            self.publish.reset_mock()

        self.session.add(models.TaskEvent(task_id=task.id, kind="ai.dispatch_failed", at=now,
                                         detail={"attemptId": "old", "error": "Old routing failure"}))
        await self.session.commit()
        await task_dispatch_context._push_task(self.session, task, False)
        assert_cards("failed")

        self.session.add(models.TaskEvent(task_id=task.id, kind="ai.dispatch_started",
                                         at=now + timedelta(seconds=1), detail={"attemptId": "retry"}))
        await self.session.commit()
        await dispatch_reconcile._publish(self.session, task, "pending")
        assert_cards("dispatching")

        self.session.add(models.TaskEvent(task_id=task.id, kind="ai.dispatched",
                                         at=now + timedelta(seconds=2),
                                         detail={"attemptId": "retry", "ref": "cloud-ref"}))
        execution = am.ExecutionSession(task_id=task.id, ref="cloud-ref", state="running")
        self.session.add(execution)
        await self.session.commit()
        await task_dispatch_context._push_task(self.session, task, False)
        assert_cards("running")

        factory = async_sessionmaker(self.engine, expire_on_commit=False)
        for state, error in (("done", ""), ("failed", "Current failure")):
            execution.state = state
            execution.metadata_ = {"error": error}
            await self.session.commit()
            card = await tasks.task_to_api_live(self.session, task)
            with patch.object(runner_ws, "SessionLocal", factory):
                await runner_ws._publish_task_owner(task.id, {"type": "task.updated", "task": card})
            assert_cards(state)

    async def test_runner_task_cards_do_not_follow_a_device_account_switch(self):
        from app.api import runner_ws
        from app.services import tasks
        task = models.Task(id="switched", title="Private card", status="doing", owner_client_id="e1",
                           owner_user_id="executor", created_by="executor")
        self.session.add(task)
        client = await self.session.get(models.Client, "e1")
        client.user_ref = "requester"
        await self.session.commit()
        card = await tasks.task_to_api_live(self.session, task)
        with patch.object(runner_ws, "SessionLocal", async_sessionmaker(self.engine, expire_on_commit=False)):
            await runner_ws._publish_task_owner(task.id, {"type": "task.updated", "task": card})
        self.assertEqual([call.args[0] for call in self.publish.await_args_list], ["e2"])
        self.assertEqual(self.publish.await_args.kwargs["user_id"], "executor")


if __name__ == "__main__":
    unittest.main()
