"""Real-filesystem attachment storage regressions; registered in the release gate."""
import hashlib
import os
import shutil
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from app.services import storage


class LocalAttachmentNameTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.enterContext(patch.object(storage, "_LOCAL_DIR", self.folder.name))
        self.enterContext(patch.object(storage, "backend_name", return_value="local"))

    def assert_payload(self, key, payload):
        self.assertEqual(storage.get(key, "local"), payload)
        stream = storage.open_stream(key, "local")
        self.assertEqual(b"".join(storage.iter_stream(stream)), payload)
        self.assertTrue(stream.closed)

    def legacy_file(self, key, payload, form="flat"):
        safe = key.replace("/", "__").replace("\\", "__")
        # Reconstruct the old layout independently of the migration code.
        if form == "flat":
            name = safe
        else:
            prefix, _, tail = safe.rpartition("__")
            digest = hashlib.sha256(key.encode()).hexdigest()[:40]
            compact = "h-" + digest + os.path.splitext(tail)[1]
            name = prefix[:120] + "__" + compact if form == "readable" else compact
        path = storage._extended(os.path.join(storage._LOCAL_DIR, name))
        os.makedirs(storage._extended(storage._LOCAL_DIR, directory=True), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(payload)
        return path

    def test_old_data_reads_streams_and_deletes_without_losing_neighbor(self):
        key, neighbor = "att/task/id/report.txt", "att/task/other/other.txt"
        path = self.legacy_file(key, b"written by old release")
        self.legacy_file(neighbor, b"untouched")
        self.assertEqual(storage.migrate_local_objects([key, neighbor]), 2)
        self.assert_payload(key, b"written by old release")
        storage.delete(key, "local")
        self.assertFalse(os.path.exists(path))
        self.assert_payload(neighbor, b"untouched")
        with self.assertRaises(FileNotFoundError):
            storage.get(key, "local")

    def test_each_old_format_survives_directory_copy(self):
        for form in ("flat", "readable", "compact"):
            with self.subTest(form=form):
                source = os.path.join(self.folder.name, "source-" + form)
                target = os.path.join(self.folder.name, "restored-" + form)
                key = "att/task/id/report.txt"
                with patch.object(storage, "_LOCAL_DIR", source):
                    original = self.legacy_file(key, b"old bytes", form)
                shutil.copytree(source, target)
                with patch.object(storage, "_LOCAL_DIR", target):
                    self.assertEqual(storage.migrate_local_objects([key]), 1)
                    self.assert_payload(key, b"old bytes")
                    storage.delete(key, "local")
                    with self.assertRaises(FileNotFoundError):
                        storage.open_stream(key, "local")
                self.assertEqual(Path(original).read_bytes(), b"old bytes")

    def test_collision_keys_have_independent_bytes_streams_and_deletion(self):
        for first, second in (("att/t/a__b/name.txt", "att/t/a/b/name.txt"),
                              ("att/t/id/Report.txt", "att/t/id/report.txt"),
                              ("att/t/id/100%file", "att/t/id/100%25file"),
                              ("att/t/id/a\\b", "att/t/id/a/b")):
            with self.subTest(keys=(first, second)):
                self.assertNotEqual(storage._local_path(first).casefold(),
                                    storage._local_path(second).casefold())
                storage.put(first, b"first", "text/plain")
                storage.put_stream(second, BytesIO(b"second"), 6, "text/plain")
                self.assert_payload(first, b"first")
                self.assert_payload(second, b"second")
                storage.delete(first, "local")
                with self.assertRaises(FileNotFoundError):
                    storage.get(first, "local")
                self.assert_payload(second, b"second")
                storage.delete(second, "local")

    def test_real_filesystem_name_boundaries(self):
        for name in ("报告" * 98 + ".pdf", "x" * 196 + ".txt", "🦄" * 196 + ".txt",
                     "会议纪要: 11月17日.docx", "CON", "report. ", ".."):
            with self.subTest(name=name):
                key = "att/task/id/" + name
                payload = ("payload:" + name).encode()
                path = storage._local_path(key)
                self.assertRegex(os.path.basename(path), r"^[a-f0-9]{64}$")
                storage.put(key, payload, "application/octet-stream")
                self.assert_payload(key, payload)
                self.assertEqual(os.stat(path).st_size, len(payload))
                with open(path, "rb") as handle:
                    self.assertEqual(handle.read(), payload)  # The ordinary main stream, including NTFS.
                storage.delete(key, "local")
                self.assertFalse(os.path.exists(path))

    def test_v2_directory_relocation(self):
        key = "att/task/id/报告.pdf"
        storage.put(key, b"v2 bytes", "application/pdf")
        target = os.path.join(self.folder.name, "copy")
        shutil.copytree(os.path.join(self.folder.name, "objects-v2"),
                        os.path.join(target, "objects-v2"))
        with patch.object(storage, "_LOCAL_DIR", target):
            self.assert_payload(key, b"v2 bytes")
            storage.delete(key, "local")
            with self.assertRaises(FileNotFoundError):
                storage.get(key, "local")
        self.assert_payload(key, b"v2 bytes")

    def test_deleted_v2_never_falls_back_to_untracked_old_bytes(self):
        key = "att/task/id/report.txt"
        self.assertEqual(storage.migrate_local_objects([]), 0)
        old = self.legacy_file(key, b"orphaned legacy copy")
        with self.assertRaises(FileNotFoundError):
            storage.get(key, "local")
        storage.put(key, b"new", "text/plain")
        self.assert_payload(key, b"new")
        storage.delete(key, "local")
        storage.delete(key, "local")
        self.assertEqual(storage.migrate_local_objects([]), 0)
        with self.assertRaises(FileNotFoundError):
            storage.open_stream(key, "local")
        self.assertEqual(Path(old).read_bytes(), b"orphaned legacy copy")

    def test_preview_deletion_blocks_active_reference_but_can_finish_pending_cleanup(self):
        key = "att/task/id/archive.zip"
        original = Path(self.legacy_file(key, b"old copy"))
        current = Path(storage._local_path(key))
        current.parent.mkdir(parents=True, exist_ok=True)
        Path(str(current) + ".deleted").touch()
        with self.assertRaises(FileNotFoundError) as caught:
            storage.migrate_local_objects([key])
        self.assertIn(key, str(caught.exception))
        self.assertEqual(original.read_bytes(), b"old copy")
        self.assertEqual(storage.migrate_local_objects([], pending_cleanup=[key]), 0)
        self.assertEqual(original.read_bytes(), b"old copy")
        with self.assertRaises(FileNotFoundError):
            storage.get(key, "local")

    def test_normal_deletions_return_to_the_empty_volume_file_count(self):
        self.assertEqual(storage.migrate_local_objects([]), 0)
        directory = Path(self.folder.name)
        baseline = {path for path in directory.rglob("*") if path.is_file()}
        keys = [f"att/task/ordinary-{number}/brief.txt" for number in range(64)]
        for key in keys:
            storage.put(key, b"brief", "text/plain")
        for key in keys:
            storage.delete(key, "local")
            storage.delete(key, "local")
        self.assertEqual(storage.migrate_local_objects([]), 0)
        for key in keys:
            with self.assertRaises(FileNotFoundError):
                storage.get(key, "local")
        self.assertEqual({path for path in directory.rglob("*") if path.is_file()}, baseline)

    def test_failed_stream_write_preserves_previous_object(self):
        key = "att/task/id/report.txt"
        storage.put(key, b"original", "text/plain")

        class BrokenStream(BytesIO):
            def read(self, size=-1):
                raise OSError("simulated interrupted upload")

        with self.assertRaises(OSError):
            storage.put_stream(key, BrokenStream(b"replacement"), 11, "text/plain")
        self.assert_payload(key, b"original")
        self.assertFalse(list(Path(self.folder.name).rglob(".upload-*")))

    def test_migration_preflights_all_aliases_before_changing_any_file(self):
        first, second = "att/t/a__b/name.txt", "att/t/a/b/name.txt"
        shared = self.legacy_file(first, b"cannot know which record owns these bytes")
        unique = self.legacy_file("att/t/unique/name.txt", b"unique")
        before = Path(shared).read_bytes()
        with self.assertRaises(storage.AmbiguousLocalKeys) as caught:
            storage.migrate_local_objects(["att/t/unique/name.txt", first, second])
        self.assertIn(sorted([first, second]), caught.exception.collisions)
        self.assertEqual(Path(shared).read_bytes(), before)
        self.assertEqual(Path(unique).read_bytes(), b"unique")
        self.assertFalse(os.path.exists(storage._local_path("att/t/unique/name.txt")))

    def test_case_only_keys_use_the_actual_volume_identity(self):
        first, second = "att/task/id/Report.txt", "att/task/id/report.txt"
        original = Path(self.legacy_file(first, b"May"))
        other = original.with_name(second.replace("/", "__"))
        try:
            with other.open("xb") as handle:
                handle.write(b"June")
        except FileExistsError:
            self.assertTrue(original.samefile(other))
            with self.assertRaises(storage.AmbiguousLocalKeys):
                storage.migrate_local_objects([first, second])
            self.assertEqual(original.read_bytes(), b"May")
        else:
            self.assertFalse(original.samefile(other))
            self.assertEqual(storage.migrate_local_objects([first, second]), 2)
            self.assert_payload(first, b"May")
            self.assert_payload(second, b"June")

    def test_two_records_sharing_one_file_are_reported_before_any_moves(self):
        first, second, unique = "att/task/1/one.txt", "att/task/2/two.txt", "att/task/3/three.txt"
        source = Path(self.legacy_file(first, b"shared"))
        neighbor = Path(self.legacy_file(unique, b"neighbor"))
        other = Path(self.folder.name, second.replace("/", "__"))
        os.link(source, other)
        with self.assertRaises(storage.AmbiguousLocalKeys) as caught:
            storage.migrate_local_objects([unique, first, second])
        self.assertIn(sorted([first, second]), caught.exception.collisions)
        self.assertEqual(source.read_bytes(), b"shared")
        self.assertTrue(source.samefile(other))
        self.assertEqual(neighbor.read_bytes(), b"neighbor")

    @unittest.skipUnless(os.name == "nt", "requires Windows filename rules")
    def test_unresolved_historical_windows_name_stops_before_any_moves(self):
        missing = "att/task/id/report:final.pdf"
        key = "att/task/other/ordinary.txt"
        source = Path(self.legacy_file(key, b"preserve me"))
        with self.assertRaises(FileNotFoundError) as caught:
            storage.migrate_local_objects([key, missing])
        self.assertIn(missing, str(caught.exception))
        self.assertIn("NTFS", str(caught.exception))
        self.assertEqual(source.read_bytes(), b"preserve me")
        self.assertFalse(os.path.exists(storage._local_path(key)))

    def test_unique_migration_is_repeatable_and_uses_unchanged_logical_keys(self):
        key = "att/task/id/report.txt"
        old = self.legacy_file(key, b"old payload")
        self.assertEqual(storage.migrate_local_objects([key, key]), 1)
        self.assertFalse(os.path.exists(old))
        self.assertEqual(storage.migrate_local_objects([key]), 0)
        self.assert_payload(key, b"old payload")
        storage.delete(key, "local")
        with self.assertRaises(FileNotFoundError):
            storage.get(key, "local")

    def test_migration_preserves_conflicting_old_and_new_objects(self):
        key = "att/task/id/report.txt"
        old = self.legacy_file(key, b"old")
        storage.put(key, b"new", "text/plain")
        with self.assertRaises(FileExistsError):
            storage.migrate_local_objects([key])
        self.assertEqual(Path(old).read_bytes(), b"old")
        self.assert_payload(key, b"new")

    def test_multiple_historical_formats_for_one_key_are_not_guessed(self):
        key = "att/task/id/report.txt"
        first = self.legacy_file(key, b"first", "flat")
        second = self.legacy_file(key, b"second", "compact")
        with self.assertRaisesRegex(ValueError, "Multiple legacy objects"):
            storage.migrate_local_objects([key])
        self.assertEqual(Path(first).read_bytes(), b"first")
        self.assertEqual(Path(second).read_bytes(), b"second")

    def test_interrupted_migration_can_resume(self):
        keys = ["att/task/a/report.txt", "att/task/b/report.txt"]
        for key in keys:
            self.legacy_file(key, key.encode())
        rename = os.rename
        calls = 0

        def interrupted(source, destination):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated interruption")
            return rename(source, destination)

        with patch.object(os, "rename", side_effect=interrupted):
            with self.assertRaises(OSError):
                storage.migrate_local_objects(keys)
        self.assertEqual(storage.migrate_local_objects(keys), 1)
        for key in keys:
            self.assert_payload(key, key.encode())

    @unittest.skipUnless(os.name == "nt", "requires real Windows filesystem")
    def test_old_layouts_migrate_after_restore_beyond_max_path(self):
        source = os.path.join(self.folder.name, "source")
        directory = os.path.join(self.folder.name, "项目📅" * 35, "历史📅" * 35)
        keys = ["att/task/id/brief.txt", "att/task/id/" + "报告" * 90 + ".pdf",
                "att/task/id/" + "表" * 192 + ".txt"]
        with patch.object(storage, "_LOCAL_DIR", source):
            for key, form in zip(keys, ("flat", "readable", "compact")):
                self.legacy_file(key, key.encode(), form)
        destination = storage._extended(directory, directory=True)
        shutil.copytree(source, destination)
        self.addCleanup(shutil.rmtree, destination)
        with patch.object(storage, "_LOCAL_DIR", directory):
            self.assertGreater(len(os.path.abspath(directory).encode("utf-16-le")) // 2, 259)
            self.assertEqual(storage.migrate_local_objects(keys), 3)
            for key in keys:
                self.assert_payload(key, key.encode())
                storage.delete(key, "local")
                with self.assertRaises(FileNotFoundError):
                    storage.open_stream(key, "local")

    @unittest.skipUnless(os.name == "nt", "requires real Windows filesystem")
    def test_windows_deep_directory_with_non_bmp_characters(self):
        deep = os.path.join(self.folder.name, "项目📅" * 30, "uploads")
        with patch.object(storage, "_LOCAL_DIR", deep):
            for key in ("att/t/id/会议纪要:final.pdf", "att/t/id/" + "表" * 196 + ".txt"):
                storage.put(key, b"deep path payload", "text/plain")
                self.assert_payload(key, b"deep path payload")
                storage.delete(key, "local")
                with self.assertRaises(FileNotFoundError):
                    storage.get(key, "local")


class AttachmentInventoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
        from app.conversation_handoff_models import ConversationHandoff
        from app.models import Attachment

        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(storage, "_LOCAL_DIR", str(self.directory)))
        self.enterContext(patch.object(storage, "backend_name", return_value="local"))
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(engine.dispose)
        async with engine.begin() as connection:
            await connection.run_sync(Attachment.__table__.create)
            await connection.run_sync(ConversationHandoff.__table__.create)
        self.session = await self.enterAsyncContext(async_sessionmaker(engine)())

    def attachment(self, key, **fields):
        from app.models import Attachment

        self.session.add(Attachment(task_id="", storage_key=key, **fields))

    def handoff(self, task, key, backend="local", **fields):
        from app.conversation_handoff_models import ConversationHandoff

        self.session.add(ConversationHandoff(
            id=task, task_id=task, transfer_id=task, owner_client_id="client",
            owner_user_id="user", storage_key=key, backend=backend, **fields))

    async def test_startup_inventories_local_attachments_and_handoff_archives(self):
        keys = ["att/task/id/brief.txt", "mate-messages/id/snapshot.txt",
                "handoff/task/archive.zip", "handoff/migrating/archive.zip"]
        for key in keys[:2]:
            self.attachment(key, backend="local")
        self.handoff("first", keys[2], sha256=hashlib.sha256(keys[2].encode()).hexdigest())
        self.handoff("pending", "", backend="", options={"legacyBlob": {"key": keys[3], "backend": "local"}})
        self.handoff("cleaned", "", backend="", options={"legacyBlob": {"key": "already-cleaned", "backend": "local"}})
        self.handoff("remote", "object", backend="minio", options={"legacyBlob": {"key": "remote", "backend": "minio"}})
        for key in keys:
            (self.directory / key.replace("/", "__")).write_bytes(key.encode())
        self.attachment("remote-only", backend="minio")
        self.attachment("", backend="local")
        await self.session.commit()
        self.assertEqual(await storage.migrate_local_attachments(self.session), len(keys))
        self.assertEqual(await storage.migrate_local_attachments(self.session), 0)
        for key in keys:
            self.assertEqual(storage.get(key, "local"), key.encode())
            self.assertFalse((self.directory / key.replace("/", "__")).exists())

    async def test_recorded_length_mismatch_preserves_every_legacy_source(self):
        keys = ["att/task/1/one.txt", "att/task/2/two.txt"]
        sources = [self.directory / key.replace("/", "__") for key in keys]
        for key, source, expected_size in zip(keys, sources, [4, 8]):
            source.write_bytes(b"data")
            self.attachment(key, backend="local", size=expected_size)
        await self.session.commit()
        with self.assertRaises(ValueError) as caught:
            await storage.migrate_local_attachments(self.session)
        self.assertIn(keys[1], str(caught.exception))
        for source in sources:
            self.assertEqual(source.read_bytes(), b"data")

    async def test_staged_v2_object_is_verified_before_resuming_migration(self):
        key, neighbor = "att/task/1/one.txt", "att/task/2/two.txt"
        storage.put(key, b"June", "text/plain")
        expected = hashlib.sha256(b"July").hexdigest()
        self.attachment(key, backend="local", size=4, evidence_meta={"sha256": expected})
        self.attachment(neighbor, backend="local", size=4)
        old = self.directory / neighbor.replace("/", "__")
        old.write_bytes(b"text")
        await self.session.commit()
        with self.assertRaises(ValueError) as caught:
            await storage.migrate_local_attachments(self.session)
        self.assertIn(key, str(caught.exception))
        self.assertEqual(old.read_bytes(), b"text")
        self.assertEqual(storage.get(key, "local"), b"June")

    async def test_inconsistent_digests_on_shared_logical_key_preserve_original(self):
        key = "handoff/task/snapshot.txt"
        payload = b"one report"
        old = self.directory / key.replace("/", "__")
        old.write_bytes(payload)
        self.attachment(key, backend="local", evidence_meta={"sha256": hashlib.sha256(payload).hexdigest()})
        self.handoff("other", key, sha256=hashlib.sha256(b"different content").hexdigest())
        await self.session.commit()
        with self.assertRaises(ValueError) as caught:
            await storage.migrate_local_attachments(self.session)
        self.assertIn(key, str(caught.exception))
        self.assertEqual(old.read_bytes(), payload)
        self.assertFalse(os.path.exists(storage._local_path(key)))

    async def test_minio_only_deployment_needs_no_local_uploads_directory(self):
        self.attachment("attachments/remote.txt", backend="minio")
        self.handoff("remote", "handoff/remote.zip", backend="minio")
        await self.session.commit()
        absent = self.directory / "unused-uploads"
        with (patch.object(storage, "_LOCAL_DIR", str(absent)),
              patch.object(storage, "backend_name", return_value="minio")):
            self.assertEqual(await storage.migrate_local_attachments(self.session), 0)
        self.assertFalse(absent.exists())

    async def test_delete_unreferenced_waits_for_final_committed_owner(self):
        from sqlalchemy import delete
        from app.conversation_handoff_models import ConversationHandoff
        from app.models import Attachment

        key = "handoff/task/archive.zip"
        self.attachment(key, backend="local")
        self.handoff("owner", key)
        (self.directory / key.replace("/", "__")).write_bytes(b"ordinary archive")
        await self.session.commit()
        self.assertEqual(await storage.migrate_local_attachments(self.session), 1)
        self.assertFalse(await storage.delete_unreferenced(self.session, key, "local"))
        await self.session.execute(delete(Attachment).where(Attachment.storage_key == key))
        await self.session.commit()
        self.assertFalse(await storage.delete_unreferenced(self.session, key, "local"))
        self.assertEqual(storage.get(key, "local"), b"ordinary archive")
        await self.session.execute(delete(ConversationHandoff).where(ConversationHandoff.storage_key == key))
        await self.session.commit()
        self.assertTrue(await storage.delete_unreferenced(self.session, key, "local"))
        self.assertFalse(os.path.exists(storage._local_path(key)))
        with self.assertRaises(FileNotFoundError):
            storage.get(key, "local")


if __name__ == "__main__":
    unittest.main()
