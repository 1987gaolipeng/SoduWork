"""Provider-pinned library API behavior; no real disk or remote service access."""
import asyncio
import io
import socket
from types import SimpleNamespace
from unittest.mock import patch
from zipfile import ZipFile

import httpx
from sqlalchemy.ext.asyncio import AsyncSession
import uvicorn

from tests.test_library import LibraryHttpTestCase
from app.library_models import LibraryItem
from app.services import library_storage
from app.services import library_nfs
from tests.nfs_wire_fixture import Peer


class _ProviderStores:
    def __init__(self):
        self.objects = {"local": {}, "minio": {}, "nfs": {}}
        self.remote = "nfs"
        self.default = "local"
        self.unavailable = set()
        self.after_ready = None
        self.after_write = None

    def resolve(self, backend=None):
        value = str(backend or self.default).lower().strip()
        if value == "remote":
            if not self.remote:
                raise library_storage.LibraryStorageError("LIBRARY_STORAGE_NOT_CONFIGURED", retryable=False)
            return self.remote
        if value not in self.objects:
            raise library_storage.LibraryStorageError("LIBRARY_STORAGE_NOT_CONFIGURED", retryable=False)
        return value

    def ensure_ready(self, backend=None):
        selected = self.resolve(backend)
        if selected in self.unavailable:
            raise library_storage.LibraryStorageError("LIBRARY_STORAGE_UNAVAILABLE")
        if self.after_ready:
            self.after_ready()
        return True

    def put_bytes(self, key, data, content_type, backend=None):
        selected = self.resolve(backend)
        self.objects[selected][key] = bytes(data)
        if self.after_write:
            self.after_write()
        return selected

    def put_stream(self, key, handle, size, content_type, backend=None):
        return self.put_bytes(key, handle.read(size), content_type, backend)

    def read_bytes(self, key, limit=16 * 1024 * 1024, backend=None):
        try:
            data = self.objects[self.resolve(backend)][key]
        except KeyError as exc:
            raise FileNotFoundError(key) from exc
        if len(data) > limit:
            raise ValueError("too large")
        return data

    def open_stream(self, key, backend=None):
        return io.BytesIO(self.read_bytes(key, 64 * 1024 * 1024, backend))

    def delete(self, key, backend=None):
        self.objects[self.resolve(backend)].pop(key, None)


