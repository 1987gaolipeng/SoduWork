"""Single-connection saves preserve sibling state and reject stale edit windows."""
import os
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
import copy
import tempfile
import unittest

import httpx
from skill_test_support import fixture
from app import models
from app.services import mcp_servers, capability_catalog


def row(id_="one", **patch):
    return {"id": id_, "name": id_, "type": "http", "url": "https://mcp.example.test/mcp",
            "headers": {"Authorization": "Bearer private-fixture-" + id_}, "enabled": False,
            "approved": True, "approvedTarget": "https://mcp.example.test/mcp", **patch}


class PersonalWriteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-single-connector-")
        self.app, self.tokens, self.sessions, self.cleanup = await fixture(self.temp.name)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        await self.seed([row(), row("two")])

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.cleanup()
        self.temp.cleanup()

    async def seed(self, rows, who="alice"):
        async with self.sessions() as session:
            client = await session.get(models.Client, "device-" + who)
            client.mcp_servers = rows
            client.mcp_enabled = ["unrelated-company"]
            await session.commit()

    async def req(self, method, path, who="alice", **kwargs):
        return await self.http.request(method, "/api/v1" + path,
            headers={"Authorization": "Device " + self.tokens[who]}, **kwargs)

    async def view(self):
        response = await self.req("GET", "/mcp-servers")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["personal"]

    async def save(self, spec, original=None, who="alice"):
        return await self.req("POST", "/mcp-servers/upsert", who=who,
                              json={"server": spec, "original": original})

    async def stored(self):
        async with self.sessions() as session:
            client = await session.get(models.Client, "device-alice")
            return copy.deepcopy(client.mcp_servers), list(client.mcp_enabled)

    async def test_edit_preserves_concurrent_sibling_change_legacy_rows_and_company_selection(self):
        original = (await self.view())[0]
        current = [row(), row("two", enabled=True), row("newly-imported"), {"id": "legacy", "private": "keep"}]
        await self.seed(current)
        result = await self.save({**original, "name": "renamed"}, original)
        self.assertEqual(result.status_code, 200, result.text)
        rows, selection = await self.stored()
        self.assertEqual(rows[1:], current[1:])
        self.assertEqual(selection, ["unrelated-company"])
        self.assertEqual(rows[0]["name"], "renamed")
        self.assertEqual(rows[0]["headers"], current[0]["headers"])
        self.assertNotIn("private-fixture-one", result.text)

    async def test_changed_or_deleted_connection_is_not_overwritten_or_resurrected(self):
        original = (await self.view())[0]
        for current in ([row(name="newer-name")], [row(enabled=True)], []):
            with self.subTest(current=current):
                await self.seed(current)
                result = await self.save({**original, "description": "stale edit"}, original)
                self.assertEqual(result.status_code, 409, result.text)
                self.assertEqual((await self.stored())[0], current)

    async def test_latest_rotated_write_only_secret_survives_unrelated_edit(self):
        original = (await self.view())[0]
        rotated = row(headers={"Authorization": "Bearer rotated-fixture-secret"})
        await self.seed([rotated])
        result = await self.save({**original, "description": "new description"}, original)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual((await self.stored())[0][0]["headers"], rotated["headers"])
        self.assertNotIn("rotated-fixture-secret", result.text)

    async def test_fixed_creation_id_makes_lost_response_retry_idempotent(self):
        spec = row("created")
        for _ in range(2):
            result = await self.save(spec)
            self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len((await self.stored())[0]), 3)
        conflict = await self.save({**spec, "name": "different"})
        self.assertEqual(conflict.status_code, 409, conflict.text)
        self.assertEqual((await self.stored())[0][-1]["name"], "created")

    async def test_other_account_cannot_edit_or_recover_credentials_from_original(self):
        original = (await self.view())[0]
        denied = await self.save({**original, "description": "foreign edit"}, original, who="bob")
        self.assertEqual(denied.status_code, 409, denied.text)
        self.assertNotIn("private-fixture-one", denied.text)
        own = await self.save({**original, "headers": {}}, who="bob")
        self.assertEqual(own.status_code, 200, own.text)
        self.assertEqual(own.json()["personal"][0]["headers"], {})
        self.assertEqual((await self.stored())[0][0], row())

    async def test_builtin_edit_and_duplicates_rejected_without_losing_existing_rows(self):
        template = next(t for t in capability_catalog.MCP_TEMPLATES if not t.get("configurable"))
        spec = {**template["template"], "id": "builtin", "templateKey": template["key"],
                "approved": True, "approvedTarget": template["key"]}
        await self.seed([mcp_servers.personal_spec(spec), row()])
        original = (await self.view())[0]
        denied = await self.save({**original, "name": "renamed"}, original)
        self.assertEqual(denied.status_code, 403, denied.text)
        duplicate = await self.save(row("new", name="ONE"))
        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        self.assertEqual(len((await self.stored())[0]), 2)

    async def test_capacity_and_company_collision_are_still_enforced(self):
        await self.seed([row(str(i)) for i in range(20)])
        denied = await self.save(row("new"))
        self.assertEqual(denied.status_code, 409, denied.text)
        self.assertEqual(len((await self.stored())[0]), 20)
        await self.seed([])
        async with self.sessions() as session:
            await mcp_servers.save(session, [row("company", name="reserved")])
            await session.commit()
        denied = await self.save(row("new", name="reserved"))
        self.assertEqual(denied.status_code, 409, denied.text)
        self.assertEqual((await self.stored())[0], [])

    async def test_legacy_template_defaults_are_normalized_for_snapshot_comparison(self):
        template = capability_catalog.mcp_template("connector-tencent-meeting")
        spec = {**template["template"], "id": "meeting", "templateKey": template["key"],
                "approved": True, "approvedTarget": template["key"], "env": {}, "description": ""}
        await self.seed([spec])
        original = (await self.view())[0]
        result = await self.save({**original, "name": "renamed-meeting"}, original)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["personal"][0]["name"], "renamed-meeting")


if __name__ == "__main__":
    unittest.main()
