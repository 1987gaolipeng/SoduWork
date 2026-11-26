"""Admin name validation through the HTTP routes and independent database sessions."""
import asyncio
import tempfile
import unittest
from pathlib import Path

import httpx
from fastapi import FastAPI
from sqlalchemy import Insert, event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin, business_records
from app.auth import sign_token
from app.db import Base, get_session


class AdminNameTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.engine = create_async_engine(f"sqlite+aiosqlite:///{Path(temp.name).as_posix()}/names.db")
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            tables = [model.__table__ for model in
                      (models.User, models.OrgUnit, models.Role, models.Integration, models.Domain, models.AuditLog)]
            await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        async with self.sessions() as session:
            session.add(models.User(id="admin", username="admin", is_super=True))
            await session.commit()

        async def session_for_request():
            async with self.sessions() as session:
                yield session

        app = FastAPI()
        app.include_router(admin.router)
        app.include_router(business_records.router)
        app.dependency_overrides[get_session] = session_for_request
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                                      base_url="http://test/api/v1/admin/",
                                      headers={"Authorization": "Bearer " + sign_token("admin")})
        self.addAsyncCleanup(self.http.aclose)

    async def create_org(self, name, parent=None):
        response = await self.http.post("orgs", json={"name": name, "parentId": parent})
        self.assertEqual(response.status_code, 200)
        return response.json()["id"]

    async def test_org_and_domain_creation_each_persist_one_audit_entry(self):
        async with self.sessions.begin() as session:
            session.add(models.OrgUnit(id="parent", name="Parent"))

        for path, model, target_type, body in (
            ("orgs", models.OrgUnit, "org", {"name": "New team", "parentId": "parent", "dataSource": "test"}),
            ("domains", models.Domain, "domain", {"name": "New domain"}),
        ):
            with self.subTest(path=path):
                response = await self.http.post(path, json=body)
                self.assertEqual(response.status_code, 200, response.text)
                target_id = response.json()["id"]
                async with self.sessions() as session:
                    stored = await session.get(model, target_id)
                    self.assertIsNotNone(stored)
                    self.assertEqual(stored.name, body["name"])
                    audit = (await session.scalars(select(models.AuditLog).where(
                        models.AuditLog.target_id == target_id))).one()
                    self.assertEqual((audit.actor_id, audit.action, audit.target_type, audit.target_label),
                                     ("admin", f"{target_type}.create", target_type, stored.name))
                    if target_type == "org":
                        self.assertEqual((audit.detail["parentId"], audit.detail["dataSource"]), ("parent", "test"))
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count(models.AuditLog.id))), 2)

    async def test_org_and_domain_creation_roll_back_when_audit_insert_fails(self):
        attempts = 0

        def reject_audit_insert(conn, clauseelement, multiparams, params, execution_options):
            nonlocal attempts
            if isinstance(clauseelement, Insert) and clauseelement.table.name == models.AuditLog.__tablename__:
                attempts += 1
                raise OSError("Synthetic audit storage failure")

        event.listen(self.engine.sync_engine, "before_execute", reject_audit_insert)
        self.addCleanup(event.remove, self.engine.sync_engine, "before_execute", reject_audit_insert)

        for path, model in (("orgs", models.OrgUnit), ("domains", models.Domain)):
            with self.subTest(path=path):
                response = await self.http.post(path, json={"name": "Uncommitted"})
                self.assertTrue(500 <= response.status_code < 600, response.text)
                async with self.sessions() as session:
                    self.assertIsNone(await session.scalar(select(model.id)))
                    self.assertIsNone(await session.scalar(select(models.AuditLog.id)))
        self.assertEqual(attempts, 2)

    async def test_names_are_trimmed_and_bounded_on_create_and_rename(self):
        maximum = "组" * 64
        for route in ("orgs", "roles", "integrations"):
            response = await self.http.post(route, json={"name": f"\u3000{maximum}\t"})
            self.assertEqual(response.status_code, 200, route)
            self.assertEqual(response.json()["name"], maximum)
            path = f"{route}/{response.json()['id']}"
            for invalid in ("", " \t\u3000", maximum + "组"):
                self.assertEqual((await self.http.post(route, json={"name": invalid})).status_code, 422, route)
                if route != "integrations":
                    self.assertEqual((await self.http.patch(path, json={"name": invalid})).status_code, 422, route)
            if route != "integrations":
                self.assertEqual((await self.http.patch(path, json={"name": "  新名称 "})).json()["name"], "新名称")

    async def test_department_source_visibility_hierarchy_and_reversible_archive(self):
        normal = await self.create_org("Business")
        response = await self.http.post("orgs", json={"name": "QA", "dataSource": "test"})
        self.assertEqual(response.status_code, 200)
        qa = response.json()
        child = (await self.http.post("orgs", json={"name": "Child", "parentId": qa["id"],
                                                   "dataSource": "business"})).json()
        self.assertEqual(child["dataSource"], "test")
        self.assertEqual({row["id"] for row in (await self.http.get("orgs")).json()}, {normal})
        managed = (await self.http.get("orgs?includeManaged=true")).json()
        self.assertEqual({row["id"] for row in managed}, {normal, qa["id"], child["id"]})

        async def batch(action, *ids):
            return await self.http.post("business-records/orgs", json={"action": action, "ids": ids})

        self.assertEqual((await batch("archive", qa["id"])).status_code, 409)
        self.assertEqual((await batch("archive", qa["id"], child["id"])).json()["changed"], 2)
        self.assertEqual((await self.http.post("orgs", json={"name": "Blocked", "parentId": qa["id"]})).status_code, 409)
        self.assertEqual((await self.http.patch("orgs/" + normal, json={"parentId": qa["id"]})).status_code, 409)
        self.assertEqual((await batch("restore", child["id"])).status_code, 409)
        self.assertEqual((await batch("restore", qa["id"], child["id"])).json()["changed"], 2)
        self.assertEqual((await batch("business", child["id"])).status_code, 409)
        self.assertEqual((await batch("business", qa["id"], child["id"])).json()["changed"], 2)
        self.assertEqual((await batch("test", qa["id"], normal)).status_code, 409)
        rows = {row["id"]: row for row in (await self.http.get("orgs")).json()}
        for org_id in (qa["id"], child["id"], normal):
            self.assertEqual(rows[org_id]["dataSource"], "business")
        self.assertEqual((await batch("test", qa["id"], child["id"])).json()["changed"], 2)
        self.assertEqual((await batch("test", qa["id"])).json()["changed"], 0)
        self.assertEqual({row["id"] for row in (await self.http.get("orgs")).json()}, {normal})

        # Imported mixed trees retain their visible children and retries remain idempotent.
        async with self.sessions() as session:
            imported = await session.get(models.OrgUnit, child["id"])
            imported.data_source = "legacy"
            await session.commit()
        self.assertEqual((await batch("test", qa["id"])).json()["changed"], 0)
        visible = (await self.http.get("orgs")).json()
        self.assertEqual(next(row["parentId"] for row in visible if row["id"] == child["id"]), qa["id"])
        self.assertEqual((await batch("business", qa["id"])).json()["changed"], 1)
        self.assertEqual((await batch("test", qa["id"])).status_code, 409)
        self.assertEqual((await batch("archive", child["id"])).json()["changed"], 1)
        self.assertEqual((await batch("test", qa["id"])).json()["changed"], 1)

    async def test_test_manager_creation_and_managed_list_remain_scoped(self):
        own, other = await self.create_org("Own"), await self.create_org("Other")
        async with self.sessions() as session:
            role = models.Role(name="Manager", permissions=["org.manage"])
            session.add(role)
            await session.flush()
            session.add_all([models.User(id="manager", username="manager", org_id=own,
                                         role_id=role.id, is_test_account=True),
                             models.User(id="member", username="member", org_id=own)])
            await session.commit()
        manager_headers = {"Authorization": "Bearer " + sign_token("manager")}
        created = await self.http.post("orgs", json={"parentId": own, "name": "Plain name"}, headers=manager_headers)
        self.assertEqual(created.status_code, 200)
        self.assertEqual(created.json()["dataSource"], "test")
        allowed = await self.http.get("orgs?includeManaged=true", headers=manager_headers)
        self.assertEqual({row["id"] for row in allowed.json()}, {own, created.json()["id"]})
        forbidden = await self.http.post("orgs", json={"parentId": other, "name": "Other team"}, headers=manager_headers)
        self.assertEqual(forbidden.status_code, 403)
        member_headers = {"Authorization": "Bearer " + sign_token("member")}
        self.assertEqual((await self.http.get("orgs?includeManaged=true", headers=member_headers)).status_code, 403)

    async def test_control_characters_cannot_be_stored_in_organization_names(self):
        org = await self.create_org("قسم الأبحاث")
        for control in ("\0", "\x1b", "\n", "\x85", "\u2028", "\u202e", "\u2067"):
            with self.subTest(control=repr(control)):
                body = {"name": f"First{control}Last"}
                self.assertEqual((await self.http.post("orgs", json=body)).status_code, 422)
                self.assertEqual((await self.http.patch(f"orgs/{org}", json=body)).status_code, 422)
        async with self.sessions() as session:
            self.assertEqual(list(await session.scalars(select(models.OrgUnit.name))), ["قسم الأبحاث"])

    async def test_rename_and_move_check_the_destination_before_writing(self):
        first = await self.create_org("One")
        second = await self.create_org("Two")
        child = await self.create_org("Team", first)
        await self.create_org("Team", second)
        for changes in ({"name": "Two", "parentId": ""}, {"parentId": second}):
            self.assertEqual((await self.http.patch(f"orgs/{child}", json=changes)).status_code, 409)
        async with self.sessions() as session:
            row = await session.get(models.OrgUnit, child)
            self.assertEqual((row.name, row.parent_id), ("Team", first))
        moved = await self.http.patch(f"orgs/{child}", json={"parentId": second, "name": " Other "})
        self.assertEqual((moved.json()["name"], moved.json()["parentId"]), ("Other", second))
        self.assertEqual((await self.http.patch(f"orgs/{child}", json={"name": "Other"})).status_code, 200)

    async def test_existing_padded_sibling_and_legacy_duplicates(self):
        async with self.sessions() as session:
            session.add(models.OrgUnit(id="legacy", name="\u3000Team\t"))
            await session.commit()
        self.assertEqual((await self.http.post("orgs", json={"name": " Team "})).status_code, 409)
        async with self.sessions() as session:
            session.add(models.OrgUnit(name="Team"))
            await session.commit()
        sorted_row = await self.http.patch("orgs/legacy", json={"sort": 3})
        self.assertEqual(sorted_row.json()["name"], "\u3000Team\t")
        renamed = await self.http.patch("orgs/legacy", json={"name": "Other"})
        self.assertEqual(renamed.json()["name"], "Other")

    async def test_concurrent_sibling_creates_commit_once(self):
        responses = await asyncio.gather(*(self.http.post("orgs", json={"name": name})
                                           for name in ("Team", " Team ")))
        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        async with self.sessions() as session:
            self.assertEqual(list(await session.scalars(select(models.OrgUnit.name))), ["Team"])


if __name__ == "__main__":
    unittest.main()