class LibraryRemoteHttpTests(LibraryHttpTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.providers = _ProviderStores()
        self.provider_patch = patch.multiple(
            library_storage,
            resolve_backend=self.providers.resolve,
            storage_backend=lambda: self.providers.resolve(),
            ensure_ready=self.providers.ensure_ready,
            put_bytes=self.providers.put_bytes,
            put_stream=self.providers.put_stream,
            read_bytes=self.providers.read_bytes,
            open_stream=self.providers.open_stream,
            delete=self.providers.delete,
        )
        self.provider_patch.start()

    async def asyncTearDown(self):
        self.provider_patch.stop()
        await super().asyncTearDown()

    async def folder(self, storage, name="docs", **extra):
        response = await self.request("POST", "/folders", json={"name": name, "storage": storage, **extra})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["folder"]

    async def note(self, storage, content="NFS content", **extra):
        response = await self.request("POST", "/items", json={
            "kind": "note", "title": "report", "content": content, "storage": storage, **extra})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["item"]

    async def test_nfs_upload_read_preview_and_owner_isolation(self):
        folder = await self.folder("nfs")
        response = await self.request("POST", "/items/upload", data={"storage": "nfs", "folderId": folder["id"]},
                                      files={"file": ("说明.txt", "中文原文".encode(), "text/plain")})
        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()["item"]
        self.assertEqual(item["backend"], "nfs")
        for suffix in ("/content", "/content?preview=true"):
            result = await self.request("GET", f"/items/{item['id']}" + suffix)
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["content"], "中文原文")
        downloaded = await self.request("GET", f"/items/{item['id']}/download")
        self.assertEqual(downloaded.status_code, 200, downloaded.text)
        self.assertEqual(downloaded.content, "中文原文".encode())
        listing = await self.request("GET", "", params={"scope": "all", "storage": "nfs", "folderId": folder["id"]})
        self.assertEqual([row["id"] for row in listing.json()["items"]], [item["id"]])
        foreign_listing = await self.request("GET", "", owner="bob", params={"scope": "all", "storage": "nfs"})
        self.assertEqual(foreign_listing.json()["items"], [])
        for method, suffix in (("GET", "/content"), ("GET", "/download"), ("DELETE", "")):
            self.assertEqual((await self.request(method, f"/items/{item['id']}" + suffix, owner="bob")).status_code, 404)

    async def test_nfs_zip_listing_member_and_recycle_purge_use_persisted_backend(self):
        output = io.BytesIO()
        with ZipFile(output, "w") as archive:
            archive.writestr("资料/说明.txt", "archive content")
        response = await self.request("POST", "/items/upload", data={"storage": "remote"},
                                      files={"file": ("资料.zip", output.getvalue(), "application/zip")})
        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()["item"]
        self.providers.remote = "minio"
        archive = await self.request("GET", f"/items/{item['id']}/archive")
        self.assertEqual(archive.status_code, 200, archive.text)
        self.assertEqual(archive.json()["archive"]["fileCount"], 1)
        member = await self.request("GET", f"/items/{item['id']}/archive/file", params={"path": "资料/说明.txt"})
        self.assertEqual(member.status_code, 200, member.text)
        self.assertEqual(member.content, b"archive content")
        preview = await self.request("GET", f"/items/{item['id']}/archive/file", params={"path": "资料/说明.txt", "preview": True})
        self.assertEqual(preview.json()["content"], "archive content")
        self.assertEqual((await self.request("GET", f"/items/{item['id']}/archive", owner="bob")).status_code, 404)
        self.assertEqual((await self.request("GET", f"/items/{item['id']}/archive/file", owner="bob", params={"path": "资料/说明.txt"})).status_code, 404)
        self.assertEqual((await self.request("DELETE", f"/items/{item['id']}")).status_code, 200)
        self.assertEqual((await self.request("GET", f"/items/{item['id']}/archive")).status_code, 404)
        self.assertEqual((await self.request("DELETE", f"/items/{item['id']}/purge", owner="bob")).status_code, 404)
        self.assertEqual(len(self.providers.objects["nfs"]), 1)
        self.assertEqual((await self.request("DELETE", f"/items/{item['id']}/purge")).status_code, 200)
        self.assertEqual(self.providers.objects["nfs"], {})

    async def test_nfs_edit_and_folder_moves_preserve_backend(self):
        nfs_folder = await self.folder("nfs")
        minio_folder = await self.folder("minio")
        item = await self.note("nfs", folderId=nfs_folder["id"])
        old_key = next(iter(self.providers.objects["nfs"]))
        self.providers.remote = "minio"
        result = await self.request("PATCH", f"/items/{item['id']}", json={"content": "updated", "title": "edited"})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["item"]["backend"], "nfs")
        self.assertNotIn(old_key, self.providers.objects["nfs"])
        self.assertEqual(list(self.providers.objects["nfs"].values()), [b"updated"])
        self.assertEqual(self.providers.objects["local"], {})
        self.assertEqual(self.providers.objects["minio"], {})
        moved = await self.request("PATCH", f"/items/{item['id']}", json={"folderId": minio_folder["id"]})
        self.assertEqual(moved.status_code, 409, moved.text)
        nested = await self.folder("", name="nested", parentId=nfs_folder["id"])
        self.assertEqual(nested["backend"], "nfs")
        listing = await self.request("GET", "", params={"scope": "folders", "storage": "nfs"})
        self.assertEqual([row["id"] for row in listing.json()["folders"]], [nfs_folder["id"]])

    async def test_remote_is_pinned_before_storage_probe_and_old_ids_survive_priority_change(self):
        self.providers.after_ready = lambda: setattr(self.providers, "remote", "minio")
        item = await self.note("remote")
        self.assertEqual(item["backend"], "nfs")
        self.assertEqual(list(self.providers.objects["nfs"].values()), [b"NFS content"])
        self.assertEqual(self.providers.objects["minio"], {})
        current = await self.note("remote", content="MinIO content")
        self.assertEqual(current["backend"], "minio")
        for storage, expected in (("nfs", item["id"]), ("remote", current["id"])):
            listing = await self.request("GET", "", params={"scope": "all", "storage": storage})
            self.assertEqual([row["id"] for row in listing.json()["items"]], [expected])
        original = await self.request("GET", f"/items/{item['id']}/content")
        self.assertEqual(original.status_code, 200, original.text)
        self.assertEqual(original.json()["content"], "NFS content")

    async def test_remote_failure_does_not_fall_back_to_other_provider(self):
        self.providers.unavailable.add("nfs")
        response = await self.request("POST", "/items", json={"kind": "note", "content": "unsafe fallback", "storage": "remote"})
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json()["detail"]["code"], "LIBRARY_STORAGE_UNAVAILABLE")
        self.assertEqual(self.providers.objects, {"local": {}, "minio": {}, "nfs": {}})

    async def test_remote_without_configuration_returns_storage_error_not_invalid_argument(self):
        self.providers.remote = ""
        response = await self.request("GET", "", params={"storage": "remote"})
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json()["detail"]["code"], "LIBRARY_STORAGE_NOT_CONFIGURED")
        self.assertFalse(response.json()["detail"]["retryable"])
        invalid = await self.request("GET", "", params={"storage": "unknown-provider"})
        self.assertEqual(invalid.status_code, 400, invalid.text)
        self.providers.default = "remote"
        for path, body in (("/folders", {"name": "unconfigured"}), ("/items", {"kind": "note", "content": "unconfigured"})):
            implicit = await self.request("POST", path, json=body)
            self.assertEqual(implicit.status_code, 503, implicit.text)
            self.assertEqual(implicit.json()["detail"]["code"], "LIBRARY_STORAGE_NOT_CONFIGURED")

    async def test_remote_folders_store_provider_identity_and_keep_children_when_priority_changes(self):
        original = await self.folder("remote")
        self.assertEqual(original["backend"], "nfs")
        self.providers.remote = "minio"
        newer = await self.folder("remote")
        self.assertEqual(newer["backend"], "minio")
        nested = await self.folder("", name="nested", parentId=original["id"])
        self.assertEqual(nested["backend"], "nfs")
        original_listing = await self.request("GET", "", params={"scope": "all", "storage": "nfs", "folderId": original["id"]})
        self.assertEqual(original_listing.status_code, 200, original_listing.text)
        self.assertEqual([row["id"] for row in original_listing.json()["folders"]], [nested["id"]])
        wrong_provider = await self.request("GET", "", params={"scope": "all", "storage": "remote", "folderId": original["id"]})
        self.assertEqual(wrong_provider.status_code, 409, wrong_provider.text)

    async def test_commit_failure_cleans_the_written_provider_after_priority_change(self):
        self.providers.after_write = lambda: setattr(self.providers, "remote", "minio")
        with patch.object(AsyncSession, "commit", side_effect=RuntimeError("isolated commit failure")):
            with self.assertRaisesRegex(RuntimeError, "isolated commit failure"):
                await self.request("POST", "/items/upload", data={"storage": "remote"}, files={"file": ("test.txt", b"upload", "text/plain")})
        self.assertEqual(self.providers.objects, {"local": {}, "minio": {}, "nfs": {}})
        async with self.sessions() as session:
            from sqlalchemy import select
            self.assertEqual(list((await session.execute(select(LibraryItem))).scalars()), [])


