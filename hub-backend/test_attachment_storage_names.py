"""Local attachment storage must accept any filename the upload routes allow."""
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import storage


class LocalAttachmentNameTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.enterContext(patch.object(storage, "_LOCAL_DIR", self.folder.name))
        self.enterContext(patch.object(storage, "backend_name", return_value="local"))

    def _round_trip(self, key):
        data = ("payload for " + key).encode("utf-8")
        self.assertEqual(storage.put(key, data, "application/octet-stream"), "local")
        self.assertEqual(storage.get(key, "local"), data)
        handle = storage.open_stream(key, "local")
        self.assertEqual(b"".join(storage.iter_stream(handle)), data)
        path = Path(storage._local_path(key))
        self.assertEqual(path.parent, Path(self.folder.name))
        self.assertEqual(path.read_bytes(), data)
        storage.delete(key, "local")
        self.assertFalse(path.exists())
        return path

    def test_short_names_keep_their_existing_location(self):
        key = "att/task-1/attachment-1/brief.pdf"
        path = self._round_trip(key)
        self.assertEqual(path.name, "att__task-1__attachment-1__brief.pdf")

    def test_long_multibyte_name_is_stored(self):
        # Upload routes keep up to 200 characters; 200 CJK characters are
        # 600 UTF-8 bytes, beyond the 255-byte filename limit on Linux.
        name = "华东区域客户满意度调研报告" * 15 + ".pdf"
        key = "att/3259e758-4ecf-41b3-b385-0f86b67c3867/37d15ab5-dccf-4e25-8d62-bea1b0e21063/" + name[-200:]
        path = self._round_trip(key)
        self.assertTrue(path.name.endswith(".pdf"))
        self.assertLessEqual(len(os.fsencode(path.name)), 255)

    def test_distinct_long_names_do_not_collide(self):
        prefix = "att/task-1/attachment-1/" + "长" * 190
        self.assertNotEqual(storage._local_path(prefix + "a.txt"), storage._local_path(prefix + "b.txt"))

    @unittest.skipUnless(os.name == "nt", "Windows filename rules")
    def test_windows_reserved_characters_are_stored_in_the_main_stream(self):
        key = "att/task-1/attachment-1/会议纪要: 11月17日.docx"
        path = self._round_trip(key)
        # Without hashing, NTFS treats ":" as an alternate data stream and
        # leaves an empty "att__…__会议纪要" file in the uploads directory.
        self.assertNotIn(":", path.name)
        self.assertEqual(sorted(os.listdir(self.folder.name)), [])

    def test_existing_object_under_the_legacy_name_is_still_found(self):
        key = "att/task-1/attachment-1/" + "x" * 150 + ".txt"
        legacy = Path(self.folder.name) / key.replace("/", "__")
        with patch.object(storage, "_native_name_ok", return_value=False):
            legacy.write_bytes(b"written before this change")
            self.assertEqual(Path(storage._local_path(key)), legacy)
            self.assertEqual(storage.get(key, "local"), b"written before this change")

    @unittest.skipUnless(os.name == "nt", "Windows path limits")
    def test_complete_path_counts_utf16_units_in_the_directory(self):
        directory = os.path.join(self.folder.name, "项目📅" * 12)
        prefix = "att/task-1/attachment-1/"
        base = os.path.join(directory, prefix.replace("/", "__"))
        key = prefix + "表" * (250 - len(base) - len(".txt")) + ".txt"
        legacy = os.path.join(directory, key.replace("/", "__"))
        self.assertEqual(len(legacy), 250)
        self.assertGreater(len(legacy.encode("utf-16-le")) // 2, 259)
        with patch.object(storage, "_LOCAL_DIR", directory):
            storage.put(key, b"report", "text/plain")
            self.assertNotEqual(storage._local_path(key), legacy)
            self.assertEqual(storage.get(key, "local"), b"report")

    @unittest.skipUnless(os.name == "nt", "Windows path limits")
    def test_restored_legacy_and_readable_files_past_max_path(self):
        keys = ["att/task-1/attachment-1/会议记录.txt",
                "att/project-1234567890/attachment-1234567890/" + "报告📅" * 60 + ".txt"]
        source = os.path.join(self.folder.name, "source")
        with patch.object(storage, "_LOCAL_DIR", source):
            for key in keys:
                storage.put(key, b"original", "text/plain")
            self.assertEqual(os.path.basename(storage._local_path(keys[0])), keys[0].replace("/", "__"))
            self.assertIn("__h-", os.path.basename(storage._local_path(keys[1])))

        deep = os.path.join(self.folder.name, "d" * (238 - len(self.folder.name)))
        os.rename(source, deep)
        real_exists = os.path.exists

        def exists_without_system_long_paths(path):
            if not path.startswith("\\\\?\\") and len(path.encode("utf-16-le")) // 2 > 259:
                return False
            return real_exists(path)

        with patch.object(storage, "_LOCAL_DIR", deep), patch.object(
                os.path, "exists", side_effect=exists_without_system_long_paths):
            for key in keys:
                with self.subTest(key=key):
                    self.assertEqual(storage.get(key, "local"), b"original")
                    self.assertEqual(b"".join(storage.iter_stream(storage.open_stream(key, "local"))), b"original")
                    storage.delete(key, "local")
        self.assertEqual(os.listdir(deep), [])



def _windows_rules(name, path):
    """Emulate the Windows name and MAX_PATH checks on every platform."""
    return (len(name.encode("utf-16-le")) // 2 <= 255
            and len(os.path.abspath(path).encode("utf-16-le")) // 2 <= 259 and ":" not in name)


class UploadDirectoryLocationTests(unittest.TestCase):
    """Hashed objects must stay reachable wherever the uploads directory lives."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.enterContext(patch.object(storage, "backend_name", return_value="local"))
        self.enterContext(patch.object(storage, "_native_name_ok", side_effect=_windows_rules))

    def _directory(self, length):
        path = os.path.join(self.root, "d" * max(1, length - len(self.root) - 1))
        os.makedirs(path)
        return path

    def test_objects_survive_moving_the_uploads_directory(self):
        key = "att/3259e758-4ecf-41b3-b385-0f86b67c3867/37d15ab5-dccf-4e25-8d62-bea1b0e21063/" + "x" * 120 + ".txt"
        deep = self._directory(150)
        with patch.object(storage, "_LOCAL_DIR", deep):
            storage.put(key, b"stored under the hashed name", "text/plain")
            hashed = os.path.basename(storage._local_path(key))
        self.assertIn("h-", hashed)
        # Restore a copy at a short path, where the original mapping would now fit.
        short = os.path.join(self.root, "u")
        shutil.copytree(deep, short)
        with patch.object(storage, "_LOCAL_DIR", short):
            self.assertTrue(_windows_rules(key.replace("/", "__"), os.path.join(short, key.replace("/", "__"))))
            self.assertEqual(storage.get(key, "local"), b"stored under the hashed name")
            self.assertEqual(b"".join(storage.iter_stream(storage.open_stream(key, "local"))),
                             b"stored under the hashed name")
            storage.delete(key, "local")
        self.assertEqual(os.listdir(short), [])

    def test_legacy_objects_survive_moving_to_a_deeper_directory(self):
        key = "att/task-1/attachment-1/brief.pdf"
        short = self._directory(20)
        with patch.object(storage, "_LOCAL_DIR", short):
            storage.put(key, b"original mapping", "application/pdf")
        deep = os.path.join(self._directory(200), "uploads")
        shutil.copytree(short, deep)
        with patch.object(storage, "_LOCAL_DIR", deep):
            self.assertEqual(storage.get(key, "local"), b"original mapping")
            storage.delete(key, "local")
        self.assertEqual(os.listdir(deep), [])

    def test_fallback_fits_the_complete_path_in_a_deep_directory(self):
        key = ("att/3259e758-4ecf-41b3-b385-0f86b67c3867/37d15ab5-dccf-4e25-8d62-bea1b0e21063/"
               + "华东区域客户满意度调研报告" * 5 + ".pdf")
        deep = self._directory(160)
        with patch.object(storage, "_LOCAL_DIR", deep):
            path = storage._local_path(key)
            self.assertLessEqual(len(path), 259, path)
            self.assertTrue(_windows_rules(os.path.basename(path), path))
            self.assertTrue(path.endswith(".pdf"))
            storage.put(key, b"deep directory", "application/pdf")
            self.assertEqual(storage.get(key, "local"), b"deep directory")
            # A second, different name in the same directory never collides.
            self.assertNotEqual(storage._local_path(key[:-4] + "2.pdf"), path)


if __name__ == "__main__":
    unittest.main()
