"""Authenticated domain writes reject invalid sort values before any mutation."""
import asyncio
import os
import tempfile
from pathlib import Path
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin
from app.auth import sign_token
from app.db import Base, get_session


class DomainSortValidationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.engine = create_async_engine(f"sqlite+aiosqlite:///{Path(directory.name) / 'test.db'}")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        # Only the real tables used by these endpoints and their associations.
        tables = [model.__table__ for model in (
            models.User, models.Role, models.Domain, models.AuditLog,
            models.Client, models.Task, models.OrgUnit, models.Position, models.AppSetting,
        )]
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        async with self.sessions() as session:
            session.add_all([
                models.Role(id="manager-role", name="Manager", permissions=["user.manage"]),
                models.User(id="manager", username="manager", role_id="manager-role",
                            is_active=True, auth_version=1, domains=["existing"]),
                models.User(id="reader", username="reader", is_active=True, auth_version=1),
                models.Domain(id="existing", name="Existing", sort=2),
                models.Task(id="linked-task", title="Synthetic association", domain_id="existing"),
            ])
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(admin.router)

        async def db():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app, raise_app_exceptions=False),
            base_url="http://isolated",
        )

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def request(self, method, path="/domains", *, who="manager", **kwargs):
        headers = {"Authorization": "Bearer " + sign_token(who, 1)} if who else {}
        headers.update(kwargs.pop("headers", {}))
        return await self.http.request(method, "/api/v1/admin" + path, headers=headers, **kwargs)

    async def test_overlapping_updates_return_and_audit_each_actors_own_write(self):
        async with self.sessions() as session:
            session.add(models.User(id="second-manager", username="second-manager", role_id="manager-role"))
            await session.commit()
        changes = [(f"Domain {i}", "manager" if i % 2 else "second-manager") for i in range(20)]
        replies = await asyncio.gather(*(self.request(
            "PATCH", "/domains/existing", who=actor, json={"name": name, "sort": i})
            for i, (name, actor) in enumerate(changes)))
        for i, ((name, _), response) in enumerate(zip(changes, replies)):
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual((response.json()["name"], response.json()["sort"]), (name, i))

        async with self.sessions() as session:
            logs = list(await session.scalars(select(models.AuditLog).where(
                models.AuditLog.action == "domain.update", models.AuditLog.target_id == "existing")))
            domain = await session.get(models.Domain, "existing")
            self.assertCountEqual([(row.target_label, row.actor_id) for row in logs], changes)
            next_edit = {row.detail["before"]["name"]: row for row in logs}
            previous = {"name": "Existing", "sort": 2, "id": "existing", "isSystem": False}
            for _ in changes:
                row = next_edit.pop(previous["name"])
                current = row.detail["after"]
                self.assertEqual(row.target_label, current["name"])
                self.assertEqual(row.detail["before"], previous)
                self.assertEqual(current["sort"], int(current["name"].split()[1]))
                previous = current
            self.assertFalse(next_edit)
            self.assertEqual((domain.name, domain.sort), (previous["name"], previous["sort"]))

    async def test_audit_insert_failure_rolls_back_domain_edit(self):
        async with self.engine.begin() as conn:
            await conn.execute(text("""
                CREATE TRIGGER reject_domain_audit BEFORE INSERT ON audit_log
                WHEN NEW.action = 'domain.update'
                BEGIN SELECT RAISE(ABORT, 'audit write unavailable'); END
            """))
        reply = await self.request("PATCH", "/domains/existing", json={"name": "Rejected", "sort": 9})
        self.assertEqual(reply.status_code, 500)
        async with self.sessions() as session:
            domain = await session.get(models.Domain, "existing")
            self.assertEqual((domain.name, domain.sort), ("Existing", 2))
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.AuditLog)), 0)

    async def test_user_assignments_protect_domains_and_reject_stale_ids(self):
        async with self.sessions() as session:
            session.add(models.OrgUnit(id="team", name="Team"))
            actor = await session.get(models.User, "manager")
            actor.org_id = "team"
            await session.commit()

        body = {"username": "new-user", "password": "isolated-fixture", "orgId": "team"}
        bad_role = await self.request("POST", "/users", json={**body, "roleId": "missing-role"})
        self.assertEqual(bad_role.status_code, 400, bad_role.text)
        invalid = await self.request("POST", "/users", json={**body, "domains": ["missing"]})
        self.assertEqual(invalid.status_code, 400, invalid.text)
        created = await self.request("POST", "/users", json={**body, "domains": ["existing"]})
        self.assertEqual(created.status_code, 200, created.text)
        user_path = "/users/" + created.json()["id"]
        bad_role = await self.request("PATCH", user_path, json={"roleId": "missing-role"})
        self.assertEqual(bad_role.status_code, 400, bad_role.text)
        bad_patch = await self.request("PATCH", user_path, json={"domains": ["existing", "missing"]})
        self.assertEqual(bad_patch.status_code, 400, bad_patch.text)
        renamed = await self.request("PATCH", user_path, json={"displayName": "Renamed"})
        self.assertEqual(renamed.json()["domains"], ["existing"])

        for path in ("/users/manager", user_path):
            blocked = await self.request("DELETE", "/domains/existing")
            self.assertEqual(blocked.status_code, 400, blocked.text)
            self.assertIn("仍有用户", blocked.json()["detail"])
            cleared = await self.request("PATCH", path, json={"domains": []})
            self.assertEqual(cleared.json()["domains"], [])
        deleted = await self.request("DELETE", "/domains/existing")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        stale = await self.request("PATCH", user_path, json={"domains": ["existing"]})
        self.assertEqual(stale.status_code, 400, stale.text)

    async def test_domain_names_are_required_bounded_and_unique_on_both_write_paths(self):
        for value in (None, "", "   ", "x" * 65, {"name": "bad"}):
            response = await self.request("POST", json={} if value is None else {"name": value})
            self.assertEqual(response.status_code, 422, response.text)
            response = await self.request("PATCH", "/domains/existing", json={"name": value})
            self.assertEqual(response.status_code, 422, response.text)
        new = await self.request("POST", json={"name": "  Another  "})
        self.assertEqual(new.json()["name"], "Another")
        for method, path in (("POST", "/domains"), ("PATCH", "/domains/existing")):
            response = await self.request(method, path, json={"name": " another "})
            self.assertEqual(response.status_code, 409, response.text)

    async def assert_unchanged(self):
        async with self.sessions() as session:
            domain = await session.get(models.Domain, "existing")
            self.assertEqual((domain.name, domain.sort), ("Existing", 2))
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.Domain)), 1)
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.AuditLog)), 0)
            self.assertEqual((await session.get(models.User, "manager")).domains, ["existing"])
            self.assertEqual((await session.get(models.Task, "linked-task")).domain_id, "existing")
            storage = await session.scalar(text("SELECT typeof(sort) FROM domain WHERE id='existing'"))
            self.assertEqual(storage, "integer")

    async def test_create_and_patch_accept_integer_boundaries_and_legacy_decimal_strings(self):
        cases = [
            (-(2**31), -(2**31)), (2**31 - 1, 2**31 - 1), (0, 0), (-7, -7),
            ("-2147483648", -(2**31)), ("2147483647", 2**31 - 1),
            ("  +9  ", 9), ("-0003", -3), ("0", 0),
        ]
        for index, (value, expected) in enumerate(cases):
            with self.subTest(value=value):
                created = await self.request("POST", json={"name": f"Synthetic {index}", "sort": value})
                self.assertEqual(created.status_code, 200, created.text)
                self.assertEqual(created.json()["sort"], expected)
                self.assertIs(type(created.json()["sort"]), int)
                updated = await self.request("PATCH", "/domains/existing", json={"sort": value})
                self.assertEqual(updated.status_code, 200, updated.text)
                self.assertEqual((updated.json()["id"], updated.json()["sort"]), ("existing", expected))
                self.assertIs(type(updated.json()["sort"]), int)
        async with self.sessions() as session:
            storage_types = (await session.execute(text("SELECT DISTINCT typeof(sort) FROM domain"))).scalars().all()
            self.assertEqual(storage_types, ["integer"])
            self.assertEqual((await session.get(models.User, "manager")).domains, ["existing"])
            self.assertEqual((await session.get(models.Task, "linked-task")).domain_id, "existing")
            actions = (await session.execute(select(models.AuditLog.action))).scalars().all()
            self.assertEqual(actions.count("domain.create"), len(cases))
            self.assertEqual(actions.count("domain.update"), len(cases))

    async def test_omitted_null_and_create_empty_string_keep_existing_defaults(self):
        for index, extra in enumerate(({}, {"sort": None}, {"sort": ""})):
            with self.subTest(extra=extra):
                response = await self.request("POST", json={"name": f"Synthetic default {index}", **extra})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["sort"], 0)
        for extra in ({}, {"sort": None}):
            with self.subTest(extra=extra):
                response = await self.request("PATCH", "/domains/existing", json={"name": "Renamed", **extra})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual((response.json()["name"], response.json()["sort"]), ("Renamed", 2))
        # PATCH previously persisted an empty string as corrupt data, unlike POST's default.
        rejected = await self.request("PATCH", "/domains/existing", json={"sort": ""})
        self.assertEqual(rejected.status_code, 400, rejected.text)

    async def test_invalid_create_and_patch_leave_records_associations_and_audit_unchanged(self):
        invalid = [
            "abc", "3.5", "1e3", "1_0", "+", " ", "NaN", "Infinity",
            True, False, 3.5, -3.5, 1.0, {}, {"value": 1}, [], [1],
            -(2**31) - 1, 2**31, 2**63, 10**100,
            "2147483648", "-2147483649", "9" * 5000,
        ]
        for value in invalid:
            for method, path in (("POST", "/domains"), ("PATCH", "/domains/existing")):
                with self.subTest(method=method, value=repr(value)[:80]):
                    response = await self.request(method, path, json={"name": "Must not persist", "sort": value})
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertIn("sort", response.json()["detail"])
        await self.assert_unchanged()
        listed = await self.request("GET")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual([(row["id"], row["name"], row["sort"]) for row in listed.json()],
                         [("existing", "Existing", 2)])

    async def test_nonfinite_json_numbers_return_400_without_side_effects(self):
        # 1e309 is valid JSON syntax but decodes to a nonfinite Python float.
        for number in ("1e309", "-1e309", "NaN", "Infinity", "-Infinity"):
            for method, path in (("POST", "/domains"), ("PATCH", "/domains/existing")):
                with self.subTest(method=method, number=number):
                    response = await self.request(
                        method, path, content='{"name":"Must not persist","sort":' + number + '}',
                        headers={"Content-Type": "application/json"},
                    )
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertIn("sort", response.json()["detail"])
        await self.assert_unchanged()

    async def test_write_authentication_and_permissions_still_run_before_validation(self):
        for method, path in (("POST", "/domains"), ("PATCH", "/domains/existing")):
            for who, expected in ((None, 401), ("reader", 403)):
                with self.subTest(method=method, who=who):
                    response = await self.request(method, path, who=who, json={"sort": {}})
                    self.assertEqual(response.status_code, expected, response.text)
        await self.assert_unchanged()

    async def test_valid_patch_of_missing_domain_still_returns_404(self):
        response = await self.request("PATCH", "/domains/missing", json={"sort": "5"})
        self.assertEqual(response.status_code, 404, response.text)
        await self.assert_unchanged()


if __name__ == "__main__":
    unittest.main()
