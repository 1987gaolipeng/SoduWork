"""Isolated cache, storage-pool and thumbnail regressions; no external storage."""
import asyncio
import io
import tempfile
import threading
import unittest
import zipfile
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from tests.test_library import LibraryHttpTestCase
from app.db import Base
from app.deps import current_client
from app.library_models import LibraryFolder, LibraryItem
from app.models import AppSetting, Client, User
from app.services import device_auth, library_read_cache, library_storage, library_thumbnail


class ReadWorkCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_singleflight_cancelled_reader_and_defensive_copies(self):
        cache = library_read_cache.ReadWorkCache()
        entered, release = asyncio.Event(), threading.Event()
        loop = asyncio.get_running_loop()
        calls = []
        def work():
            calls.append(1)
            loop.call_soon_threadsafe(entered.set)
            if not release.wait(5):
                raise TimeoutError("isolated test failed to release worker")
            return {"items": [1]}
        tasks = [asyncio.create_task(cache.get("same", work)) for _ in range(20)]
        try:
            await asyncio.wait_for(entered.wait(), 2)
            tasks[0].cancel()
            with self.assertRaises(asyncio.CancelledError):
                await tasks[0]
        finally:
            release.set()
        values = await asyncio.gather(*tasks[1:])
        self.assertEqual(len(calls), 1)
        values[0]["items"].append(2)
        self.assertEqual(await cache.get("same", work), {"items": [1]})

    async def test_concurrency_and_pending_are_bounded(self):
        cache = library_read_cache.ReadWorkCache(concurrency=2, pending=4)
        loop = asyncio.get_running_loop()
        entered, release = asyncio.Event(), threading.Event()
        lock = threading.Lock()
        active, peak = 0, 0
        def work():
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(active, peak)
                if active == 2:
                    loop.call_soon_threadsafe(entered.set)
            try:
                if not release.wait(5):
                    raise TimeoutError("isolated test failed to release worker")
                return "ok"
            finally:
                with lock:
                    active -= 1
        tasks = [asyncio.create_task(cache.get(i, work)) for i in range(4)]
        try:
            await asyncio.wait_for(entered.wait(), 2)
            with self.assertRaises(library_storage.LibraryStorageError) as raised:
                await cache.get("overflow", work)
            self.assertEqual(raised.exception.code, "LIBRARY_READ_BUSY")
        finally:
            release.set()
        self.assertEqual(await asyncio.gather(*tasks), ["ok"] * 4)
        self.assertEqual(peak, 2)

    async def test_partition_expiry_failures_and_memory_budget(self):
        cache = library_read_cache.ReadWorkCache(entries=2, max_bytes=4)
        calls = []
        def work(value):
            def run():
                calls.append(value)
                return value
            return run
        self.assertEqual(await cache.get(("alice", "file"), work(b"aa"), size=len), b"aa")
        self.assertEqual(await cache.get(("bob", "file"), work(b"bb"), size=len), b"bb")
        self.assertEqual(await cache.get(("alice", "file"), work(b"xx"), size=len), b"aa")
        await cache.get("oversized", work(b"large"), size=len)
        await cache.get("oversized", work(b"large"), size=len)
        self.assertEqual(calls.count(b"large"), 2)
        await cache.get("eviction", work(b"cc"), size=len)
        self.assertEqual(await cache.get(("bob", "file"), work(b"dd"), size=len), b"dd")
        await cache.get("expired", work(b"ee"), ttl=-1, size=len)
        self.assertEqual(await cache.get("expired", work(b"ff"), size=len), b"ff")
        def fail():
            raise OSError("isolated failure")
        with self.assertRaises(OSError):
            await cache.get("retry", fail)
        self.assertEqual(await cache.get("retry", work(b"ok"), size=len), b"ok")

    async def test_health_cache_is_partitioned_by_effective_configuration(self):
        values = {"library_storage_dir": "first", "minio_endpoint": "one", "other": "ignored"}
        calls = []
        def probe(backend=None):
            calls.append(1)
            return True
        with patch.object(library_read_cache, "health", library_read_cache.ReadWorkCache()), \
             patch.object(library_storage, "get_settings", return_value=SimpleNamespace(model_dump=lambda: values)), \
             patch.object(library_storage, "ensure_ready", probe):
            await library_read_cache.ensure_ready("nfs", lambda: probe("nfs"))
            await library_read_cache.ensure_ready("nfs", lambda: probe("nfs"))
            values["other"] = "still ignored"
            await library_read_cache.ensure_ready("nfs", lambda: probe("nfs"))
            self.assertEqual(len(calls), 1)
            values["library_storage_dir"] = "second"
            await library_read_cache.ensure_ready("nfs", lambda: probe("nfs"))
            self.assertEqual(len(calls), 2)

    async def test_status_and_list_share_the_selected_provider_probe(self):
        calls = Counter()
        def probe(backend=None):
            calls[backend] += 1
            return True
        with patch.object(library_read_cache, "health", library_read_cache.ReadWorkCache()), \
             patch.object(library_storage, "remote_order", return_value=["nfs", "minio"]), \
             patch.object(library_storage, "_remote_configuration", return_value={}), \
             patch.object(library_storage, "storage_backend", return_value="nfs"), \
             patch.object(library_storage, "ensure_ready", probe):
            # Exercise both request orders, aliases/defaults, and cache reuse.
            values = await asyncio.gather(
                library_read_cache.ensure_ready(None, lambda: probe("nfs")),
                library_read_cache.storage_status(),
                library_read_cache.ensure_ready("remote", lambda: probe("nfs")))
            self.assertTrue(values[1]["remote"]["connected"])
            self.assertEqual(calls, {"local": 1, "nfs": 1})
            again = await library_read_cache.storage_status()
            self.assertEqual(calls, {"local": 1, "nfs": 1})
            self.assertEqual(again["minio"]["state"], "standby")
            # Explicit reads of an existing standby provider remain independent.
            await library_read_cache.ensure_ready("minio", lambda: probe("minio"))
            self.assertEqual(calls["minio"], 1)

    async def test_failed_probe_is_shared_without_losing_error_semantics(self):
        calls = Counter()
        def probe(backend=None):
            calls[backend] += 1
            if backend == "nfs":
                raise library_storage.LibraryStorageError("LIBRARY_NFS_ACCESS_DENIED", "fixture denied", False)
            return True
        with patch.object(library_read_cache, "health", library_read_cache.ReadWorkCache()), \
             patch.object(library_storage, "remote_order", return_value=["nfs"]), \
             patch.object(library_storage, "_remote_configuration", return_value={}), \
             patch.object(library_storage, "ensure_ready", probe):
            status = await library_read_cache.storage_status()
            self.assertFalse(status["remote"]["connected"])
            self.assertEqual(status["remote"]["code"], "LIBRARY_NFS_ACCESS_DENIED")
            for _ in range(2):
                with self.assertRaises(library_storage.LibraryStorageError) as caught:
                    await library_read_cache.ensure_ready("nfs", lambda: probe("nfs"))
                self.assertEqual(caught.exception.code, "LIBRARY_NFS_ACCESS_DENIED")
                self.assertEqual(caught.exception.message, "fixture denied")
                self.assertFalse(caught.exception.retryable)
            self.assertEqual(calls, {"local": 1, "nfs": 1})


