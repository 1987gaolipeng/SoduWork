"""Concurrent edits and storage moves must preserve the latest file and location."""
import asyncio
from contextlib import asynccontextmanager
import threading
import unittest
from unittest.mock import patch

from tests.test_library import LibraryHttpTestCase, _FakeMinio
from app.api import library
from app.library_models import LibraryItem
from app.services import library_conversation_save


class LibraryStorageMigrationConcurrencyTests(LibraryHttpTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        # Separate namespaces are essential: a single fake object dictionary
        # would let downloads succeed even when the persisted backend is wrong.
        self.backends = {name: _FakeMinio() for name in ("local", "nfs")}

        def storage_call(name, *args, backend=None):
            if name == "ensure_ready":
                return True
            selected = backend or "local"
            result = getattr(self.backends[selected], name)(*args)
            return selected if name in {"put_bytes", "put_stream"} else result

        self.backend_patch = patch.object(library, "_storage_call", storage_call)
        self.backend_patch.start()
        self.addCleanup(self.backend_patch.stop)

    async def _overlap_updates(self, item_id, first_body, second_body, paused_write):
        written, resume = threading.Event(), threading.Event()
        reached = asyncio.get_running_loop().create_future()
        second = None
        real_storage = library._storage_call
        real_update = library._update_library_item
        real_lock = library_conversation_save.save_lock

        def paused_storage(name, *args, backend=None):
            result = real_storage(name, *args, backend=backend)
            if name == paused_write and not written.is_set():
                written.set()
                if not resume.wait(10):
                    raise RuntimeError("first storage write was not released")
            return result

        def observe_second(stage):
            if asyncio.current_task() is second and not reached.done():
                reached.set_result(stage)

        async def observed_update(*args, **kwargs):
            observe_second("update")
            return await real_update(*args, **kwargs)

        @asynccontextmanager
        async def observed_lock(*args, **kwargs):
            observe_second("lock")
            async with real_lock(*args, **kwargs):
                yield

        path = f"/items/{item_id}"
        with patch.object(library, "_storage_call", paused_storage), \
                patch.object(library, "_update_library_item", observed_update), \
                patch.object(library_conversation_save, "save_lock", observed_lock):
            first = asyncio.create_task(self.request("PATCH", path, json=first_body))
            try:
                self.assertTrue(await asyncio.to_thread(written.wait, 5),
                                "first request never reached its storage write")
                second = asyncio.create_task(self.request("PATCH", path, json=second_body))
                stage = await asyncio.wait_for(reached, 5)
                if stage == "update":
                    # Without serialization, finish the second update while
                    # the first still holds stale metadata. With serialization,
                    # reaching the lock is enough: do not wait for its writer.
                    await asyncio.wait_for(asyncio.shield(second), 5)
            finally:
                resume.set()
                tasks = [first] + ([second] if second is not None else [])
                responses = await asyncio.wait_for(asyncio.gather(*tasks), 5)
        for response in responses:
            self.assertEqual(response.status_code, 200, response.text)

    async def _create_local_note(self):
        response = await self.request("POST", "/items", json={
            "kind": "note", "title": "Concurrent report",
            "content": "before", "storage": "local",
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["item"]["id"]

    async def _assert_latest_remote_file(self, item_id):
        async with self.sessions() as session:
            row = await session.get(LibraryItem, item_id)
            self.assertEqual(row.backend, "nfs")
            self.assertEqual(row.size, 11)
            key = row.storage_key
        with self.subTest(check="metadata matches the stored object"):
            self.assertEqual(self.backends["nfs"].objects.get(key), b"after-after")
        with self.subTest(check="HTTP download returns the latest edit"):
            downloaded = await self.request("GET", f"/items/{item_id}/download")
            self.assertEqual(downloaded.status_code, 200, downloaded.text)
            self.assertEqual(downloaded.headers["content-length"], "11")
            self.assertEqual(downloaded.content, b"after-after")

    async def test_edit_started_before_migration_keeps_matching_backend_and_object(self):
        item_id = await self._create_local_note()
        await self._overlap_updates(
            item_id, {"content": "after-after"},
            {"storage": "nfs", "folderId": ""}, "put_bytes",
        )
        await self._assert_latest_remote_file(item_id)

    async def test_migration_started_before_edit_does_not_restore_stale_content(self):
        item_id = await self._create_local_note()
        await self._overlap_updates(
            item_id, {"storage": "nfs", "folderId": ""},
            {"content": "after-after"}, "put_stream",
        )
        await self._assert_latest_remote_file(item_id)


if __name__ == "__main__":
    unittest.main()
