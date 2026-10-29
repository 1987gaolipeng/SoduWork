"""Library isolation and failure recovery; no live database or storage."""
import unittest
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tests.test_library import LibraryHttpTestCase
from app.api import library
from app.deps import current_client
from app.library_models import LibraryFolder
from app.services import library_formats


class LibraryIntegrityTests(LibraryHttpTestCase):
    async def test_sqlite_timestamps_always_include_utc_timezone(self):
        folder = await self.create_folder()
        item = await self.create_item()
        await self.request("GET", f"/items/{item['id']}/download")
        trashed = (await self.request("DELETE", f"/items/{item['id']}")).json()["item"]
        for row in (folder, item, trashed):
            for field in ("createdAt", "updatedAt", "deletedAt", "lastOpenedAt"):
                if row.get(field):
                    self.assertEqual(datetime.fromisoformat(row[field]).utcoffset(), timedelta(0), (field, row[field]))

    async def test_all_routes_require_device_authentication(self):
        self.app.dependency_overrides.pop(current_client)
        for method, path, options in [
            ("GET", "", {}), ("GET", "/storage/status", {}),
            ("POST", "/folders", {"json": {"name": "x"}}),
            ("POST", "/items", {"json": {"content": "x"}}),
            ("POST", "/items/upload", {"files": {"file": ("x.txt", b"x")}}),
            ("GET", "/items/missing/download", {}), ("DELETE", "/trash", {}),
        ]:
            response = await self.request(method, path, **options)
            self.assertEqual(response.status_code, 401, response.text)
        self.assertEqual(self.store.objects, {})

    async def test_omitted_storage_inherits_folder_for_children_items_and_uploads(self):
        response = await self.request("POST", "/folders", json={"name": "remote", "storage": "minio"})
        folder = response.json()["folder"]
        child = await self.create_folder("child", parent_id=folder["id"])
        item = await self.create_item(folder_id=folder["id"])
        upload = await self.request("POST", "/items/upload", data={"folderId": folder["id"]},
                                    files={"file": ("nested.txt", b"nested", "text/plain")})
        self.assertEqual(upload.status_code, 200, upload.text)
        for row in (child, item, upload.json()["item"]):
            self.assertEqual(row["backend"], "minio")
        forbidden = await self.request("POST", "/items", json={
            "folderId": folder["id"], "storage": "local", "content": "x"})
        self.assertEqual(forbidden.status_code, 409, forbidden.text)

    async def test_folder_names_are_unique_within_storage_even_at_root(self):
        local = await self.create_folder("same")
        response = await self.request("POST", "/folders", json={"name": "same", "storage": "minio"})
        self.assertEqual(response.status_code, 200, response.text)
        renamed = await self.request("PATCH", f"/folders/{local['id']}", json={"name": "same"})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        async with self.sessions() as session:
            session.add(LibraryFolder(owner_key="alice", name="same", backend="local"))
            with self.assertRaises(IntegrityError):
                await session.commit()
            await session.rollback()
        long_name = await self.create_folder("a" * 200)
        self.assertEqual(len(long_name["name"]), 160)

    async def test_invalid_edit_does_not_write_or_orphan_objects(self):
        folder = await self.create_folder()
        item = await self.create_item(folder_id=folder["id"], content="before")
        original = dict(self.store.objects)
        for body in ({"content": "after", "folderId": "missing"},
                     {"content": "after", "extra": []},
                     {"content": "after", "favorite": "false"},
                     {"content": "after", "storage": "minio"},
                     {"storage": "minio"}):
            response = await self.request("PATCH", f"/items/{item['id']}", json=body)
            self.assertIn(response.status_code, (400, 409), response.text)
            self.assertEqual(self.store.objects, original)
        content = await self.request("GET", f"/items/{item['id']}/content")
        self.assertEqual(content.json()["content"], "before")
        invalid_create = await self.request("POST", "/items", json={"extra": []})
        self.assertEqual(invalid_create.status_code, 400, invalid_create.text)
        self.assertEqual(self.store.objects, original)

    async def test_failed_commit_cleans_new_object_but_failed_refresh_keeps_committed_object(self):
        with patch.object(AsyncSession, "commit", new=AsyncMock(side_effect=RuntimeError("commit failed"))):
            with self.assertRaisesRegex(RuntimeError, "commit failed"):
                await self.request("POST", "/items", json={"content": "hello"})
        self.assertEqual(self.store.objects, {})
        with patch.object(AsyncSession, "refresh", new=AsyncMock(side_effect=RuntimeError("refresh failed"))):
            with self.assertRaisesRegex(RuntimeError, "refresh failed"):
                await self.request("POST", "/items", json={"content": "retained"})
        listing = await self.list_items()
        self.assertEqual(len(listing["items"]), 1)
        self.assertEqual(list(self.store.objects.values()), [b"retained"])

    async def test_storage_migration_requires_matching_destination_and_retains_bytes(self):
        local = await self.create_folder()
        remote = await self.request("POST", "/folders", json={"name": "remote", "storage": "minio"})
        item = await self.create_item(folder_id=local["id"])
        old_key = next(iter(self.store.objects))
        edited = await self.request("PATCH", f"/items/{item['id']}", json={
            "storage": "minio", "folderId": remote.json()["folder"]["id"], "content": "moved"})
        self.assertEqual(edited.status_code, 200, edited.text)
        self.assertEqual(edited.json()["item"]["backend"], "minio")
        self.assertNotIn(old_key, self.store.objects)
        downloaded = await self.request("GET", f"/items/{item['id']}/download")
        self.assertEqual(downloaded.content, b"moved")

    async def test_uploaded_local_file_can_move_to_remote_without_client_reupload(self):
        original = b"%PDF-1.7\x00binary local bytes"
        upload = await self.request("POST", "/items/upload", files={
            "file": ("report.pdf", original, "application/pdf")
        })
        self.assertEqual(upload.status_code, 200, upload.text)
        item = upload.json()["item"]
        old_key = next(iter(self.store.objects))

        moved = await self.request("PATCH", f"/items/{item['id']}", json={
            "storage": "minio", "folderId": ""
        })
        self.assertEqual(moved.status_code, 200, moved.text)
        self.assertEqual(moved.json()["item"]["backend"], "minio")
        self.assertIsNone(moved.json()["item"]["folderId"])
        self.assertNotIn(old_key, self.store.objects)

        downloaded = await self.request("GET", f"/items/{item['id']}/download")
        self.assertEqual(downloaded.status_code, 200, downloaded.text)
        self.assertEqual(downloaded.content, original)

    async def test_uploaded_markdown_and_csv_keep_their_formats_after_edit(self):
        for filename, data, content_type, edited, expected in (
            ("notes.md", b"# before", "text/markdown", "# after", b"# after"),
            ("table.csv", b'a,"b,c"\r\n', "text/csv", "a\tb,c", b'a,"b,c"\r\n'),
        ):
            upload = await self.request("POST", "/items/upload", files={"file": (filename, data, content_type)})
            item = upload.json()["item"]
            preview = await self.request("GET", f"/items/{item['id']}/content")
            self.assertEqual(preview.status_code, 200, preview.text)
            response = await self.request("PATCH", f"/items/{item['id']}", json={"content": edited})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["item"]["filename"], filename)
            self.assertTrue(response.json()["item"]["contentType"].startswith(content_type))
            download = await self.request("GET", f"/items/{item['id']}/download")
            self.assertEqual(download.content, expected)

    async def test_unsupported_uploaded_formats_cannot_be_corrupted_by_text_edits(self):
        for extension in ("pdf", "doc", "rtf", "xls", "ods", "ppt", "odp"):
            upload = await self.request("POST", "/items/upload", files={
                "file": ("original." + extension, b"original bytes", "application/octet-stream")})
            item = upload.json()["item"]
            before = dict(self.store.objects)
            response = await self.request("PATCH", f"/items/{item['id']}", json={"content": "overwrite"})
            self.assertEqual(response.status_code, 400, response.text)
            self.assertEqual(self.store.objects, before)
            downloaded = await self.request("GET", f"/items/{item['id']}/download")
            self.assertEqual(downloaded.content, b"original bytes")

    async def test_real_office_exports_download_and_read_back(self):
        for kind, content, expected in (("spreadsheet", "a\tb\n1\t2", "a\tb\n1\t2"),
                                        ("presentation", "Title\nBody", "Title\nBody")):
            response = await self.request("POST", "/items", json={"kind": kind, "title": kind, "content": content})
            self.assertEqual(response.status_code, 200, response.text)
            item = response.json()["item"]
            download = await self.request("GET", f"/items/{item['id']}/download")
            self.assertTrue(download.content.startswith(b"PK"))
            preview = await self.request("GET", f"/items/{item['id']}/content")
            self.assertEqual(preview.status_code, 200, preview.text)
            self.assertEqual(preview.json()["content"], expected)
        docx, _, mime = library_formats.export("legacy_document", "word", "First\nSecond")
        upload = await self.request("POST", "/items/upload", files={"file": ("word.docx", docx, mime)})
        preview = await self.request("GET", f"/items/{upload.json()['item']['id']}/content")
        self.assertEqual(preview.json()["content"], "First\nSecond")

    async def test_empty_trash_only_purges_selected_storage(self):
        items = []
        for storage in ("local", "minio"):
            response = await self.request("POST", "/items", json={"content": storage, "storage": storage})
            item = response.json()["item"]
            items.append(item)
            await self.request("DELETE", f"/items/{item['id']}")
        response = await self.request("DELETE", "/trash", params={"storage": "local"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"ok": True, "purged": 1, "remaining": 0, "partial": False})
        remaining = await self.list_items("trash")
        self.assertEqual([row["id"] for row in remaining["items"]], [items[1]["id"]])

    async def test_preview_download_does_not_change_modified_date(self):
        from datetime import datetime, timezone
        from sqlalchemy import update
        from app.library_models import LibraryItem
        item = await self.create_item()
        original = datetime(2020, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
        async with self.sessions() as session:
            await session.execute(update(LibraryItem).where(LibraryItem.id == item["id"]).values(updated_at=original))
            await session.commit()
        response = await self.request("GET", f"/items/{item['id']}/download")
        self.assertEqual(response.status_code, 200)
        rows = (await self.list_items())["items"]
        found = next(row for row in rows if row["id"] == item["id"])
        self.assertEqual(found["updatedAt"], original.isoformat())
        self.assertIsNotNone(found["lastOpenedAt"])

    async def test_upload_limits_and_safe_names(self):
        empty = await self.request("POST", "/items/upload", files={"file": ("empty", b"")})
        self.assertEqual(empty.status_code, 400, empty.text)
        with patch.object(library, "_max_bytes", return_value=4):
            oversized = await self.request("POST", "/items/upload", files={"file": ("large", b"12345")})
            self.assertEqual(oversized.status_code, 413, oversized.text)
        self.assertEqual(self.store.objects, {})
        self.assertEqual(library._safe_name("..\\..\\folder\\safe.txt"), "safe.txt")
        self.assertEqual(library._safe_name("../../safe\r\n.txt"), "safe.txt")
        invalid_mime = await self.request("POST", "/items", json={"kind": "file", "contentType": "x" * 161})
        self.assertEqual(invalid_mime.status_code, 400, invalid_mime.text)


if __name__ == "__main__":
    unittest.main()
