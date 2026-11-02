"""Real SQL budgets and device-scoped ACL parity for single-task events."""
import os

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ.setdefault("AUTH_SECRET", "isolated-notification-query-test-secret-not-for-production")
os.environ.setdefault("ADMIN_PASS", "isolated-notification-query-test-password")

import unittest
import asyncio
import tempfile
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from sqlalchemy import create_engine, event, func, inspect, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models, memory_record_models, models  # noqa: F401
from app.api import tasks
from app.db import Base, get_session
from app.deps import current_client
from app.schemas import task_to_api
from app.services import task_access, task_notifications, task_requirements


class TaskNotificationQueryTests(unittest.IsolatedAsyncioTestCase):
    @asynccontextmanager
    async def fixture(self, devices=10, users=10):
        # The optional PG URL is restricted to an explicitly isolated fixture.
        pg_url = os.environ.get("TASK_NOTIFICATION_TEST_DATABASE_URL", "")
        if pg_url:
            parsed = urlsplit(pg_url)
            if (parsed.hostname != "127.0.0.1" or parsed.port != 15493 or
                    not parsed.path.startswith("/.smoke_notification_")):
                raise RuntimeError("Use the isolated notification PostgreSQL fixture only")
        directory = tempfile.TemporaryDirectory(prefix="soduwork-notification-test-")
        engine = create_async_engine(pg_url or "sqlite+aiosqlite:///" + directory.name + "/test.db")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        try:
            if pg_url:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
            else:
                # Keep the complete private schema without async DDL handoffs
                # under unittest's debug loop; all business queries stay async.
                schema_engine = create_engine("sqlite:///" + directory.name + "/test.db")
                try:
                    Base.metadata.create_all(schema_engine)
                finally:
                    schema_engine.dispose()
            async with sessions() as session:
                session.add_all([
                    models.OrgUnit(id="company", name="Company"),
                    models.OrgUnit(id="department", name="Department", parent_id="company"),
                    models.OrgUnit(id="foreign", name="Foreign company"),
                ])
                session.add_all(models.User(id=f"u{i}", username=f"user{i}",
                    org_id="department", is_active=True) for i in range(users))
                clients = [models.Client(id=f"d{i}", user_ref=f"u{i % users}",
                    auth_state="active") for i in range(devices)]
                session.add_all(clients)
                await session.commit()
            yield engine, sessions, clients
        finally:
            if pg_url:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.drop_all)
            await engine.dispose()
            directory.cleanup()

    async def test_shared_write_query_count_does_not_scale_with_devices(self):
        counts = {}
        for devices in (10, 375):
            with self.subTest(devices=devices):
                async with self.fixture(devices, min(devices, 100)) as (engine, sessions, clients):
                    app = FastAPI()
                    app.include_router(tasks.router)

                    async def identity():
                        return clients[0]

                    async def db():
                        async with sessions() as session:
                            yield session

                    app.dependency_overrides[current_client] = identity
                    app.dependency_overrides[get_session] = db
                    statements = []
                    event.listen(engine.sync_engine, "before_cursor_execute",
                                 lambda _c, _u, sql, _p, _x, _m: statements.append(sql))
                    sent = []

                    async def publish(device, payload, *, user_id):
                        self.assertEqual(user_id, next(c.user_ref for c in clients if c.id == device))
                        sent.append((device, payload))

                    operations = [
                        ("create", "PUT", {"title": "One requirement", "visibility": "organization"}),
                        ("edit", "PATCH", {"title": "Edited requirement"}),
                        ("replay", "PUT", {"title": "Edited requirement"}),
                        ("edit-versioned", "PATCH", {"title": "Versioned edit", "requirementVersion": 3}),
                    ]
                    with patch.object(task_access.hub, "publish", new=AsyncMock(side_effect=publish)):
                        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                                     base_url="http://fixture") as http:
                            for name, method, body in operations:
                                statements.clear()
                                sent.clear()
                                response = await http.request(method, "/api/v1/tasks/query-task", json=body)
                                self.assertEqual(response.status_code, 200, response.text)
                                self.assertEqual(response.json()["id"], "query-task")
                                self.assertEqual(sent, [], "save must not deliver notifications inline")
                                counts[devices, name] = len(statements)
                                self.assertLessEqual(len(statements), {
                                    "create": 16, "edit": 8, "replay": 9, "edit-versioned": 9}[name])
                                if name != "create":
                                    history_queries = []
                                    for sql in statements:
                                        self.assertFalse(any(table in sql for table in ("memory_record", "org_unit")), sql)
                                        if any(table in sql for table in (
                                                "task_event", "automation_execution_session",
                                                "automation_workflow_run", "automation_resource_lease")):
                                            # Definition writes must verify execution history under the write lock.
                                            # Permit bounded existence checks, never a timeline or organization scan.
                                            self.assertIn("EXISTS (", sql)
                                            self.assertIn("WHERE task.id IN", sql)
                                            self.assertNotIn("ORDER BY", sql)
                                            history_queries.append(sql)
                                    self.assertLessEqual(len(history_queries), 2,
                                        "Only the write guard and returned edit permission need execution facts")
                                statements.clear()
                                self.assertTrue(await task_notifications.run_once(sessions))
                                self.assertEqual(len(sent), devices)
                                self.assertEqual({row[1]["task"]["id"] for row in sent}, {"query-task"})
                                self.assertEqual({row[1]["type"] for row in sent},
                                                 {"task.created" if name == "create" else "task.updated"})
                                counts[devices, name + "-background"] = len(statements)
                                self.assertLessEqual(len(statements), 64,
                                    f"{name}: notification preparation grew to {len(statements)} SQLs")
                                for device, payload in sent:
                                    # The creator's other devices remain participants;
                                    # unrelated users must still receive redacted cards.
                                    if clients[int(device[1:])].user_ref != "u0":
                                        self.assertFalse(payload["task"]["canViewExecution"])
                                        self.assertNotIn("workRouting", payload["task"])
        for name in ("create", "edit", "replay", "edit-versioned"):
            self.assertLessEqual(counts[375, name], counts[10, name] + 8)
            self.assertLessEqual(counts[375, name + "-background"], counts[10, name + "-background"] + 8)
        print("Foreground/background SQL counts:", counts)

    async def test_private_write_only_notifies_its_authorized_device(self):
        async with self.fixture() as (_, sessions, clients):
            async with sessions() as session:
                from app.services import tasks as service
                with patch.object(task_access.hub, "publish", new=AsyncMock()) as publish:
                    result = await service.put_local_task(session, clients[0].id, "private-task",
                                                          {"title": "Private", "visibility": "related"})
                    self.assertEqual(publish.await_count, 0)
                    await task_notifications.run_once(sessions)
                self.assertEqual(result["id"], "private-task")
                self.assertEqual([call.args[0] for call in publish.await_args_list], ["d0"])

    async def seed_source_permissions(self, session):
        task = models.Task(id="merged", owner_client_id="d0", created_by="u0",
            assignee_user_id="u1", origin="local", status="todo", title="Execution title",
            note="Private execution instructions", work_routing={"private": "execution-only"},
            requirement_content={"title": "Public requirement", "note": "Public input"},
            legacy_requirements=[
                {"id": "source-a", "title": "Source A", "description": "Input A"},
                {"id": "source-b", "title": "Source B", "description": "Input B"},
            ])
        session.add(task)
        session.add(models.Task(id="unrelated", owner_client_id="d0", title="Unrelated"))
        session.add_all([
            models.TaskRequirementAccess(task_id="merged", source_id="source-a",
                principal_kind="user", principal_id="u2", role="creator"),
            models.TaskRequirementAccess(task_id="merged", source_id="source-a",
                principal_kind="client", principal_id="d2", role="creator"),
            models.TaskRequirementAccess(task_id="merged", source_id="source-b",
                principal_kind="client", principal_id="d2", role="creator"),
            models.TaskRequirementAccess(task_id="unrelated", source_id="source-b",
                principal_kind="user", principal_id="u2", role="creator"),
        ])
        session.add(models.Client(id="same-account", user_ref="u2", auth_state="active"))
        # Legacy device grants apply before account activation. A later login
        # must use user grants and cannot inherit the device's private source.
        session.add(models.Client(id="legacy-device", user_ref=None, auth_state="active"))
        session.add_all(models.TaskRequirementAccess(task_id="merged", source_id=source,
            principal_kind="client", principal_id="legacy-device", role="creator")
            for source in ("source-a", "source-b"))
        (await session.get(models.User, "u4")).is_super = True
        (await session.get(models.User, "u5")).org_id = "foreign"
        (await session.get(models.User, "u6")).is_active = False
        await session.commit()

    async def test_batched_projection_matches_per_device_acl_without_private_leaks(self):
        async with self.fixture() as (_, sessions, _):
            async with sessions() as session:
                await self.seed_source_permissions(session)
                task = await session.get(models.Task, "merged")
                clients = list(await session.scalars(select(models.Client)))
                for shared_org in (None, "company"):
                    with self.subTest(shared_org=shared_org):
                        task.shared_org_id = shared_org
                        await session.commit()
                        expected = {}
                        names = await task_access._name_map(session, [task])
                        devices = await task_access._device_name_map(session, [task])
                        for client in clients:
                            api = task_access.decorate(task, task_to_api(task), client, names, devices)
                            expected[client.id] = await task_requirements.decorate(session, client, task, api)
                        prepared = await task_requirements.prepare_notifications(session, task, clients)
                        actual = {}
                        for client in clients:
                            api = task_access.decorate(task, task_to_api(task), client, names, devices)
                            actual[client.id] = await task_requirements.decorate(
                                session, client, task, api, prepared=prepared[client.id])
                        self.assertEqual(actual, expected)
                        self.assertEqual(actual["d0"]["note"], "Private execution instructions")
                        self.assertTrue(actual["d1"]["canViewExecution"])
                        for client in clients:
                            if client.id not in {"d0", "d1"}:
                                self.assertNotIn("workRouting", actual[client.id])
                                self.assertNotEqual(actual[client.id]["note"], "Private execution instructions")
                        if shared_org is None:
                            self.assertTrue(actual["legacy-device"]["canEditRequirement"])
                            self.assertFalse(actual["d2"]["canEditRequirement"])
                            self.assertEqual(actual["d2"]["title"], "Source A")
                            self.assertFalse(actual["same-account"]["canEditRequirement"])
                            self.assertEqual(actual["same-account"]["title"], "Source A")
                            self.assertEqual([x["id"] for x in actual["same-account"]["migratedRequirements"]],
                                             ["source-a"])

    async def test_logged_in_account_never_inherits_anonymous_source_grants(self):
        async with self.fixture() as (_, sessions, _):
            async with sessions() as session:
                await self.seed_source_permissions(session)
                task = await session.get(models.Task, "merged")
                client = await session.get(models.Client, "d2")
                for uid, sources in (("u3", []), ("u2", ["source-a"])):
                    client.user_ref = uid
                    await session.commit()
                    prepared = await task_requirements.prepare_notifications(session, task, [client])
                    actual = await task_requirements.decorate(session, client, task, task_to_api(task),
                                                              prepared=prepared[client.id])
                    expected = await task_requirements.decorate(session, client, task, task_to_api(task))
                    self.assertEqual(actual, expected)
                    self.assertFalse(actual["canEditRequirement"])
                    self.assertEqual([row["id"] for row in actual["migratedRequirements"]], sources)

    async def test_repository_notification_projection_matches_current_membership(self):
        from app.repository_issue_models import RepositoryIssueLink, RepositoryIssueMember
        for provider in ("gitlab", "github"):
            with self.subTest(provider=provider):
                async with self.fixture() as (_, sessions, clients):
                    async with sessions() as session:
                        session.add(automation_models.ScmRepository(id="catalog", integration_id=provider,
                            provider=provider, external_id="repository", full_name="fixture/repo",
                            org_id="department"))
                        task = models.Task(id="issue", origin=provider + "_issue", status="todo",
                            title="Public request", note="Public input", result="Private result",
                            work_routing={"private": "execution"})
                        session.add_all([task, RepositoryIssueLink(id="link", catalog_id="catalog",
                            issue_id="issue", issue_iid=1, task_id=task.id),
                            RepositoryIssueMember(catalog_id="catalog", external_user_id="external-u0",
                                user_id="u0", username="user0", active=True)])
                        (await session.get(models.User, "u2")).org_id = "foreign"
                        await session.commit()
                        for revoked in (False, True):
                            if revoked:
                                (await session.get(models.User, "u0")).is_active = False
                                await session.commit()
                            prepared = await task_requirements.prepare_notifications(session, task, clients)
                            for client in clients:
                                expected = await task_requirements.decorate(session, client, task, task_to_api(task))
                                actual = await task_requirements.decorate(session, client, task, task_to_api(task),
                                                                          prepared=prepared[client.id])
                                self.assertEqual(actual, expected, (provider, revoked, client.id))
                                self.assertNotIn("workRouting", actual)
                                self.assertNotIn("result", actual)
                            self.assertEqual(prepared["d0"].repository_issues[task.id]["member"], not revoked)
                            self.assertFalse(prepared["d2"].repository_issues[task.id]["member"])

    async def test_notification_preparation_never_reuses_revoked_permissions(self):
        async with self.fixture() as (_, sessions, _):
            async with sessions() as session:
                await self.seed_source_permissions(session)
                task = await session.get(models.Task, "merged")
                client = await session.get(models.Client, "legacy-device")
                async def project():
                    prepared = await task_requirements.prepare_notifications(session, task, [client])
                    return await task_requirements.decorate(session, client, task, task_to_api(task),
                                                            prepared=prepared[client.id])
                self.assertTrue((await project())["canEditRequirement"])
                grant = await session.scalar(select(models.TaskRequirementAccess).where(
                    models.TaskRequirementAccess.task_id == "merged",
                    models.TaskRequirementAccess.principal_kind == "client",
                    models.TaskRequirementAccess.principal_id == "legacy-device",
                    models.TaskRequirementAccess.source_id == "source-b"))
                await session.delete(grant)
                await session.commit()
                result = await project()
                self.assertFalse(result["canEditRequirement"])
                self.assertEqual(result["title"], "Source A")

    async def test_notification_work_rolls_back_with_the_task(self):
        async with self.fixture() as (_, sessions, _):
            async with sessions() as session:
                task = models.Task(id="rollback", owner_client_id="d0", title="Not committed")
                session.add(task)
                task_notifications.enqueue(session, task, "task.created")
                await session.flush()
                await session.rollback()
            async with sessions() as session:
                self.assertIsNone(await session.get(models.Task, "rollback"))
                self.assertEqual(await session.scalar(select(func.count()).select_from(
                    models.TaskNotificationOutbox)), 0)
            self.assertFalse(await task_notifications.run_once(sessions))

    async def test_outbox_write_failure_cannot_leave_a_saved_unnotifiable_change(self):
        async with self.fixture() as (engine, sessions, _):
            async with sessions() as session:
                session.add(models.Task(id="atomic", owner_client_id="d0", title="Before", status="todo"))
                await session.commit()
            def fail_outbox(_c, _u, sql, _p, _x, _m):
                if sql.startswith("INSERT INTO task_notification_outbox"):
                    raise RuntimeError("isolated outbox storage failure")
            event.listen(engine.sync_engine, "before_cursor_execute", fail_outbox)
            from app.services import tasks as service
            try:
                async with sessions() as session:
                    with self.assertRaisesRegex(RuntimeError, "outbox storage failure"):
                        await service.update_task(session, "d0", "atomic", {"title": "Must roll back"})
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", fail_outbox)
            async with sessions() as session:
                self.assertEqual((await session.get(models.Task, "atomic")).title, "Before")
                self.assertEqual(await session.scalar(select(func.count()).select_from(
                    models.TaskNotificationOutbox)), 0)

    async def test_failed_delivery_survives_session_close_and_retries(self):
        async with self.fixture() as (_, sessions, clients):
            from app.services import tasks as service
            with patch.object(task_access.hub, "publish", new=AsyncMock(side_effect=RuntimeError("offline"))):
                async with sessions() as session:
                    saved = await service.put_local_task(session, clients[0].id, "retry", {"title": "Saved"})
                self.assertEqual(saved["id"], "retry")
                with self.assertLogs("uvicorn.error", level="ERROR"):
                    self.assertTrue(await task_notifications.run_once(sessions))
            async with sessions() as session:
                job = await session.scalar(select(models.TaskNotificationOutbox))
                self.assertEqual(job.attempts, 1)
                self.assertIsNone(job.lease_token)
                self.assertGreater(job.available_at.replace(tzinfo=timezone.utc), datetime.now(timezone.utc))
                job.available_at = datetime.now(timezone.utc) - timedelta(seconds=1)
                await session.commit()
            with patch.object(task_access.hub, "publish", new=AsyncMock()) as send:
                self.assertTrue(await task_notifications.run_once(sessions))
                self.assertEqual(send.await_count, 1)
            self.assertFalse(await task_notifications.run_once(sessions))

    async def test_cross_node_failure_keeps_job_and_retry_uses_strict_delivery(self):
        from app.services.cluster_bus import bus
        async with self.fixture() as (_, sessions, _):
            async with sessions() as session:
                task = models.Task(id="cluster", owner_client_id="d0", title="Cluster")
                session.add(task)
                task_notifications.enqueue(session, task, "task.updated")
                await session.commit()
            with patch.object(bus, "enabled", True), patch.object(bus, "broadcast", new=AsyncMock(
                    side_effect=RuntimeError("remote Hub inbox unavailable"))) as broadcast, \
                    patch.object(task_access.hub, "publish", new=AsyncMock()) as local:
                with self.assertLogs("uvicorn.error", level="ERROR"):
                    await task_notifications.run_once(sessions)
                self.assertEqual(local.await_count, 0)
                async with sessions() as session:
                    job = await session.scalar(select(models.TaskNotificationOutbox))
                    self.assertEqual(job.attempts, 1)
                    job.available_at = datetime.now(timezone.utc) - timedelta(seconds=1)
                    await session.commit()
                broadcast.side_effect = None
                await task_notifications.run_once(sessions)
                self.assertTrue(all(c.kwargs == {"strict": True} for c in broadcast.await_args_list))
                self.assertEqual(local.await_count, 1)
                self.assertEqual(local.await_args.kwargs, {"_local": True, "user_id": "u0"})
                self.assertTrue(all(c.args[0]["userId"] == "u0" for c in broadcast.await_args_list))
            self.assertFalse(await task_notifications.run_once(sessions))

    async def test_claim_is_exclusive_and_recovers_expired_lease_in_task_order(self):
        async with self.fixture() as (_, sessions, _):
            async with sessions() as session:
                task = models.Task(id="lease", owner_client_id="d0", title="Lease")
                session.add(task)
                first = task_notifications.enqueue(session, task, "task.created")
                await session.flush()
                second = task_notifications.enqueue(session, task, "task.updated")
                await session.commit()
                first_id, second_id = first.id, second.id
            first_claim = await task_notifications.claim(sessions)
            self.assertEqual(first_claim[0], first_id)
            self.assertIsNone(await task_notifications.claim(sessions), "another worker cannot overtake the task")
            async with sessions() as session:
                job = await session.get(models.TaskNotificationOutbox, first_id)
                job.lease_until = datetime.now(timezone.utc) - timedelta(seconds=1)
                await session.commit()
            recovered = await task_notifications.claim(sessions)
            self.assertEqual(recovered[0], first_id)
            self.assertNotEqual(recovered[1], first_claim[1])
            self.assertEqual(recovered[-1], 2)
            async with sessions() as session:
                await session.delete(await session.get(models.TaskNotificationOutbox, first_id))
                await session.commit()
            self.assertEqual((await task_notifications.claim(sessions))[0], second_id)

    async def test_concurrent_workers_cannot_claim_the_same_job(self):
        async with self.fixture() as (_, sessions, _):
            async with sessions() as session:
                task = models.Task(id="concurrent", owner_client_id="d0", title="Concurrent")
                session.add(task)
                task_notifications.enqueue(session, task, "task.created")
                await session.commit()
            claims = await asyncio.gather(*(task_notifications.claim(sessions) for _ in range(8)))
            self.assertEqual(sum(job is not None for job in claims), 1)

    async def test_cancelled_worker_leaves_recoverable_work(self):
        async with self.fixture() as (engine, sessions, _):
            checked_out = 0
            @event.listens_for(engine.sync_engine, "checkout")
            def track_checkout(*_args):
                nonlocal checked_out
                checked_out += 1
            @event.listens_for(engine.sync_engine, "checkin")
            def track_checkin(*_args):
                nonlocal checked_out
                checked_out -= 1
            async with sessions() as session:
                task = models.Task(id="cancel", owner_client_id="d0", title="Cancel")
                session.add(task)
                task_notifications.enqueue(session, task, "task.created")
                await session.commit()
            entered = asyncio.Event()
            async def wait(_device, _event, *, user_id):
                self.assertEqual(user_id, "u0")
                entered.set()
                await asyncio.Event().wait()
            with patch.object(task_access.hub, "publish", new=AsyncMock(side_effect=wait)):
                worker = asyncio.create_task(task_notifications.run_once(sessions))
                await asyncio.wait_for(entered.wait(), 3)
                self.assertEqual(checked_out, 0,
                                 "slow task fanout must not hold a database connection")
                worker.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await worker
            async with sessions() as session:
                job = await session.scalar(select(models.TaskNotificationOutbox))
                self.assertIsNotNone(job.lease_token)
                job.lease_until = datetime.now(timezone.utc) - timedelta(seconds=1)
                await session.commit()
            with patch.object(task_access.hub, "publish", new=AsyncMock()) as send:
                await task_notifications.run_once(sessions)
                self.assertEqual(send.await_count, 1)

    async def test_delayed_jobs_use_current_visibility_and_remove_previous_viewers(self):
        async with self.fixture() as (_, sessions, clients):
            from app.services import tasks as service
            async with sessions() as session:
                await service.put_local_task(session, clients[0].id, "visibility",
                    {"title": "Public", "visibility": "organization"})
                await service.update_task(session, clients[0].id, "visibility",
                    {"title": "Now private", "visibility": "related"})
            with patch.object(task_access.hub, "publish", new=AsyncMock()) as send:
                while await task_notifications.run_once(sessions):
                    pass
            for call in send.await_args_list:
                device, payload = call.args
                if device != "d0":
                    self.assertEqual(payload, {"type": "task.deleted", "id": "visibility"})
                else:
                    self.assertEqual(payload["task"]["title"], "Now private")
            self.assertEqual({c.args[0] for c in send.await_args_list}, {c.id for c in clients})

    async def test_delete_survives_task_removal_and_old_create_cannot_resurrect_it(self):
        async with self.fixture() as (_, sessions, clients):
            from app.services import tasks as service
            async with sessions() as session:
                await service.put_local_task(session, clients[0].id, "delete",
                    {"title": "Delete", "visibility": "organization"})
                self.assertTrue((await service.delete_task(session, clients[0].id, "delete"))["ok"])
            with patch.object(task_access.hub, "publish", new=AsyncMock()) as send:
                self.assertTrue(await task_notifications.run_once(sessions))
                self.assertEqual(send.await_count, 0)
                self.assertTrue(await task_notifications.run_once(sessions))
                self.assertEqual(send.await_count, len(clients))
                for call in send.await_args_list:
                    self.assertEqual(call.args[1], {"type": "task.deleted", "id": "delete"})
            self.assertFalse(await task_notifications.run_once(sessions))

    async def test_assignment_notice_is_persisted_before_background_arrival(self):
        async with self.fixture() as (_, sessions, clients):
            from app.services import tasks as service
            async with sessions() as session:
                await service.create_task(session, clients[0].id, {"title": "Assignment"},
                                          notify=False, task_id="assignment")
            with patch.object(task_access.hub, "publish", new=AsyncMock()) as send:
                async with sessions() as session:
                    await service.update_task(session, clients[0].id, "assignment", {"assigneeUserId": "u1"})
                self.assertEqual(send.await_count, 0)
                async with sessions() as session:
                    notice = await session.scalar(select(models.MateMessage))
                    self.assertEqual(notice.recipient_id, "u1")
                await task_notifications.run_once(sessions)
                arrivals = [c for c in send.await_args_list if c.args[1].get("arrival") == "assign"]
                self.assertEqual([c.args[0] for c in arrivals], ["d1"])
                self.assertEqual(arrivals[0].args[1]["notificationId"], notice.id)
                notices = [c for c in send.await_args_list if c.args[1].get("type") == "notice"
                           and c.args[1].get("kind") == "task_assignment"]
                self.assertEqual([c.args[0] for c in notices], ["d1"])

    async def test_delete_retains_original_account_after_device_login_changes(self):
        from app.realtime import Hub
        from test_realtime_account_scope import Socket
        from app.services import tasks as service
        async with self.fixture(2, 2) as (_, sessions, _):
            async with sessions() as session:
                await service.create_task(session, "d0", {"title": "Private"},
                                          notify=False, task_id="private-delete")
                await service.delete_task(session, "d0", "private-delete")
                job = await session.scalar(select(models.TaskNotificationOutbox))
                self.assertEqual(job.payload["recipient_accounts"], {"d0": "u0"})
                (await session.get(models.Client, "d0")).user_ref = "u1"
                await session.commit()
            hub, next_account = Hub(), Socket()
            await hub.connect("d0", next_account, user_id="u1")
            with patch.object(task_access, "hub", hub), \
                 patch.object(hub, "publish", wraps=hub.publish) as publish:
                await task_notifications.run_once(sessions)
                publish.assert_awaited_once_with("d0", {"type": "task.deleted", "id": "private-delete"}, user_id="u0")
            self.assertEqual(next_account.messages, [])

    async def test_legacy_delete_without_account_evidence_never_targets_current_login(self):
        async with self.fixture() as (_, sessions, _):
            async with sessions() as session:
                session.add(models.TaskNotificationOutbox(task_id="legacy-deleted", event_type="task.deleted",
                                                          payload={"recipients": ["d0"]}))
                await session.commit()
            with patch.object(task_access.hub, "publish", new=AsyncMock()) as publish:
                await task_notifications.run_once(sessions)
                publish.assert_not_awaited()

    async def test_inline_delete_accounts_remain_frozen_and_missing_evidence_is_ignored(self):
        async with self.fixture() as (_, sessions, _):
            async with sessions() as session:
                session.add(models.TaskNotificationOutbox(task_id="inline-deleted", event_type="task.deleted",
                    payload={"recipients": [{"device": "d0", "user": "u0"},
                                             {"device": "d1", "user": ""},
                                             {"device": "d2"}]}))
                (await session.get(models.Client, "d0")).user_ref = "u1"
                await session.commit()
            with patch.object(task_access.hub, "publish", new=AsyncMock()) as publish:
                await task_notifications.run_once(sessions)
                self.assertEqual([(call.args[0], call.kwargs["user_id"])
                                  for call in publish.await_args_list], [("d0", "u0"), ("d1", "")])
                self.assertTrue(all(call.args[1] == {"type": "task.deleted", "id": "inline-deleted"}
                                    for call in publish.await_args_list))

    async def test_close_receipt_retries_failure_and_does_not_duplicate_audit(self):
        async with self.fixture() as (_, sessions, _):
            async with sessions() as session:
                task = models.Task(id="closed", owner_client_id="d0", created_by="u0",
                    requester_user_id="u1", status="done", title="Closed")
                session.add(task)
                task_notifications.enqueue(session, task, "task.updated", closed=True, closer="d0")
                await session.commit()
            failed = False
            async def publish(_device, payload, *, user_id):
                self.assertIsInstance(user_id, str)
                nonlocal failed
                if payload.get("kind") == "task_receipt" and not failed:
                    failed = True
                    raise OSError("receipt transport failed")
            with patch.object(task_access.hub, "publish", new=AsyncMock(side_effect=publish)) as send:
                with self.assertLogs("uvicorn.error", level="ERROR"):
                    await task_notifications.run_once(sessions)
                self.assertTrue(failed)
                async with sessions() as session:
                    job = await session.scalar(select(models.TaskNotificationOutbox))
                    self.assertEqual(job.attempts, 1)
                    job.available_at = datetime.now(timezone.utc) - timedelta(seconds=1)
                    await session.commit()
                claimed = await task_notifications.claim(sessions)
                await task_notifications.deliver(claimed, sessions)
                await task_notifications.deliver(claimed, sessions)  # ack lost after successful delivery
            async with sessions() as session:
                rows = list(await session.scalars(select(models.TaskEvent).where(models.TaskEvent.kind == "receipt")))
                self.assertEqual([row.id for row in rows], [claimed[0]])
            notices = [c for c in send.await_args_list if c.args[1].get("kind") == "task_receipt"]
            self.assertEqual(len(notices), 2, "one failed attempt and one success, no duplicate after ack loss")