class LibraryReadHttpTests(LibraryHttpTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.engine.dispose()
        self.tmp = tempfile.TemporaryDirectory(prefix="soduwork-library-read-")
        self.engine = create_async_engine("sqlite+aiosqlite:///" + (Path(self.tmp.name) / "test.db").as_posix(),
            pool_size=1, max_overflow=0, pool_timeout=2)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
                LibraryFolder.__table__, LibraryItem.__table__, Client.__table__, User.__table__, AppSetting.__table__]))
        self.tokens = {}
        async with self.sessions() as session:
            for owner in ("alice", "bob"):
                client = Client(id="device-" + owner, user_ref=owner, auth_state="active", auth_version=1)
                session.add_all([User(id=owner, username=owner), client])
                self.tokens[owner] = device_auth.issue_session(client)[0]
            await session.commit()
        # Use real signed device authentication and its database identity query.
        self.app.dependency_overrides.pop(current_client)
        self.patches = [patch.object(device_auth, "should_write_last_seen", return_value=False),
            patch.object(library_read_cache, "health", library_read_cache.ReadWorkCache()),
            patch.object(library_thumbnail, "cache", library_read_cache.ReadWorkCache())]
        for replacement in self.patches:
            replacement.start()

    async def asyncTearDown(self):
        for replacement in reversed(self.patches):
            replacement.stop()
        await super().asyncTearDown()
        self.tmp.cleanup()

    async def request(self, method, path, owner="alice", **kwargs):
        headers = dict(kwargs.pop("headers", {}))
        headers["Authorization"] = "Device " + self.tokens[owner]
        return await super().request(method, path, owner=owner, headers=headers, **kwargs)

    async def test_blocked_storage_probes_do_not_hold_the_authenticated_pool_connection(self):
        for path in ["/storage/status", ""]:
            with self.subTest(path=path):
                entered, release = asyncio.Event(), threading.Event()
                loop = asyncio.get_running_loop()
                def probe(*args, **kwargs):
                    loop.call_soon_threadsafe(entered.set)
                    if not release.wait(5):
                        raise TimeoutError("isolated test failed to release probe")
                    return True
                with patch.object(library_storage, "ensure_ready", probe):
                    request = asyncio.create_task(self.request("GET", path))
                    try:
                        await asyncio.wait_for(entered.wait(), 2)
                        self.assertFalse(request.done(), "request must still await the blocked external probe")
                        async with self.sessions() as session:
                            self.assertEqual(await asyncio.wait_for(session.scalar(select(1)), 1), 1)
                    finally:
                        release.set()
                    response = await asyncio.wait_for(request, 3)
                    self.assertEqual(response.status_code, 200, response.text)

    async def test_content_and_archive_reads_release_the_authenticated_pool_connection(self):
        zipped = io.BytesIO()
        with zipfile.ZipFile(zipped, "w") as archive:
            archive.writestr("note.txt", "ok")
        zip_bytes = zipped.getvalue()
        async with self.sessions() as session:
            session.add_all([
                LibraryItem(id="plain", owner_key="alice", kind="document", backend="local",
                            storage_key="plain", filename="note.txt", size=2),
                LibraryItem(id="zipped", owner_key="alice", kind="file", backend="local",
                            storage_key="zipped", filename="notes.zip", size=len(zip_bytes)),
            ])
            await session.commit()
        for path in ["/items/plain/content", "/items/zipped/archive",
                     "/items/zipped/archive/file?path=note.txt&preview=true"]:
            with self.subTest(path=path):
                entered, release = asyncio.Event(), threading.Event()
                loop = asyncio.get_running_loop()
                def read(key, *args, **kwargs):
                    loop.call_soon_threadsafe(entered.set)
                    if not release.wait(5):
                        raise TimeoutError("isolated test failed to release reader")
                    return b"ok" if key == "plain" else zip_bytes
                with patch.object(library_storage, "read_bytes", read):
                    request = asyncio.create_task(self.request("GET", path))
                    try:
                        await asyncio.wait_for(entered.wait(), 2)
                        self.assertFalse(request.done())
                        async with self.sessions() as session:
                            self.assertEqual(await asyncio.wait_for(session.scalar(select(1)), 1), 1)
                    finally:
                        release.set()
                    response = await asyncio.wait_for(request, 3)
                    self.assertEqual(response.status_code, 200, response.text)

    async def image_item(self, owner="alice", name="photo", color="red", size=(1024, 512)):
        buffer = io.BytesIO()
        Image.new("RGB", size, color).save(buffer, format="PNG")
        data = buffer.getvalue()
        key = f"{owner}/{name}.png"
        self.store.objects[key] = data
        async with self.sessions() as session:
            item = LibraryItem(id=owner + "-" + name, owner_key=owner, kind="image", backend="local",
                storage_key=key, filename=name + ".png", content_type="image/png", size=len(data))
            session.add(item)
            await session.commit()
        return item.id

    async def test_thumbnail_requires_current_owner_auth_and_bounds_dimensions(self):
        alice = await self.image_item()
        bob = await self.image_item("bob", color="blue")
        self.assertEqual((await self.http.get(f"/api/v1/library/items/{alice}/thumbnail")).status_code, 401)
        self.assertEqual((await self.request("GET", f"/items/{alice}/thumbnail", owner="bob")).status_code, 404)
        first = await self.request("GET", f"/items/{alice}/thumbnail")
        self.assertEqual(first.status_code, 200, first.text[:100] if first.status_code != 200 else "")
        self.assertEqual(first.headers["cache-control"], "private, no-store")
        with Image.open(io.BytesIO(first.content)) as image:
            self.assertEqual(image.size, (256, 128))
            self.assertEqual(image.getpixel((0, 0))[:3], (255, 0, 0))
        second = await self.request("GET", f"/items/{bob}/thumbnail", owner="bob")
        with Image.open(io.BytesIO(second.content)) as image:
            self.assertEqual(image.getpixel((0, 0))[:3], (0, 0, 255))
        # A populated thumbnail cache must not bypass later account revocation.
        async with self.sessions() as session:
            owner = await session.get(User, "alice")
            owner.is_active = False
            await session.commit()
        self.assertEqual((await self.request("GET", f"/items/{alice}/thumbnail")).status_code, 403)

    async def test_thumbnail_rechecks_item_revision_and_owner_after_cache_fill(self):
        item_id = await self.image_item()
        path = f"/items/{item_id}/thumbnail"
        first = await self.request("GET", path)
        self.assertEqual(first.status_code, 200)
        buffer = io.BytesIO()
        Image.new("RGB", (600, 300), "green").save(buffer, format="PNG")
        self.store.objects["replacement.png"] = buffer.getvalue()
        async with self.sessions() as session:
            item = await session.get(LibraryItem, item_id)
            item.storage_key = "replacement.png"
            item.updated_at = datetime.now(timezone.utc) + timedelta(seconds=1)
            item.size = len(buffer.getvalue())
            await session.commit()
        changed = await self.request("GET", path)
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.content, first.content)
        async with self.sessions() as session:
            item = await session.get(LibraryItem, item_id)
            item.owner_key = "bob"
            await session.commit()
        self.assertEqual((await self.request("GET", path)).status_code, 404)

    async def test_oversized_metadata_rejected_before_opening_original(self):
        item_id = await self.image_item()
        async with self.sessions() as session:
            item = await session.get(LibraryItem, item_id)
            item.size = library_thumbnail.MAX_SOURCE + 1
            await session.commit()
        with patch.object(library_storage, "open_stream", side_effect=AssertionError("must not download original")):
            response = await self.request("GET", f"/items/{item_id}/thumbnail")
        self.assertEqual(response.status_code, 413)


class ThumbnailStreamTests(unittest.TestCase):
    def test_oversized_or_invalid_input_closes_and_releases_stream(self):
        class Tracked(io.BytesIO):
            released = False
            def release_conn(self):
                self.released = True
        for content in [b"not an image", b"x" * 33]:
            with self.subTest(length=len(content)):
                stream = Tracked(content)
                with patch.object(library_thumbnail, "MAX_SOURCE", 32), self.assertRaises(library_storage.LibraryStorageError):
                    library_thumbnail.render(lambda: stream)
                self.assertTrue(stream.closed)
                self.assertTrue(stream.released)

    def test_decoded_pixel_budget_closes_original_stream(self):
        buffer = io.BytesIO()
        Image.new("RGB", (20, 20)).save(buffer, format="PNG")
        stream = io.BytesIO(buffer.getvalue())
        with patch.object(library_thumbnail, "MAX_PIXELS", 399), self.assertRaises(library_storage.LibraryStorageError):
            library_thumbnail.render(lambda: stream)
        self.assertTrue(stream.closed)
