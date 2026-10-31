"""Admin fleet governance and desktop personal isolation with real auth and DB.

Runner presence is simulated; these cases do not start commercial models,
read actual credentials or connect to the user's running services.
"""
import unittest
from unittest.mock import patch

from sqlalchemy import delete, select

from test_handoff_target_diagnostics import TargetDiagnosticsTests as Base
from app import auth, db, models
from app.api import cloud_environments, runner_ws
from app.automation_models import ExecutionSession, RunnerNode
from app.services import runner_enroll, runner_hub, runner_registry


class CloudAdminGovernanceTests(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.app.include_router(runner_ws.router)
        self.app.include_router(cloud_environments.router)
        self.admin_headers = {"Authorization": "Bearer " + auth.sign_token(self.user_id)}

    async def asyncTearDown(self):
        # Enrollment generates its own ids, so the base's prefix cleanup alone
        # cannot remove these isolated nodes between inherited super-user tests.
        async with db.SessionLocal() as session:
            await session.execute(delete(RunnerNode).where(RunnerNode.org_id == self.org))
            await session.commit()
        await super().asyncTearDown()

    async def grant_manager(self):
        async with db.SessionLocal() as session:
            role = models.Role(id=self.prefix + "-role", name="Cloud manager", permissions=["runner.manage"])
            session.add(role)
            user = await session.get(models.User, self.user_id)
            user.role_id = role.id
            await session.commit()

    async def test_multiserver_lifecycle_permissions_and_audit(self):
        endpoint = "/api/v1/admin/runners"
        body = {"host": "Cloud A", "orgId": self.org, "hub": "https://soduwork.example.test"}
        denied = await self.http.post(endpoint + "/enroll", headers=self.admin_headers, json=body)
        self.assertEqual(denied.status_code, 403, denied.text)
        await self.grant_manager()
        foreign = await self.http.post(endpoint + "/enroll", headers=self.admin_headers,
                                       json={**body, "orgId": self.foreign_org})
        self.assertEqual(foreign.status_code, 403, foreign.text)
        created = []
        for name in ("Cloud A", "Cloud B"):
            reply = await self.http.post(endpoint + "/enroll", headers=self.admin_headers,
                                        json={**body, "host": name})
            self.assertEqual(reply.status_code, 200, reply.text)
            created.append(reply.json())
        first, second = created
        rid = first["runnerId"]
        self.assertNotEqual(rid, second["runnerId"])
        admin_list = await self.http.get(endpoint, headers=self.admin_headers)
        self.assertEqual(admin_list.status_code, 200, admin_list.text)
        desktop = await self.http.get("/api/v1/cloud-environments")
        self.assertEqual({r["runnerId"] for r in admin_list.json()["items"]},
                         {first["runnerId"], second["runnerId"]})
        self.assertEqual(desktop.status_code, 200, desktop.text)
        self.assertEqual(desktop.json()["ownership"], "personal")
        self.assertEqual(desktop.json()["environments"], [],
                         "shared fleet nodes must stay out of the personal desktop API")
        for item in created:
            self.assertNotIn(item["key"], admin_list.text)
            self.assertNotIn(item["key"], desktop.text)
        live = self.live("live")
        runner_hub._RUNNERS.pop(live.id)
        live.id = rid
        runner_hub._RUNNERS[rid] = live
        for mode in ("draining", "accepting", "disabled"):
            changed = await self.http.post(endpoint + "/" + rid + "/mode", headers=self.admin_headers,
                                          json={"mode": mode})
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertEqual(live.dispatch_mode, mode)
            listing = await self.http.get(endpoint, headers=self.admin_headers)
            self.assertEqual(listing.status_code, 200, listing.text)
            item = next(r for r in listing.json()["items"] if r["runnerId"] == rid)
            self.assertEqual(item["mode"], mode)
            self.assertEqual(item["accepting"], mode == "accepting")
            personal_listing = await self.http.get("/api/v1/cloud-environments")
            self.assertEqual(personal_listing.json()["environments"], [])
        denied_change = await self.http.patch("/api/v1/cloud-environments/" + rid,
                                              json={"mode": "accepting"})
        self.assertEqual(denied_change.status_code, 404, denied_change.text)
        self.assertEqual(live.dispatch_mode, "disabled")
        resumed = await self.http.post(endpoint + "/" + rid + "/mode", headers=self.admin_headers,
                                       json={"mode": "accepting"})
        self.assertEqual(resumed.status_code, 200, resumed.text)
        self.assertEqual(live.dispatch_mode, "accepting")
        personal = await self.http.post("/api/v1/cloud-environments",
            json={"name": "My cloud", "hub": "https://hub.example.test"})
        self.assertEqual(personal.status_code, 200, personal.text)
        personal_id = personal.json()["environment"]["id"]
        configured = await self.http.patch("/api/v1/cloud-environments/" + personal_id,
                                            json={"name": "My renamed cloud"})
        self.assertEqual(configured.status_code, 200, configured.text)
        self.assertEqual(configured.json()["environment"]["name"], "My renamed cloud")
        personal_listing = await self.http.get("/api/v1/cloud-environments")
        self.assertEqual([row["id"] for row in personal_listing.json()["environments"]], [personal_id])
        self.assertNotIn(personal.json()["setup"]["key"], personal_listing.text)
        async with db.SessionLocal() as session:
            audits = list((await session.scalars(select(models.AuditLog).where(
                models.AuditLog.actor_id == self.user_id))).all())
            self.assertIn("runner.enroll", {r.action for r in audits})
            self.assertIn("runner.mode", {r.action for r in audits})
            self.assertIn("runner.configure", {r.action for r in audits})
            for item in created:
                self.assertNotIn(item["key"], str([r.detail for r in audits]))

    async def test_admin_delete_preserves_unfinished_sessions_and_completed_history(self):
        await self.grant_manager()
        rid, sid = self.prefix + "-offline", self.prefix + "-session"
        async with db.SessionLocal() as session:
            session.add(RunnerNode(id=rid, org_id=self.org, enroll_name="Temporarily offline"))
            session.add(ExecutionSession(id=sid, ref=sid, task_id=self.prefix + "-task",
                                         runner_id=rid, state="running"))
            await session.commit()
        endpoint = "/api/v1/admin/runners/" + rid
        for state in runner_registry._ACTIVE_SESSION:
            async with db.SessionLocal() as session:
                (await session.get(ExecutionSession, sid)).state = state
                await session.commit()
            reply = await self.http.delete(endpoint, headers=self.admin_headers)
            self.assertEqual(reply.status_code, 409, (state, reply.text))
            self.assertIn("未结束", reply.text)
        async with db.SessionLocal() as session:
            (await session.get(ExecutionSession, sid)).state = "done"
            await session.commit()
        deleted = await self.http.delete(endpoint, headers=self.admin_headers)
        self.assertEqual(deleted.status_code, 200, deleted.text)
        async with db.SessionLocal() as session:
            self.assertIsNone(await session.get(RunnerNode, rid))
            self.assertIsNotNone(await session.get(ExecutionSession, sid))

    async def test_independent_credentials_cannot_replace_personal_device_identity(self):
        await self.grant_manager()
        for suffix, client_id, tags in (
            ("personal", self.client_id, []),
            ("tagged", "", [runner_hub.CLIENT_TAG]),
        ):
            rid = self.prefix + "-" + suffix
            async with db.SessionLocal() as session:
                session.add(RunnerNode(id=rid, org_id=self.org, client_id=client_id, tags=tags,
                                       enroll_name="Keep personal identity"))
                await session.commit()
            for endpoint, body in (
                ("/api/v1/admin/runners/enroll", {"runnerId": rid, "orgId": self.org}),
                ("/api/v1/admin/runners/" + rid + "/issue-key", {"orgId": self.org}),
            ):
                reply = await self.http.post(endpoint, headers=self.admin_headers, json=body)
                self.assertEqual(reply.status_code, 422, reply.text)
            async with db.SessionLocal() as session:
                row = await session.get(RunnerNode, rid)
                self.assertFalse(row.secret_hash)
                self.assertEqual(row.client_id, client_id)
                self.assertEqual(row.enroll_name, "Keep personal identity")

    async def test_shared_key_rotation_revokes_old_key_and_foreign_management_is_denied(self):
        await self.grant_manager()
        rid = self.prefix + "-shared"
        async with db.SessionLocal() as session:
            old = await runner_registry.issue_key(session, rid, org_id=self.org)
            session.add(RunnerNode(id=self.prefix + "-foreign", org_id=self.foreign_org))
            await session.commit()
        reply = await self.http.post("/api/v1/admin/runners/" + rid + "/issue-key",
                                     headers=self.admin_headers, json={"orgId": self.org})
        self.assertEqual(reply.status_code, 200, reply.text)
        new = reply.json()["key"]
        async with db.SessionLocal() as session:
            self.assertFalse(await runner_registry.verify_key(session, rid, old))
            self.assertTrue(await runner_registry.verify_key(session, rid, new))
        endpoint = "/api/v1/admin/runners/" + self.prefix + "-foreign"
        for suffix in ("/issue-key", "/mode", "/probe"):
            response = await self.http.post(endpoint + suffix, headers=self.admin_headers, json={"mode": "disabled"})
            self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual((await self.http.delete(endpoint, headers=self.admin_headers)).status_code, 404)

    async def test_invalid_install_addresses_fail_before_rotating_credentials(self):
        await self.grant_manager()
        rid = self.prefix + "-address"
        async with db.SessionLocal() as session:
            old = await runner_registry.issue_key(session, rid, org_id=self.org)
            await session.commit()
        for hub in ("https://good.test/$(whoami)", "https://good.test/&whoami",
                    "https://good.test/`whoami`", "https://good.test/%26whoami",
                    "https://user:secret@good.test", "https://good.test?q=x",
                    "https://good.test/\"broken", "https://good.test\nwhoami",
                    "file:///tmp/a", "http://good.test:99999"):
            reply = await self.http.post("/api/v1/admin/runners/enroll", headers=self.admin_headers,
                json={"runnerId": rid, "orgId": self.org, "hub": hub})
            self.assertEqual(reply.status_code, 422, reply.text)
            async with db.SessionLocal() as session:
                self.assertTrue(await runner_registry.verify_key(session, rid, old))
        self.assertEqual(runner_enroll.hub_url("soduwork.example.test:9080"), "http://soduwork.example.test:9080")
        self.assertEqual(runner_enroll.hub_url("wss://soduwork.example.test/hub"), "https://soduwork.example.test/hub")
        self.assertEqual(runner_enroll.hub_url("https://[2001:db8::1]:9443/hub"), "https://[2001:db8::1]:9443/hub")
        with patch.object(runner_enroll, "_lan_ip", return_value="192.0.2.20"):
            for local in ("http://[::]:9080", "http://[::1]:9080", "http://127.0.0.2:9080"):
                self.assertEqual(runner_enroll.hub_url(local), "http://192.0.2.20:9080")


if __name__ == "__main__":
    unittest.main()
