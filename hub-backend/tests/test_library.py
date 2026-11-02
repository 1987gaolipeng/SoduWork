"""HTTP regression tests for the personal material library.

The fixture deliberately includes only the library router, uses an isolated
in-memory SQLite database, and replaces the MinIO adapter with an in-memory
object store.  This keeps the tests independent from the Hub database and
from a running MinIO instance while exercising the real FastAPI endpoints.
"""

import io
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

# Always force an isolated test database, even when a developer shell has a
# production DATABASE_URL exported.
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from fastapi import FastAPI, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.db import Base, get_session
from app.deps import current_client
from app.library_models import LibraryFolder, LibraryItem
from app.models import Client
from app.api import library
from app.services import library_storage


class _ObjectStream(io.BytesIO):
    """MinIO-like stream with the cleanup hook used by ``iter_stream``."""

    def release_conn(self):
        return None


class _FakeMinio:
    def __init__(self):
        self.objects = {}
        self.deleted = []
        self.fail_delete = set()

    def put_bytes(self, key, data, content_type):
        self.objects[key] = bytes(data)
        return "fake"

    def put_stream(self, key, handle, size, content_type):
        handle.seek(0)
        self.objects[key] = handle.read(size)
        return "fake"

    def read_bytes(self, key, limit=16 * 1024 * 1024):
        if key not in self.objects:
            raise FileNotFoundError(key)
        data = self.objects[key]
        if len(data) > limit:
            raise ValueError("too large")
        return data

    def open_stream(self, key):
        if key not in self.objects:
            raise FileNotFoundError(key)
        return _ObjectStream(self.objects[key])

    def delete(self, key):
        self.deleted.append(key)
        if key in self.fail_delete:
            raise OSError("fake MinIO delete failure")
        self.objects.pop(key, None)


class LibraryHttpTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(
                lambda sync_connection: Base.metadata.create_all(
                    sync_connection,
                    tables=[LibraryFolder.__table__, LibraryItem.__table__],
                )
            )

        self.app = FastAPI()
        self.app.include_router(library.router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def client_override(request: Request):
            owner = request.headers.get("X-Test-Owner", "alice").strip() or "alice"
            return Client(id="device-" + owner, user_ref=owner)

        self.app.dependency_overrides[get_session] = session_override
        self.app.dependency_overrides[current_client] = client_override
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://test"
        )
        self.store = _FakeMinio()
        self.storage_patch = patch.multiple(
            library_storage,
            ensure_ready=lambda: True,
            put_bytes=self.store.put_bytes,
            put_stream=self.store.put_stream,
            read_bytes=self.store.read_bytes,
            open_stream=self.store.open_stream,
            delete=self.store.delete,
        )
        self.storage_patch.start()

    async def asyncTearDown(self):
        self.storage_patch.stop()
        await self.http.aclose()
        await self.engine.dispose()

    async def request(self, method, path, owner="alice", **kwargs):
        headers = dict(kwargs.pop("headers", {}))
        headers["X-Test-Owner"] = owner
        return await self.http.request(method, "/api/v1/library" + path, headers=headers, **kwargs)

    async def create_item(self, title="read me", owner="alice", folder_id=None, content="hello"):
        body = {"kind": "note", "title": title, "content": content}
        if folder_id:
            body["folderId"] = folder_id
        response = await self.request("POST", "/items", owner=owner, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["item"]

    async def create_folder(self, name="docs", owner="alice", parent_id=None):
        body = {"name": name}
        if parent_id:
            body["parentId"] = parent_id
        response = await self.request("POST", "/folders", owner=owner, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["folder"]

    async def list_items(self, scope="recommended", owner="alice"):
        response = await self.request("GET", "", owner=owner, params={"scope": scope})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()


class LibraryHttpTests(LibraryHttpTestCase):
    async def test_storage_failure_is_machine_readable_for_library_view(self):
        failure = library_storage.LibraryStorageError(
            "LIBRARY_STORAGE_NOT_CONFIGURED", retryable=False
        )
        with patch.object(library_storage, "ensure_ready", side_effect=failure):
            response = await self.request("GET", "")
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json()["detail"], {
            "code": "LIBRARY_STORAGE_NOT_CONFIGURED",
            "message": "请配置资料库存储环境",
            "retryable": False,
        })
        with patch.object(library_storage, "ensure_ready", side_effect=OSError("MinIO offline")):
            response = await self.request("GET", "")
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json()["detail"]["code"], "LIBRARY_STORAGE_UNAVAILABLE")
        self.assertEqual(response.json()["detail"]["message"], "请配置资料库存储环境")

    async def test_storage_status_endpoint_returns_capabilities_without_listing(self):
        expected = {
            "ok": True,
            "default": "local",
            "local": {"backend": "local", "state": "available", "enabled": True},
            "minio": {"backend": "minio", "state": "disabled", "enabled": False},
        }
        with patch.object(library_storage, "status", return_value=expected):
            response = await self.request("GET", "/storage/status")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), expected)

    async def test_storage_status_reports_owner_remote_quota(self):
        async with self.sessions() as session:
            session.add_all([
                LibraryItem(id="alice-nfs-live", owner_key="alice", backend="nfs", size=100),
                LibraryItem(id="alice-nfs-trash", owner_key="alice", backend="nfs", size=200,
                            deleted_at=datetime.now(timezone.utc)),
                LibraryItem(id="alice-local", owner_key="alice", backend="local", size=400),
                LibraryItem(id="bob-nfs", owner_key="bob", backend="nfs", size=800),
            ])
            await session.commit()
        capability = {
            "backend": "nfs", "state": "available", "configured": True,
            "available": True, "enabled": True, "connected": True,
        }
        expected = {
            "ok": True, "default": "local", "storage": {
                "local": {"backend": "local", "state": "available", "enabled": True},
                "remote": capability,
            }, "remote": capability, "remoteBackend": "nfs",
        }
        with patch.object(library_storage, "status", return_value=expected):
            response = await self.request("GET", "/storage/status")
        self.assertEqual(response.status_code, 200, response.text)
        quota = response.json()["storage"]["remote"]
        self.assertEqual(quota["quotaBytes"], 1024 * 1024 * 1024)
        self.assertEqual(quota["usedBytes"], 300)
        self.assertEqual(quota["remainingBytes"], 1024 * 1024 * 1024 - 300)
        self.assertEqual(response.json()["remote"]["usedBytes"], 300)

    async def test_note_content_can_be_saved_and_replaced(self):
        item = await self.create_item("draft", content="before")
        old_key = next(iter(self.store.objects))
        updated = await self.request(
            "PATCH", f"/items/{item['id']}",
            json={"title": "saved draft", "content": "after", "extra": {"tag": "saved"}},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["item"]["title"], "saved draft")
        self.assertEqual(updated.json()["item"]["extra"], {
            "tag": "saved", "soduWorkSource": item["extra"]["soduWorkSource"],
        })
        content = await self.request("GET", f"/items/{item['id']}/content")
        self.assertEqual(content.status_code, 200, content.text)
        self.assertEqual(content.json()["content"], "after")
        self.assertNotIn(old_key, self.store.objects)
        self.assertEqual(list(self.store.objects.values()), [b"after"])

    async def test_update_commit_failure_cleans_new_bytes_and_preserves_original(self):
        item = await self.create_item("draft", content="before")
        original_objects = dict(self.store.objects)
        old_key = next(iter(original_objects))

        async def fail_commit(session):
            # Write the actual SQLite transaction, then fail before commit so
            # the production rollback must restore content and metadata.
            await session.flush()
            raise RuntimeError("injected commit failure")

        for changes in ({"content": "after", "extra": {"tag": "changed"}},
                        {"content": "after", "extra": {}},
                        {"extra": {"tag": "metadata only"}}):
            with self.subTest(changes=changes):
                before_deletes = len(self.store.deleted)
                with patch.object(AsyncSession, "commit", new=fail_commit):
                    with self.assertRaisesRegex(RuntimeError, "injected commit failure"):
                        await self.request("PATCH", f"/items/{item['id']}",
                                           json={"title": "changed", **changes})
                self.assertEqual(self.store.objects, original_objects)
                removed = self.store.deleted[before_deletes:]
                self.assertEqual(len(removed), 1 if "content" in changes else 0)
                self.assertTrue(all(isinstance(key, str) and key != old_key for key in removed))
                async with self.sessions() as session:
                    row = await session.get(LibraryItem, item["id"])
                    self.assertEqual(row.storage_key, old_key)
                    self.assertEqual(row.title, "draft")
                    self.assertEqual(row.extra, item["extra"])
                current = await self.request("GET", f"/items/{item['id']}/content")
                self.assertEqual(current.status_code, 200, current.text)
                self.assertEqual(current.json()["content"], "before")

    async def test_item_can_be_moved_between_owned_folders_and_back_to_root(self):
        """Moving an item validates the destination owner and storage backend."""
        target = await self.create_folder("target")
        nested = await self.create_folder("nested", parent_id=target["id"])
        item = await self.create_item("movable")

        moved = await self.request(
            "PATCH", f"/items/{item['id']}", json={"folderId": target["id"]}
        )
        self.assertEqual(moved.status_code, 200, moved.text)
        self.assertEqual(moved.json()["item"]["folderId"], target["id"])

        # Moving again is an ordinary metadata update and does not duplicate
        # the object or change its persisted backend.
        moved_nested = await self.request(
            "PATCH", f"/items/{item['id']}", json={"folderId": nested["id"]}
        )
        self.assertEqual(moved_nested.status_code, 200, moved_nested.text)
        self.assertEqual(moved_nested.json()["item"]["folderId"], nested["id"])
        self.assertEqual(len(self.store.objects), 1)

        returned = await self.request(
            "PATCH", f"/items/{item['id']}", json={"folderId": ""}
        )
        self.assertEqual(returned.status_code, 200, returned.text)
        self.assertIsNone(returned.json()["item"]["folderId"])

        # A folder from another user, a folder in another storage tab, and a
        # missing folder must all leave the current location unchanged.
        foreign = await self.create_folder("foreign", owner="bob")
        remote = await self.request(
            "POST", "/folders", json={"name": "remote", "storage": "minio"}
        )
        self.assertEqual(remote.status_code, 200, remote.text)
        for folder_id in (foreign["id"], remote.json()["folder"]["id"], "missing-folder"):
            rejected = await self.request(
                "PATCH", f"/items/{item['id']}", json={"folderId": folder_id}
            )
            self.assertEqual(rejected.status_code, 409, rejected.text)
            self.assertTrue(rejected.json().get("detail"))

            current = await self.request("GET", "", params={"scope": "all"})
            self.assertEqual(current.status_code, 200, current.text)
            self.assertEqual([row["id"] for row in current.json()["items"]], [item["id"]])
            self.assertIsNone(current.json()["items"][0]["folderId"])

    async def test_storage_tabs_filter_items_and_folders_by_backend(self):
        local_folder_response = await self.request(
            "POST", "/folders", json={"name": "local docs", "storage": "local"}
        )
        self.assertEqual(local_folder_response.status_code, 200, local_folder_response.text)
        local_folder = local_folder_response.json()["folder"]
        local_response = await self.request(
            "POST", "/items", json={"kind": "note", "title": "local note", "content": "l",
                                      "folderId": local_folder["id"], "storage": "local"}
        )
        self.assertEqual(local_response.status_code, 200, local_response.text)
        local_item = local_response.json()["item"]
        remote_response = await self.request(
            "POST", "/items", json={"kind": "note", "title": "remote note", "content": "r", "storage": "minio"}
        )
        self.assertEqual(remote_response.status_code, 200, remote_response.text)
        remote_item = remote_response.json()["item"]
        self.assertEqual(local_item["backend"], "local")
        self.assertEqual(remote_item["backend"], "minio")

        local_list = await self.request("GET", "", params={"scope": "all", "storage": "local", "folderId": local_folder["id"]})
        self.assertEqual(local_list.status_code, 200, local_list.text)
        self.assertEqual({row["id"] for row in local_list.json()["items"]}, {local_item["id"]})
        local_folders = await self.request("GET", "", params={"scope": "folders", "storage": "local"})
        self.assertEqual([f["id"] for f in local_folders.json()["folders"]], [local_folder["id"]])
        remote_list = await self.request("GET", "", params={"scope": "all", "storage": "minio"})
        self.assertEqual({row["id"] for row in remote_list.json()["items"]}, {remote_item["id"]})

    async def test_category_contents_and_recent_order_preserve_owner_storage_and_tree(self):
        """Collections span folders; tree tabs retain the current directory."""
        at = datetime(2026, 9, 28, 8, tzinfo=timezone.utc)
        async with self.sessions() as session:
            session.add_all([
                LibraryFolder(id="root-folder", owner_key="alice", name="docs", backend="local"),
                LibraryFolder(id="nested-folder", owner_key="alice", parent_id="root-folder", name="nested", backend="local"),
                LibraryFolder(id="remote-folder", owner_key="alice", name="remote", backend="minio"),
                LibraryFolder(id="foreign-folder", owner_key="bob", name="foreign", backend="local"),
            ])
            cases = [
                ("old-note", "note", "a old", None, "alice", "local", 0, 0, False),
                ("new-note", "note", "z new", "root-folder", "alice", "local", 3, 0, False),
                ("old-image", "image", "a image", None, "alice", "local", 1, 0, False),
                ("new-image-a", "image", "y image", "root-folder", "alice", "local", 2, 1, False),
                ("new-image-b", "image", "x image", "root-folder", "alice", "local", 2, 1, False),
                ("new-image-c", "image", "z image", None, "alice", "local", 2, 0, False),
                ("deleted-image", "image", "deleted", None, "alice", "local", 4, 0, True),
                ("remote-image", "image", "remote", None, "alice", "minio", 5, 0, False),
                ("foreign-image", "image", "foreign", None, "bob", "local", 6, 0, False),
            ]
            for item_id, kind, title, folder_id, owner, backend, updated, created, deleted in cases:
                session.add(LibraryItem(
                    id=item_id, owner_key=owner, folder_id=folder_id, kind=kind, title=title,
                    backend=backend, created_at=at + timedelta(hours=created),
                    updated_at=at + timedelta(days=updated), deleted_at=at if deleted else None,
                ))
            await session.commit()

        async def listed(scope, **params):
            result = await self.request("GET", "", params={"scope": scope, "storage": "local", **params})
            self.assertEqual(result.status_code, 200, result.text)
            return result.json()

        recommended = await listed("recommended")
        self.assertEqual(recommended["folders"], [])
        self.assertEqual([r["id"] for r in recommended["items"]], [
            "new-note", "new-image-b", "new-image-a", "new-image-c", "old-image", "old-note",
        ])
        images = await listed("images")
        self.assertEqual(images["folders"], [])
        self.assertEqual([r["id"] for r in images["items"]], [
            "new-image-b", "new-image-a", "new-image-c", "old-image",
        ])
        folders = await listed("folders")
        self.assertEqual(folders["items"], [])
        self.assertEqual([r["id"] for r in folders["folders"]], ["root-folder"])
        root = await listed("all")
        self.assertEqual([r["id"] for r in root["folders"]], ["root-folder"])
        self.assertEqual({r["id"] for r in root["items"]}, {"old-note", "old-image", "new-image-c"})
        nested = await listed("all", folderId="root-folder")
        self.assertEqual([r["id"] for r in nested["folders"]], ["nested-folder"])
        self.assertEqual({r["id"] for r in nested["items"]}, {"new-note", "new-image-a", "new-image-b"})
        self.assertEqual(nested["folder"]["id"], "root-folder")
        filtered = await listed("folders", query="missing")
        self.assertEqual(filtered["folders"], [])

    async def test_folder_favorites_are_explicit_cross_folder_owner_and_storage_scoped(self):
        root = await self.create_folder("root")
        nested = await self.create_folder("nested favorite", parent_id=root["id"])
        self.assertFalse(root["favorite"])
        self.assertFalse(nested["favorite"])
        remote = await self.request("POST", "/folders", json={"name": "remote favorite", "storage": "minio"})
        remote_id = remote.json()["folder"]["id"]
        for folder_id in (nested["id"], remote_id):
            response = await self.request("PATCH", f"/folders/{folder_id}", json={"favorite": True})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()["folder"]["favorite"])
        wrong_backend = await self.request(
            "PATCH", f"/folders/{remote_id}", json={"favorite": False, "storage": "local"}
        )
        self.assertEqual(wrong_backend.status_code, 409, wrong_backend.text)
        item = await self.create_item("favorite note", folder_id=root["id"])
        non_favorite = await self.create_item("not favorite", folder_id=nested["id"])
        self.assertEqual((await self.request("PATCH", f"/items/{item['id']}", json={"favorite": True})).status_code, 200)

        favorites = await self.request("GET", "", params={"scope": "favorites", "storage": "local"})
        self.assertEqual([r["id"] for r in favorites.json()["folders"]], [nested["id"]])
        self.assertEqual([r["id"] for r in favorites.json()["items"]], [item["id"]])
        self.assertNotIn(non_favorite["id"], [r["id"] for r in favorites.json()["items"]])
        remote_favorites = await self.request("GET", "", params={"scope": "favorites", "storage": "minio"})
        self.assertEqual([r["id"] for r in remote_favorites.json()["folders"]], [remote_id])
        self.assertEqual(remote_favorites.json()["items"], [])
        foreign = await self.list_items("favorites", owner="bob")
        self.assertEqual(foreign["items"], [])
        self.assertEqual(foreign["folders"], [])
        hijack = await self.request("PATCH", f"/folders/{nested['id']}", owner="bob", json={"favorite": False})
        self.assertEqual(hijack.status_code, 404, hijack.text)

        unfavorite = await self.request("PATCH", f"/folders/{nested['id']}", json={"favorite": False})
        self.assertEqual(unfavorite.status_code, 200, unfavorite.text)
        self.assertFalse(unfavorite.json()["folder"]["favorite"])
        remaining = await self.request("GET", "", params={"scope": "favorites", "storage": "local"})
        self.assertEqual(remaining.json()["folders"], [])
        self.assertEqual([r["id"] for r in remaining.json()["items"]], [item["id"]])

    async def test_folder_favorite_rejects_non_boolean_without_mutation(self):
        folder = await self.create_folder()
        for invalid in ("false", "true", 0, 1, None, [], {}):
            response = await self.request("PATCH", f"/folders/{folder['id']}", json={"favorite": invalid})
            self.assertEqual(response.status_code, 400, response.text)
        response = await self.request("PATCH", f"/folders/{folder['id']}", json={})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual((await self.list_items("favorites"))["folders"], [])
        async with self.sessions() as session:
            self.assertFalse((await session.get(LibraryFolder, folder["id"])).favorite)

    async def test_folder_can_be_renamed_with_owner_and_sibling_validation(self):
        folder = await self.create_folder("before rename")
        renamed = await self.request(
            "PATCH", f"/folders/{folder['id']}", json={"name": "after rename"}
        )
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual(renamed.json()["folder"]["name"], "after rename")

        sibling = await self.create_folder("already used")
        conflict = await self.request(
            "PATCH", f"/folders/{folder['id']}", json={"name": sibling["name"]}
        )
        self.assertEqual(conflict.status_code, 409, conflict.text)
        empty = await self.request(
            "PATCH", f"/folders/{folder['id']}", json={"name": "  "}
        )
        self.assertEqual(empty.status_code, 400, empty.text)
        foreign = await self.request(
            "PATCH", f"/folders/{folder['id']}", owner="bob", json={"name": "hijack"}
        )
        self.assertEqual(foreign.status_code, 404, foreign.text)

    async def test_soft_delete_hides_content_and_download_until_restore_then_purge(self):
        item = await self.create_item()
        key = next(iter(self.store.objects))
        self.assertTrue(key.startswith(library_storage.owner_prefix("alice")))

        content = await self.request("GET", f"/items/{item['id']}/content")
        self.assertEqual(content.status_code, 200, content.text)
        self.assertEqual(content.json()["content"], "hello")
        hidden = await self.request("PATCH", f"/items/{item['id']}", json={"extra": {"hidden": True}})
        self.assertEqual(hidden.status_code, 200, hidden.text)
        self.assertTrue(hidden.json()["item"]["extra"]["hidden"])
        download = await self.request("GET", f"/items/{item['id']}/download")
        self.assertEqual(download.status_code, 200, download.text)
        self.assertEqual(download.content, b"hello")

        deleted = await self.request("DELETE", f"/items/{item['id']}")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertTrue(deleted.json()["trashed"])
        self.assertIn(key, self.store.objects, "soft delete must retain the MinIO object")
        self.assertEqual((await self.list_items())["items"], [])
        trash = await self.list_items("trash")
        self.assertEqual([row["id"] for row in trash["items"]], [item["id"]])
        self.assertEqual(trash["trashCount"], 1)
        for suffix in ("content", "download"):
            self.assertEqual(
                (await self.request("GET", f"/items/{item['id']}/{suffix}")).status_code,
                404,
            )

        restored = await self.request("POST", f"/items/{item['id']}/restore")
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertFalse(restored.json()["item"]["isDeleted"])
        self.assertEqual([row["id"] for row in (await self.list_items())["items"]], [item["id"]])
        self.assertEqual((await self.request("POST", f"/items/{item['id']}/restore")).status_code, 409)

        self.assertEqual((await self.request("DELETE", f"/items/{item['id']}/purge")).status_code, 409)
        self.assertEqual((await self.request("DELETE", f"/items/{item['id']}")).status_code, 200)
        purged = await self.request("DELETE", f"/items/{item['id']}/purge")
        self.assertEqual(purged.status_code, 200, purged.text)
        self.assertNotIn(key, self.store.objects)
        self.assertEqual((await self.list_items("trash"))["items"], [])
        async with self.sessions() as session:
            self.assertIsNone(await session.get(LibraryItem, item["id"]))

    async def test_empty_trash_partial_failure_keeps_failed_metadata_and_is_owner_scoped(self):
        first = await self.create_item("first")
        second = await self.create_item("second")
        foreign = await self.create_item("foreign", owner="bob")
        for row in (first, second):
            self.assertEqual((await self.request("DELETE", f"/items/{row['id']}" )).status_code, 200)
        self.assertEqual((await self.request("DELETE", f"/items/{foreign['id']}", owner="bob")).status_code, 200)
        async with self.sessions() as session:
            first_row = await session.get(LibraryItem, first["id"])
            failed_key = first_row.storage_key
        self.store.fail_delete.add(failed_key)

        emptied = await self.request("DELETE", "/trash")
        self.assertEqual(emptied.status_code, 200, emptied.text)
        self.assertEqual(emptied.json()["purged"], 1)
        self.assertEqual([row["id"] for row in (await self.list_items("trash"))["items"]], [first["id"]])
        self.assertEqual([row["id"] for row in (await self.list_items("trash", owner="bob"))["items"]], [foreign["id"]])
        async with self.sessions() as session:
            self.assertIsNotNone(await session.get(LibraryItem, first["id"]))
            self.assertIsNone(await session.get(LibraryItem, second["id"]))

        self.store.fail_delete.clear()
        self.assertEqual((await self.request("DELETE", "/trash")).json()["purged"], 1)
        self.assertEqual((await self.list_items("trash"))["items"], [])
        self.assertEqual((await self.list_items("trash", owner="bob"))["items"][0]["id"], foreign["id"])

    async def test_foreign_owner_cannot_read_download_restore_purge_or_empty_another_trash(self):
        item = await self.create_item()
        folder = await self.create_folder()
        self.assertEqual((await self.request("PATCH", f"/items/{item['id']}", owner="bob", json={"title": "hijack"})).status_code, 404)
        self.assertEqual((await self.request("GET", f"/items/{item['id']}/content", owner="bob")).status_code, 404)
        self.assertEqual((await self.request("GET", f"/items/{item['id']}/download", owner="bob")).status_code, 404)
        self.assertEqual((await self.request("DELETE", f"/items/{item['id']}", owner="bob")).status_code, 404)
        self.assertEqual((await self.request("DELETE", f"/folders/{folder['id']}", owner="bob")).status_code, 404)

        self.assertEqual((await self.request("DELETE", f"/items/{item['id']}")).status_code, 200)
        for method, path in (("POST", f"/items/{item['id']}/restore"), ("DELETE", f"/items/{item['id']}/purge")):
            self.assertEqual((await self.request(method, path, owner="bob")).status_code, 404)
        self.assertEqual((await self.request("DELETE", "/trash", owner="bob")).json()["purged"], 0)
        self.assertEqual([row["id"] for row in (await self.list_items("trash"))["items"]], [item["id"]])

    async def test_deleted_folder_can_be_removed_and_item_restores_to_root(self):
        folder = await self.create_folder("temporary")
        item = await self.create_item(folder_id=folder["id"])
        self.assertEqual((await self.request("DELETE", f"/folders/{folder['id']}" )).status_code, 409)
        self.assertEqual((await self.request("DELETE", f"/items/{item['id']}" )).status_code, 200)
        deleted_folder = await self.request("DELETE", f"/folders/{folder['id']}")
        self.assertEqual(deleted_folder.status_code, 200, deleted_folder.text)
        restored = await self.request("POST", f"/items/{item['id']}/restore")
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertIsNone(restored.json()["item"]["folderId"])
        root = await self.list_items()
        self.assertEqual([row["id"] for row in root["items"]], [item["id"]])

    async def test_multipart_upload_creates_owner_prefix_and_supports_folder_favorite_delete(self):
        """The first upload materializes the user's MinIO prefix.

        MinIO/S3 does not have physical directories: a folder is represented by
        the object key prefix.  The endpoint must therefore derive that prefix
        before the first PUT and keep it stable for all objects owned by the
        same user.  Metadata folders remain independent and can be supplied to
        a multipart upload.
        """
        upload = await self.request(
            "POST",
            "/items/upload",
            files={"file": ("guide.txt", b"uploaded guide", "text/plain")},
        )
        self.assertEqual(upload.status_code, 200, upload.text)
        item = upload.json()["item"]
        self.assertIsNone(item["folderId"])
        self.assertEqual(item["filename"], "guide.txt")
        self.assertEqual(item["size"], len(b"uploaded guide"))
        self.assertEqual(item["kind"], "document")
        self.assertEqual(len(self.store.objects), 1)
        key = next(iter(self.store.objects))
        alice_prefix = library_storage.owner_prefix("alice")
        self.assertTrue(key.startswith(alice_prefix), key)

        docs = await self.create_folder("docs")
        nested = await self.request(
            "POST",
            "/items/upload",
            data={"folderId": docs["id"]},
            files={"file": ("nested.txt", b"nested", "text/plain")},
        )
        self.assertEqual(nested.status_code, 200, nested.text)
        self.assertEqual(nested.json()["item"]["folderId"], docs["id"])
        self.assertEqual(nested.json()["item"]["size"], len(b"nested"))

        # A second object from the same owner reuses the same prefix while
        # another owner receives a different, non-guessable namespace.
        second_key = next(k for k in self.store.objects if k != key)
        self.assertEqual(len(self.store.objects), 2)
        self.assertTrue(all(k.startswith(alice_prefix) for k in self.store.objects), self.store.objects)
        self.assertNotEqual(key, second_key)

        foreign = await self.request(
            "POST",
            "/items/upload",
            owner="bob",
            files={"file": ("bob.txt", b"bob", "text/plain")},
        )
        self.assertEqual(foreign.status_code, 200, foreign.text)
        bob_prefix = library_storage.owner_prefix("bob")
        self.assertNotEqual(alice_prefix, bob_prefix)
        self.assertTrue(any(k.startswith(bob_prefix) for k in self.store.objects), self.store.objects)
        self.assertEqual(len([k for k in self.store.objects if k.startswith(alice_prefix)]), 2)

        favorited = await self.request(
            "PATCH", f"/items/{item['id']}", json={"favorite": True}
        )
        self.assertEqual(favorited.status_code, 200, favorited.text)
        self.assertTrue(favorited.json()["item"]["favorite"])
        nested_favorite = await self.request(
            "PATCH", f"/items/{nested.json()['item']['id']}", json={"favorite": True}
        )
        self.assertEqual(nested_favorite.status_code, 200, nested_favorite.text)
        favorites = await self.list_items("favorites")
        self.assertEqual({row["id"] for row in favorites["items"]}, {item["id"], nested.json()["item"]["id"]})
        self.assertEqual(
            (await self.list_items("favorites", owner="bob"))["items"], []
        )

        deleted = await self.request("DELETE", f"/items/{item['id']}")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertTrue(deleted.json()["trashed"])
        self.assertEqual(
            [row["id"] for row in (await self.list_items("favorites"))["items"]],
            [nested.json()["item"]["id"]],
        )
        self.assertEqual(
            [row["id"] for row in (await self.list_items("trash"))["items"]],
            [item["id"]],
        )


    async def test_source_metadata_roundtrip_and_conversation_association(self):
        """Provenance fields: declared at save time, read-only, linkable later."""
        # A note cannot smuggle soduWorkSource through free-form extra.
        smuggled = await self.request(
            "POST", "/items",
            json={"kind": "note", "title": "smuggle",
                  "content": "hi", "extra": {"soduWorkSource": {"type": "conversation"}}},
        )
        self.assertEqual(smuggled.status_code, 400, smuggled.text)

        created = await self.request(
            "POST", "/items",
            json={"kind": "note", "title": "from chat", "content": "hi",
                  "sourceType": "conversation", "sessionId": "sess-2024-01",
                  "conversationTitle": "周报整理"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        item = created.json()["item"]
        self.assertEqual(item["sourceType"], "conversation")
        self.assertEqual(item["sourceLabel"], "会话文件")
        self.assertEqual(item["sessionId"], "sess-2024-01")
        self.assertEqual(item["conversationTitle"], "周报整理")

        # A conversation tag without a session id is downgraded to an honest
        # manual upload instead of a dead link.
        no_session = await self.request(
            "POST", "/items",
            json={"kind": "note", "title": "no session", "content": "hi",
                  "sourceType": "conversation"},
        )
        self.assertEqual(no_session.status_code, 200, no_session.text)
        self.assertEqual(no_session.json()["item"]["sourceType"], "upload")

        # Malformed session ids are rejected outright.
        bad_session = await self.request(
            "POST", "/items",
            json={"kind": "note", "title": "bad", "content": "hi",
                  "sessionId": "../etc/passwd"},
        )
        self.assertEqual(bad_session.status_code, 400, bad_session.text)

        # Whole-extra replacement keeps the reserved source block and the
        # derived fields stable.
        renamed_extra = await self.request(
            "PATCH", f"/items/{item['id']}",
            json={"extra": {"userTag": "keep-me"}},
        )
        self.assertEqual(renamed_extra.status_code, 200, renamed_extra.text)
        kept = renamed_extra.json()["item"]
        self.assertEqual(kept["extra"].get("soduWorkSource", {}).get("sessionId"), "sess-2024-01")
        self.assertEqual(kept["extra"].get("userTag"), "keep-me")
        self.assertEqual(kept["sourceType"], "conversation")

    async def test_attach_source_after_the_fact_is_idempotent_and_owner_scoped(self):
        """Draft attachments link to their conversation once it exists."""
        upload = await self.request(
            "POST", "/items/upload",
            files={"file": ("draft.txt", b"draft", "text/plain")},
        )
        self.assertEqual(upload.status_code, 200, upload.text)
        item_id = upload.json()["item"]["id"]
        self.assertEqual(upload.json()["item"]["sourceType"], "upload")

        linked = await self.request(
            "POST", f"/items/{item_id}/source",
            json={"sourceType": "conversation", "sessionId": "draft-sess-01",
                  "conversationTitle": "新建对话"},
        )
        self.assertEqual(linked.status_code, 200, linked.text)
        self.assertTrue(linked.json()["updated"])
        updated = linked.json()["item"]
        self.assertEqual(updated["sourceType"], "conversation")
        self.assertEqual(updated["sessionId"], "draft-sess-01")

        # Calling again with a new title keeps the first association.
        again = await self.request(
            "POST", f"/items/{item_id}/source",
            json={"sourceType": "conversation", "sessionId": "other-sess-99",
                  "conversationTitle": "另一个会话"},
        )
        self.assertEqual(again.status_code, 200, again.text)
        self.assertFalse(again.json()["updated"])
        self.assertEqual(again.json()["item"]["sessionId"], "draft-sess-01")

        # A non-conversation source payload is rejected.
        bad = await self.request(
            "POST", f"/items/{item_id}/source", json={"sourceType": "library"}
        )
        self.assertEqual(bad.status_code, 400, bad.text)

        # Other owners cannot touch the association.
        foreign = await self.request(
            "POST", f"/items/{item_id}/source", owner="bob",
            json={"sourceType": "conversation", "sessionId": "bob-sess-001"},
        )
        self.assertEqual(foreign.status_code, 404, foreign.text)

    async def test_delivery_items_keep_conversation_provenance(self):
        """Delivery snapshots stay authoritative for conversation provenance."""
        # Delivery manifests are written by the delivery pipeline, not by the
        # library create endpoint; simulate that exactly via a direct insert.
        delivery_extra = {"soduWorkDelivery": {
            "source": "cloud", "sessionId": "cloud-sess-01",
            "revision": "r1", "files": [{
                "path": "report.txt", "checksum": "abc",
                "size": 2, "contentType": "text/plain"}]}}
        async with self.sessions() as session:
            row = LibraryItem(owner_key="alice", kind="note", title="delivered",
                              filename="delivered.txt", content_type="text/plain",
                              size=2, storage_key="fake", backend="minio",
                              extra=delivery_extra)
            session.add(row)
            await session.commit()
            item_id = row.id
        listing = await self.list_items("recommended")
        item = next(r for r in listing["items"] if r["id"] == item_id)
        self.assertEqual(item["sourceType"], "cloud_conversation")
        self.assertEqual(item["sourceLabel"], "云端会话成果")
        self.assertEqual(item["sessionId"], "cloud-sess-01")

        # The conversation association endpoint must not overwrite it.
        attached = await self.request(
            "POST", f"/items/{item['id']}/source",
            json={"sourceType": "conversation", "sessionId": "later-sess-02"},
        )
        self.assertEqual(attached.status_code, 200, attached.text)
        self.assertFalse(attached.json()["updated"])
        self.assertEqual(attached.json()["item"]["sessionId"], "cloud-sess-01")


if __name__ == "__main__":
    unittest.main()
