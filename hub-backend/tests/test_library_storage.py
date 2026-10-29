"""Storage-adapter regression tests without a live MinIO dependency."""

import os
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from app.config import get_settings
from app.services import library_storage


class LibraryStorageAdapterTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.env = {
            "LIBRARY_STORAGE_BACKEND": "local",
            "LIBRARY_STORAGE_DIR": self.root.name,
            "LIBRARY_REMOTE_ORDER": "minio,nfs",
            "LIBRARY_NFS_HOST": "", "LIBRARY_NFS_EXPORT": "", "LIBRARY_NFS_VERSION": "3",
        }
        self.patcher = patch.dict(os.environ, self.env, clear=False)
        self.patcher.start()
        get_settings.cache_clear()

    def tearDown(self):
        self.patcher.stop()
        get_settings.cache_clear()
        self.root.cleanup()

    def test_local_backend_round_trip_and_owner_prefix(self):
        self.assertEqual(library_storage.storage_backend(), "local")
        self.assertTrue(library_storage.ensure_ready())
        alice = library_storage.object_key("alice", "item-a", "a.txt")
        bob = library_storage.object_key("bob", "item-b", "b.txt")
        self.assertNotEqual(library_storage.owner_prefix("alice"), library_storage.owner_prefix("bob"))

        self.assertEqual(library_storage.put_bytes(alice, b"hello", "text/plain"), "local")
        self.assertEqual(library_storage.read_bytes(alice), b"hello")
        stream = library_storage.open_stream(alice)
        try:
            self.assertEqual(stream.read(), b"hello")
        finally:
            stream.close()
        self.assertTrue((Path(self.root.name) / alice).is_file())
        library_storage.delete(alice)
        self.assertFalse((Path(self.root.name) / alice).exists())

        # A second user gets a different directory even when item IDs match.
        self.assertTrue(bob.startswith(library_storage.owner_prefix("bob")))

    def test_local_paths_cannot_escape_configured_root(self):
        for key in ("../outside", "../../outside", "..\\outside", "/outside", "C:\\outside"):
            with self.subTest(key=key), self.assertRaises(library_storage.LibraryStorageError):
                library_storage.put_bytes(key, b"blocked", "text/plain")
        self.assertEqual(list(Path(self.root.name).rglob("*")), [])

    def test_incomplete_upload_cleans_temporary_files_without_replacing_old_object(self):
        key = library_storage.object_key("alice", "atomic")
        library_storage.put_bytes(key, b"original", "text/plain")
        with self.assertRaises(library_storage.LibraryStorageError):
            library_storage.put_stream(key, BytesIO(b"short"), 10, "text/plain")
        self.assertEqual(library_storage.read_bytes(key), b"original")
        self.assertEqual(list(Path(self.root.name).rglob("*.part-*")), [])

    def test_streams_close_and_release_connection_on_cancel_and_read_limit(self):
        class Stream(BytesIO):
            released = False

            def release_conn(self):
                self.released = True

        stream = Stream(b"abcdef")
        iterator = library_storage.iter_stream(stream, chunk_size=2)
        self.assertEqual(next(iterator), b"ab")
        iterator.close()
        self.assertTrue(stream.closed)
        self.assertTrue(stream.released)
        stream = Stream(b"abcdef")
        with patch.object(library_storage, "open_stream", return_value=stream):
            with self.assertRaises(ValueError):
                library_storage.read_bytes("key", limit=2)
        self.assertTrue(stream.closed)
        self.assertTrue(stream.released)

    def test_minio_missing_object_is_distinct_from_unavailable_backend(self):
        class MissingObject(Exception):
            code = "NoSuchKey"

        with patch.object(library_storage, "_client") as client, patch.object(
            library_storage, "bucket_name", return_value="bucket"
        ):
            client.return_value.get_object.side_effect = MissingObject()
            with self.assertRaises(FileNotFoundError):
                library_storage.open_stream("missing", backend="minio")
            client.return_value.get_object.side_effect = OSError("offline")
            with self.assertRaises(library_storage.LibraryStorageError):
                library_storage.open_stream("missing", backend="minio")

    def test_partial_explicit_minio_configuration_is_reported(self):
        with patch.dict(os.environ, {
            "LIBRARY_STORAGE_BACKEND": "minio",
            "LIBRARY_MINIO_ENDPOINT": "http://minio.invalid:9000",
            "LIBRARY_MINIO_ACCESS_KEY": "",
            "LIBRARY_MINIO_SECRET_KEY": "",
            "LIBRARY_MINIO_BUCKET": "file-storage",
        }, clear=False):
            get_settings.cache_clear()
            with self.assertRaises(library_storage.LibraryStorageError) as caught:
                library_storage.configuration()
            self.assertEqual(caught.exception.code, "LIBRARY_STORAGE_NOT_CONFIGURED")

    def test_explicit_minio_round_trip_is_independent_of_local_default(self):
        class FakeMinio:
            def __init__(self):
                self.objects = {}

            def bucket_exists(self, bucket):
                return True

            def put_object(self, bucket, key, handle, length, **kwargs):
                self.objects[key] = handle.read(length)

            def get_object(self, bucket, key):
                stream = BytesIO(self.objects[key])
                stream.release_conn = lambda: None
                return stream

            def remove_object(self, bucket, key):
                self.objects.pop(key, None)

        fake = FakeMinio()
        key = library_storage.object_key("alice", "minio-item")
        with patch.object(library_storage, "configuration", return_value=(
            "minio.invalid:9000", "access", "secret", "bucket", False
        )), patch.object(library_storage, "_client", return_value=fake):
            self.assertTrue(library_storage.ensure_ready(backend="minio"))
            self.assertEqual(library_storage.put_bytes(key, b"minio", "text/plain", backend="minio"), "minio")
            self.assertEqual(library_storage.read_bytes(key, backend="minio"), b"minio")
            library_storage.delete(key, backend="minio")
            self.assertNotIn(key, fake.objects)

    def test_storage_status_defaults_to_local_and_disables_unconfigured_minio(self):
        with patch.object(
            library_storage, "configuration",
            side_effect=library_storage.LibraryStorageError(
                "LIBRARY_STORAGE_NOT_CONFIGURED", retryable=False
            ),
        ):
            status = library_storage.status()
        self.assertEqual(status["default"], "local")
        self.assertEqual(status["local"]["state"], "available")
        self.assertTrue(status["local"]["enabled"])
        self.assertEqual(status["minio"]["state"], "disabled")
        self.assertFalse(status["minio"]["configured"])
        self.assertFalse(status["minio"]["enabled"])
        self.assertEqual(status["minio"]["code"], "LIBRARY_STORAGE_NOT_CONFIGURED")

    def test_storage_status_distinguishes_configured_remote_failure(self):
        with patch.object(
            library_storage, "configuration",
            return_value=("minio.example:9000", "access", "secret", "bucket", False),
        ), patch.object(library_storage, "ensure_ready", side_effect=OSError("offline")):
            status = library_storage.status()
        self.assertEqual(status["minio"]["state"], "unavailable")
        self.assertTrue(status["minio"]["configured"])
        self.assertFalse(status["minio"]["available"])
        self.assertFalse(status["minio"]["enabled"])
        self.assertEqual(status["minio"]["code"], "LIBRARY_STORAGE_UNAVAILABLE")

    def test_storage_status_marks_healthy_remote_as_available(self):
        with patch.object(
            library_storage, "configuration",
            return_value=("minio.example:9000", "access", "secret", "bucket", False),
        ), patch.object(library_storage, "ensure_ready", return_value=True):
            status = library_storage.status()
        self.assertEqual(status["minio"]["state"], "available")
        self.assertTrue(status["minio"]["configured"])
        self.assertTrue(status["minio"]["available"])
        self.assertTrue(status["minio"]["enabled"])


if __name__ == "__main__":
    unittest.main()
