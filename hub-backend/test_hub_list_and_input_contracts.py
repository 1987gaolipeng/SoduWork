"""Exercise list and write contracts on the Hub HTTP routes against isolated SQLite."""
import csv
import io
import os
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import Depends, FastAPI
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models, models
from app.db import Base, get_session
from app.deps import current_client, current_user
from app.library_models import LibraryFolder, LibraryItem
from app.api import admin, approvals, clients, deliveries, environments, first_chat, library, quotas, runner_ws, tasks, usage, work_catalog
from app.permissions import ALL_KEYS


class HubContractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            for i in range(3):
                key = f"row-{i}"
                user = models.User(id=key, username=key, org_id=key, is_super=i == 0)
                device = models.Client(id=key, user_ref=key, auth_state="active")
                session.add_all([user, device, models.OrgUnit(id=key, name=key),
                                 models.Role(id=key, name=key), models.Domain(id=key, name=key)])
                if i == 0:
                    self.user, self.device = user, device
            await session.flush()
            for i in range(3):
                session.add(models.AiSchedule(id=f"schedule-{i}", title=f"schedule {i}",
                                              owner_client_id="row-1" if i == 2 else "row-0"))
            session.add(models.Project(id="project", name="Fixture", org_id="row-0"))
            session.add(LibraryFolder(id="dir", name="Folder", owner_key="row-0"))
            session.add_all([LibraryItem(id=key, title=key, owner_key=owner) for key, owner in
                             (("file-a", "row-0"), ("file-b", "row-0"), ("private", "row-1"))])
            await session.commit()
        self.user._perms = set(ALL_KEYS)
        api = self.app = FastAPI()
        for router in (admin.router, approvals.router, clients.router, deliveries.router, environments.router, first_chat.router,
                       library.router, runner_ws.router, tasks.router, usage.router, work_catalog.admin_router):
            api.include_router(router)

        async def database():
            async with self.sessions() as session:
                yield session

        api.dependency_overrides[get_session] = database
        api.dependency_overrides[current_user] = lambda: self.user
        api.dependency_overrides[current_client] = lambda: self.device
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=api),
                                      base_url="http://fixture/api/v1/")
        self.addAsyncCleanup(self.http.aclose)

    async def request(self, method, path, expected=200, **kwargs):
        response = await self.http.request(method, path, **kwargs)
        self.assertEqual(response.status_code, expected, (method, path, response.status_code))
        return response.json()

    async def test_create_task_rejects_missing_or_blank_title(self):
        for body in ({}, {"title": ""}, {"title": "  "}):
            with self.subTest(body=body):
                result = await self.request("POST", "tasks", 400, json=body)
                self.assertEqual(result["detail"], "请填写需求标题")
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.Task)), 0)

    async def test_invalid_team_scope_preserves_setting_and_audit(self):
        path = "admin/team-module-scope"
        await self.request("PUT", path, json={"scope": " EVERYONE "})
        for body in ({}, {"scope": None}, {"scope": []}, {"scope": "everyoen"}):
            with self.subTest(body=body):
                await self.request("PUT", path, expected=422, json=body)
        self.assertEqual(await self.request("GET", path), {"scope": "everyone"})
        async with self.sessions() as session:
            audit_count = await session.scalar(select(func.count()).select_from(models.AuditLog)
                                               .where(models.AuditLog.action == "team.module_scope"))
            self.assertEqual(audit_count, 1)
        saved = await self.request("PUT", path, json={"scope": "managers"})
        self.assertEqual(saved["scope"], "managers")

    async def test_directory_reads_follow_admin_and_selector_permissions(self):
        self.user.is_super = False
        self.user._perms = set()
        async with self.sessions() as session, session.begin():
            child = await session.get(models.OrgUnit, "row-1")
            child.parent_id = self.user.org_id
        own = await self.request("GET", "admin/orgs?limit=1")
        self.assertEqual(([row["id"] for row in own["items"]], own["total"]), (["row-0"], 1))
        await self.request("GET", "admin/orgs?includeManaged=true", 403)
        for path in ("roles", "permissions", "domains", "role-options"):
            await self.request("GET", "admin/" + path, 403)
        for permission in ("user.manage", "identity.manage", "client.assign"):
            self.user._perms = {permission}
            options = await self.request("GET", "admin/role-options")
            self.assertEqual(len(options), 3)
            self.assertTrue(all(set(row) == {"id", "name"} for row in options))
            await self.request("GET", "admin/roles", 403)
        self.user._perms = {"user.manage"}
        self.assertEqual((await self.request("GET", "admin/orgs?limit=1"))["total"], 2)
        self.assertEqual(len(await self.request("GET", "admin/domains")), 3)
        async with self.sessions() as session, session.begin():
            child = await session.get(models.OrgUnit, "row-1")
            child.data_source = "test"
        self.assertEqual((await self.request("GET", "admin/orgs?limit=1"))["total"], 1)
        self.assertEqual((await self.request("GET", "admin/orgs?includeManaged=true&limit=1"))["total"], 2)
        self.user._perms = {"task.dispatch"}
        await self.request("GET", "admin/orgs?includeManaged=true", 403)
        self.assertEqual((await self.request("GET", "admin/domains?limit=1"))["total"], 3)
        self.user._perms = {"role.manage"}
        self.assertTrue(all("permissions" in role for role in await self.request("GET", "admin/roles")))
        await self.request("GET", "admin/permissions")
        self.user._perms = set()
        self.user.org_id = None
        self.assertEqual(await self.request("GET", "admin/orgs?limit=1"), {"items": [], "total": 0})

    async def test_first_chat_uses_current_models_and_only_the_signed_in_accounts_recent_report(self):
        async def reporting_device(session=Depends(get_session)):
            return await session.get(models.Client, self.device.id)

        self.app.dependency_overrides[current_client] = reporting_device
        async with self.sessions() as session, session.begin():
            device = await session.get(models.Client, self.device.id)
            device.platform = "linux/x64"
            device.config = {"theme": "light"}
            session.add(models.ModelProvider(id="service", name="Fixture", base_url="https://fixture.invalid/v1",
                                             api_key="fixture-key", enabled=True))
            session.add(models.ModelDef(id="image-only", provider_id="service", name="picture", modality="image"))
        expected = {"providerReady": True, "chatModelReady": False, "runtimeReady": None, "modelReady": None}
        self.assertEqual(await self.request("GET", "admin/first-chat-readiness"), expected)
        async with self.sessions() as session, session.begin():
            session.add(models.ModelDef(id="chat-model", provider_id="service", name="chat", modality="chat"))
        expected["chatModelReady"] = True
        await self.request("PUT", "first-chat-readiness", 422, json={"runtimeReady": "true", "modelReady": True})
        await self.request("PUT", "first-chat-readiness", json={"runtimeReady": True, "modelReady": False})
        self.assertEqual(await self.request("GET", "admin/first-chat-readiness"),
                         {**expected, "runtimeReady": True, "modelReady": False})
        with patch.object(first_chat, "time", return_value=first_chat.time() + first_chat.REPORT_TTL + 1):
            self.assertEqual(await self.request("GET", "admin/first-chat-readiness"), expected)
        async with self.sessions() as session, session.begin():
            device = await session.get(models.Client, self.device.id)
            self.assertEqual(admin._admin_client_config(device.config), {"theme": "light"})
            device.auth_version += 1
        self.assertEqual(await self.request("GET", "admin/first-chat-readiness"), expected)
        await self.request("PUT", "first-chat-readiness", json={"runtimeReady": True, "modelReady": True})
        self.user.id = "row-1"
        self.assertEqual(await self.request("GET", "admin/first-chat-readiness"), expected)
        self.user.is_super = False
        self.user._perms = set()
        await self.request("GET", "admin/first-chat-readiness", 403)

    async def test_delete_distinguishes_missing_resources_from_in_use(self):
        for resource in ("orgs", "roles"):
            path = "admin/" + resource + "/missing"
            await self.request("PATCH", path, expected=404, json={"name": "Missing"})
            await self.request("DELETE", path, expected=404)
        await self.request("DELETE", "admin/orgs/row-0", expected=400)

    async def test_create_deployment_target_reports_required_ids_before_lookup(self):
        for body, field in (({}, "repoId"), ({"repoId": "  "}, "repoId"),
                            ({"repoId": "missing"}, "environmentId"), ({"repoId": "missing", "environmentId": []}, "environmentId")):
            result = await self.request("POST", "admin/deployment-targets", expected=400, json=body)
            self.assertIn(field, result["detail"])
        await self.request("POST", "admin/deployment-targets", expected=404,
                           json={"repoId": "missing", "environmentId": "staging"})

    async def test_account_status_filters_before_pagination_and_keeps_legacy_lists(self):
        self.app.include_router(quotas.router)
        async with self.sessions() as session, session.begin():
            member = await session.get(models.User, "row-1")
            member.is_active = False
        for path in ("admin/users", "admin/quotas/members"):
            with self.subTest(path=path):
                legacy = await self.request("GET", path)
                self.assertEqual(len(legacy if isinstance(legacy, list) else legacy["items"]), 3)
                disabled = await self.request("GET", path + "?isActive=false&limit=1")
                self.assertEqual(disabled["total"], 1)
                self.assertEqual([(u["id"], u["isActive"]) for u in disabled["items"]], [("row-1", False)])
                active = await self.request("GET", path + "?isActive=true&limit=1&offset=1")
                self.assertEqual(active["total"], 2)
                self.assertEqual(len(active["items"]), 1)
                self.assertTrue(active["items"][0]["isActive"])
        result = await self.request("GET", "admin/quotas/members?q=row-1&isActive=true")
        self.assertEqual((result["items"], result["total"]), ([], 0))

    async def test_admin_and_device_list_windows(self):
        for i in range(2):
            await self.request("POST", "tasks", json={"title": f"task {i}"})
        for path in ("admin/users", "admin/orgs", "admin/roles", "admin/domains",
                     "admin/clients", "tasks", "schedules"):
            with self.subTest(path=path):
                legacy = await self.request("GET", path)
                self.assertIsInstance(legacy, list)
                self.assertEqual(len(legacy), 2 if path in ("tasks", "schedules") else 3)
                seen = []
                for offset in range(len(legacy)):
                    page = await self.request("GET", path, params={"offset": offset, "limit": 1})
                    self.assertEqual(page["total"], len(legacy))
                    self.assertEqual(len(page["items"]), 1)
                    seen.append(page["items"][0]["id"])
                self.assertCountEqual(seen, [row["id"] for row in legacy])
                beyond = await self.request("GET", path, params={"offset": 300})
                self.assertEqual((beyond["items"], beyond["total"]), ([], len(legacy)))
                await self.request("GET", path, 422, params={"limit": 0})
        await self.request("GET", "approvals", 422, params={"limit": 0})
        await self.request("GET", "deliveries", 422, params={"limit": 0})
        for path in ("admin/client-inventory", "admin/clients?paged=1"):
            page = await self.request("GET", path + ("&" if "?" in path else "?") + "pageSize=1")
            self.assertEqual((page["pageSize"], len(page["items"]), page["total"]), (1, 1, 3))
        for mix in ("limit=3&page=1", "offset=0&pageSize=25"):
            response = await self.http.get("admin/client-inventory?" + mix)
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.headers.get("X-Error-Code"), "hub.input.pages")
        self.user.is_super = False
        limited = await self.request("GET", "admin/users?limit=1")
        self.assertEqual(([user["id"] for user in limited["items"]], limited["total"]), (["row-0"], 1))

    async def test_receipt_pages_use_task_visibility_and_stable_event_order(self):
        stamp = datetime(2026, 1, 1, tzinfo=timezone.utc)
        async with self.sessions() as session:
            session.add(models.Client(id="unassigned-device", user_ref=None))
            await session.flush()
            session.add_all([
                models.Task(id="unassigned", owner_client_id="unassigned-device", title="Unassigned device"),
                models.Task(id="own", owner_client_id="row-0", title="Current task", status="done"),
                models.Task(id="other", owner_client_id="row-1", title="Other task"),
            ])
            await session.flush()
            session.add_all([
                models.TaskEvent(id="0", task_id="unassigned", kind="receipt", at=stamp),
                models.TaskEvent(id="a", task_id="own", kind="receipt", detail={"title": "Snapshot"}, at=stamp),
                models.TaskEvent(id="b", task_id="other", kind="receipt", at=stamp),
                models.TaskEvent(id="c", task_id="own", kind="receipt", at=stamp),
                models.TaskEvent(id="d", task_id="deleted", kind="receipt", at=stamp),
                models.TaskEvent(id="e", task_id="own", kind="comment", at=stamp),
            ])
            await session.commit()

        path = "admin/receipts"
        unrestricted = await self.request("GET", path)
        self.assertEqual([row["id"] for row in unrestricted], ["d", "c", "b", "a", "0"])
        self.assertEqual(unrestricted[0]["status"], "")

        self.user.is_super = False
        first = await self.request("GET", path, params={"limit": 1})
        second = await self.request("GET", path, params={"limit": 1, "offset": 1})
        self.assertEqual([(row["id"], row["title"], row["status"]) for row in first + second],
                         [("c", "Current task", "done"), ("a", "Snapshot", "done")])
        self.assertEqual([r["id"] for r in await self.request("GET", path, params={"offset": 2})], ["0"])
        self.assertEqual(await self.request("GET", path, params={"limit": 0}), [])
        for params in ({"limit": -1}, {"offset": -1}, {"offset": 2**63}):
            await self.request("GET", path, 422, params=params)

    async def test_legacy_receipt_list_and_timeline_bound_fields_without_rewriting_history(self):
        from app.services import task_events

        async with self.sessions() as session:
            task = models.Task(id="old", owner_client_id="row-0", title="工" * 201)
            session.add(task)
            await session.flush()
            raw = {"to": "N" * 65, "contact": "c" * 201}
            session.add(models.TaskEvent(id="old-event", task_id=task.id, kind="receipt", detail=raw))
            await session.commit()
            timeline = await task_events.timeline(session, task.id)
            self.assertEqual(timeline[0]["detail"]["contact"], "")
            self.assertEqual(timeline[0]["detail"]["fieldWarnings"],
                             {"requesterName": "truncated", "contact": "omitted"})
        row, = await self.request("GET", "admin/receipts")
        self.assertEqual((row["title"], row["requesterName"], row["contact"]),
                         ("工" * 199 + "…", "N" * 63 + "…", ""))
        self.assertEqual(row["fieldWarnings"],
                         {"title": "truncated", "requesterName": "truncated", "contact": "omitted"})
        async with self.sessions() as session:
            original = await session.get(models.TaskEvent, "old-event")
            self.assertEqual(original.detail, raw)

    async def test_receipt_queries_clamp_large_limits_in_the_database(self):
        async with self.sessions() as session:
            session.add_all(models.TaskEvent(id=f"r-{i}", task_id="removed", kind="receipt")
                            for i in range(205))
            await session.commit()
        statements = []

        def capture(conn, cursor, statement, parameters, context, executemany):
            if "FROM task_event" in statement:
                statements.append(statement)

        event.listen(self.engine.sync_engine, "before_cursor_execute", capture)
        self.addCleanup(event.remove, self.engine.sync_engine, "before_cursor_execute", capture)
        self.assertEqual(len(await self.request("GET", "admin/receipts")), 50)
        self.assertEqual(len(await self.request("GET", "admin/receipts?limit=1000")), 200)
        self.assertEqual(len(statements), 2)
        self.assertTrue(all("LIMIT" in statement for statement in statements))

    async def test_client_inventory_sort_applies_before_pagination(self):
        now = datetime.now(timezone.utc)
        async with self.sessions() as session:
            for key, name, owner, state, platform, version, seen in (
                ("sort-a", "Zulu", "row-1", "revoked", "darwin", "2", now - timedelta(days=1)),
                ("sort-b", "ALPHA", None, "active", "Linux", "5", now + timedelta(minutes=5)),
                ("sort-c", "alpha", "row-2", "pending", "macOS", "1", None),
            ):
                device = models.Client(id=key, name=name, user_ref=owner, auth_state=state,
                                       platform=platform, app_version=version, last_seen_at=seen)
                session.add(device)
            await session.commit()

        # Names differing only by case tie on the device ID; Darwin and macOS
        # share a displayed platform, so their ordering falls back to version.
        orders = {
            "name": ("bca", "abc"), "owner": ("bac", "cab"), "online": ("bac", "acb"),
            "auth": ("bca", "acb"), "platform": ("bca", "acb"), "lastSeen": ("abc", "bac"),
        }
        for key, (asc, desc) in orders.items():
            for direction, expected in (("asc", asc), ("desc", desc)):
                with self.subTest(key=key, direction=direction):
                    params = {"q": "sort-", "sortBy": key, "sortDir": direction, "pageSize": 2}
                    first = await self.request("GET", "admin/clients", params={**params, "paged": 1})
                    next_page = await self.request("GET", "admin/client-inventory", params={**params, "page": 2})
                    self.assertEqual(first["total"], 3)
                    self.assertEqual([item["id"] for item in first["items"] + next_page["items"]],
                                     ["sort-" + suffix for suffix in expected])
        for endpoint in ("admin/client-inventory", "admin/client-inventory/export.csv"):
            for invalid in ({"sortBy": "other"}, {"sortDir": "other"}):
                await self.request("GET", endpoint, expected=422, params=invalid)

    async def test_client_inventory_csv_matches_scoped_filtered_order_across_batches(self):
        self.user.is_super = False
        self.user._perms = {"client.view"}
        seen = datetime(2024, 6, 15, 12, 34, 56, tzinfo=timezone.utc)
        special_name = '=Fleet, "one"\nsecond line'
        async with self.sessions() as session:
            member = await session.get(models.User, "row-0")
            member.display_name = "  +Manager"
            for i in range(405):
                session.add(models.Client(id=f"fleet-{i:03}", name=special_name if i == 0 else "Fleet",
                                          user_ref="row-0" if i % 2 == 0 else None, platform="Android",
                                          app_version="1.2.3", last_seen_at=seen + timedelta(minutes=i)))
            # Each of these violates exactly one of scope, form, state or search.
            session.add_all([
                models.Client(id="fleet-other-org", user_ref="row-1", platform="Android"),
                models.Client(id="fleet-desktop", platform="Linux"),
                models.Client(id="fleet-online", platform="Android",
                              last_seen_at=datetime.now(timezone.utc) + timedelta(minutes=5)),
                models.Client(id="unmatched", platform="Android"),
            ])
            await session.commit()

        filters = {"state": "offline", "form": "mobile", "q": "fleet", "sortBy": "lastSeen", "sortDir": "desc"}
        expected_ids = [f"fleet-{i:03}" for i in reversed(range(405))]
        listed = []
        for page in range(1, 6):
            part = await self.request("GET", "admin/clients", params={**filters, "paged": 1, "page": page, "pageSize": 100})
            self.assertEqual(part["total"], len(expected_ids))
            listed.extend(item["id"] for item in part["items"])
        self.assertEqual(listed, expected_ids)

        endpoint = "admin/client-inventory/export.csv"
        response = await self.http.get(endpoint, params=filters)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.content.startswith(b"\xef\xbb\xbf"))
        self.assertTrue(response.headers["content-type"].startswith("text/csv"))
        self.assertIn("attachment;", response.headers["content-disposition"])
        self.assertEqual(response.headers["cache-control"], "no-store")
        records = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))
        self.assertEqual([row["id"] for row in records], listed)
        self.assertEqual(records[-1], {
            "id": "fleet-000", "name": "'" + special_name, "ownerName": "'  +Manager",
            "connectionState": "offline", "authState": "pending", "platform": "Android",
            "version": "1.2.3", "lastSeen": seen.isoformat(),
        })
        empty = await self.http.get(endpoint, params={**filters, "q": "not-found"})
        self.assertEqual(empty.status_code, 200)
        self.assertEqual(len(empty.content.decode("utf-8-sig").splitlines()), 1)
        self.user._perms = set()
        for path in ("admin/client-inventory", endpoint):
            await self.request("GET", path, expected=403)

    async def test_device_search_treats_keywords_as_literal_substrings(self):
        async with self.sessions() as session:
            (await session.get(models.Client, "row-0")).name = "Win_01"
            (await session.get(models.Client, "row-1")).name = "WinX01"
            (await session.get(models.User, "row-1")).display_name = "ops%team"
            (await session.get(models.User, "row-2")).username = r"hq\admin"
            session.add(models.Client(id="dev_special", user_ref="row-2", auth_state="active"))
            await session.commit()
        for route in ("admin/clients", "admin/client-inventory"):
            for term, ids in ((" WIN_01 ", ["row-0"]), ("%", ["row-1"]),
                              ("dev_", ["dev_special"]), ("a%", []),
                              ("\\", ["row-2", "dev_special"])):
                with self.subTest(route=route, term=term):
                    page = await self.request("GET", route, params={"paged": "true", "q": term})
                    self.assertEqual(page["total"], len(ids))
                    self.assertCountEqual([row["id"] for row in page["items"]], ids)
        self.user.is_super = False
        page = await self.request("GET", "admin/clients", params={"paged": "true", "q": "%"})
        self.assertEqual((page["total"], page["items"]), (0, []))

    async def test_library_pages_cross_folder_boundary(self):
        with patch("app.api.library.library_read_cache.ensure_ready", new_callable=AsyncMock):
            first = await self.request("GET", "library?scope=all&limit=2")
            self.assertEqual([f["id"] for f in first["folders"]], ["dir"])
            self.assertEqual([f["id"] for f in first["items"]], ["file-a"])
            last = await self.request("GET", "library?scope=all&offset=2&limit=2")
            self.assertEqual((last["total"], last["folders"], last["items"][0]["id"]), (3, [], "file-b"))
            empty = await self.request("GET", "library?scope=all&offset=50")
            self.assertEqual((empty["total"], empty["folders"], empty["items"]), (3, [], []))

    async def test_task_writes_and_comments(self):
        await self.request("POST", "tasks", 400, json={"title": "invalid", "assigneeUserId": "missing"})
        for value in (True, False):
            await self.request("POST", "tasks", 422, json={"title": "invalid", "due": value})
        await self.request("POST", "team/tasks", 400, json={"title": "invalid", "toInbox": True,
                                                           "assigneeUserId": "missing"})
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.Task)), 0)
        task = await self.request("POST", "tasks", json={"title": "valid", "due": 1900000000000})
        self.assertEqual(task["due"], 1900000000000)
        await self.request("PATCH", f"tasks/{task['id']}", 422, json={"due": False})
        self.assertEqual((await self.request("GET", f"tasks/{task['id']}"))["due"], 1900000000000)
        comments = f"tasks/{task['id']}/comments"
        for body, status in (({}, 422), (False, 422), ("x" * 4001, 400)):
            await self.request("POST", comments, status, json={"body": body})
        await self.request("POST", comments, json={"body": "x" * 4000})
        async with self.sessions() as session:
            stored = (await session.scalars(select(models.TaskComment.body))).all()
            self.assertEqual(stored, ["x" * 4000])

    async def test_dispatch_requester_limits_apply_before_creating_tasks(self):
        for path, target in (("admin/dispatch", {"targets": ["row-0"]}),
                             ("team/tasks", {"assigneeUserId": "row-0"}),
                             ("tasks/assigned", {"assigneeUserId": "row-1"})):
            with self.subTest(path=path):
                fields = {"requesterName": "名" * 64, "requesterContact": "a" * 200}
                if path != "team/tasks":
                    fields["requesterUserId"] = "u" * 36
                payload = {"title": "External request", **target, **fields}
                for field, value in fields.items():
                    rejected = await self.request("POST", path, 422, json={**payload, field: value + "x"})
                    self.assertEqual(rejected["detail"][0]["loc"][-1], field)
                accepted = await self.request("POST", path, json=payload)
                task = accepted["task"] if path == "tasks/assigned" else accepted["tasks"][0]
                self.assertEqual({key: task[key] for key in fields}, fields)
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.Task)), 3)

    async def test_workflow_guide_targets_effective_plugin_in_selected_org(self):
        async with self.sessions() as session:
            for plugin_id, org_id, enabled in (
                ("platform-flow", None, True), ("local-flow", "row-0", False),
            ):
                session.add(automation_models.Plugin(id=plugin_id, org_id=org_id,
                                                     key="shared-flow", name="Flow", enabled=enabled))
            await session.commit()

        for org_id, plugin_id, enabled in (("row-0", "local-flow", False), ("row-1", "platform-flow", True)):
            with self.subTest(org_id=org_id):
                catalog = await self.request("GET", "admin/work-catalog", params={"orgId": org_id})
                matches = [row for row in catalog["workflows"] if row["key"] == "shared-flow"]
                self.assertEqual([(row["id"], row["enabled"]) for row in matches], [(plugin_id, enabled)])

    async def test_catalog_and_environment_inputs(self):
        for body in ({"name": "fixture", "type": "unlisted"},
                     {"name": "fixture", "type": "generic", "config": {"baseUrl": "unsupported://example.invalid"}}):
            await self.request("POST", "admin/integrations", 400, json=body)
        await self.request("POST", "admin/projects/project/repos", 400,
                           json={"name": "fixture", "gitUrl": "file:///fixture"})
        await self.request("POST", "admin/environments", 400,
                           json={"key": "testing", "tier": "unlisted"})
        env = await self.request("POST", "admin/environments", json={"key": "testing", "name": ""})
        self.assertEqual(env["name"], "testing")
        endpoint = f"admin/environments/{env['id']}"
        for body in ({"name": ""}, {"name": "  "}, {"orgId": "row-1", "name": "Changed"}):
            await self.request("PATCH", endpoint, 422, json=body)
        saved = await self.request("PATCH", endpoint, json={"orgId": env.get("orgId")})
        self.assertEqual((saved["name"], saved.get("orgId")), ("testing", env.get("orgId")))
        await self.request("PATCH", f"admin/environments/{env['id']}", 400, json={"tier": "unlisted"})
        await self.request("POST", "admin/work-catalog/professions", 400,
                           json={"orgId": "row-0", "name": "Analyst", "category": "unlisted"})

    async def test_profession_writes_identify_invalid_competencies(self):
        for path in ("admin/work-catalog/professions", "admin/positions"):
            with self.subTest(path=path):
                profile = {"orgId": "row-0", "name": path.rsplit("/", 1)[-1]}
                rejected = await self.request("POST", path, 400, json={**profile, "competencies": 12345})
                self.assertEqual(rejected["detail"], "competencies 必须是数组")
                created = await self.request("POST", path, json={**profile, "competencies": ["Planning"]})
                endpoint = f"{path}/{created['id']}"
                for value in (12345, 0, "Planning"):
                    rejected = await self.request("PATCH", endpoint, 400, json={"competencies": value})
                    self.assertEqual(rejected["detail"], "competencies 必须是数组")
                unchanged = await self.request("PATCH", endpoint, json={"description": "Updated profile"})
                self.assertEqual(unchanged["competencies"], ["Planning"])
                updated = await self.request("PATCH", endpoint, json={"competencies": ["Writing"]})
                self.assertEqual(updated["competencies"], ["Writing"])

    async def test_scenario_writes_reject_invalid_fields_without_changing_the_draft(self):
        route = "admin/work-catalog/scenarios"
        draft = {"orgId": "row-0", "key": "draft-report", "name": "Report", "enabled": False}
        contract = {"kind": "artifact", "summary": "Report", "deliverables": ["report.md"],
                    "acceptance": ["Reviewed"]}
        for value in (12345, "report", []):
            rejected = await self.request("POST", route, 400, json={**draft, "outputContract": value})
            self.assertIn("outputContract", rejected["detail"])
        saved = await self.request("POST", route, json={**draft, "outputContract": contract})
        endpoint = f"{route}/{saved['id']}"
        for fields, invalid in (({"outputContract": 0}, "outputContract"),
                                ({"outputContract": {"deliverables": "report.md"}}, "deliverables"),
                                ({"outputContract": {"acceptance": 0}}, "acceptance"),
                                ({"intentHints": "report"}, "intentHints"),
                                ({"positionIds": 0}, "positionIds"),
                                ({"requiredCapabilities": {}}, "requiredCapabilities")):
            with self.subTest(fields=fields):
                rejected = await self.request("PATCH", endpoint, 400, json=fields)
                self.assertIn(invalid, rejected["detail"])
        updated = await self.request("PATCH", endpoint, json={"name": "Renamed report"})
        self.assertEqual(updated["outputContract"], contract)

    async def test_catalog_reads_existing_empty_list_contract(self):
        route = "admin/work-catalog/scenarios"
        saved = await self.request("POST", route, json={
            "orgId": "row-0", "key": "legacy-draft", "name": "Legacy draft", "enabled": False})
        async with self.sessions() as session:
            row = await session.get(models.WorkScenario, saved["id"])
            row.output_contract = []
            await session.commit()
        catalog = await self.request("GET", "admin/work-catalog?orgId=row-0")
        entry = next(scene for scene in catalog["scenarios"] if scene["id"] == saved["id"])
        self.assertEqual(entry["outputContract"], saved["outputContract"])
        updated = await self.request("PATCH", f"{route}/{saved['id']}", json={"name": "Renamed"})
        self.assertEqual(updated["outputContract"], saved["outputContract"])

    async def test_existing_scenario_key_returns_conflict_in_its_organization(self):
        route = "admin/work-catalog/scenarios"
        body = {"orgId": "row-0", "key": "review", "name": "First review", "enabled": False}
        first = await self.request("POST", route, json=body)
        duplicate = await self.request("POST", route, 409, json={**body, "key": " REVIEW ", "name": "Second review"})
        self.assertEqual(duplicate["detail"], "这个场景标识已经存在")
        catalog = await self.request("GET", "admin/work-catalog?orgId=row-0")
        matching = [item for item in catalog["scenarios"] if item["key"] == "review"]
        self.assertEqual([(item["id"], item["name"]) for item in matching], [(first["id"], "First review")])
        other = await self.request("POST", route, json={**body, "orgId": "row-1"})
        self.assertNotEqual(other["id"], first["id"])
        await self.request("POST", route, 400, json={**body, "key": "bad key"})

    async def test_users_and_positions_require_an_existing_department(self):
        body = {"username": "candidate", "password": "example-password", "orgId": "missing"}
        self.assertEqual((await self.request("POST", "admin/users", 400, json=body))["detail"], "部门不存在")
        await self.request("POST", "admin/positions", 400, json={"name": "Analyst", "orgId": "missing"})
        await self.request("PATCH", "admin/users/row-1", 400, json={"orgId": "missing"})
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.User, "row-1")).org_id, "row-1")
            self.assertIsNone(await session.scalar(select(models.User).where(models.User.username == "candidate")))
            self.assertIsNone(await session.scalar(select(models.Position)))
        created = await self.request("POST", "admin/users", json={**body, "orgId": "row-0"})
        updated = await self.request("PATCH", f"admin/users/{created['id']}", json={"orgId": "row-1"})
        self.assertEqual(updated["orgId"], "row-1")
        self.assertEqual((await self.request("POST", "admin/positions",
                                            json={"name": "Analyst", "orgId": "row-0"}))["orgId"], "row-0")

    async def test_integration_rejects_unsupported_top_level_fields(self):
        body = {"name": "GitLab", "type": "gitlab"}
        error = await self.request("POST", "admin/integrations", 422, json={**body, "projectId": "project"})
        self.assertIn("projectId", error["detail"][0]["loc"])
        async with self.sessions() as session:
            self.assertIsNone(await session.scalar(select(models.Integration)))
        created = await self.request("POST", "admin/integrations", json=body)
        self.assertEqual(created["name"], "GitLab")

    async def test_environment_selector_uses_registered_tags_in_scope(self):
        async with self.sessions() as session:
            session.add_all([
                automation_models.RunnerNode(id="runner", org_id="row-0", tags=["release"]),
                automation_models.RunnerNode(id="embedded", client_id="row-0", tags=["client"]),
                automation_models.RunnerNode(id="elsewhere", org_id="row-1", tags=["other"]),
                automation_models.RunnerNode(id="personal", org_id="row-0", owner_user_id="row-0", tags=["personal"]),
                automation_models.RunnerNode(id="retired", org_id="row-0", management_state="retired", tags=["old"]),
            ])
            await session.commit()
        body = {"key": "testing", "orgId": "row-0"}
        await self.request("POST", "admin/environments", 422, json={**body, "runnerSelector": {"tags": "test"}})
        env = await self.request("POST", "admin/environments", json={
            **body, "runnerSelector": {"tags": [" RELEASE ", "release", "client"]}})
        self.assertEqual(env["runnerSelector"]["tags"], ["release", "client"])
        path = f"admin/environments/{env['id']}"
        for selector in ("invalid", {"tags": [True]}, {"runnerIds": "runner"}, {"tags": ["ghost"]},
                         {"tags": ["other"]}, {"tags": ["personal"]}, {"tags": ["old"]}):
            with self.subTest(selector=selector):
                await self.request("PATCH", path, 422, json={"runnerSelector": selector})
        async with self.sessions() as session:
            row = await session.get(automation_models.Environment, env["id"])
            self.assertEqual(row.runner_selector["tags"], ["release", "client"])
        cleared = await self.request("PATCH", path, json={"runnerSelector": {"tags": []}})
        self.assertEqual(cleared["runnerSelector"]["tags"], [])

    async def test_usage_window_and_enrollment(self):
        for path in ("usage/me", "admin/usage/overview"):
            for days in (-1, 0, 366, 999999):
                await self.request("GET", path, 422, params={"days": days})
            for days in (1, 365):
                await self.request("GET", path, params={"days": days})
        for body in ({}, {"host": "  "}, {"runnerId": "new-runner"}):
            await self.request("POST", "admin/runners/enroll", 422, json=body)
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(automation_models.RunnerNode)), 0)

        new = await self.request("POST", "admin/runners/enroll", json={"host": "fixture-host", "orgId": "row-0"})
        rotated = await self.request("POST", "admin/runners/enroll", json={"runnerId": new["runnerId"]})
        self.assertTrue(rotated["rotated"])
        self.assertEqual(rotated["runnerId"], new["runnerId"])
