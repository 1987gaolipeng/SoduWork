"""Batch library actions keep ownership and partial-failure semantics explicit."""
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from tests.test_library import LibraryHttpTestCase
from app.services import library_sharing


class LibraryBatchTests(LibraryHttpTestCase):
    async def test_batch_delete_moves_owned_items_and_reports_missing_rows(self):
        first = await self.create_item("first")
        second = await self.create_item("second")
        response = await self.request("POST", "/items/batch-delete", json={
            "itemIds": [first["id"], second["id"], "missing-item"],
        })
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["succeeded"], [first["id"], second["id"]])
        self.assertEqual(body["failed"][0]["id"], "missing-item")
        listing = await self.list_items("all")
        self.assertEqual(listing["items"], [])
        trash = await self.list_items("trash")
        self.assertEqual({row["id"] for row in trash["items"]}, {first["id"], second["id"]})

    async def test_batch_delete_does_not_cross_owner_or_redelete_trash(self):
        own = await self.create_item("own")
        other = await self.create_item("other", owner="bob")
        await self.request("DELETE", f"/items/{own['id']}")
        response = await self.request("POST", "/items/batch-delete", json={
            "itemIds": [own["id"], other["id"]],
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual({row["id"] for row in response.json()["succeeded"]}, set())
        self.assertEqual({row["id"] for row in response.json()["failed"]}, {own["id"], other["id"]})

    async def test_batch_share_returns_per_item_results(self):
        first = await self.create_item("first")
        second = await self.create_item("second")

        async def fake_share(_session, _client, item_id, _recipients, _note):
            if item_id == second["id"]:
                raise HTTPException(404, "missing")
            return {"ok": True, "itemId": item_id, "shared": 1}

        with patch.object(library_sharing, "share", new=AsyncMock(side_effect=fake_share)):
            response = await self.request("POST", "/items/batch-share", json={
                "itemIds": [first["id"], second["id"]],
                "recipientUserIds": ["member"],
                "note": "for review",
            })
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual([entry["id"] for entry in body["succeeded"]], [first["id"]])
        self.assertEqual(body["failed"][0]["id"], second["id"])


def load_tests(loader, tests, pattern):
    import unittest
    return unittest.TestSuite(LibraryBatchTests(name) for name in LibraryBatchTests.__dict__ if name.startswith("test_"))


if __name__ == "__main__":
    import unittest
    unittest.main()
