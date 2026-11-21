"""Secret-reference organization validation through isolated authenticated HTTP and SQL."""
import importlib
from pathlib import Path
import unittest

import httpx
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import environments
from app.auth import sign_token
from app.db import Base, get_session
from app.services import environment_service as service

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class SecretReferenceOrgValidationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        tables = [model.__table__ for model in (
            models.OrgUnit, models.Role, models.User, models.AuditLog, am.SecretReference,
        )]
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="own-org", name="Own organization"),
                models.OrgUnit(id="other-org", name="Other organization"),
                models.Role(id="manager-role", name="Manager", permissions=["environment.manage"]),
                models.User(id="super", username="super", is_super=True, is_active=True, auth_version=1),
                models.User(id="manager", username="manager", org_id="own-org",
                            role_id="manager-role", is_active=True, auth_version=1),
                models.User(id="reader", username="reader", is_active=True, auth_version=1),
            ])
            await session.commit()
        app = FastAPI()
        app.include_router(environments.router)

        async def db():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://isolated",
        )
        self.addAsyncCleanup(self.engine.dispose)
        self.addAsyncCleanup(self.http.aclose)

    @staticmethod
    def body(**changes):
        return {"name": "Fixture reference", "provider": "runner-env", "locator": "FIXTURE_ENV", **changes}

    async def request(self, method, suffix="", *, who="super", **kwargs):
        headers = {"Authorization": "Bearer " + sign_token(who, 1)} if who else {}
        return await self.http.request(method, "/api/v1/admin/secret-references" + suffix,
                                       headers=headers, **kwargs)

    async def assert_counts(self, references, audits):
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count(am.SecretReference.id))), references)
            self.assertEqual(await session.scalar(select(func.count(models.AuditLog.id))), audits)

    async def test_invalid_types_return_400_without_reference_or_audit_writes(self):
        for value in (["x"], {"a": 1}, [], {}, False, True, 0, 123, 1.5):
            with self.subTest(value=value):
                response = await self.request("POST", json=self.body(orgId=value))
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn("orgId", response.json()["detail"])
                await self.assert_counts(0, 0)

    async def test_unknown_organizations_return_400_without_writes(self):
        for org in ("missing-org", " ", " own-org ", "123", "x" * 100):
            with self.subTest(org=org):
                response = await self.request("POST", json=self.body(orgId=org))
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn("orgId", response.json()["detail"])
                await self.assert_counts(0, 0)

    async def test_service_rejects_bad_ownership_before_mutation_and_session_remains_usable(self):
        async with self.sessions() as session:
            for value in (["x"], {"a": 1}, [], {}, False, True, 0, 123, 1.5, "missing-org"):
                with self.subTest(value=value):
                    with self.assertRaisesRegex(ValueError, "orgId"):
                        await service.save_secret_ref(session, self.body(orgId=value))
                    self.assertFalse(session.new)
                    self.assertFalse(session.dirty)
                    self.assertEqual(await session.scalar(select(func.count(am.SecretReference.id))), 0)
            # No rollback is required for a validation error; the same session can save valid input.
            created = await service.save_secret_ref(session, self.body(orgId="own-org"))
            self.assertEqual(created.org_id, "own-org")
        await self.assert_counts(1, 0)

    async def test_omitted_null_and_empty_string_preserve_system_reference_contract(self):
        for fields in ({}, {"orgId": None}, {"orgId": ""}):
            with self.subTest(fields=fields):
                response = await self.request("POST", json=self.body(**fields))
                self.assertEqual(response.status_code, 200, response.text)
                self.assertIsNone(response.json()["orgId"])
        await self.assert_counts(3, 3)

    async def test_existing_organizations_persist_and_listing_respects_scope(self):
        for org in (None, "own-org", "other-org"):
            response = await self.request("POST", json=self.body(orgId=org))
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["orgId"], org)
            async with self.sessions() as session:
                saved = await session.get(am.SecretReference, response.json()["id"])
                self.assertEqual(saved.org_id, org)
        for who, expected in (("super", {None, "own-org", "other-org"}),
                              ("manager", {None, "own-org"})):
            response = await self.request("GET", who=who)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual({item["orgId"] for item in response.json()["items"]}, expected)
        await self.assert_counts(3, 3)

    async def test_manager_ownership_comes_from_authenticated_account(self):
        for fields in ({}, {"orgId": None}, {"orgId": ""}, {"orgId": "other-org"},
                       {"orgId": ["x"]}, {"orgId": {"a": 1}}):
            with self.subTest(fields=fields):
                response = await self.request("POST", who="manager", json=self.body(**fields))
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["orgId"], "own-org")
        await self.assert_counts(6, 6)

    async def test_missing_permission_is_rejected_before_validation(self):
        for who, status in ((None, 401), ("reader", 403)):
            response = await self.request("POST", who=who, json=self.body(orgId=["x"]))
            self.assertEqual(response.status_code, status, response.text)
        await self.assert_counts(0, 0)

    async def test_updates_preserve_ownership_and_scope_guards(self):
        for org in (None, "own-org", "other-org"):
            created = await self.request("POST", json=self.body(orgId=org))
            self.assertEqual(created.status_code, 200, created.text)
            suffix = "/" + created.json()["id"]
            changed = await self.request("PATCH", suffix, who="manager",
                                         json={"name": "Manager edit", "orgId": "own-org"})
            self.assertEqual(changed.status_code, 200 if org == "own-org" else 403, changed.text)
            for supplied in (None, "other-org", ["x"], {"a": 1}):
                changed = await self.request("PATCH", suffix, json={"name": "Renamed", "orgId": supplied})
                self.assertEqual(changed.status_code, 200, changed.text)
                self.assertEqual(changed.json()["orgId"], org)
        await self.assert_counts(3, 16)

    async def test_unrelated_validation_retains_existing_error_status(self):
        for fields in ({"provider": "unsupported"}, {"locator": "invalid-name"}):
            response = await self.request("POST", json=self.body(orgId="own-org", **fields))
            self.assertEqual(response.status_code, 409, response.text)
        await self.assert_counts(0, 0)


if __name__ == "__main__":
    unittest.main()