class TaskNotificationMigrationTests(unittest.TestCase):
    def test_versioned_outbox_upgrade_downgrade_and_backup_restore(self):
        from importlib import import_module
        from pathlib import Path
        from alembic.migration import MigrationContext
        from alembic.operations import Operations
        from app.data_backup import backup_database, restore_database
        revision = import_module("migrations.versions.0063_task_notification_outbox")
        with tempfile.TemporaryDirectory(prefix="soduwork-notification-migration-") as directory:
            root = Path(directory)
            source = root / "test.db"
            engine = create_engine("sqlite:///" + source.as_posix())
            try:
                with engine.begin() as connection:
                    connection.execute(text("CREATE TABLE proof (value TEXT NOT NULL)"))
                    connection.execute(text("INSERT INTO proof VALUES ('preserved')"))
                    with Operations.context(MigrationContext.configure(connection)):
                        revision.upgrade()
                    indexes = {row["name"] for row in inspect(connection).get_indexes("task_notification_outbox")}
                    self.assertEqual(indexes, {"ix_task_notification_due", "ix_task_notification_order"})
                    connection.execute(models.TaskNotificationOutbox.__table__.insert().values(
                        id="durable-job", task_id="already-deleted", event_type="task.deleted",
                        payload={"recipients": ["device"]}))
                backup = backup_database("sqlite+aiosqlite:///" + source.as_posix(), root / "backup")
                restored = root / "restored.db"
                restore_database(Path(backup["backup"]), "sqlite+aiosqlite:///" + restored.as_posix(),
                                 confirm_target=str(restored.resolve()))
                restored_engine = create_engine("sqlite:///" + restored.as_posix())
                try:
                    with restored_engine.connect() as connection:
                        self.assertEqual(connection.scalar(text("SELECT id FROM task_notification_outbox")), "durable-job")
                finally:
                    restored_engine.dispose()
                with engine.begin() as connection:
                    with Operations.context(MigrationContext.configure(connection)):
                        revision.downgrade()
                    self.assertNotIn("task_notification_outbox", inspect(connection).get_table_names())
                    self.assertEqual(connection.scalar(text("SELECT value FROM proof")), "preserved")
                    with Operations.context(MigrationContext.configure(connection)):
                        revision.upgrade()
            finally:
                engine.dispose()


def load_tests(loader, tests, pattern):
    # Keep the existing transport/concurrency contract in the same release gate.
    tests.addTests(loader.loadTestsFromName("tests.test_task_notification_fanout"))
    tests.addTests(loader.loadTestsFromName("test_task_publish_latency"))
    return tests


if __name__ == "__main__":
    unittest.main()
