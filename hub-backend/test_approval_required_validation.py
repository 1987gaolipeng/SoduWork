"""Approval countersigner validation through authenticated, isolated HTTP."""
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


BASE_RULES = {"actions": ["review"], "approvers": [{"type": "requester", "label": "Requester"}]}
ORIGINAL_RULES = {**BASE_RULES, "mode": "threshold", "required": 2,
                  "invalidateOnNewVersion": True, "separationOfDuties": False}


class ApprovalRequiredValidationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        tables = [model.__table__ for model in (
            models.OrgUnit, models.Role, models.User, models.AuditLog, am.ApprovalPolicy,
        )]
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="own-org", name="Own organization"),
                models.OrgUnit(id="other-org", name="Other organization"),
                models.Role(id="policy-manager-role", name="Manager", permissions=["flow.manage"]),
                models.User(id="manager", username="manager", org_id="own-org",
                            role_id="policy-manager-role", is_active=True, auth_version=1),
                models.User(id="reader", username="reader", is_active=True, auth_version=1),
                am.ApprovalPolicy(id="existing", key="existing", name="Original", org_id="own-org",
                                  rules=ORIGINAL_RULES),
                am.ApprovalPolicy(id="peer", key="peer", name="Peer", org_id="own-org",
                                  rules=ORIGINAL_RULES),
                am.ApprovalPolicy(id="other", key="other", name="Other", org_id="other-org",
                                  rules=ORIGINAL_RULES),
                am.ApprovalPolicy(id="system", key="system", name="System", rules=ORIGINAL_RULES),
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
        return await self.http.request(method, "/api/v1/admin/approval-policies" + suffix,
                                       headers=headers, **kwargs)

    async def assert_unchanged(self):
        async with self.sessions() as session:
            rows = (await session.execute(select(
                am.ApprovalPolicy.id, am.ApprovalPolicy.key, am.ApprovalPolicy.name,
                am.ApprovalPolicy.org_id, am.ApprovalPolicy.rules,
            ).order_by(am.ApprovalPolicy.id))).all()
            self.assertEqual([tuple(row) for row in rows], [
                ("existing", "existing", "Original", "own-org", ORIGINAL_RULES),
                ("other", "other", "Other", "other-org", ORIGINAL_RULES),
                ("peer", "peer", "Peer", "own-org", ORIGINAL_RULES),
                ("system", "system", "System", None, ORIGINAL_RULES),
            ])
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.AuditLog)), 0)

    async def test_invalid_required_returns_400_without_data_or_audit_writes(self):
        invalid = [
            [], [3], {}, {"value": 3}, True, False, 1.5, 1.0,
            "abc", "1.5", "1e3", "1_0", " ", "+", "NaN", "Infinity",
            -(2**31) - 1, 2**31, 2**63, 10**100,
            "2147483648", "-2147483649", "9" * 5000,
        ]
        for method, suffix in (("POST", ""), ("PATCH", "/existing")):
            for value in invalid:
                with self.subTest(method=method, value=repr(value)[:80]):
                    response = await self.request(method, suffix, json={
                        "key": "changed", "name": "Must not persist",
                        "rules": {**BASE_RULES, "required": value},
                    })
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertIn("rules.required", response.json()["detail"])
        await self.assert_unchanged()

    async def test_nonfinite_json_numbers_return_400_without_writes(self):
        # Exponent overflow is valid JSON syntax that decodes to a nonfinite float.
        for number in ("1e309", "-1e309", "NaN", "Infinity", "-Infinity"):
            for method, suffix in (("POST", ""), ("PATCH", "/existing")):
                with self.subTest(method=method, number=number):
                    content = ('{"key":"changed","name":"Must not persist","rules":'
                               '{"actions":["review"],"approvers":[{"type":"requester"}],'
                               '"required":' + number + '}}')
                    response = await self.request(method, suffix, content=content,
                        headers={"Content-Type": "application/json"})
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertIn("rules.required", response.json()["detail"])
        await self.assert_unchanged()

    async def test_valid_integers_and_strings_keep_clamps_modes_and_organization(self):
        cases = [(1, 1), (2, 2), (50, 50), (0, 1), (-4, 1), (51, 50),
                 (" +12 ", 12), ("-04", 1), ("050", 50),
                 (-(2**31), 1), (2**31 - 1, 50),
                 ("-2147483648", 1), ("2147483647", 50), ("0" * 5000 + "2", 2)]
        for index, (value, expected) in enumerate(cases):
            with self.subTest(value=repr(value)[:80]):
                rules = {**BASE_RULES, "required": value}
                created = await self.request("POST", json={"key": f"case-{index}",
                    "name": "Synthetic policy", "orgId": "other-org", "rules": rules})
                self.assertEqual(created.status_code, 200, created.text)
                updated = await self.request("PATCH", "/existing", json={"rules": rules})
                self.assertEqual(updated.status_code, 200, updated.text)
                expected_rules = {**ORIGINAL_RULES, "required": expected,
                                  "mode": "any" if expected == 1 else "threshold"}
                for response in (created, updated):
                    self.assertEqual(response.json()["rules"], expected_rules)
                    self.assertEqual(response.json()["orgId"], "own-org")
                    async with self.sessions() as session:
                        row = await session.get(am.ApprovalPolicy, response.json()["id"])
                        self.assertEqual((row.rules, row.org_id), (expected_rules, "own-org"))
        async with self.sessions() as session:
            actions = (await session.execute(select(models.AuditLog.action))).scalars().all()
            self.assertEqual(actions.count("approval_policy.create"), len(cases))
            self.assertEqual(actions.count("approval_policy.update"), len(cases))

    async def test_missing_required_and_empty_values_keep_default_one(self):
        for index, extra in enumerate(({}, {"required": None}, {"required": ""})):
            with self.subTest(extra=extra):
                rules = {**BASE_RULES, **extra}
                created = await self.request("POST", json={"key": f"default-{index}", "rules": rules})
                self.assertEqual(created.status_code, 200, created.text)
                restored = await self.request("PATCH", "/existing", json={"rules": ORIGINAL_RULES})
                self.assertEqual(restored.status_code, 200, restored.text)
                updated = await self.request("PATCH", "/existing", json={"rules": rules})
                self.assertEqual(updated.status_code, 200, updated.text)
                for response in (created, updated):
                    self.assertEqual((response.json()["rules"]["required"], response.json()["rules"]["mode"]),
                                     (1, "any"))

    async def test_patch_without_rules_preserves_existing_configuration(self):
        response = await self.request("PATCH", "/existing", json={"name": "Renamed"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((response.json()["name"], response.json()["rules"]), ("Renamed", ORIGINAL_RULES))
        async with self.sessions() as session:
            row = await session.get(am.ApprovalPolicy, "existing")
            self.assertEqual((row.name, row.rules), ("Renamed", ORIGINAL_RULES))

    async def test_authentication_permissions_and_scope_precede_required_validation(self):
        body = {"name": "Changed", "rules": {**BASE_RULES, "required": []}}
        for method, suffix in (("POST", ""), ("PATCH", "/existing")):
            for who, expected in ((None, 401), ("reader", 403)):
                response = await self.request(method, suffix, who=who, json=body)
                self.assertEqual(response.status_code, expected, response.text)
        for suffix, expected in (("/system", 403), ("/other", 403), ("/missing", 404)):
            response = await self.request("PATCH", suffix, json=body)
            self.assertEqual(response.status_code, expected, response.text)
        await self.assert_unchanged()

    async def test_duplicate_policy_keys_still_return_409_without_writes(self):
        created = await self.request("POST", json={"key": "existing", "rules": ORIGINAL_RULES})
        self.assertEqual(created.status_code, 409, created.text)
        updated = await self.request("PATCH", "/existing", json={"key": "peer", "name": "Changed",
            "rules": {**BASE_RULES, "required": 3}})
        self.assertEqual(updated.status_code, 409, updated.text)
        await self.assert_unchanged()


if __name__ == "__main__":
    unittest.main()
