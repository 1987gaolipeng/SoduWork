"""Task receipts must not serialize independent devices' slow event channels."""
import asyncio
import os
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ.setdefault("AUTH_SECRET", "isolated-task-fanout-test-secret-not-for-deployment")

from app import models
from app.services import task_access


class TaskNotificationFanoutTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, count, publish, decorate=None):
        stack = ExitStack()
        self.addCleanup(stack.close)
        clients = [models.Client(id=f"device-{i}", user_ref=f"user-{i}")
                   for i in range(count)]
        task = models.Task(id="task", title="Requirement", owner_client_id="device-0",
                           assignee_user_id="user-1", owner_user_id="user-0")
        stack.enter_context(patch.object(task_access, "recipient_clients",
                                        new=AsyncMock(return_value=clients)))
        for name in ("_name_map", "_device_name_map"):
            stack.enter_context(patch.object(task_access, name, new=AsyncMock(return_value={})))
        stack.enter_context(patch("app.services.task_requirement_projection.decorate_many",
                                  new=AsyncMock()))
        stack.enter_context(patch("app.services.requirement_edit_policy.decorate_many", new=AsyncMock()))
        stack.enter_context(patch("app.services.task_requirements.prepare_notifications", new=AsyncMock(
            return_value={client.id: None for client in clients})))
        async def project(_session, client, task, api, **_inputs):
            return await decorate(_session, client, task, api) if decorate else api
        stack.enter_context(patch("app.services.task_requirements.decorate", new=AsyncMock(side_effect=project)))
        stack.enter_context(patch.object(task_access.hub, "publish", new=AsyncMock(side_effect=publish)))
        return task

    async def test_slow_devices_do_not_serialize_or_block_other_recipients(self):
        gate, all_started, fast_received = asyncio.Event(), asyncio.Event(), asyncio.Event()
        started = set()

        async def publish(device, _event, *, user_id):
            self.assertEqual(user_id, device.replace("device-", "user-"))
            started.add(device)
            if len(started) == 7:
                all_started.set()
            if device == "device-6":
                fast_received.set()
            else:
                await gate.wait()

        task = self.fixture(7, publish)
        sending = asyncio.create_task(task_access.publish_task(
            SimpleNamespace(), task, "task.created", {"id": task.id}))
        try:
            await asyncio.wait_for(all_started.wait(), 1)
            self.assertTrue(fast_received.is_set())
            self.assertFalse(sending.done(), "the receipt still awaits all attempted notifications")
        finally:
            gate.set()
            await sending

    async def test_permission_projections_stay_serial_and_payloads_stay_device_scoped(self):
        projecting, projected, sent = False, [], []

        async def decorate(_session, client, _task, value):
            nonlocal projecting
            self.assertFalse(projecting, "one AsyncSession must never be queried concurrently")
            projecting = True
            await asyncio.sleep(0)
            value["visibleFor"] = client.id
            projected.append(client.id)
            projecting = False
            return value

        async def publish(device, event, *, user_id):
            self.assertEqual(user_id, device.replace("device-", "user-"))
            self.assertEqual(len(projected), 3, "finish authorization before network fanout")
            sent.append((device, event))

        task = self.fixture(3, publish, decorate)
        await task_access.publish_task(SimpleNamespace(), task, "task.updated",
            {"id": task.id, "arrival": "stale", "by": "stale"},
            arrival="assign", by="Creator", notification_id="notice")
        self.assertEqual(len(sent), 3)
        for device, event in sent:
            self.assertEqual(event["task"]["visibleFor"], device)
            self.assertNotIn("arrival", event["task"])
            self.assertEqual(event["notificationId"], "notice")
            self.assertEqual(event.get("arrival"), "assign" if device == "device-1" else None)
            self.assertEqual(event.get("by"), "Creator" if device == "device-1" else None)
            self.assertEqual(event["task"]["readOnly"], device != "device-0")

    async def test_projection_failure_never_starts_unprepared_network_work(self):
        sent = []

        async def decorate(_session, client, _task, value):
            if client.id == "device-1":
                raise RuntimeError("permission lookup unavailable")
            return value

        async def publish(device, _event, *, user_id):
            self.assertEqual(user_id, device.replace("device-", "user-"))
            sent.append(device)

        task = self.fixture(3, publish, decorate)
        with self.assertRaisesRegex(RuntimeError, "permission lookup"):
            await task_access.publish_task(SimpleNamespace(), task, "task.created", {"id": task.id})
        self.assertEqual(sent, [])

    async def test_fanout_is_bounded_and_eventually_attempts_every_recipient(self):
        gate, capacity_reached = asyncio.Event(), asyncio.Event()
        active, peak, received = 0, 0, []

        async def publish(device, _event, *, user_id):
            self.assertEqual(user_id, device.replace("device-", "user-"))
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            received.append(device)
            if active == 3:
                capacity_reached.set()
            try:
                await gate.wait()
            finally:
                active -= 1

        task = self.fixture(10, publish)
        with patch.object(task_access, "_PUBLISH_CONCURRENCY", 3):
            sending = asyncio.create_task(task_access.publish_task(
                SimpleNamespace(), task, "task.created", {"id": task.id}))
            try:
                await asyncio.wait_for(capacity_reached.wait(), 1)
                self.assertEqual(len(received), 3)
            finally:
                gate.set()
                await sending
        self.assertLessEqual(peak, 3)
        self.assertEqual(len(set(received)), 10)
        self.assertEqual(active, 0)

    async def test_transport_failure_is_reported_after_other_deliveries_settle(self):
        gate, all_started = asyncio.Event(), asyncio.Event()
        received, finished = [], []

        async def publish(device, _event, *, user_id):
            self.assertEqual(user_id, device.replace("device-", "user-"))
            received.append(device)
            if len(received) == 5:
                all_started.set()
            if device == "device-0":
                raise RuntimeError("transport unavailable")
            await gate.wait()
            finished.append(device)

        task = self.fixture(5, publish)
        sending = asyncio.create_task(task_access.publish_task(
            SimpleNamespace(), task, "task.created", {"id": task.id}))
        try:
            await asyncio.wait_for(all_started.wait(), 1)
            self.assertFalse(sending.done())
        finally:
            gate.set()
            with self.assertRaisesRegex(RuntimeError, "transport unavailable"):
                await sending
        self.assertEqual(set(received), {f"device-{i}" for i in range(5)})
        self.assertEqual(set(finished), {f"device-{i}" for i in range(1, 5)})

    async def test_cancellation_does_not_leave_detached_deliveries(self):
        gate, all_started = asyncio.Event(), asyncio.Event()
        started, cancelled = [], []

        async def publish(device, _event, *, user_id):
            self.assertEqual(user_id, device.replace("device-", "user-"))
            started.append(device)
            if len(started) == 3:
                all_started.set()
            try:
                await gate.wait()
            except asyncio.CancelledError:
                cancelled.append(device)
                raise

        task = self.fixture(3, publish)
        sending = asyncio.create_task(task_access.publish_task(
            SimpleNamespace(), task, "task.created", {"id": task.id}))
        await asyncio.wait_for(all_started.wait(), 1)
        sending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await sending
        self.assertEqual(set(cancelled), set(started))


class TaskCreateNotificationIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_committed_create_reaches_fast_viewer_before_slow_devices_finish(self):
        import httpx
        from fastapi import FastAPI, Request
        from sqlalchemy import func, select
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
        from app.api import tasks
        from app.db import Base, get_session
        from app.deps import current_client
        from app.realtime import Hub
        # Register execution-session tables before creating the isolated schema;
        # live task projection imports this model lazily during the request.
        from app import automation_models  # noqa: F401
        # Replayed creates also resolve runtime memory during projection.
        from app import memory_record_models  # noqa: F401

        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(engine.dispose)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        clients = {}
        async with sessions() as session:
            session.add(models.OrgUnit(id="company", name="Company"))
            for i in range(7):
                uid, did = f"user-{i}", f"device-{i}"
                session.add(models.User(id=uid, username=uid, org_id="company", is_active=True))
                clients[did] = models.Client(id=did, user_ref=uid, auth_state="active")
                session.add(clients[did])
            await session.commit()

        app = FastAPI()
        app.include_router(tasks.router)

        async def identity(request: Request):
            return clients[request.headers.get("X-Test-Identity", "device-0")]

        async def db():
            async with sessions() as session:
                yield session

        app.dependency_overrides[current_client] = identity
        app.dependency_overrides[get_session] = db
        http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture")
        self.addAsyncCleanup(http.aclose)
        channels = Hub()
        gate, all_started = asyncio.Event(), asyncio.Event()
        received, completed = {}, set()

        class Socket:
            def __init__(self, device):
                self.device = device

            async def send_json(self, event):
                received[self.device] = event
                if len(received) == 7:
                    all_started.set()
                if self.device != "device-6":
                    await gate.wait()
                completed.add(self.device)

        for did in clients:
            await channels.connect(did, Socket(did), accept=False, user_id=clients[did].user_ref)

        body = {"title": "Shared requirement", "note": "Already parsed", "visibility": "organization"}
        with patch.object(task_access, "hub", channels):
            request = asyncio.create_task(http.put("/api/v1/tasks/new-task", json=body))
            # The revised API contract acknowledges the committed row and its
            # durable delivery work before contacting any device.
            response = await asyncio.wait_for(request, 3)
            self.assertEqual(response.status_code, 200, response.text)
            # The creation receipt is rendered immediately from this PUT
            # response.  It must carry the resolved owner display name so the
            # client never falls back to the truncated assignee ID.
            self.assertEqual(response.json().get("assigneeName"), "user-0")
            self.assertFalse(received)
            from app.services import task_notifications
            sending = asyncio.create_task(task_notifications.run_once(sessions))
            try:
                await asyncio.wait_for(all_started.wait(), 3)
                self.assertIn("device-6", completed)
                self.assertTrue(request.done())
                self.assertFalse(sending.done())
                # Verify through another session: notification work starts only
                # after the Hub has durably committed the authoritative row.
                async with sessions() as session:
                    persisted = await session.get(models.Task, "new-task")
                    self.assertIsNotNone(persisted)
                    self.assertEqual(persisted.owner_client_id, "device-0")
                    self.assertEqual(persisted.title, body["title"])
            finally:
                gate.set()
                await sending
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["id"], "new-task")
            self.assertEqual(completed, set(clients))
            for did, event in received.items():
                self.assertEqual(event["type"], "task.created")
                if did != "device-0":
                    self.assertFalse(event["task"]["canViewExecution"])
                    self.assertNotIn("workRouting", event["task"])

            replay = await http.put("/api/v1/tasks/new-task", json=body)
            self.assertEqual(replay.status_code, 200, replay.text)
            denied = await http.put("/api/v1/tasks/new-task", json=body,
                                    headers={"X-Test-Identity": "device-1"})
            self.assertEqual(denied.status_code, 409, denied.text)
        async with sessions() as session:
            count = await session.scalar(select(func.count()).select_from(models.Task))
            self.assertEqual(count, 1, "idempotent retries cannot create duplicates or change ownership")


if __name__ == "__main__":
    unittest.main()
