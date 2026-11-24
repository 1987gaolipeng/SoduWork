"""Approval action-list validation through authenticated, isolated HTTP."""
import copy
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
from app.services import approval_policies, approval_routing

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


ORIGINAL_RULES = {"actions": ["review"], "mode": "threshold", "required": 2,
                  "approvers": [{"type": "requester", "label": "Requester"}],
                  "invalidateOnNewVersion": True, "separationOfDuties": False}
INVALID_ACTIONS = [5, 0, True, False, None, "review", "", {}, {"deploy": False}]


class ApprovalActionsValidationTests(unittest.IsolatedAsyncioTestCase):
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
                models.Role(id="actions-manager-role", name="Manager", permissions=["flow.manage"]),
                models.User(id="manager", username="manager", org_id="own-org",
                            role_id="actions-manager-role", is_active=True, auth_version=1),
                models.User(id="reader", username="reader", is_active=True, auth_version=1),
                models.User(id="super", username="super", is_super=True, is_active=True, auth_version=1),
            ])
            session.add_all([
                am.ApprovalPolicy(id=key, key=key, name=name, org_id=org, rules=ORIGINAL_RULES,
                                  is_system=(key == "system"))
                for key, name, org in (("existing", "Original", "own-org"),
                                       ("peer", "Peer", "own-org"),
                                       ("other", "Other", "other-org"),
                                       ("system", "System", None))
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

    async def test_non_list_actions_return_400_without_data_or_audit_writes(self):
        for method, suffix in (("POST", ""), ("PATCH", "/existing")):
            for value in INVALID_ACTIONS:
                with self.subTest(method=method, value=value):
                    response = await self.request(method, suffix, json={
                        "key": "changed", "name": "Must not persist",
                        "rules": {**ORIGINAL_RULES, "actions": value},
                    })
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertIn("rules.actions", response.json()["detail"])
        await self.assert_unchanged()

    async def test_nonfinite_json_actions_return_400_without_writes(self):
        for number in ("1e309", "-1e309", "NaN", "Infinity", "-Infinity"):
            for method, suffix in (("POST", ""), ("PATCH", "/existing")):
                with self.subTest(method=method, number=number):
                    content = ('{"key":"changed","name":"Must not persist","rules":'
                               '{"approvers":[{"type":"requester"}],"actions":' + number + '}}')
                    response = await self.request(method, suffix, content=content,
                        headers={"Content-Type": "application/json"})
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertIn("rules.actions", response.json()["detail"])
        await self.assert_unchanged()

    async def test_valid_lists_normalize_actions_and_preserve_policy_fields(self):
        cases = [([" REVIEW ", "review", "Deploy"], ["review", "deploy"]),
                 (["baseline", "review", "merge", "uat", "deploy"],
                  ["baseline", "review", "merge", "uat", "deploy"])]
        for index, (value, expected) in enumerate(cases):
            rules = {**ORIGINAL_RULES, "actions": value}
            created = await self.request("POST", json={"key": f"case-{index}",
                "name": "Synthetic policy", "orgId": "other-org", "rules": rules})
            self.assertEqual(created.status_code, 200, created.text)
            updated = await self.request("PATCH", "/existing", json={"rules": rules})
            self.assertEqual(updated.status_code, 200, updated.text)
            expected_rules = {**ORIGINAL_RULES, "actions": expected}
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

    async def test_missing_empty_and_unknown_actions_keep_business_errors(self):
        without_actions = {key: value for key, value in ORIGINAL_RULES.items() if key != "actions"}
        for rules in (without_actions, {**ORIGINAL_RULES, "actions": []},
                      {**ORIGINAL_RULES, "actions": ["unknown"]}):
            for method, suffix in (("POST", ""), ("PATCH", "/existing")):
                response = await self.request(method, suffix, json={
                    "key": "changed", "name": "Must not persist", "rules": rules})
                self.assertEqual(response.status_code, 409, response.text)
        await self.assert_unchanged()

    async def test_patch_without_rules_preserves_existing_configuration(self):
        response = await self.request("PATCH", "/existing", json={"name": "Renamed"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((response.json()["name"], response.json()["rules"]), ("Renamed", ORIGINAL_RULES))
        async with self.sessions() as session:
            row = await session.get(am.ApprovalPolicy, "existing")
            self.assertEqual((row.name, row.rules), ("Renamed", ORIGINAL_RULES))

    async def test_superuser_can_rename_a_builtin_without_rewriting_its_rules(self):
        rules = approval_routing.default_rules("baseline")
        async with self.sessions() as session:
            row = await session.get(am.ApprovalPolicy, "system")
            row.rules = rules
            await session.commit()

        response = await self.request("PATCH", "/system", who="super", json={"name": "新的基线审批"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["name"], "新的基线审批")
        listed = await self.request("GET", who="super")
        self.assertEqual(listed.status_code, 200, listed.text)
        saved = next(item for item in listed.json()["items"] if item["id"] == "system")
        self.assertTrue(saved["isSystem"])
        self.assertEqual((saved["name"], saved["rules"]), ("新的基线审批", rules))

    async def test_invalid_rename_rejects_the_entire_patch_without_a_success_audit(self):
        for name in ("", "  ", None, ["invalid"]):
            for suffix, who in (("/system", "super"), ("/existing", "manager")):
                with self.subTest(name=name, suffix=suffix):
                    response = await self.request("PATCH", suffix, who=who, json={
                        "name": name, "key": "must-not-persist", "rules": {**ORIGINAL_RULES, "required": 3},
                    })
                    self.assertEqual(response.status_code, 400, response.text)
        await self.assert_unchanged()

    async def test_authentication_scope_and_duplicate_checks_keep_precedence(self):
        body = {"key": "changed", "name": "Changed", "rules": {**ORIGINAL_RULES, "actions": 5}}
        for method, suffix in (("POST", ""), ("PATCH", "/existing")):
            for who, expected in ((None, 401), ("reader", 403)):
                response = await self.request(method, suffix, who=who, json=body)
                self.assertEqual(response.status_code, expected, response.text)
        for suffix, expected in (("/system", 403), ("/other", 403), ("/missing", 404)):
            response = await self.request("PATCH", suffix, json=body)
            self.assertEqual(response.status_code, expected, response.text)
        for method, suffix, key in (("POST", "", "existing"), ("PATCH", "/existing", "peer")):
            response = await self.request(method, suffix, json={**body, "key": key})
            self.assertEqual(response.status_code, 409, response.text)
        await self.assert_unchanged()


class ApprovalActionContractTests(unittest.TestCase):
    def test_non_list_actions_raise_the_specific_validation_error(self):
        for value in (*INVALID_ACTIONS, 1.5, float("inf"), float("nan"), ("review",)):
            with self.subTest(value=value), self.assertRaises(approval_policies.InvalidApprovalActions) as caught:
                approval_policies._rules({**ORIGINAL_RULES, "actions": value})
            self.assertIn("rules.actions", str(caught.exception))

    def test_normalization_does_not_mutate_input_rules(self):
        raw = {**copy.deepcopy(ORIGINAL_RULES), "actions": [" REVIEW ", "review", "Deploy"]}
        before = copy.deepcopy(raw)
        normalized = approval_policies._rules(raw)
        self.assertEqual(normalized, {**ORIGINAL_RULES, "actions": ["review", "deploy"]})
        self.assertEqual(raw, before)


if __name__ == "__main__":
    unittest.main()
