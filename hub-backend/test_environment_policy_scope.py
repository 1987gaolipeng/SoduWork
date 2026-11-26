"""Environment gate policy ownership for new configuration and existing stored references."""
import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.db import Base
from app.services import deployments, environment_service, project_setup, release_control


class EnvironmentPolicyScopeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        tables = [model.__table__ for model in (
            am.Environment, am.ApprovalPolicy, am.ApprovalRequest, am.DeploymentTarget, models.Client,
            models.Repo,
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

    async def test_decision_targets_require_visible_environment_and_active_repo_binding(self):
        self.db.add(models.Repo(id="repo", project_id="project", name="Repo", org_id="org-a"))
        task = models.Task(repo_id="repo")
        for key, org, repo, env_enabled, target_enabled, expected in (
            ("own", "org-a", "repo", True, True, True),
            ("shared", None, "repo", True, True, True),
            ("out-of-scope", "org-b", "repo", True, True, False),
            ("other-repo", "org-a", "another", True, True, False),
            ("inactive-env", "org-a", "repo", False, True, False),
            ("inactive-target", "org-a", "repo", True, False, False),
        ):
            with self.subTest(environment=key):
                self.db.add(am.Environment(id=key, key=key, name=key, org_id=org, enabled=env_enabled))
                self.db.add(am.DeploymentTarget(repo_id=repo, environment_id=key, name=key,
                                                enabled=target_enabled))
                await self.db.flush()
                self.assertEqual(await deployments.has_targets(self.db, task, environment_id=key), expected)
        for key in ("", "missing"):
            self.assertFalse(await deployments.has_targets(self.db, task, environment_id=key))
        self.assertFalse(await deployments.has_targets(self.db, models.Task(), environment_id="shared"))

    async def test_unavailable_decision_environment_stops_before_approval_processing(self):
        from app.api import approvals, release

        task = models.Task(id="task")
        with patch.object(deployments, "has_targets", new_callable=AsyncMock, return_value=False) as scope:
            for request_id in ("", "existing"):
                with self.subTest(request_id=request_id):
                    result = await release_control.decide(self.db, task, None, action="deploy",
                                                          decision="approve", environment_id="env",
                                                          request_id=request_id)
                    self.assertEqual(result["reason"], "invalid_environment")
                    for api in (approvals, release):
                        error = api._decision_error(result)
                        self.assertEqual(error.status_code, 409)
                        self.assertEqual(error.headers, {"X-Error-Code": "hub.input.release_environment"})
                        self.assertEqual(error.detail, result["detail"])
                    scope.assert_awaited_with(self.db, task, environment_id="env")
        self.assertEqual(await self.db.scalar(select(func.count(am.ApprovalRequest.id))), 0)

    async def test_release_api_forwards_selected_approval_and_environment_together(self):
        from app.api import release

        task = models.Task(id="task", title="Fixture")
        actor = models.User(id="reviewer")
        approval = am.ApprovalRequest(id="selected", task_id=task.id, action="deploy",
                                      artifact_version_id="version", environment_id="preview")
        self.db.add(approval)
        with patch.object(release, "task_or_404", new_callable=AsyncMock, return_value=task), \
                patch.object(release_control, "decide", new_callable=AsyncMock,
                             return_value={"ok": True}) as decide, \
                patch.object(release.audit, "log", new_callable=AsyncMock):
            await release.decide(task.id, {"action": "deploy", "decision": "approve",
                                           "requestId": approval.id, "environmentId": "preview"},
                                 actor, self.db)
        self.assertEqual(decide.await_args.kwargs["request_id"], approval.id)
        self.assertEqual(decide.await_args.kwargs["environment_id"], "preview")

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
