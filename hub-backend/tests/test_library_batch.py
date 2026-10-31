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

    async def test_batch_share_sends_one_package_with_all_selected_items(self):
        first = await self.create_item("first")
        second = await self.create_item("second")
        selected = [first["id"], second["id"]]
        result = {"ok": True, "itemIds": selected, "packaged": True, "shared": 1}
        with patch.object(library_sharing, "share_items", new=AsyncMock(return_value=result)) as share:
            response = await self.request("POST", "/items/batch-share", json={
                "itemIds": [*selected, first["id"]],
                "recipientUserIds": ["member"],
                "note": "for review",
            })
        self.assertEqual(response.status_code, 200, response.text)
        share.assert_awaited_once()
        args, kwargs = share.await_args
        self.assertEqual(args[1].user_ref, "alice")
        self.assertEqual(args[2:], (selected, ["member"], "for review"))
        self.assertEqual(kwargs, {"request_key": "", "package": True,
                                  "snapshots": None, "force_package": False})
        body = response.json()
        self.assertEqual(body["succeeded"], [{"ids": selected, "folderIds": [], "result": result}])
        self.assertEqual(body["failed"], [])
        self.assertEqual((body["shared"], body["notifications"]), (2, 1))

    async def test_batch_share_rejection_never_reports_partial_delivery(self):
        first = await self.create_item("first")
        with patch.object(library_sharing, "share_items", new=AsyncMock(
                side_effect=HTTPException(404, "missing"))) as share:
            response = await self.request("POST", "/items/batch-share", json={
                "itemIds": [first["id"], "missing-item"],
                "recipientUserIds": ["member"],
            })
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(response.json(), {"detail": "missing"})
        share.assert_awaited_once()


def load_tests(loader, tests, pattern):
    import unittest
    return unittest.TestSuite(LibraryBatchTests(name) for name in LibraryBatchTests.__dict__ if name.startswith("test_"))


if __name__ == "__main__":
    import unittest
    unittest.main()
