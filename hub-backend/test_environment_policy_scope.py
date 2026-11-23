"""Environment gate policy ownership for new configuration and existing stored references."""
import unittest

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.db import Base
from app.services import environment_service, project_setup, release_control


class EnvironmentPolicyScopeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        tables = [model.__table__ for model in (
            am.Environment, am.ApprovalPolicy, am.ApprovalRequest, am.DeploymentTarget, models.Client,
        )]
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        self.db = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.addAsyncCleanup(self.engine.dispose)
        self.addAsyncCleanup(self.db.close)
        self.db.add_all([
            am.ApprovalPolicy(id=key, key=key, name=key, org_id=org)
            for key, org in (("shared", None), ("own", "org-a"), ("other", "org-b"))
        ])
        await self.db.commit()

    async def test_owned_and_global_policies_can_be_set_swapped_and_cleared(self):
        env = await environment_service.save_environment(self.db, {
            "orgId": "org-a", "key": "dev", "approvalPolicyId": "own", "acceptancePolicyId": "shared",
        })
        self.assertEqual((env.approval_policy_id, env.acceptance_policy_id), ("own", "shared"))
        await environment_service.save_environment(self.db, {
            "approvalPolicyId": "shared", "acceptancePolicyId": "own", "orgId": "org-b",
        }, env)
        self.assertEqual((env.org_id, env.approval_policy_id, env.acceptance_policy_id),
                         ("org-a", "shared", "own"))
        await environment_service.save_environment(self.db, {"acceptancePolicyId": None}, env)
        self.assertEqual((env.approval_policy_id, env.acceptance_policy_id), ("shared", ""))

    async def test_both_fields_enforce_ownership_on_create_and_update(self):
        for org in ("org-a", None):
            for field in ("approvalPolicyId", "acceptancePolicyId"):
                with self.subTest(org=org, field=field):
                    with self.assertRaisesRegex(ValueError, "不存在或不属于"):
                        await environment_service.save_environment(self.db, {
                            "key": "invalid-create", "orgId": org, field: "other",
                        })
                    await self.db.rollback()
                    env = await environment_service.save_environment(self.db, {
                        "key": "env-" + field.lower(), "orgId": org,
                        "approvalPolicyId": "shared", "acceptancePolicyId": "shared",
                    })
                    env_id = env.id
                    with self.assertRaisesRegex(ValueError, "不存在或不属于"):
                        await environment_service.save_environment(self.db, {
                            field: "other", "orgId": "org-b", "name": "Rejected edit",
                        }, env)
                    await self.db.rollback()
                    env = await self.db.get(am.Environment, env_id)
                    self.assertEqual((env.name, env.approval_policy_id, env.acceptance_policy_id),
                                     (env.key, "shared", "shared"))

    async def test_legacy_references_block_new_gates_and_previews_until_repaired(self):
        env = am.Environment(id="legacy", key="legacy", name="Legacy", org_id="org-a",
                             approval_policy_id="other", acceptance_policy_id="other",
                             promotion_policy={"requiresApproval": True, "requiresAcceptance": True})
        self.db.add_all([env, am.DeploymentTarget(repo_id="repo", environment_id="legacy", name="Test")])
        await self.db.commit()
        project = models.Project(id="project", name="Project")
        task = models.Task(id="task", title="Fixture")
        artifact = am.ArtifactVersion(id="version")
        plan = await project_setup._approval_plan(self.db, project, models.User(id="owner"),
                                                  [models.Repo(id="repo")], {})
        self.assertEqual({gate["action"] for gate in plan}, {"deploy", "uat"})
        for gate in plan:
            self.assertFalse(gate["ok"])
            self.assertEqual((gate["policyName"], gate["candidates"]), ("", []))
        for action in ("deploy", "uat"):
            with self.assertRaisesRegex(ValueError, "不存在或不属于"):
                await release_control.ensure_request(self.db, task, artifact, action, env.id)
        self.assertEqual(await self.db.scalar(select(func.count(am.ApprovalRequest.id))), 0)
        with self.assertRaises(ValueError):
            await environment_service.save_environment(self.db, {"name": "Incomplete repair"}, env)
        await self.db.rollback()
        env = await self.db.get(am.Environment, "legacy")
        await environment_service.save_environment(self.db, {
            "approvalPolicyId": "own", "acceptancePolicyId": "",
        }, env)
        self.assertEqual((env.approval_policy_id, env.acceptance_policy_id), ("own", ""))


if __name__ == "__main__":
    unittest.main()
