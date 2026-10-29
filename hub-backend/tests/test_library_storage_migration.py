"""Local disk to NFS migration through isolated HTTP, SQLite and TCP/XDR."""
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy.ext.asyncio import AsyncSession

from tests import test_library_remote
from app.library_models import LibraryItem
from app.services import library_storage


class LibraryStorageMigrationTests(test_library_remote.LibraryNfsWireHttpTests):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        directory = tempfile.TemporaryDirectory(prefix="library-migration-")
        self.addCleanup(directory.cleanup)
        self.settings.library_storage_dir = directory.name
        self.local_root = Path(directory.name)

    async def upload_local(self, content, **extra):
        response = await self.request("POST", "/items/upload", data={"storage": "local", **extra},
                                      files={"file": ("report.pdf", content, "application/pdf")})
        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()["item"]
        self.assertEqual(item["backend"], "local")
        async with self.sessions() as session:
            row = await session.get(LibraryItem, item["id"])
            key = row.storage_key
        self.assertEqual((self.local_root / key).read_bytes(), content)
        return item, key

    async def assert_local_retained(self, item, key, content):
        async with self.sessions() as session:
            row = await session.get(LibraryItem, item["id"])
            self.assertEqual(row.backend, "local")
            self.assertEqual(row.storage_key, key)
            self.assertEqual(row.folder_id, item["folderId"])
            self.assertEqual(row.size, len(content))
        self.assertEqual((self.local_root / key).read_bytes(), content)
        downloaded = await self.request("GET", f"/items/{item['id']}/download")
        self.assertEqual(downloaded.status_code, 200, downloaded.text)
        self.assertEqual(downloaded.content, content)

    async def test_local_binary_migration_preserves_bytes_over_nfs_and_removes_local_object(self):
        content = b"%PDF-1.7\x00\xff" + bytes(range(256)) * 300
        local = await self.request("POST", "/folders", json={"name": "source", "storage": "local"})
        remote = await self.request("POST", "/folders", json={"name": "destination", "storage": "remote"})
        self.assertEqual(local.status_code, 200, local.text)
        self.assertEqual(remote.status_code, 200, remote.text)
        destination = remote.json()["folder"]
        item, old_key = await self.upload_local(content, folderId=local.json()["folder"]["id"])

        moved = await self.request("PATCH", f"/items/{item['id']}", json={
            "storage": "remote", "folderId": destination["id"]})

        self.assertEqual(moved.status_code, 200, moved.text)
        result = moved.json()["item"]
        self.assertEqual(result["backend"], "nfs")
        self.assertEqual(result["folderId"], destination["id"])
        for field in ("id", "filename", "contentType", "size"):
            self.assertEqual(result[field], item[field])
        async with self.sessions() as session:
            row = await session.get(LibraryItem, item["id"])
            self.assertEqual(row.backend, "nfs")
            new_key = row.storage_key
        self.assertNotEqual(new_key, old_key)
        self.assertEqual(self.peer.resolve(new_key)["data"], content)
        self.assertFalse((self.local_root / old_key).exists())
        downloaded = await self.request("GET", f"/items/{item['id']}/download")
        self.assertEqual(downloaded.status_code, 200, downloaded.text)
        self.assertEqual(downloaded.content, content)
        foreign = await self.request("GET", f"/items/{item['id']}/download", owner="bob")
        self.assertEqual(foreign.status_code, 404, foreign.text)

    async def test_nfs_copy_failure_preserves_local_metadata_and_download(self):
        content = b"local original\x00\xff"
        item, key = await self.upload_local(content)
        self.peer.fail_write = True

        moved = await self.request("PATCH", f"/items/{item['id']}", json={"storage": "remote"})

        self.assertEqual(moved.status_code, 503, moved.text)
        self.assertTrue(moved.json()["detail"]["code"].startswith("LIBRARY_NFS_"))
        self.assertEqual(self.peer.resolve(key.rsplit("/", 1)[0])["children"], {})
        await self.assert_local_retained(item, key, content)

    async def test_declared_size_mismatch_aborts_before_nfs_write_and_preserves_local_download(self):
        content = b"complete local original"
        item, key = await self.upload_local(content)
        real_open_stream = library_storage.open_stream
        for supplied in (content[:-1], content + b"unexpected"):
            with self.subTest(supplied_size=len(supplied)):
                def faulty_read(object_key, backend=None):
                    if object_key == key and backend == "local":
                        return io.BytesIO(supplied)
                    return real_open_stream(object_key, backend=backend)

                with patch.object(library_storage, "open_stream", side_effect=faulty_read):
                    moved = await self.request("PATCH", f"/items/{item['id']}", json={"storage": "remote"})

                self.assertEqual(moved.status_code, 503, moved.text)
                self.assertEqual(moved.json()["detail"]["code"], "LIBRARY_STORAGE_INCOMPLETE_READ")
                self.assertEqual(self.peer.nodes[b"root"]["children"], {})
                await self.assert_local_retained(item, key, content)

    async def test_failed_metadata_commit_removes_new_nfs_object_and_preserves_local_download(self):
        content = b"original survives failed commit\x00\xff"
        item, key = await self.upload_local(content)
        parent = key.rsplit("/", 1)[0]
        observed = {}

        async def fail_commit(session):
            observed["source"] = (self.local_root / key).read_bytes()
            observed["destination"] = [self.peer.nodes[handle]["data"]
                                       for handle in self.peer.resolve(parent)["children"].values()]
            raise RuntimeError("isolated migration commit failure")

        with patch.object(AsyncSession, "commit", new=fail_commit):
            moved = await self.request("PATCH", f"/items/{item['id']}", json={"storage": "remote"})

        self.assertEqual(moved.status_code, 500, moved.text)
        self.assertEqual(observed, {"source": content, "destination": [content]})
        self.assertEqual(self.peer.resolve(parent)["children"], {})
        await self.assert_local_retained(item, key, content)


if __name__ == "__main__":
    unittest.main()
