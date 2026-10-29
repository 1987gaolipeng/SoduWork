"""ZIP browsing through the authenticated library routes, without extraction."""
import hashlib
import io
import stat
import struct
import warnings
import zlib
from unittest.mock import patch
from zipfile import ZIP_BZIP2, ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

from tests.test_library import LibraryHttpTestCase
from app.deps import current_client
from app.library_models import LibraryItem
from app.services import library_storage


def zip_bytes(entries, compression=ZIP_STORED):
    output = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with ZipFile(output, "w", compression=compression) as archive:
            for path, content in entries:
                archive.writestr(path, content)
    return output.getvalue()


class LibraryArchiveTests(LibraryHttpTestCase):
    async def upload_zip(self, data=None, entries=None, filename="资料.zip"):
        response = await self.request("POST", "/items/upload", files={
            "file": (filename, data if data is not None else zip_bytes(entries or []), "application/zip"),
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["item"]

    async def listing(self, item, **kwargs):
        return await self.request("GET", f"/items/{item['id']}/archive", **kwargs)

    async def member(self, item, path, **kwargs):
        return await self.request("GET", f"/items/{item['id']}/archive/file", params={"path": path}, **kwargs)

    async def assert_error(self, response, status, code):
        self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(response.json()["detail"]["code"], code)

    async def test_directory_listing_includes_empty_and_implicit_folders(self):
        item = await self.upload_zip(entries=[("empty/", b""), ("站点/index.html", b"<h1>Hello</h1>"),
                                               ("站点/assets/icon.svg", b"<svg/>"), ("README.md", b"# Hello")])
        response = await self.listing(item)
        self.assertEqual(response.status_code, 200, response.text)
        manifest = response.json()["archive"]
        entries = {entry["path"]: entry for entry in manifest["files"]}
        self.assertEqual(set(entries), {"empty", "站点", "站点/assets", "站点/index.html", "站点/assets/icon.svg", "README.md"})
        self.assertTrue(entries["empty"]["isDirectory"])
        self.assertTrue(entries["站点/assets"]["isDirectory"])
        self.assertEqual(entries["站点/index.html"]["filename"], "index.html")
        self.assertEqual(entries["站点/index.html"]["contentType"], "text/html")
        self.assertEqual(manifest["fileCount"], 3)
        self.assertEqual(manifest["directoryCount"], 3)
        self.assertEqual(manifest["totalSize"], 27)
        self.assertEqual((await self.request("GET", "" )).json()["items"][0]["updatedAt"], item["updatedAt"])

    async def test_member_bytes_and_headers_are_safe_and_original_is_unchanged(self):
        original = zip_bytes([("folder/photo.png", b"\x89PNG\x00payload"), ("folder/page.html", b"<script>alert(1)</script>")])
        item = await self.upload_zip(data=original)
        response = await self.member(item, "folder/photo.png")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"\x89PNG\x00payload")
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertIn("attachment", response.headers["content-disposition"])
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertIn("sandbox", response.headers["content-security-policy"])
        self.assertEqual((await self.request("GET", f"/items/{item['id']}/download")).content, original)

    async def test_text_preview_uses_existing_encoding_support(self):
        item = await self.upload_zip(entries=[("中文.txt", "资料预览".encode("gb18030"))])
        response = await self.request("GET", f"/items/{item['id']}/archive/file",
                                      params={"path": "中文.txt", "preview": "true"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["content"], "资料预览")
        self.assertEqual(response.json()["preview"]["encoding"], "gb18030")

    async def test_empty_zip_is_a_valid_empty_folder(self):
        response = await self.listing(await self.upload_zip())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["archive"]["files"], [])

    async def test_html_members_share_meta_charset_decoding_and_binary_rejection(self):
        text = '<meta charset="windows-1252"><h1>Café</h1>'
        item = await self.upload_zip(entries=[
            ("site/index.html", text.encode("cp1252")),
            ("site/bom.htm", text.encode("utf-16")),
            ("site/binary.html", text.encode("cp1252") + b"\x00\x01"),
        ])
        for path, encoding in (("site/index.html", "cp1252"), ("site/bom.htm", "utf-16")):
            with self.subTest(path=path):
                response = await self.request("GET", f"/items/{item['id']}/archive/file",
                                              params={"path": path, "preview": "true"})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["content"], text)
                self.assertEqual(response.json()["preview"]["encoding"], encoding)
        response = await self.request("GET", f"/items/{item['id']}/archive/file",
                                      params={"path": "site/binary.html", "preview": "true"})
        await self.assert_error(response, 415, "LIBRARY_ARCHIVE_PREVIEW_UNSUPPORTED")

    async def test_foreign_and_deleted_items_cannot_be_listed_or_read(self):
        item = await self.upload_zip(entries=[("private.txt", b"secret")])
        for operation in (self.listing(item, owner="bob"), self.member(item, "private.txt", owner="bob")):
            response = await operation
            self.assertEqual(response.status_code, 404, response.text)
        await self.request("DELETE", f"/items/{item['id']}")
        self.assertEqual((await self.listing(item)).status_code, 404)
        self.assertEqual((await self.member(item, "private.txt")).status_code, 404)

    async def test_archive_routes_require_authentication(self):
        item = await self.upload_zip(entries=[("private.txt", b"secret")])
        self.app.dependency_overrides.pop(current_client)
        self.assertEqual((await self.listing(item)).status_code, 401)
        self.assertEqual((await self.member(item, "private.txt")).status_code, 401)

    async def test_missing_members_and_directories_are_not_downloadable(self):
        item = await self.upload_zip(entries=[("folder/", b""), ("folder/a.txt", b"a")])
        for path in ("missing.txt", "folder"):
            await self.assert_error(await self.member(item, path), 404, "LIBRARY_ARCHIVE_MEMBER_NOT_FOUND")

    async def test_traversal_and_absolute_member_requests_are_rejected(self):
        item = await self.upload_zip(entries=[("safe.txt", b"safe")])
        for path in ("../safe.txt", "/safe.txt", "C:/safe.txt", "folder/../safe.txt", "folder\\..\\safe.txt"):
            with self.subTest(path=path):
                await self.assert_error(await self.member(item, path), 400, "LIBRARY_ARCHIVE_UNSAFE_PATH")

    async def test_unsafe_entries_reject_the_archive_before_any_member_is_exposed(self):
        for path in ("../escape.txt", "/absolute.txt", "C:\\escape.txt", "a/../b.txt", "a//b.txt", "bad\nname.txt"):
            with self.subTest(path=path):
                item = await self.upload_zip(entries=[("safe.txt", b"safe"), (path, b"bad")])
                await self.assert_error(await self.listing(item), 400, "LIBRARY_ARCHIVE_UNSAFE_PATH")
                await self.assert_error(await self.member(item, "safe.txt"), 400, "LIBRARY_ARCHIVE_UNSAFE_PATH")

    async def test_duplicate_case_collisions_and_file_folder_collisions_are_rejected(self):
        for entries in ([('same.txt', b'1'), ('same.txt', b'2')],
                        [('Folder/A.txt', b'1'), ('folder/a.txt', b'2')],
                        [('a', b'1'), ('a/b.txt', b'2')],
                        [('a\\b.txt', b'1'), ('a/b.txt', b'2')]):
            with self.subTest(entries=entries):
                await self.assert_error(await self.listing(await self.upload_zip(entries=entries)),
                                        400, "LIBRARY_ARCHIVE_AMBIGUOUS_PATH")

    async def test_symlinks_and_special_files_are_rejected(self):
        for mode in (stat.S_IFLNK, stat.S_IFIFO):
            entry = ZipInfo("unsafe")
            entry.create_system = 3
            entry.external_attr = (mode | 0o777) << 16
            item = await self.upload_zip(entries=[(entry, b"../../target")])
            await self.assert_error(await self.listing(item), 415, "LIBRARY_ARCHIVE_UNSUPPORTED_ENTRY")

    async def test_corrupt_zip_and_corrupt_member_report_read_errors(self):
        await self.assert_error(await self.listing(await self.upload_zip(data=b"not a zip")),
                                415, "LIBRARY_ARCHIVE_INVALID")
        data = bytearray(zip_bytes([("a.txt", b"original")]))
        data[data.index(b"original")] ^= 1
        item = await self.upload_zip(data=bytes(data))
        await self.assert_error(await self.member(item, "a.txt"), 422, "LIBRARY_ARCHIVE_CORRUPT_MEMBER")

    async def test_encrypted_entries_are_not_silently_treated_as_empty_files(self):
        data = bytearray(zip_bytes([("locked.txt", b"locked")]))
        for signature, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
            start = data.index(signature)
            flags = struct.unpack_from("<H", data, start + offset)[0]
            struct.pack_into("<H", data, start + offset, flags | 1)
        await self.assert_error(await self.listing(await self.upload_zip(data=bytes(data))),
                                415, "LIBRARY_ARCHIVE_ENCRYPTED")

    async def test_archive_size_is_bounded_before_storage_read(self):
        item = await self.upload_zip(entries=[("a.txt", b"a")])
        async with self.sessions() as session:
            row = await session.get(LibraryItem, item["id"])
            row.size = 65 * 1024 * 1024
            await session.commit()
        with patch.object(library_storage, "read_bytes", side_effect=AssertionError("must not read")):
            await self.assert_error(await self.listing(item), 413, "LIBRARY_ARCHIVE_TOO_LARGE")

    async def test_member_and_total_uncompressed_limits_are_checked(self):
        from app.services import library_archive
        item = await self.upload_zip(entries=[("a.txt", b"12345"), ("b.txt", b"67890")])
        with patch.object(library_archive, "MAX_MEMBER_BYTES", 4):
            await self.assert_error(await self.listing(item), 413, "LIBRARY_ARCHIVE_TOO_LARGE")
        with patch.object(library_archive, "MAX_TOTAL_BYTES", 9):
            await self.assert_error(await self.listing(item), 413, "LIBRARY_ARCHIVE_TOO_LARGE")

    async def test_entry_count_and_compression_bombs_are_bounded(self):
        from app.services import library_archive
        item = await self.upload_zip(entries=[("a.txt", b"a"), ("b.txt", b"b"), ("c.txt", b"c")])
        with patch.object(library_archive, "MAX_ENTRIES", 2):
            await self.assert_error(await self.listing(item), 413, "LIBRARY_ARCHIVE_TOO_LARGE")
        compressed = zip_bytes([("bomb.txt", b"0" * (2 * 1024 * 1024))], ZIP_DEFLATED)
        await self.assert_error(await self.listing(await self.upload_zip(data=compressed)),
                                413, "LIBRARY_ARCHIVE_TOO_LARGE")

    async def test_delivery_zip_keeps_immutable_digest_verification(self):
        original = zip_bytes([("a.txt", b"original")])
        item = await self.upload_zip(data=original)
        async with self.sessions() as session:
            row = await session.get(LibraryItem, item["id"])
            row.extra = {"soduWorkDelivery": {"kind": "bundle", "objectSha256": hashlib.sha256(original).hexdigest()}}
            key = row.storage_key
            await session.commit()
        response = await self.member(item, "a.txt")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"original")
        self.store.objects[key] = zip_bytes([("a.txt", b"modified")])
        await self.assert_error(await self.listing(item), 502, "LIBRARY_ARCHIVE_INTEGRITY")

    async def test_missing_and_incomplete_storage_objects_are_distinguished(self):
        item = await self.upload_zip(entries=[("a.txt", b"a")])
        key = next(iter(self.store.objects))
        original = self.store.objects[key]
        self.store.objects[key] = original[:-1]
        await self.assert_error(await self.listing(item), 502, "LIBRARY_ARCHIVE_INTEGRITY")
        del self.store.objects[key]
        await self.assert_error(await self.listing(item), 404, "LIBRARY_ARCHIVE_OBJECT_NOT_FOUND")

    async def test_non_zip_files_are_not_opened_as_archives(self):
        item = await self.upload_zip(entries=[("document.xml", b"data")], filename="report.docx")
        await self.assert_error(await self.listing(item), 415, "LIBRARY_ARCHIVE_UNSUPPORTED")

    async def test_zip_mime_without_filename_extension_can_be_browsed(self):
        item = await self.upload_zip(entries=[("readme.txt", b"hello")], filename="资料")
        response = await self.listing(item)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((await self.member(item, "readme.txt")).content, b"hello")

    async def test_legacy_chinese_and_unicode_path_extra_names_remain_readable(self):
        for encoding, display, use_extra in (("gb18030", "报告.txt", False),
                                              ("utf-8", "说明.md", False),
                                              ("cp437", "café.txt", False),
                                              ("cp437", "报告.txt", True)):
            raw_name = b"report.txt" if use_extra else display.encode(encoding)
            name = "x" * len(raw_name)
            info = ZipInfo(name)
            if use_extra:
                unicode_path = b"\x01" + struct.pack("<I", zlib.crc32(raw_name)) + display.encode("utf-8")
                info.extra = struct.pack("<HH", 0x7075, len(unicode_path)) + unicode_path
            data = bytearray(zip_bytes([(info, b"content")]))
            for signature, offset in ((b"PK\x03\x04", 30), (b"PK\x01\x02", 46)):
                start = data.index(signature) + offset
                data[start:start + len(raw_name)] = raw_name
            item = await self.upload_zip(data=bytes(data))
            with self.subTest(encoding=encoding, extra=use_extra):
                response = await self.listing(item)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["archive"]["files"][0]["filename"], display)
                self.assertEqual((await self.member(item, display)).content, b"content")

    async def test_unsupported_compression_returns_an_actionable_error(self):
        item = await self.upload_zip(data=zip_bytes([("a.txt", b"compressed")], ZIP_BZIP2))
        await self.assert_error(await self.listing(item), 415, "LIBRARY_ARCHIVE_UNSUPPORTED_ENTRY")

    async def test_entry_budget_cannot_be_bypassed_by_forged_directory_count(self):
        from app.services import library_archive
        data = bytearray(zip_bytes([("a.txt", b"a"), ("b.txt", b"b"), ("c.txt", b"c")]))
        end = data.rfind(b"PK\x05\x06")
        struct.pack_into("<HH", data, end + 8, 1, 1)
        item = await self.upload_zip(data=bytes(data))
        with patch.object(library_archive, "MAX_ENTRIES", 2):
            await self.assert_error(await self.listing(item), 413, "LIBRARY_ARCHIVE_TOO_LARGE")

    async def test_null_filename_is_not_silently_shortened_by_zipinfo(self):
        data = bytearray(zip_bytes([("safe.txt", b"content")]))
        for signature, offset in ((b"PK\x03\x04", 30), (b"PK\x01\x02", 46)):
            start = data.index(signature) + offset
            data[start + 4] = 0
        item = await self.upload_zip(data=bytes(data))
        await self.assert_error(await self.listing(item), 400, "LIBRARY_ARCHIVE_UNSAFE_PATH")
