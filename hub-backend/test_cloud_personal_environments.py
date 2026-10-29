"""Contract tests for per-user cloud Runner environments.

These intentionally use the real authenticated HTTP routes and SQLite schema,
but never start a Runner process or contact an external model/service.
"""
import unittest
import uuid
import httpx
from unittest.mock import patch
from test_handoff_target_diagnostics import WORK
from app import db, models
from app.api import cloud_environments as cloud_api
from app.automation_models import RunnerNode
from app.services import device_auth, runner_hub, runner_registry


class PersonalCloudEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await db.init_db()
        self.prefix = uuid.uuid4().hex[:12]
        self.org = self.prefix + "-org"
        self.foreign_org = self.prefix + "-foreign"
        self.user_id = self.prefix + "-owner"
        self.client_id = self.prefix + "-desktop"
        self.foreign_client_id = self.prefix + "-foreign-device"
        async with db.SessionLocal() as session:
            session.add_all([
                models.OrgUnit(id=self.org, name="Target test team"),
                models.OrgUnit(id=self.foreign_org, name="Other test organization"),
                models.User(id=self.user_id, username=self.user_id, org_id=self.org, is_active=True),
                models.User(id=self.prefix + "-foreign-owner", username=self.prefix + "-foreign-owner",
                            org_id=self.foreign_org, is_active=True),
                models.Client(id=self.client_id, user_ref=self.user_id, auth_state="active"),
                models.Client(id=self.foreign_client_id, user_ref=self.prefix + "-foreign-owner",
                              auth_state="active"),
            ])
            await session.commit()
        async with db.SessionLocal() as session:
            client = await session.get(models.Client, self.client_id)
            token = device_auth.issue_session(client)[0]
        from fastapi import FastAPI
        self.app = FastAPI()
        self.app.include_router(cloud_api.router)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://isolated",
                                      headers={"Authorization": "Device " + token})
        runner_hub._RUNNERS.clear()

    async def asyncTearDown(self):
        runner_hub._RUNNERS.clear()
        await self.http.aclose()
        async with db.SessionLocal() as session:
            from sqlalchemy import delete
            await session.execute(delete(RunnerNode).where(RunnerNode.id.startswith(self.prefix)))
            await session.commit()
        await db.engine.dispose()

    def live(self, name, *, client_id="", org_id=None):
        rid = self.prefix + "-" + name
        node = runner_hub._Runner(None, {
            "runnerId": rid, "host": name, "workRoot": str(WORK / "remote-work"),
            "agents": [{"key": "codex", "auth": "authed"}], "caps": ["handoff1"],
            "capabilities": {"available": ["files", "terminal"]},
        })
        node.client_id, node.org_id = client_id, self.org if org_id is None else org_id
        node.ready, node.inventory_ready, node.dispatch_mode = True, True, "accepting"
        node.alive = lambda: True
        runner_hub._RUNNERS[rid] = node
        return node

    async def test_personal_create_list_rotate_and_one_per_user(self):
        endpoint = "/api/v1/cloud-environments"
        body = {"name": "我的云端执行机", "hub": "https://soduwork.example.test/hub",
                "workRoot": "C:\\soduwork-work"}
        created = await self.http.post(endpoint, json=body)
        self.assertEqual(created.status_code, 200, created.text)
        result = created.json()
        rid, key = result["environment"]["id"], result["setup"]["key"]
        self.assertEqual(result["environment"]["ownerUserId"], self.user_id)
        self.assertEqual(result["environment"]["workRoot"], body["workRoot"])
        self.assertTrue(result["environment"]["credential"]["configured"])
        self.assertTrue(await self._verify(rid, key))
        self.assertEqual((await self.http.post(endpoint, json=body)).status_code, 409)
        self.assertEqual((await self.http.post(endpoint, json={**body, "orgId": self.foreign_org})).status_code, 422)

        listing = await self.http.get(endpoint)
        self.assertEqual(listing.status_code, 200, listing.text)
        payload = listing.json()
        self.assertEqual(payload["ownership"], "personal")
        self.assertFalse(payload["permissions"]["canCreate"])
        self.assertEqual([row["id"] for row in payload["environments"]], [rid])
        self.assertNotIn(key, listing.text)
        self.assertNotIn("secret_hash", listing.text)

        rotated = await self.http.post(endpoint + "/" + rid + "/credentials", json={})
        self.assertEqual(rotated.status_code, 200, rotated.text)
        new_key = rotated.json()["setup"]["key"]
        self.assertNotEqual(key, new_key)
        self.assertFalse(await self._verify(rid, key))
        self.assertTrue(await self._verify(rid, new_key))

    async def test_owner_isolation_and_online_rotation_guard(self):
        endpoint = "/api/v1/cloud-environments"
        created = await self.http.post(endpoint, json={"name": "Only mine",
            "hub": "https://soduwork.example.test/hub"})
        self.assertEqual(created.status_code, 200, created.text)
        rid = created.json()["environment"]["id"]

        # A second authenticated device for another user cannot observe or
        # mutate the personal row.
        async with db.SessionLocal() as session:
            foreign = await session.get(models.Client, self.foreign_client_id)
            token = device_auth.issue_session(foreign)[0]
        import httpx
        other = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                  base_url="http://isolated",
                                  headers={"Authorization": "Device " + token})
        try:
            self.assertEqual((await other.get(endpoint)).json()["environments"], [])
            self.assertEqual((await other.patch(endpoint + "/" + rid, json={"name": "x"})).status_code, 404)
            self.assertEqual((await other.post(endpoint + "/" + rid + "/credentials", json={})).status_code, 404)
            self.assertEqual((await other.delete(endpoint + "/" + rid)).status_code, 404)
        finally:
            await other.aclose()

        # Reusing the same durable id while the machine is connected is
        # rejected; the previous key remains the only valid credential.
        live = self.live("online")
        runner_hub._RUNNERS.pop(live.id)
        live.id = rid
        runner_hub._RUNNERS[rid] = live
        try:
            blocked = await self.http.post(endpoint + "/" + rid + "/credentials", json={})
            self.assertEqual(blocked.status_code, 409, blocked.text)
        finally:
            runner_hub._RUNNERS.pop(rid, None)

    async def test_handoff_targets_only_owned_personal_runner(self):
        personal = self.live("personal")
        personal.owner_user_id = self.user_id
        shared = self.live("shared")
        foreign = self.live("foreign")
        async with db.SessionLocal() as session:
            session.add_all([
                RunnerNode(id=personal.id, owner_user_id=self.user_id, org_id=self.org),
                RunnerNode(id=shared.id, org_id=self.org),
                RunnerNode(id=foreign.id, owner_user_id=self.prefix + "-foreign-owner",
                           org_id=self.foreign_org),
            ])
            await session.commit()
        from app.api import conversation_handoffs as handoff_api
        self.app.include_router(handoff_api.router)
        with patch("app.services.conversation_handoffs.cloud_runner_allowed", return_value=True):
            reply = await self.http.get("/api/v1/conversation-handoffs/targets")
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual([row["runnerId"] for row in reply.json()["targets"]], [personal.id])
        self.assertNotIn(shared.id, reply.text)
        self.assertNotIn(foreign.id, reply.text)

    async def test_delete_evicts_idle_online_runner_without_waiting(self):
        endpoint = "/api/v1/cloud-environments"
        created = await self.http.post(endpoint, json={"name": "Fast removal",
            "hub": "https://soduwork.example.test/hub"})
        self.assertEqual(created.status_code, 200, created.text)
        rid, key = created.json()["environment"]["id"], created.json()["setup"]["key"]
        live = self.live("online")
        live.id = rid
        live.owner_user_id = self.user_id
        runner_hub._RUNNERS[rid] = live
        removed = await self.http.delete(endpoint + "/" + rid)
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertNotIn(rid, runner_hub._RUNNERS)
        self.assertFalse(await self._verify(rid, key))
        self.assertEqual((await self.http.get(endpoint)).json()["environments"], [])

    async def _verify(self, rid, key):
        async with db.SessionLocal() as session:
            return await runner_registry.verify_key(session, rid, key)


if __name__ == "__main__":
    unittest.main()
