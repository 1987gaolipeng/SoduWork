"""Conversation saves and automatic deliveries must share one verified record."""
import asyncio
from unittest.mock import patch

from tests.test_delivery_collections import DeliveryCollectionsTestCase, entry
from app.api import library
from app.library_models import LibraryItem
from app.services import library_storage


class ConversationSaveTests(DeliveryCollectionsTestCase):
    async def save(self, data=b"# Weekly report", filename="report.md", **form):
        headers = form.pop("headers", {})
        values = {"sourceType": "conversation", "sessionId": "session-one",
                  "conversationTitle": "Design a weekly report", **form}
        return await self.http.post("/api/v1/library/items/upload", data=values,
            files={"file": (filename, data, "text/plain")}, headers=headers)

    async def rows(self):
        reply = await self.http.get("/api/v1/library?scope=all")
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()["items"]

    async def test_save_after_automatic_delivery_reuses_id_bytes_and_enriches_title(self):
        original = await self.upload()
        delivery_id = original.json()["delivery"]["id"]
        saved = await self.save()
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["item"]["id"], delivery_id)
        rows = await self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["conversationTitle"], "Design a weekly report")
        self.assertEqual((await self.http.get(f"/api/v1/deliveries/{delivery_id}/download")).content,
                         b"# Weekly report")
        self.assertEqual(len([p for p in (self.root / "library").rglob("*") if p.is_file()]), 1)

    async def test_manual_first_promotes_without_changing_existing_library_reference(self):
        saved = await self.save()
        original_id = saved.json()["item"]["id"]
        edited = await self.http.patch(f"/api/v1/library/items/{original_id}",
            json={"title": "My custom title", "favorite": True, "extra": {"tag": "important"}})
        self.assertEqual(edited.status_code, 200, edited.text)
        published = await self.upload()
        self.assertEqual(published.status_code, 200, published.text)
        self.assertEqual(published.json()["delivery"]["id"], original_id)
        self.assertEqual(len(await self.rows()), 1)
        self.assertEqual(published.json()["item"]["title"], "My custom title")
        self.assertTrue(published.json()["item"]["favorite"])
        self.assertEqual(published.json()["item"]["extra"]["tag"], "important")
        self.assertEqual((await self.http.get(f"/api/v1/library/items/{original_id}/download")).content,
                         b"# Weekly report")
        retry = await self.upload()
        self.assertTrue(retry.json()["duplicate"])
        self.assertEqual(retry.json()["delivery"]["id"], original_id)
        changed = b"# Updated report"
        conflict = await self.upload(self.manifest(files=[entry("report.md", changed)]), changed)
        self.assertEqual(conflict.status_code, 409, conflict.text)

    async def test_concurrent_manual_saves_and_delivery_create_one_record(self):
        replies = await asyncio.gather(self.save(), self.upload(), self.save())
        self.assertEqual([r.status_code for r in replies], [200, 200, 200], [r.text for r in replies])
        self.assertEqual(len(await self.rows()), 1)
        self.assertEqual(len({r.json()["item"]["id"] for r in replies}), 1)

    async def test_equal_bytes_in_new_delivery_revision_stay_distinct(self):
        await self.save()
        first = await self.upload()
        second = await self.upload(self.manifest(revision="rev-two"))
        self.assertEqual(second.status_code, 200, second.text)
        self.assertNotEqual(first.json()["delivery"]["id"], second.json()["delivery"]["id"])
        self.assertEqual(len(await self.rows()), 2)

    async def test_scope_and_different_bytes_do_not_merge(self):
        first = await self.upload()
        original_id = first.json()["delivery"]["id"]
        folder = await self.http.post("/api/v1/library/folders", json={"name": "Copies"})
        variants = [dict(data=b"# Newer report!"), dict(filename="copy.md"),
                    dict(sessionId="session-two"), dict(headers={"X-User": "bob"}),
                    dict(folderId=folder.json()["folder"]["id"])]
        ids = {original_id}
        for values in variants:
            response = await self.save(**values)
            self.assertEqual(response.status_code, 200, response.text)
            new_id = response.json()["item"]["id"]
            self.assertNotIn(new_id, ids, values)
            ids.add(new_id)
        # Ordinary uploads now reject destination-name collisions; only
        # conversation revisions retain the independent-version contract.
        plain_again = await self.save(sourceType="upload", sessionId="")
        self.assertEqual(plain_again.status_code, 409, plain_again.text)
        self.assertEqual(plain_again.json()["detail"]["code"], "LIBRARY_NAME_CONFLICT")

    async def test_delivery_title_is_optional_sanitized_and_not_part_of_content_identity(self):
        initial = await self.upload(self.manifest(conversationTitle="\nDesign report\t"))
        self.assertEqual(initial.status_code, 200, initial.text)
        self.assertEqual(initial.json()["item"]["conversationTitle"], "Design report")
        repeated = await self.upload(self.manifest(conversationTitle="Renamed conversation"))
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertEqual(initial.json()["delivery"]["id"], repeated.json()["delivery"]["id"])
        self.assertEqual(repeated.json()["item"]["conversationTitle"], "Renamed conversation")

    async def test_promoted_delivery_retry_survives_move_and_trash_is_not_resurrected(self):
        saved = await self.save()
        item_id = saved.json()["item"]["id"]
        await self.upload()
        folder = await self.http.post("/api/v1/library/folders", json={"name": "Moved"})
        moved = await self.http.patch(f"/api/v1/library/items/{item_id}",
                                     json={"folderId": folder.json()["folder"]["id"]})
        self.assertEqual(moved.status_code, 200, moved.text)
        retry = await self.upload()
        self.assertEqual(retry.json()["delivery"]["id"], item_id)
        await self.http.delete(f"/api/v1/library/items/{item_id}")
        trashed = await self.upload()
        self.assertEqual(trashed.status_code, 409, trashed.text)

    async def test_corrupt_same_sized_stored_file_is_not_reused(self):
        initial = await self.upload()
        item_id = initial.json()["delivery"]["id"]
        async with self.sessions() as session:
            row = await session.get(LibraryItem, item_id)
            library_storage.put_bytes(row.storage_key, b"x" * row.size, row.content_type, backend="local")
        saved = await self.save()
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertNotEqual(saved.json()["item"]["id"], item_id)

    async def test_backend_isolation_and_promoted_retry_after_default_changes(self):
        saved = await self.save()
        item_id = saved.json()["item"]["id"]
        await self.upload()
        with patch.object(library_storage, "storage_backend", return_value="nfs"):
            retry = await self.upload()
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json()["delivery"]["id"], item_id)
        async with self.sessions() as session:
            row = await session.get(LibraryItem, item_id)
            row.backend = "minio"
            await session.commit()
        local_copy = await self.save()
        self.assertEqual(local_copy.status_code, 200, local_copy.text)
        self.assertNotEqual(local_copy.json()["item"]["id"], item_id)

    async def test_matching_corrupted_bytes_do_not_reuse_invalid_delivery_manifest(self):
        original = await self.upload()
        item_id = original.json()["delivery"]["id"]
        changed = b"x" * len(b"# Weekly report")
        async with self.sessions() as session:
            row = await session.get(LibraryItem, item_id)
            library_storage.put_bytes(row.storage_key, changed, row.content_type, backend="local")
        saved = await self.save(data=changed)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertNotEqual(saved.json()["item"]["id"], item_id)

    async def test_plain_upload_is_not_promoted_and_reserved_manifest_cannot_be_forged(self):
        saved = await self.save(sourceType="upload", sessionId="")
        published = await self.upload()
        self.assertNotEqual(saved.json()["item"]["id"], published.json()["delivery"]["id"])
        changed = await self.http.patch(f'/api/v1/library/items/{saved.json()["item"]["id"]}',
            json={"extra": {"soduWorkDelivery": {"identity": "forged"}}})
        self.assertEqual(changed.status_code, 400, changed.text)

    async def test_edit_loaded_before_promotion_cannot_change_verified_delivery_bytes(self):
        saved = await self.save()
        item_id = saved.json()["item"]["id"]
        loaded, resume = asyncio.Event(), asyncio.Event()
        owned = library._owned_item
        first = True

        async def paused_read(*args, **kwargs):
            nonlocal first
            row = await owned(*args, **kwargs)
            if first:
                first = False
                loaded.set()
                await resume.wait()
            return row

        with patch.object(library, "_owned_item", paused_read):
            edit = asyncio.create_task(self.http.patch(f"/api/v1/library/items/{item_id}",
                                                       json={"content": "Changed after promotion"}))
            try:
                await asyncio.wait_for(loaded.wait(), 3)
                published = await self.upload()
                self.assertEqual(published.status_code, 200, published.text)
            finally:
                resume.set()
            result = await asyncio.wait_for(edit, 3)
        self.assertEqual(result.status_code, 409, result.text)
        self.assertEqual((await self.http.get(f"/api/v1/deliveries/{item_id}/download")).content,
                         b"# Weekly report")

    async def test_promoted_delivery_recovers_a_lost_commit_acknowledgement(self):
        from sqlalchemy.ext.asyncio import AsyncSession
        saved = await self.save()
        original_commit = AsyncSession.commit
        lost = False

        async def lost_ack(session):
            nonlocal lost
            await original_commit(session)
            if not lost:
                lost = True
                raise OSError("commit acknowledgement lost")

        with patch.object(AsyncSession, "commit", lost_ack):
            reply = await self.upload()
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual(reply.json()["delivery"]["id"], saved.json()["item"]["id"])
        self.assertTrue(reply.json()["duplicate"])
        self.assertEqual(len(await self.rows()), 1)

    async def test_late_source_association_cannot_clear_promoted_delivery(self):
        saved = await self.save(sourceType="upload", sessionId="")
        item_id = saved.json()["item"]["id"]
        source = {"sourceType": "conversation", "sessionId": "session-one",
                  "conversationTitle": "Design a weekly report"}
        loaded, resume = asyncio.Event(), asyncio.Event()
        owned = library._owned_item
        first = True

        async def paused_read(*args, **kwargs):
            nonlocal first
            row = await owned(*args, **kwargs)
            if first:
                first = False
                loaded.set()
                await resume.wait()
            return row

        with patch.object(library, "_owned_item", paused_read):
            late = asyncio.create_task(self.http.post(f"/api/v1/library/items/{item_id}/source", json=source))
            try:
                await asyncio.wait_for(loaded.wait(), 3)
                linked = await self.http.post(f"/api/v1/library/items/{item_id}/source", json=source)
                self.assertEqual(linked.status_code, 200, linked.text)
                published = await self.upload()
                self.assertEqual(published.status_code, 200, published.text)
                self.assertEqual(published.json()["delivery"]["id"], item_id)
            finally:
                resume.set()
            result = await asyncio.wait_for(late, 3)
        self.assertEqual(result.status_code, 200, result.text)
        download = await self.http.get(f"/api/v1/deliveries/{item_id}/download")
        self.assertEqual(download.status_code, 200, download.text)
        self.assertEqual(download.content, b"# Weekly report")
