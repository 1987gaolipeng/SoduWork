"""Target discovery uses real device authentication and a migrated isolated DB.

Only live Runner presence is simulated. No vendor process, service, credentials
or business database is used; these tests cover visibility and explanations.
"""
import unittest
from unittest.mock import patch, PropertyMock

from handoff_test_support import HandoffFixture
from sqlalchemy import select
from app import db, models
from app.automation_models import RunnerNode
from app.services.cluster_bus import bus


class TargetDiagnosticsTests(HandoffFixture, unittest.IsolatedAsyncioTestCase):
    async def test_current_device_offline_scope_and_get_is_read_only(self):
        local = self.live("current", client_id=self.client_id)
        self.live("private-colleague", client_id=self.colleague_id)
        self.live("private-foreign", client_id=self.foreign_client_id, org_id=self.foreign_org)
        self.live("shared-foreign", org_id=self.foreign_org)
        self.live("unassigned", org_id="")
        empty = await self.catalog()
        self.assertEqual(empty["targets"], [])
        self.assertEqual(empty["diagnostics"]["state"], "not_configured")
        self.assertEqual(empty["diagnostics"]["nodes"], [])
        async with db.SessionLocal() as session:
            session.add_all([
                RunnerNode(id=self.prefix + "-offline", org_id=self.org, owner_user_id=self.user_id,
                           host="cloud-worker", enroll_name="Team cloud"),
                RunnerNode(id=self.prefix + "-hidden-offline", org_id=self.foreign_org, host="PRIVATE-HOST"),
                RunnerNode(id=self.prefix + "-personal-offline", org_id=self.org, client_id=self.colleague_id,
                           host="PRIVATE-COLLEAGUE"),
            ])
            await session.commit()
            before = list((await session.execute(select(RunnerNode.id, RunnerNode.updated_at))).all())
        data = await self.catalog()
        self.assertEqual(data["diagnostics"]["state"], "unavailable")
        nodes = {n["runnerId"]: n for n in data["diagnostics"]["nodes"]}
        self.assertEqual(set(nodes), {self.prefix + "-offline"})
        self.assertEqual(nodes[self.prefix + "-offline"]["code"], "offline")
        self.assertEqual(nodes[self.prefix + "-offline"]["name"], "Team cloud")
        self.assertEqual(nodes[self.prefix + "-offline"]["action"], "check_connection")
        self.assertNotIn("PRIVATE", str(data))
        for node in nodes.values():
            self.assertEqual(set(node), {"runnerId", "name", "online", "code", "message", "action"})
        async with db.SessionLocal() as session:
            after = list((await session.execute(select(RunnerNode.id, RunnerNode.updated_at))).all())
        self.assertEqual(before, after, "GET must not insert/update live Runner records")
        # A durable row cannot expose a live identity after it was reassigned.
        self.live("offline", client_id=self.colleague_id)
        rebound = await self.catalog()
        self.assertEqual(rebound["diagnostics"]["nodes"], [])

    async def test_recovery_reasons_and_compatible_target_list(self):
        node = self.live("recoverable")
        node.skills_known = True
        node.skills = ["office", "browser-use"]
        await self.enroll_personal(node)
        cases = [
            ("caps", [], "update_required"),
            ("ready", False, "starting"),
            ("inventory_ready", False, "starting"),
            ("dispatch_mode", "draining", "paused"),
            ("dispatch_mode", "disabled", "paused"),
            ("work_root", "", "missing_workspace"),
            ("capabilities", {"available": ["files"]}, "missing_capabilities"),
            ("agents", [], "missing_agent"),
            ("agents", [{"key": "not-registered", "auth": "authed"}], "missing_agent"),
            ("agents", [{"key": "codex", "auth": "unauthed"}], "auth_required"),
        ]
        for attr, value, reason in cases:
            with self.subTest(reason=reason, attr=attr):
                previous = getattr(node, attr)
                setattr(node, attr, value)
                data = await self.catalog()
                self.assertEqual(data["targets"], [])
                self.assertEqual(data["diagnostics"]["nodes"][0]["code"], reason)
                self.assertEqual(data["diagnostics"]["state"], "unavailable")
                setattr(node, attr, previous)
        with patch.object(type(bus), "healthy", new_callable=PropertyMock, return_value=False):
            data = await self.catalog()
            self.assertEqual(data["targets"], [])
            self.assertEqual(data["diagnostics"]["nodes"][0]["code"], "service_unavailable")
        ready = await self.catalog()
        self.assertEqual(ready["diagnostics"]["state"], "ready")
        self.assertEqual(ready["diagnostics"]["nodes"][0]["code"], "ready")
        self.assertEqual([t["id"] for t in ready["targets"]], ["runner:" + node.id + ":codex"])
        self.assertEqual(ready["targets"][0]["agentId"], "codex")
        self.assertEqual(ready["targets"][0]["modelMode"], "account")
        self.assertTrue(ready["targets"][0]["skillsKnown"])
        self.assertEqual(ready["targets"][0]["skills"], ["browser-use", "office"])

    async def test_mobile_skill_inventory_uses_same_account_execution_scope(self):
        other = self.live("own-skill-pc", client_id=self.other_id)
        other.skills_known, other.skills = True, ["browser-use"]
        await self.enroll_personal(other)
        foreign = self.live("foreign-skill-pc", client_id=self.colleague_id)
        foreign.skills_known, foreign.skills = True, ["private-skill"]
        data = await self.catalog()
        self.assertEqual([row["runnerId"] for row in data["targets"]], [other.id])
        self.assertEqual(data["targets"][0]["skills"], ["browser-use"])
        self.assertNotIn("private-skill", str(data))

    async def test_admin_and_other_own_device_keep_personal_boundaries(self):
        self.live("current", client_id=self.client_id)
        other = self.live("other-owned", client_id=self.other_id)
        self.live("colleague", client_id=self.colleague_id)
        self.live("foreign-personal", client_id=self.foreign_client_id, org_id=self.foreign_org)
        shared = self.live("foreign-shared", org_id=self.foreign_org)
        before = await self.catalog()
        self.assertEqual(before["targets"], [])
        async with db.SessionLocal() as session:
            user = await session.get(models.User, self.user_id)
            user.is_super = True
            await session.commit()
        after = await self.catalog()
        self.assertEqual(after["targets"], [])
        self.assertEqual(after["diagnostics"]["nodes"], [])
        anonymous = await self.http.get("/api/v1/conversation-handoffs/targets", headers={"Authorization": ""})
        self.assertEqual(anonymous.status_code, 401)
        async with db.SessionLocal() as session:
            user = await session.get(models.User, self.user_id)
            user.is_active = False
            await session.commit()
        inactive = await self.http.get("/api/v1/conversation-handoffs/targets")
        self.assertIn(inactive.status_code, (401, 403))


if __name__ == "__main__":
    unittest.main()
