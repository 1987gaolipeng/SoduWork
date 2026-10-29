import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from app.api import mcp_selection as target


class SelectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = SimpleNamespace(mcp_servers=[
            {"id": "a", "name": "alpha", "enabled": False, "headers": {"Authorization": "secret"}},
            {"id": "b", "name": "beta", "enabled": False},
            {"id": "legacy", "unknown": "preserve"}], mcp_enabled=["untouched"])
        self.session = SimpleNamespace(refresh=AsyncMock(), commit=AsyncMock())
        async def view(session, client):
            return {"company": [{"name": "company"}], "personal": [{"id": "a"}, {"id": "b"}],
                    "enabledCompany": list(client.mcp_enabled)}
        self.patches = [patch.object(target.mcp_servers, "client_view", side_effect=view),
                        patch.object(target.skills, "load_cfg", AsyncMock(return_value={"allowed": ["mcp-tools"]})),
                        patch.object(target.skill_preferences, "enable")]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    async def select(self, *changes):
        return await target.select_mcp_servers({"changes": list(changes)}, self.client, self.session)

    async def test_delta_preserves_secrets_unrelated_rows_and_selections(self):
        await self.select({"kind": "personal", "id": "a", "enabled": True})
        await self.select({"kind": "personal", "id": "b", "enabled": True})
        self.assertTrue(all(r["enabled"] for r in self.client.mcp_servers[:2]))
        self.assertEqual(self.client.mcp_servers[0]["headers"], {"Authorization": "secret"})
        self.assertEqual(self.client.mcp_servers[2], {"id": "legacy", "unknown": "preserve"})
        self.assertEqual(self.client.mcp_enabled, ["untouched"])
        self.session.refresh.assert_awaited_with(self.client, with_for_update=True)

    async def test_missing_connection_rejects_entire_batch(self):
        with self.assertRaises(HTTPException) as error:
            await self.select({"kind": "personal", "id": "a", "enabled": True},
                              {"kind": "personal", "id": "removed", "enabled": True})
        self.assertEqual(error.exception.status_code, 409)
        self.assertFalse(self.client.mcp_servers[0]["enabled"])
        self.session.commit.assert_not_awaited()

    async def test_toggle_company_does_not_overwrite_other_selection(self):
        await self.select({"kind": "company", "id": "company", "enabled": True})
        self.assertEqual(self.client.mcp_enabled, ["company", "untouched"])
        await self.select({"kind": "company", "id": "company", "enabled": False})
        self.assertEqual(self.client.mcp_enabled, ["untouched"])

    async def test_reject_non_boolean_without_mutating(self):
        with self.assertRaises(HTTPException):
            await self.select({"kind": "personal", "id": "a", "enabled": "false"})
        self.session.refresh.assert_not_awaited()

    async def test_admin_policy_remains_authoritative(self):
        with patch.object(target.skills, "load_cfg", AsyncMock(return_value={"allowed": []})):
            result = await self.select({"kind": "personal", "id": "a", "enabled": True})
        self.assertTrue(result["warning"])
        target.skill_preferences.enable.assert_not_called()
