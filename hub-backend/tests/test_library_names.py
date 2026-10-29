"""Destination-scoped name collisions use the real HTTP and storage path."""
import asyncio
from tests.test_library import LibraryHttpTestCase


class LibraryNameTests(LibraryHttpTestCase):
    async def upload_named(self, filename, **kwargs):
        return await self.request("POST", "/items/upload",
            files={"file": (filename, b"original", "text/plain")}, **kwargs)

    async def test_upload_conflict_preserves_original_and_scopes(self):
        first = await self.upload_named("Report.txt")
        self.assertEqual(first.status_code, 200, first.text)
        conflict = await self.upload_named("report.TXT")
        self.assertEqual(conflict.status_code, 409, conflict.text)
        self.assertEqual(conflict.json()["detail"]["code"], "LIBRARY_NAME_CONFLICT")
        folder = await self.create_folder()
        for kwargs in [dict(owner="bob"), dict(data={"folderId": folder["id"]})]:
            reply = await self.upload_named("Report.txt", **kwargs)
            self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual(len(self.store.objects), 3)

    async def test_create_and_renamed_display_names_collide(self):
        item = await self.create_item("before")
        renamed = await self.request("PATCH", f'/items/{item["id"]}', json={"title": "renamed"})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        reply = await self.upload_named("renamed.md")
        # Notes use Markdown; compare the name visible to the user, not stale storage keys.
        self.assertEqual(reply.status_code, 409, reply.text)
        same = await self.request("POST", "/items", json={"kind": "note", "title": "renamed"})
        self.assertEqual(same.status_code, 409, same.text)

    async def test_parallel_uploads_admit_one_and_trash_does_not_conflict(self):
        replies = await asyncio.gather(self.upload_named("same.txt"), self.upload_named("same.txt"))
        self.assertEqual(sorted(r.status_code for r in replies), [200, 409])
        row = next(r for r in replies if r.status_code == 200).json()["item"]
        await self.request("DELETE", f'/items/{row["id"]}')
        self.assertEqual((await self.upload_named("same.txt")).status_code, 200)

    async def test_explicit_remote_copy_checks_names_even_with_conversation_source(self):
        form = {"sourceType": "conversation", "sessionId": "session-name-test"}
        self.assertEqual((await self.upload_named("report.txt", data=form)).status_code, 200)
        reply = await self.upload_named("report.txt", data={**form, "rejectDuplicateName": "true"})
        self.assertEqual(reply.status_code, 409, reply.text)

    async def test_rename_move_and_restore_preserve_existing_items(self):
        original = await self.create_item("occupied")
        other = await self.create_item("other")
        reply = await self.request("PATCH", f'/items/{other["id"]}', json={"title": "OCCUPIED"})
        self.assertEqual(reply.status_code, 409, reply.text)
        folder = await self.create_folder()
        nested = await self.create_item("occupied", folder_id=folder["id"])
        reply = await self.request("PATCH", f'/items/{nested["id"]}', json={"folderId": None})
        self.assertEqual(reply.status_code, 409, reply.text)
        await self.request("DELETE", f'/items/{original["id"]}')
        await self.create_item("occupied")
        reply = await self.request("POST", f'/items/{original["id"]}/restore')
        self.assertEqual(reply.status_code, 409, reply.text)
        reply = await self.request("GET", "?scope=all")
        saved = next(row for row in reply.json()["items"] if row["id"] == other["id"])
        self.assertEqual(saved["title"], "other")

    async def test_folder_names_are_case_and_unicode_normalized(self):
        await self.create_folder("Caf\u00e9")
        reply = await self.request("POST", "/folders", json={"name": "CAFE\u0301"})
        self.assertEqual(reply.status_code, 409, reply.text)
        other = await self.create_folder("other")
        reply = await self.request("PATCH", f'/folders/{other["id"]}', json={"name": "caf\u00e9"})
        self.assertEqual(reply.status_code, 409, reply.text)

    async def test_parallel_folder_creation_admits_one(self):
        replies = await asyncio.gather(*[
            self.request("POST", "/folders", json={"name": name}) for name in ("DOCS", "docs")])
        self.assertEqual(sorted(r.status_code for r in replies), [200, 409])

    async def test_file_folder_names_share_the_destination_namespace(self):
        await self.create_folder("Report.txt")
        reply = await self.upload_named("report.TXT")
        self.assertEqual(reply.status_code, 409, reply.text)
        await self.upload_named("other.txt")
        reply = await self.request("POST", "/folders", json={"name": "OTHER.txt"})
        self.assertEqual(reply.status_code, 409, reply.text)

    async def test_dotfile_renamed_display_name_collides(self):
        first = await self.upload_named(".env")
        self.assertEqual(first.status_code, 200, first.text)
        reply = await self.request("PATCH", '/items/' + first.json()["item"]["id"], json={"title": "config"})
        self.assertEqual(reply.status_code, 200, reply.text)
        reply = await self.upload_named("config.env")
        self.assertEqual(reply.status_code, 409, reply.text)

    async def test_conversation_versions_remain_restorable_with_same_name(self):
        form = {"sourceType": "conversation", "sessionId": "version-restore"}
        first = await self.upload_named("report.txt", data=form)
        item_id = first.json()["item"]["id"]
        await self.request("DELETE", f"/items/{item_id}")
        later = await self.upload_named("report.txt", data=form)
        self.assertEqual(later.status_code, 200, later.text)
        reply = await self.request("POST", f"/items/{item_id}/restore")
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertNotEqual(reply.json()["item"]["id"], later.json()["item"]["id"])


def load_tests(loader, tests, pattern):
    # Reuse the HTTP fixture without rerunning its inherited test cases here.
    import unittest
    return unittest.TestSuite(LibraryNameTests(name) for name in LibraryNameTests.__dict__ if name.startswith("test_"))


if __name__ == "__main__":
    import unittest
    unittest.main()
