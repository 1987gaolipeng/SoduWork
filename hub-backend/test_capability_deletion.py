"""Lifecycle/security regression; all data and packages live in a temporary fixture."""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import httpx
from skill_test_support import fixture
from app import models
from app.services import skills, skill_packages, skill_sharing


class CapabilityDeletionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-capability-delete-test-")
        self.app, self.tokens, self.sessions, self.cleanup = await fixture(self.temp.name)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        builtin = Path(self.temp.name) / "empty" / "builtin-method"
        builtin.mkdir()
        (builtin / "SKILL.md").write_text("---\nname: builtin-method\ndescription: Builtin fixture\n---\nDo fixture work.", encoding="utf-8")
        self.scan_patch = patch.object(skills, "default_roots", lambda: [str(builtin.parent)])
        self.scan_patch.start()
        async with self.sessions() as session:
            await skills.save_cfg(session, {"allowed": ["builtin-method"], "roots": []})
            await session.commit()

    async def asyncTearDown(self):
        self.scan_patch.stop()
        await self.http.aclose()
        await self.cleanup()
        self.temp.cleanup()

    async def req(self, method, path, who="alice", **kw):
        return await self.http.request(method, "/api/v1" + path, headers={
            "Authorization": "Device " + self.tokens[who]}, **kw)

    async def create_skill(self, name="my-method", text="Do useful work.", who="alice"):
        result = await self.req("POST", "/skills/create", who=who,
                                json={"name": name, "description": "Fixture", "instructions": text})
        self.assertEqual(result.status_code, 200, result.text)
        return (await self.req("GET", "/skills/" + name + "/details", who=who)).json()

    async def test_owned_skill_deleted_and_selection_removed_but_payload_retained(self):
        info = await self.create_skill()
        self.assertTrue(info["canDelete"])
        row = skill_packages.active(owner_client_id="device-alice", include_company=False)[0]
        result = await self.req("DELETE", "/skills/my-method", json={"checksum": info["checksum"]})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertNotIn("my-method", result.json()["enabled"])
        self.assertEqual((await self.req("GET", "/skills/my-method/details")).status_code, 404)
        self.assertTrue((Path(row["path"]) / "SKILL.md").is_file())
        self.assertEqual(skill_packages._load_index()["deletedItems"][0]["name"], "my-method")
        self.assertEqual((await self.req("DELETE", "/skills/my-method", json={"checksum": info["checksum"]})).status_code, 404)
        self.assertEqual((await self.req("PUT", "/skills", json={"enabled": ["my-method"]})).json()["enabled"], [])

    async def test_foreign_skill_and_stale_version_cannot_be_deleted(self):
        info = await self.create_skill()
        self.assertEqual((await self.req("DELETE", "/skills/my-method", who="bob", json={"checksum": info["checksum"]})).status_code, 404)
        changed = await self.create_skill(text="Updated instructions.")
        for checksum in ("", info["checksum"]):
            result = await self.req("DELETE", "/skills/my-method", json={"checksum": checksum})
            self.assertEqual(result.status_code, 409, result.text)
        self.assertEqual((await self.req("GET", "/skills/my-method/details")).json()["checksum"], changed["checksum"])

    async def test_same_name_personal_copy_on_other_device_is_retained(self):
        info = await self.create_skill()
        other = await self.create_skill(who="bob")
        self.assertEqual(info["checksum"], other["checksum"])
        self.assertEqual((await self.req("DELETE", "/skills/my-method", json={"checksum": info["checksum"]})).status_code, 200)
        self.assertTrue((await self.req("GET", "/skills/my-method/details", who="bob")).json()["canDelete"])

    async def test_legacy_builtin_mcp_with_omitted_type_is_still_protected(self):
        async with self.sessions() as session:
            client = await session.get(models.Client, "device-alice")
            client.mcp_servers = [{"id": "legacy-time", "name": "Legacy time", "templateKey": "mcp-time",
                                   "approved": True, "approvedTarget": "mcp-time", "enabled": False}]
            await session.commit()
        response = await self.req("DELETE", "/mcp-servers/legacy-time")
        self.assertEqual(response.status_code, 403, response.text)

    async def test_builtin_skill_is_protected_but_toggleable(self):
        row = next(x for x in (await self.req("GET", "/capabilities")).json()["skills"] if x["name"] == "builtin-method")
        self.assertTrue(row["builtIn"])
        self.assertFalse(row["canDelete"])
        info = (await self.req("GET", "/skills/builtin-method/details")).json()
        self.assertFalse(info["canDelete"])
        denied = await self.req("DELETE", "/skills/builtin-method", json={"checksum": info["checksum"], "builtIn": False})
        self.assertEqual(denied.status_code, 403, denied.text)
        for selection in (["builtin-method"], []):
            result = await self.req("PUT", "/skills", json={"enabled": selection})
            self.assertEqual(result.json()["enabled"], selection)
        self.assertEqual((await self.req("GET", "/skills/builtin-method/details")).status_code, 200)

    async def test_shared_skill_survives_deleting_authors_personal_copy(self):
        info = await self.create_skill()
        submission = skill_sharing.submit("device-alice", "my-method", info["checksum"])
        skill_sharing.review(submission["id"], info["checksum"], "approve", "admin")
        async with self.sessions() as session:
            await skills.allow_shared_skill(session, "my-method")
            await session.commit()
        result = await self.req("DELETE", "/skills/my-method", json={"checksum": info["checksum"]})
        self.assertEqual(result.status_code, 200, result.text)
        other = (await self.req("GET", "/skills/my-method/details", who="bob")).json()
        self.assertEqual(other["checksum"], info["checksum"])
        self.assertFalse(other["canDelete"])
        self.assertEqual(skill_sharing.get(submission["id"])["status"], "approved")

    def http_spec(self, name="custom"):
        return {"name": name, "type": "http", "url": "https://example.invalid/mcp",
                "approved": True, "approvedTarget": "https://example.invalid/mcp",
                "headers": {"Authorization": "fixture-secret"}, "enabled": False}

    async def mcp_rows(self, rows, who="alice"):
        result = await self.req("PUT", "/mcp-servers", who=who, json={"servers": rows, "enabledCompany": []})
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()["personal"]

    async def test_custom_mcp_delete_is_owned_and_preserves_other_credentials(self):
        rows = await self.mcp_rows([self.http_spec("one"), self.http_spec("two")])
        self.assertTrue(rows[0]["canDelete"])
        self.assertEqual((await self.req("DELETE", "/mcp-servers/" + rows[0]["id"], who="bob")).status_code, 404)
        result = await self.req("DELETE", "/mcp-servers/" + rows[0]["id"])
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual([r["name"] for r in result.json()["personal"]], ["two"])
        self.assertNotIn("fixture-secret", result.text)
        async with self.sessions() as session:
            client = await session.get(models.Client, "device-alice")
            self.assertEqual(client.mcp_servers[0]["headers"]["Authorization"], "fixture-secret")

    async def test_builtin_mcp_delete_bulk_omit_retype_and_edit_rejected_toggle_allowed(self):
        spec = {"name": "Builtin time", "type": "stdio", "templateKey": "mcp-time",
                "approved": True, "approvedTarget": "mcp-time", "enabled": False}
        rows = await self.mcp_rows([spec, self.http_spec()])
        builtin = rows[0]
        self.assertTrue(builtin["builtIn"])
        self.assertFalse(builtin["canDelete"])
        self.assertFalse(builtin["canEdit"])
        self.assertEqual((await self.req("DELETE", "/mcp-servers/" + builtin["id"])).status_code, 403)
        for changed in ([rows[1]], [{**self.http_spec(), "id": builtin["id"]}],
                        [{**builtin, "name": "Renamed", "builtIn": False}, rows[1]],
                        [{**builtin, "templateKey": "mcp-git", "approvedTarget": "mcp-git"}, rows[1]]):
            result = await self.req("PUT", "/mcp-servers", json={"servers": changed})
            self.assertEqual(result.status_code, 400, result.text)
        for state in (True, False):
            rows = await self.mcp_rows([{**rows[0], "enabled": state}, rows[1]])
            self.assertEqual(rows[0]["enabled"], state)
        self.assertEqual((await self.req("DELETE", "/mcp-servers/" + rows[1]["id"])).status_code, 200)
        self.assertEqual(len((await self.req("GET", "/mcp-servers")).json()["personal"]), 1)


if __name__ == "__main__":
    unittest.main()