class LibraryNfsWireHttpTests(LibraryHttpTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        # Keep the isolated HTTP/database fixture, but restore the real storage
        # dispatcher and NFS adapter so upload/read traverse the TCP/XDR peer.
        self.storage_patch.stop()
        self.peer = Peer()
        self.settings = SimpleNamespace(
            library_storage_backend="remote", library_remote_order="minio,nfs",
            library_minio_endpoint="", library_minio_access_key="", library_minio_secret_key="",
            library_minio_bucket="library-test", library_minio_secure=False,
            minio_endpoint="", minio_access_key="", minio_secret_key="", minio_bucket="", minio_secure=False,
            library_nfs_host="127.0.0.1", library_nfs_export="/isolated-library",
            library_nfs_port=self.peer.port, library_nfs_mount_port=self.peer.port,
            library_nfs_version=3, library_nfs_uid=1234, library_nfs_gid=2345, library_nfs_timeout=1,
        )
        self.storage_settings = patch.object(library_storage, "get_settings", return_value=self.settings)
        self.nfs_settings = patch.object(library_nfs, "get_settings", return_value=self.settings)
        self.storage_settings.start()
        self.nfs_settings.start()
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(16)
        self.http_server = uvicorn.Server(uvicorn.Config(self.app, log_level="critical", lifespan="off", ws="none"))
        self.http_run = asyncio.create_task(self.http_server.serve(sockets=[self.listener]))
        for _ in range(100):
            if self.http_server.started:
                break
            await asyncio.sleep(.01)
        self.assertTrue(self.http_server.started)
        await self.http.aclose()
        self.http = httpx.AsyncClient(base_url=f"http://127.0.0.1:{self.listener.getsockname()[1]}", trust_env=False)

    async def asyncTearDown(self):
        await self.http.aclose()
        self.http_server.should_exit = True
        await asyncio.wait_for(self.http_run, timeout=5)
        self.listener.close()
        self.nfs_settings.stop()
        self.storage_settings.stop()
        self.peer.stop()
        await super().asyncTearDown()

    async def test_remote_upload_over_real_nfs_tcp_remains_readable_after_priority_change(self):
        content = "来自真实 TCP/XDR 的资料\n第二行".encode("utf-8")
        response = await self.request("POST", "/items/upload", data={"storage": "remote"},
                                      files={"file": ("说明.txt", content, "text/plain")})
        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()["item"]
        self.assertEqual(item["backend"], "nfs")
        async with self.sessions() as session:
            row = await session.get(LibraryItem, item["id"])
            self.assertEqual(row.backend, "nfs")
            key = row.storage_key
        self.assertEqual(self.peer.resolve(key)["data"], content)
        self.assertEqual(self.peer.export, "/isolated-library")
        self.assertEqual(set(self.peer.auth), {(1234, 2345)})
        self.settings.library_minio_endpoint = "127.0.0.1:1"
        self.settings.library_minio_access_key = "isolated-access"
        self.settings.library_minio_secret_key = "isolated-secret"
        self.assertEqual(library_storage.resolve_backend("remote"), "minio")
        for suffix in ("/content", "/content?preview=true"):
            result = await self.request("GET", f"/items/{item['id']}" + suffix)
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["content"], content.decode("utf-8"))
        result = await self.request("GET", f"/items/{item['id']}/download")
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.content, content)
        for suffix in ("/content", "/download"):
            result = await self.request("GET", f"/items/{item['id']}" + suffix, owner="bob")
            self.assertEqual(result.status_code, 404, result.text)
        self.assertEqual((await self.request("DELETE", f"/items/{item['id']}")).status_code, 200)
        self.assertEqual((await self.request("DELETE", f"/items/{item['id']}/purge")).status_code, 200)
        self.assertNotIn(key.rsplit("/", 1)[-1], self.peer.resolve(key.rsplit("/", 1)[0])["children"])
