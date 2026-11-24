"""Monitor approval queues and mutations through scoped administrator HTTP routes."""
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import operations
from app.auth import sign_token
from app.db import Base, get_session
from app.services import deployments, workflow_engine


class OperationsApprovalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        now = datetime.now(timezone.utc)
        async with self.sessions() as s:
            for org in ("local", "remote"):
                s.add(models.OrgUnit(id=org, name=org))
            for role, perms in (("observer", ["operations.view"]), ("operator", ["operations.view", "release.approve"]),
                                ("reader", ["operations.view", "task.view"])):
                s.add(models.Role(id=role, name=role, permissions=perms))
            for uid in ("alice", "bob", "charlie", "reader", "observer", "outside"):
                s.add(models.User(id=uid, username=uid, display_name=uid,
                    role_id=uid if uid in ("reader", "observer") else "operator",
                    org_id="remote" if uid == "outside" else "local", is_active=True))
                s.add(models.Client(id=uid, user_ref=uid, auth_state="active"))
            for key, owner, action, hours in (("a", "alice", "baseline", 26),
                                              ("b", "alice", "review", 2),
                                              ("x", "outside", "deploy", 48)):
                task = models.Task(id="t"+key, title="Task "+key, created_by=owner,
                                   owner_client_id=owner, owner_user_id=owner)
                version = am.ArtifactVersion(id="v"+key, task_id=task.id, kind="requirement",
                    checksum="synthetic", manifest={"title": task.title, "description": "Scope",
                                                     "acceptanceCriteria": ["Confirmed"]})
                s.add_all([task, version, am.ApprovalRequest(id=key, action=action,
                    task_id=task.id, artifact_version_id=version.id, required_count=1,
                    created_at=now-timedelta(hours=hours),
                    policy_snapshot={"approvers": [{"type": "permission", "key": "release.approve"}]}),
                    am.ApprovalAssignment(request_id=key, user_id=owner, user_name=owner)])
            await s.commit()
        app = FastAPI()
        app.include_router(operations.router)

        async def database():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[get_session] = database
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def request(self, path, *, who="alice", body=None):
        return await self.http.request("GET" if body is None else "POST",
            "/api/v1/admin/operations/" + path, json=body,
            headers={"Authorization": "Bearer " + sign_token(who, 1)})

    async def test_queue_matches_scoped_card_and_displays_deadlines(self):
        first = await self.request("approvals?limit=1")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["total"], 2)
        item, = first.json()["items"]
        self.assertEqual((item["id"], item["taskTitle"], item["overdue"]), ("a", "Task a", True))
        self.assertEqual(item["assignees"][0]["userId"], "alice")
        self.assertTrue(item["canDecide"])
        second, = (await self.request("approvals?limit=1&offset=1")).json()["items"]
        self.assertFalse(second["overdue"])
        self.assertFalse(second["canTransfer"])
        self.assertEqual(second["id"], "b")
        work = (await self.request("overview")).json()["work"]
        self.assertEqual((work["pendingApprovals"], work["overdueApprovals"]), (2, 1))
        hidden = (await self.request("approvals", who="observer")).json()
        self.assertEqual(hidden["total"], 2)
        for row in hidden["items"]:
            self.assertFalse(any(row[k] for k in ("canViewDetails", "canWithdraw", "canTransfer", "canDecide",
                                                   "taskTitle", "taskId", "assignees", "artifactVersionId")))

    async def test_transfer_cannot_escape_scope_or_bypass_review_and_votes(self):
        options = (await self.request("approvals/a/transfer-options?fromUserId=alice")).json()
        self.assertEqual({x["userId"] for x in options["items"]}, {"bob", "charlie"})
        body = {"fromUserId": "alice", "toUserId": "bob", "note": "Cover this gate"}
        for approval, target, who, expected in (("a", "outside", "alice", 409),
                ("b", "bob", "alice", 409), ("a", "bob", "reader", 403), ("a", "bob", "charlie", 403),
                ("x", "bob", "alice", 403)):
            res = await self.request("approvals/"+approval+"/transfer", who=who,
                                     body={**body, "toUserId": target})
            self.assertEqual(res.status_code, expected, res.text)
        res = await self.request("approvals/a/transfer", body=body)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual((await self.request("approvals/a/transfer", body=body)).status_code, 409)
        self.assertEqual((await self.request("approvals/a/withdraw", who="bob", body={"note":"cancel"})).status_code, 403)
        reject = {"decision": "reject", "note": "Please clarify the scope"}
        self.assertEqual((await self.request("approvals/a/decision", body=reject)).status_code, 403)
        res = await self.request("approvals/a/decision", who="bob", body=reject)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual((await self.request("approvals/a/withdraw", body={"note":"late"})).status_code, 409)
        async with self.sessions() as s:
            self.assertEqual((await s.get(am.ApprovalRequest, "a")).status, "rejected")
            rows = (await s.scalars(select(models.AuditLog))).all()
            self.assertEqual([(r.actor_id, r.target_id) for r in rows], [("alice", "a"), ("bob", "a")])

    async def assert_withdrawal_stops_workflow(self, node_type, request_id):
        async with self.sessions() as s:
            request = await s.get(am.ApprovalRequest, request_id)
            version = am.PluginVersion(id="workflow", plugin_id="plugin", version="1", checksum="fixed",
                workflow={"nodes": [{"key": "implement", "type": "ai"},
                    {"key": "gate", "type": node_type, "dependsOn": ["implement"],
                     "retry": {"maxAttempts": 3},
                     "config": {"onReject": {"retryFrom": "implement"}, "onFailure": {"retryFrom": "implement"}}}]})
            run = am.WorkflowRun(id="run", task_id=request.task_id, plugin_id="plugin",
                                 plugin_version_id=version.id, state="running")
            previous = am.NodeRun(run_id=run.id, node_key="implement", node_type="ai",
                                  state="succeeded", idempotency_key="implement")
            gate = am.NodeRun(id="gate", run_id=run.id, node_key="gate", node_type=node_type,
                              state="waiting_human", output={"requestId": request.id}, idempotency_key="gate")
            s.add_all([version, run, previous, gate])
            await s.commit()
        response = await self.request(f"approvals/{request_id}/withdraw", body={"note": "Release on hold"})
        self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as s:
            run = await s.get(am.WorkflowRun, "run")
            gate = await s.get(am.NodeRun, "gate")
            await workflow_engine._poll_node(s, run, gate)
            await workflow_engine._schedule_locked(s, run.id)
            self.assertEqual(run.state, "failed")
            self.assertIn("撤回", run.error)
            self.assertEqual(gate.output["failureKind"], "escalation")
            self.assertFalse(run.context.get("reworkRounds"))
            nodes = (await s.scalars(select(am.NodeRun).order_by(am.NodeRun.node_key))).all()
            self.assertEqual([(n.node_key, n.state) for n in nodes], [("gate", "failed"), ("implement", "succeeded")])
            self.assertIsNone(await s.scalar(select(am.WorkflowOutbox.id)))
            self.assertIsNone(await s.scalar(select(am.ApprovalDecision.id)))

    async def test_withdraw_stops_human_gate_without_retrying_implementation(self):
        await self.assert_withdrawal_stops_workflow("human_review", "b")

    async def test_withdraw_stops_deploy_chain_waiting_for_uat(self):
        async with self.sessions() as s:
            task = await s.get(models.Task, "ta")
            task.repo_id = "repo"
            request = await s.get(am.ApprovalRequest, "a")
            request.action, request.environment_id = "uat", "environment"
            artifact = await s.get(am.ArtifactVersion, "va")
            artifact.kind, artifact.state = "code", "tested"
            s.add_all([models.Repo(id="repo", project_id="project", name="Repo"),
                am.Environment(id="environment", key="stage", name="Stage",
                    promotion_policy={"requiresAcceptance": True, "marksDelivery": True}),
                am.DeploymentTarget(id="target", repo_id="repo", environment_id="environment", name="Target"),
                am.DeploymentRun(task_id=task.id, artifact_version_id=artifact.id, target_id="target",
                                 environment_id="environment", state="succeeded", idempotency_key="deployment")])
            await s.commit()
        with patch.object(deployments.environment_service, "preflight_chain", AsyncMock(return_value={"ok": True})):
            await self.assert_withdrawal_stops_workflow("deploy_chain", "a")
            async with self.sessions() as s:
                status = await deployments.chain_status(s, await s.get(models.Task, "ta"))
                self.assertFalse(status["complete"])
                self.assertEqual(status["environments"][0]["acceptance"], "cancelled")
                self.assertEqual(status["runs"][0]["state"], "succeeded")

    async def test_withdraw_leaves_history_and_cannot_vote_on_reissued_request(self):
        self.assertEqual((await self.request("approvals/a/withdraw", body={"note": "Revising"})).status_code, 200)
        async with self.sessions() as s:
            old = await s.get(am.ApprovalRequest, "a")
            self.assertEqual(old.status, "cancelled")
            s.add(am.ApprovalRequest(id="replacement", task_id="ta", action="baseline",
                                     artifact_version_id="va", required_count=1, created_at=old.created_at))
            s.add(am.ApprovalAssignment(request_id="replacement", user_id="alice", user_name="Alice"))
            await s.commit()
        res = await self.request("approvals/a/decision", body={"decision":"approve"})
        self.assertEqual(res.status_code, 409, res.text)
        async with self.sessions() as s:
            self.assertEqual((await s.get(am.ApprovalRequest, "replacement")).status, "pending")
        res = await self.request("approvals/replacement/decision", body={"decision":"approve"})
        self.assertEqual(res.status_code, 200, res.text)

    async def test_gate_specific_permission_follows_assignment_through_transfer(self):
        async with self.sessions() as session:
            session.add(models.Role(id="merger", name="Merge only", permissions=["operations.view", "delivery.merge"]))
            for uid in ("alice", "bob"):
                (await session.get(models.User, uid)).role_id = "merger"
            for rid in ("a", "x"):
                request = await session.get(am.ApprovalRequest, rid)
                request.action = "merge"
                request.policy_snapshot = {"approvers": [{"type": "permission", "key": "delivery.merge"}]}
            await session.commit()
        async def queue_for(uid):
            return {item["id"]: item for item in (await self.request("approvals", who=uid)).json()["items"]}

        rows = await queue_for("alice")
        self.assertEqual(set(rows), {"a", "b"})
        self.assertTrue(all(rows["a"][key] for key in ("canViewDetails", "canDecide", "canTransfer", "canWithdraw")))
        self.assertFalse(any(rows["b"][key] for key in ("canViewDetails", "canDecide", "canWithdraw", "assignees")))
        reject = {"decision": "reject", "note": "Needs revision"}
        self.assertEqual((await self.request("approvals/b/decision", body=reject)).status_code, 403)
        self.assertEqual((await self.request("approvals/b/withdraw", body={"note": "retry"})).status_code, 403)
        self.assertEqual((await self.request("approvals/x/decision", body=reject)).status_code, 403)
        other = (await queue_for("bob"))["a"]
        self.assertFalse(any(other[key] for key in ("taskTitle", "assignees", "canViewDetails", "canDecide")))
        self.assertEqual((await self.request("approvals/a/decision", who="bob", body=reject)).status_code, 403)
        transfer = {"fromUserId": "alice", "toUserId": "bob", "note": "Please review"}
        result = await self.request("approvals/a/transfer", body=transfer)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertTrue((await queue_for("bob"))["a"]["canDecide"])
        result = await self.request("approvals/a/decision", who="bob", body=reject)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["status"], "rejected")

    async def test_partial_vote_and_quorum_survive_transfer(self):
        async with self.sessions() as s:
            req = await s.get(am.ApprovalRequest, "a")
            req.required_count = 3
            s.add_all([am.ApprovalAssignment(request_id="a", user_id=uid, user_name=uid)
                       for uid in ("bob", "charlie")])
            s.add(am.ApprovalDecision(request_id="a", decision="approve", user_id="charlie",
                                      user_name="charlie"))
            await s.commit()
        item = (await self.request("approvals", who="bob")).json()["items"][0]
        self.assertEqual([r["userId"] for r in item["assignees"]], ["alice", "bob"])
        self.assertEqual([r["userId"] for r in item["assignees"] if r["canTransfer"]], ["bob"])
        for target in ("alice", "charlie"):
            res = await self.request("approvals/a/transfer", who="bob", body={
                "fromUserId":"bob", "toUserId":target, "note":"Attempt transfer"})
            self.assertEqual(res.status_code, 409, res.text)
        res = await self.request("approvals/a/decision", body={"decision":"approve"})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["status"], "pending")
        res = await self.request("approvals/a/decision", who="bob", body={"decision":"approve"})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["status"], "approved")


if __name__ == "__main__":
    unittest.main()
