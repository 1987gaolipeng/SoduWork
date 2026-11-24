"""Environment sort validation through authenticated, isolated HTTP requests."""
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

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class EnvironmentSortValidationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        tables = [model.__table__ for model in (
            models.OrgUnit, models.Role, models.User, models.AuditLog, am.Environment, am.SecretReference,
        )]
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="own-org", name="Own organization"),
                models.OrgUnit(id="other-org", name="Other organization"),
                models.Role(id="manager-role", name="Manager", permissions=["environment.manage"]),
                models.User(id="manager", username="manager", org_id="own-org",
                            role_id="manager-role", is_active=True, auth_version=1),
                models.User(id="reader", username="reader", is_active=True, auth_version=1),
                am.Environment(id="existing", key="existing", name="Original", org_id="own-org", sort=7),
                am.Environment(id="other", key="other", name="Other", org_id="other-org", sort=8),
                am.Environment(id="system", key="system", name="System", sort=9),
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

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def request(self, method, suffix="", *, who="manager", **kwargs):
        headers = dict(kwargs.pop("headers", {}))
        if who:
            headers["Authorization"] = "Bearer " + sign_token(who, 1)
        return await self.http.request(method, "/api/v1/admin/environments" + suffix,
                                       headers=headers, **kwargs)

    async def test_system_secret_reference_probe_requires_super_admin(self):
        from unittest.mock import AsyncMock, patch
        async with self.sessions() as session:
            session.add(am.SecretReference(id="system-secret", name="System secret"))
            await session.commit()
        with patch.object(environments.svc, "probe_secret_ref", new_callable=AsyncMock) as probe:
            response = await self.http.post("/api/v1/admin/secret-references/system-secret/probe",
                                            headers={"Authorization": "Bearer " + sign_token("manager", 1)})
            self.assertEqual(response.status_code, 403, response.text)
            probe.assert_not_awaited()

    async def test_new_environment_requires_an_existing_organization(self):
        async with self.sessions() as session:
            session.add(models.User(id="super", username="super", is_super=True, is_active=True, auth_version=1))
            await session.commit()
        for org in ("missing", {"id": "wrong shape"}):
            response = await self.request("POST", who="super", json={"key": "new-env", "orgId": org})
            self.assertEqual(response.status_code, 400, response.text)
        await self.assert_unchanged()
        response = await self.request("POST", who="super", json={"key": "new-env", "orgId": "own-org"})
        self.assertEqual(response.status_code, 200, response.text)

    async def assert_unchanged(self):
        async with self.sessions() as session:
            rows = (await session.execute(select(
                am.Environment.id, am.Environment.key, am.Environment.name,
                am.Environment.org_id, am.Environment.sort, am.Environment.promotion_policy,
            ).order_by(am.Environment.id))).all()
            self.assertEqual([tuple(row) for row in rows], [
                ("existing", "existing", "Original", "own-org", 7, {}),
                ("other", "other", "Other", "other-org", 8, {}),
                ("system", "system", "System", None, 9, {}),
            ])
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.AuditLog)), 0)

    async def test_environment_writes_reject_malformed_prerequisites_atomically(self):
        async with self.sessions.begin() as session:
            env = await session.get(am.Environment, "existing")
            env.promotion_policy = {"requires": ["system"]}
        bad_inputs = (12345, False, "system", 0, True, None, "", {}, {"system": True},
                      ["system", 1], [None], [["system"]])
        for method, path in (("PATCH", "/existing"), ("POST", "")):
            for value in bad_inputs:
                with self.subTest(method=method, requires=value):
                    body = {"name": "Changed", "promotionPolicy": {"requires": value}}
                    if method == "POST":
                        body["key"] = "proposed"
                    response = await self.request(method, path, json=body)
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertEqual(response.json()["detail"], "requires 必须是环境标识数组")
                    self.assertEqual(response.headers.get("X-Error-Code"), "hub.input.promotion_requires")
                    async with self.sessions() as session:
                        env = await session.get(am.Environment, "existing")
                        self.assertEqual((env.name, env.promotion_policy), ("Original", {"requires": ["system"]}))
                        self.assertEqual(await session.scalar(select(func.count()).select_from(am.Environment)), 3)
                        self.assertEqual(await session.scalar(select(func.count()).select_from(models.AuditLog)), 0)

    async def test_valid_prerequisites_keep_normalization_and_legacy_policy_reads(self):
        async with self.sessions.begin() as session:
            env = await session.get(am.Environment, "existing")
            env.promotion_policy = {"requires": None}
        result = await self.request("POST", json={"key": "new-stage", "promotionPolicy": {"requiresApproval": True}})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["promotionPolicy"]["requires"], [])
        for values, expected in (([" SYSTEM ", "system"], ["system"]), ([], [])):
            result = await self.request("PATCH", "/existing", json={"promotionPolicy": {"requires": values}})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["promotionPolicy"]["requires"], expected)

    async def test_invalid_sort_returns_400_without_data_or_audit_writes(self):
        invalid = [
            [], [1], {}, {"value": 1}, True, False, 1.5, 1.0,
            "abc", "1.5", "1e3", "1_0", " ", "+", "NaN", "Infinity",
            -(2**31) - 1, 2**31, 2**63, 10**100,
            "2147483648", "-2147483649", "9" * 5000,
        ]
        for method, suffix in (("POST", ""), ("PATCH", "/existing")):
            for value in invalid:
                with self.subTest(method=method, value=repr(value)[:80]):
                    response = await self.request(method, suffix, json={
                        "key": "changed", "name": "Must not persist", "sort": value,
                    })
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertIn("sort", response.json()["detail"])
        await self.assert_unchanged()

    async def test_nonfinite_json_numbers_return_400_without_writes(self):
        # Exponent overflow is valid JSON syntax that decodes to a nonfinite float.
        for number in ("1e309", "-1e309", "NaN", "Infinity", "-Infinity"):
            for method, suffix in (("POST", ""), ("PATCH", "/existing")):
                with self.subTest(method=method, number=number):
                    response = await self.request(method, suffix,
                        content='{"key":"changed","name":"Must not persist","sort":' + number + '}',
                        headers={"Content-Type": "application/json"})
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertIn("sort", response.json()["detail"])
        await self.assert_unchanged()

    async def test_valid_integers_and_decimal_strings_preserve_sort_and_organization(self):
        cases = [(0, 0), (-4, -4), (12, 12), (" +12 ", 12), ("-04", -4),
                 (-(2**31), -(2**31)), (2**31 - 1, 2**31 - 1),
                 ("-2147483648", -(2**31)), ("2147483647", 2**31 - 1)]
        for index, (value, expected) in enumerate(cases):
            with self.subTest(value=value):
                created = await self.request("POST", json={"key": f"case-{index}",
                    "name": "Synthetic environment", "orgId": "other-org", "sort": value})
                self.assertEqual(created.status_code, 200, created.text)
                updated = await self.request("PATCH", "/existing", json={"sort": value})
                self.assertEqual(updated.status_code, 200, updated.text)
                for response in (created, updated):
                    self.assertEqual(response.json()["sort"], expected)
                    self.assertEqual(response.json()["orgId"], "own-org")
                    async with self.sessions() as session:
                        row = await session.get(am.Environment, response.json()["id"])
                        self.assertEqual((row.sort, row.org_id), (expected, "own-org"))
        async with self.sessions() as session:
            actions = (await session.execute(select(models.AuditLog.action))).scalars().all()
            self.assertEqual(actions.count("environment.create"), len(cases))
            self.assertEqual(actions.count("environment.update"), len(cases))

    async def test_omitted_sort_and_explicit_empty_values_keep_legacy_defaults(self):
        for index, extra in enumerate(({}, {"sort": None}, {"sort": ""})):
            created = await self.request("POST", json={"key": f"default-{index}", **extra})
            self.assertEqual(created.status_code, 200, created.text)
            self.assertEqual(created.json()["sort"], 0)
        renamed = await self.request("PATCH", "/existing", json={"name": "Renamed"})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual((renamed.json()["name"], renamed.json()["sort"]), ("Renamed", 7))
        for value in (None, ""):
            updated = await self.request("PATCH", "/existing", json={"sort": 7})
            self.assertEqual(updated.status_code, 200, updated.text)
            reset = await self.request("PATCH", "/existing", json={"sort": value})
            self.assertEqual(reset.status_code, 200, reset.text)
            self.assertEqual(reset.json()["sort"], 0)

    async def test_authentication_permissions_and_scope_precede_sort_validation(self):
        for method, suffix in (("POST", ""), ("PATCH", "/existing")):
            for who, expected in ((None, 401), ("reader", 403)):
                response = await self.request(method, suffix, who=who, json={"sort": []})
                self.assertEqual(response.status_code, expected, response.text)
        for suffix, expected in (("/system", 403), ("/other", 403), ("/missing", 404)):
            response = await self.request("PATCH", suffix, json={"name": "Changed", "sort": []})
            self.assertEqual(response.status_code, expected, response.text)
        await self.assert_unchanged()

    async def test_business_conflicts_still_return_409_without_writes(self):
        duplicate = await self.request("POST", json={"key": "existing", "sort": 2})
        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        cycle = await self.request("PATCH", "/existing", json={"name": "Changed", "sort": 2,
            "promotionPolicy": {"requires": ["existing"]}})
        self.assertEqual(cycle.status_code, 409, cycle.text)
        await self.assert_unchanged()


if __name__ == "__main__":
    unittest.main()
