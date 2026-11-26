"""Local library objects must be writable under a deep data directory."""
import contextlib
import errno
import os
import pathlib
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

# Always force an isolated test database for the HTTP fixture.
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from app.services import library_storage
# Reuse the library HTTP fixture as a module so unittest does not collect and
# rerun its test classes here.
import tests.test_library as library_http


EXTENDED = "\\\\?\\"


@contextlib.contextmanager
def legacy_max_path():
    """Reject plain paths of MAX_PATH or more, as Windows does with LongPathsEnabled=0.

    Extended-length paths are exempt, matching the real API.
    """
    originals = {name: getattr(pathlib.Path, name)
                 for name in ("mkdir", "open", "write_bytes", "unlink", "replace")}

    def guarded(name):
        original = originals[name]

        def method(self, *args, **kwargs):
            text = str(self)
            if len(text) >= 260 and not text.startswith(EXTENDED):
                raise OSError(errno.ENAMETOOLONG, "simulated MAX_PATH", text)
            return original(self, *args, **kwargs)
        return method

    with contextlib.ExitStack() as stack:
        for name in originals:
            stack.enter_context(patch.object(pathlib.Path, name, guarded(name)))
        yield


def deep_root(folder, length=220):
    """A storage root of ``length`` characters, like a nested Windows data directory."""
    # Resolve first: runner temp directories can be 8.3 short names (RUNNER~1).
    folder = Path(folder).resolve()
    return folder / ("r" * max(1, length - len(str(folder)) - 1))


def long_tempdir(case):
    """A temporary directory removed through its extended-length form."""
    folder = tempfile.mkdtemp()
    case.addCleanup(shutil.rmtree, EXTENDED + os.path.abspath(folder), True)
    return folder


class LocalLibraryLongPathTests(unittest.TestCase):
    def test_round_trip_when_object_and_staging_paths_exceed_max_path(self):
        with tempfile.TemporaryDirectory() as folder:
            # The default Windows root is ~90 characters, for example
            # C:\Users\<name>\AppData\Local\SoduWork\source-service\application\hub-backend\uploads\library.
            # Pad the temporary root so object paths cross 260 characters.
            root = Path(folder) / ("r" * max(1, 120 - len(folder)))
            with patch.object(library_storage, "_local_root", return_value=root):
                library_storage.ensure_ready("local")
                key = library_storage.object_key("owner-1", "3259e758-4ecf-41b3-b385-0f86b67c3867")
                plain = root.resolve() / key
                self.assertGreater(len(str(plain)) + len(".part-") + 32, 260)
                library_storage.put_bytes(key, b"hello", "text/plain", backend="local")
                self.assertEqual(library_storage.read_bytes(key, backend="local"), b"hello")
                library_storage.delete(key, backend="local")
                with self.assertRaises(FileNotFoundError):
                    library_storage.open_stream(key, backend="local")

    def test_short_paths_are_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(library_storage, "_local_root", return_value=Path(folder)):
                path = library_storage._local_path("library/users/abc/item/object")
        self.assertEqual(path, Path(folder).resolve() / "library/users/abc/item/object")

    @unittest.skipUnless(os.name == "nt", "Windows path syntax")
    def test_windows_long_paths_use_the_extended_length_prefix(self):
        long_root = Path("C:/") / ("d" * 160)
        with patch.object(library_storage, "_local_root", return_value=long_root):
            path = library_storage._local_path("library/users/" + "a" * 64 + "/item/object")
        self.assertTrue(str(path).startswith("\\\\?\\C:\\"))



@unittest.skipUnless(os.name == "nt", "Windows MAX_PATH semantics")
class LegacyMaxPathTests(unittest.TestCase):
    def test_readiness_probe_works_under_a_220_character_root(self):
        folder = long_tempdir(self)
        root = deep_root(folder)
        self.assertEqual(len(str(root.resolve())), 220)
        with patch.object(library_storage, "_local_root", return_value=root), legacy_max_path():
            self.assertTrue(library_storage.ensure_ready("local"))
            key = library_storage.object_key("owner-1", "3259e758-4ecf-41b3-b385-0f86b67c3867")
            library_storage.put_bytes(key, b"hello", "text/plain", backend="local")
            self.assertEqual(library_storage.read_bytes(key, backend="local"), b"hello")
            library_storage.delete(key, backend="local")


@unittest.skipUnless(os.name == "nt", "Windows MAX_PATH semantics")
class LegacyMaxPathHttpTests(library_http.LibraryHttpTestCase):
    """Upload and note creation through the real routes and the local adapter."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.storage_patch.stop()  # Use the real local adapter, not the in-memory store.
        self.storage_patch = SimpleNamespace(stop=lambda: None)  # asyncTearDown stops it again.
        self.root = deep_root(long_tempdir(self))
        self.enterContext(patch.object(library_storage, "_local_root", return_value=self.root))
        self.enterContext(patch.object(library_storage, "storage_backend", return_value="local"))
        self.enterContext(legacy_max_path())

    async def test_upload_and_note_creation_under_a_220_character_root(self):
        upload = await self.request("POST", "/items/upload",
                                    files={"file": ("guide.txt", b"uploaded guide", "text/plain")})
        self.assertEqual(upload.status_code, 200, upload.text)
        self.assertEqual(upload.json()["item"]["size"], len(b"uploaded guide"))
        await self.create_item(title="long root note", content="note body")
        # Walk with the extended-length form so the check itself is not limited by MAX_PATH.
        stored = sorted(Path(base, name).read_bytes()
                        for base, _, names in os.walk(EXTENDED + str(self.root.resolve())) for name in names)
        self.assertEqual(len(stored), 2, stored)
        self.assertIn(b"uploaded guide", stored)


if __name__ == "__main__":
    unittest.main()
