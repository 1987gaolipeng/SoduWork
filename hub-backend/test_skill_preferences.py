"""Skill defaults through real authenticated API + isolated database; no live data."""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""

import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from app import models
from app.api import config
from app.services import skill_preferences, skills
from skill_test_support import fixture


class PreferenceContract(unittest.TestCase):
    def test_invalid_preferences_do_not_broaden_legacy_empty(self):
        for value in ({"version": 2}, {"version": 1, "disabled": {}},
                      {"version": 1, "disabled": [{}]}, None):
            client = SimpleNamespace(skills=[], config={skill_preferences.KEY: value})
            self.assertEqual(skill_preferences.selected_names(client, [{"name": "company"}]), set())

    def test_previously_enabled_but_revoked_name_remains_reportable(self):
        client = SimpleNamespace(skills=["company"],
            config={skill_preferences.KEY: {"version": 1, "disabled": []}})
        self.assertEqual(skill_preferences.selected_names(client, []), {"company"})


class SkillPreferences(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="soduwork-skill-defaults-")
        self.app, self.tokens, self.sessions, self.cleanup = await fixture(self.tmp.name)
        self.app.include_router(config.router)
        self.rows = [
            {"name": "company", "scope": "company"},
            {"name": "blocked", "scope": "company"},
            {"name": "office", "scope": "company"},
            {"name": "local-method", "scope": "local"},
        ]
        self.policy = {"allowed": ["company"], "roots": [], "byRepo": {}}
        async def catalog(session, client=None, **kwargs):
            own = [] if client is None else [{"name": "own-" + client.id,
                "scope": "personal", "ownerClientId": client.id}]
            return self.policy, [*self.rows, *own]
        self.catalog = patch.object(skills, "catalog_with_policy", catalog)
        self.catalog.start()
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
            base_url="http://fixture", headers={"Authorization": "Device " + self.tokens["alice"]})

    async def asyncTearDown(self):
        await self.http.aclose()
        self.catalog.stop()
        await self.cleanup()
        self.tmp.cleanup()

    async def enabled(self):
        response = await self.http.get("/api/v1/skills")
        self.assertEqual(response.status_code, 200, response.text)
        return set(response.json()["enabled"])

    async def save(self, names):
        response = await self.http.put("/api/v1/skills", json={"enabled": names})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_legacy_empty_defaults_on_but_policy_and_owner_still_gate(self):
        expected = {"company", "office", "local-method", "own-device-alice"}
        self.assertEqual(await self.enabled(), expected)
        listing = (await self.http.get("/api/v1/capabilities")).json()
        self.assertEqual({x["name"] for x in listing["skills"] if x["enabled"]}, expected)
        self.assertFalse(next(x for x in listing["skills"] if x["name"] == "blocked")["available"])
        async with self.sessions() as session:
            alice = await session.get(models.Client, "device-alice")
            self.assertEqual({x["name"] for x in await skills.resolve(session, client=alice)}, expected)
            self.assertEqual(await skills.resolve(session), [])
        bob = (await self.http.get("/api/v1/skills", headers={
            "Authorization": "Device " + self.tokens["bob"]})).json()
        self.assertIn("own-device-bob", bob["enabled"])
        self.assertNotIn("own-device-alice", bob["enabled"])

    async def test_nonempty_legacy_selection_stays_explicit_until_saved(self):
        async with self.sessions() as session:
            alice = await session.get(models.Client, "device-alice")
            alice.skills = ["company"]
            await session.commit()
        self.assertEqual(await self.enabled(), {"company"})
        await self.save(["company"])
        self.assertEqual(await self.enabled(), {"company"})
        self.rows.append({"name": "new-local", "scope": "local"})
        self.assertEqual(await self.enabled(), {"company", "new-local"})

    async def test_explicit_all_off_survives_reload_and_unavailable_catalog(self):
        await self.save([])
        self.assertEqual(await self.enabled(), set())
        previous = self.rows[:]
        self.rows[:] = []
        await self.save([])
        self.rows[:] = previous
        self.assertEqual(await self.enabled(), set())
        async with self.sessions() as session:
            alice = await session.get(models.Client, "device-alice")
            self.assertEqual(alice.config[skill_preferences.KEY]["version"], 1)
            self.assertEqual(await skills.resolve(session, client=alice), [])
        # A later new installation follows the new default; old opt-outs remain.
        self.rows.append({"name": "new-local", "scope": "local"})
        self.assertEqual(await self.enabled(), {"new-local"})

    async def test_one_opt_out_stays_off_across_policy_revocation_and_restore(self):
        await self.save(["office", "local-method", "own-device-alice"])
        self.policy["allowed"] = []
        await self.save(["office", "local-method", "own-device-alice", "blocked"])
        self.policy["allowed"] = ["company"]
        self.assertEqual(await self.enabled(), {"office", "local-method", "own-device-alice"})
        self.policy["byRepo"] = {"project": ["company", "blocked"]}
        async with self.sessions() as session:
            alice = await session.get(models.Client, "device-alice")
            self.assertEqual([x["name"] for x in await skills.resolve(session, "project", alice)], ["company"])

    async def test_regular_config_round_trip_cannot_erase_explicit_all_off(self):
        await self.save([])
        with patch("app.services.model_config_guard.personal", new=AsyncMock()):
            response = await self.http.put("/api/v1/config", json={
                "theme": "blue", skill_preferences.KEY: {"version": 1, "disabled": []}})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(skill_preferences.KEY, response.json())
        self.assertEqual(await self.enabled(), set())
        self.assertNotIn(skill_preferences.KEY, (await self.http.get("/api/v1/config")).json())

    async def test_explicit_import_enable_clears_only_that_opt_out(self):
        await self.save([])
        async with self.sessions() as session:
            alice = await session.get(models.Client, "device-alice")
            skill_preferences.enable(alice, "company")
            await session.commit()
        self.assertEqual(await self.enabled(), {"company"})
        # Creating the first personal Skill on an untouched device does not
        # accidentally turn its new default into a one-item legacy whitelist.
        async with self.sessions() as session:
            bob = await session.get(models.Client, "device-bob")
            skill_preferences.enable(bob, "own-device-bob")
            await session.commit()
            self.assertIn("company", {x["name"] for x in await skills.resolve(session, client=bob)})


if __name__ == "__main__":
    unittest.main()
