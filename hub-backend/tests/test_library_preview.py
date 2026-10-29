"""Read-only preview behavior through the authenticated library HTTP API."""
import hashlib
import io
from unittest.mock import patch
from zipfile import ZipFile

from tests.test_library import LibraryHttpTestCase
from app.library_models import LibraryItem
from app.services import library_formats, library_storage


class LibraryPreviewTests(LibraryHttpTestCase):
    async def upload(self, filename, data, content_type="application/octet-stream"):
        response = await self.request("POST", "/items/upload", files={
            "file": (filename, data, content_type),
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["item"]

    async def preview(self, item):
        return await self.request("GET", f"/items/{item['id']}/content", params={"preview": "true"})

    async def test_upload_sources_preview_without_enabling_destructive_editor(self):
        samples = [
            ("data.json", '{"name":"报告"}', "application/json"),
            ("config.xml", '<root>资料</root>', "application/xml"),
            ("app.py", 'print("你好")\n', "application/octet-stream"),
            ("README", "Plain readme\n", "application/octet-stream"),
            (".env", "NAME=demo\n", "application/octet-stream"),
            ("page.html", "<!doctype html><h1>标题</h1>", "text/html"),
            ("notes.md", "# 标题\n", "text/markdown"),
            ("data.csv", 'name,value\n"a,b",2\n', "text/csv"),
        ]
        for filename, text, mime in samples:
            with self.subTest(filename=filename):
                item = await self.upload(filename, text.encode("utf-8"), mime)
                response = await self.preview(item)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["content"], text)
        item = await self.upload("other.json", b'{"v":1}', "application/json")
        edit = await self.request("PATCH", f"/items/{item['id']}", json={"content": "oops"})
        self.assertEqual(edit.status_code, 400, edit.text)

    async def test_bom_and_chinese_legacy_encodings_decode_without_garbage(self):
        for encoding in ("utf-8-sig", "utf-16", "utf-32", "gb18030"):
            with self.subTest(encoding=encoding):
                item = await self.upload("report.txt", "中文报告\n第二行".encode(encoding), "text/plain")
                response = await self.preview(item)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["content"], "中文报告\n第二行")

    async def test_binary_mislabeled_as_text_and_legacy_office_are_not_decoded(self):
        for filename, data, mime in (
            ("bad.txt", b"MZ\x00\x01payload", "text/plain"),
            ("old.doc", b"\xd0\xcf\x11\xe0binary", "application/msword"),
            ("unreadable.txt", b"\xff\x81\xff", "text/plain"),
        ):
            with self.subTest(filename=filename):
                response = await self.preview(await self.upload(filename, data, mime))
                self.assertEqual(response.status_code, 415, response.text)

    async def test_html_meta_charset_decodes_supported_legacy_documents(self):
        for filename, meta in (
            ("page.html", '<meta charset="windows-1252">'),
            ("page.htm", "<META CHARSET='WINDOWS-1252'>"),
            ("page.xhtml", '<meta content="text/html; charset=windows-1252" http-equiv="Content-Type" />'),
        ):
            with self.subTest(filename=filename):
                original = '<!doctype html><html><head>' + meta + '</head><body>Café</body></html>'
                item = await self.upload(filename, original.encode("cp1252"), "text/html")
                response = await self.preview(item)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["content"], original)
                self.assertEqual(response.json()["preview"]["encoding"], "cp1252")

    async def test_html_charset_precedence_is_bom_then_http_then_meta(self):
        original = '<meta charset="windows-1252"><p>中文 Café</p>'
        for encoding, mime, expected in (
            ("utf-8-sig", "text/html; charset=windows-1252", "utf-8-sig"),
            ("utf-16", "text/html; charset=windows-1252", "utf-16"),
            ("utf-8", "text/html; charset=utf-8", "utf-8"),
        ):
            with self.subTest(encoding=encoding):
                response = await self.preview(await self.upload("page.html", original.encode(encoding), mime))
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["content"], original)
                self.assertEqual(response.json()["preview"]["encoding"], expected)
        # An explicitly declared but invalid UTF-8 payload must not be silently
        # decoded using a conflicting meta declaration.
        data = '<meta charset="windows-1252"><p>Café</p>'.encode("cp1252")
        response = await self.preview(await self.upload("page.html", data, "text/html; charset=utf-8"))
        self.assertEqual(response.status_code, 415, response.text)

    async def test_html_meta_sniffing_is_bounded_and_does_not_relax_binary_rejection(self):
        meta = '<meta charset="windows-1252">'
        for filename, prefix, suffix, mime in (
            ("page.txt", meta, "", "text/plain"),
            ("page.md", meta, "", "text/markdown"),
            ("page.txt", meta, "", "text/html"),
            ("page.html", '<!--' + meta + '-->', "", "text/html"),
            ("page.html", '<script>const hint=\'' + meta + '\'</script>', "", "text/html"),
            ("page.html", '<title>' + meta + '</title>', "", "text/html"),
            ("page.html", '<body><textarea>' + meta + '</textarea>', "", "text/html"),
            ("page.html", '<meta charset="untrusted-codec">', "", "text/html"),
            ("page.html", ' ' * 4096 + meta, "", "text/html"),
            ("page.html", meta, "\x00\x01", "text/html"),
        ):
            with self.subTest(filename=filename, prefix=prefix[:60], suffix=repr(suffix), mime=mime):
                data = (prefix + '<p>Café</p>' + suffix).encode("cp1252")
                response = await self.preview(await self.upload(filename, data, mime))
                self.assertEqual(response.status_code, 415, response.text)

    async def test_office_files_use_system_open_while_existing_editor_read_still_works(self):
        for kind in ("legacy_document", "spreadsheet", "presentation"):
            with self.subTest(kind=kind):
                data, suffix, mime = library_formats.export(kind, "Office", "Content")
                item = await self.upload("office" + suffix, data, mime)
                preview = await self.preview(item)
                self.assertEqual(preview.status_code, 415, preview.text)
                editor = await self.request("GET", f"/items/{item['id']}/content")
                self.assertEqual(editor.status_code, 200, editor.text)
                self.assertIn("Content", editor.json()["content"])

    async def test_invalid_office_packages_return_preview_error_not_missing_file(self):
        stream = io.BytesIO()
        with ZipFile(stream, "w") as package:
            package.writestr("wrong.xml", "<wrong/>")
        for data in (b"invalid package", stream.getvalue()):
            for filename in ("bad.docx", "bad.xlsx", "bad.pptx"):
                response = await self.preview(await self.upload(filename, data))
                self.assertEqual(response.status_code, 415, response.text)

    async def test_plain_content_keeps_existing_csv_editor_round_trip(self):
        item = await self.upload("rows.csv", b'Name,Value\n"a,b",2\n', "text/csv")
        editor = await self.request("GET", f"/items/{item['id']}/content")
        self.assertEqual(editor.status_code, 200, editor.text)
        self.assertEqual(editor.json()["content"], "Name\tValue\na,b\t2")
        saved = await self.request("PATCH", f"/items/{item['id']}", json={"content": editor.json()["content"]})
        self.assertEqual(saved.status_code, 200, saved.text)
        source = await self.preview(item)
        self.assertEqual(source.json()["content"].splitlines(), ['Name,Value', '"a,b",2'])

    async def test_long_text_is_labeled_partial_and_original_remains_downloadable(self):
        original = ("x" * (2 * 1024 * 1024) + "END").encode()
        item = await self.upload("long.txt", original, "text/plain")
        response = await self.preview(item)
        self.assertEqual(response.status_code, 200, response.text[:100])
        self.assertTrue(response.json()["preview"]["truncated"])
        self.assertNotIn("END", response.json()["content"])
        download = await self.request("GET", f"/items/{item['id']}/download")
        self.assertEqual(download.content, original)

    async def test_large_preview_rejected_without_reading_payload(self):
        item = await self.upload("large.txt", b"x", "text/plain")
        async with self.sessions() as session:
            row = await session.get(LibraryItem, item["id"])
            row.size = 32 * 1024 * 1024
            await session.commit()
        with patch.object(library_storage, "read_bytes", side_effect=AssertionError("must not read")):
            response = await self.preview(item)
        self.assertEqual(response.status_code, 413, response.text)

    async def test_delivery_preview_checks_immutable_payload_hash(self):
        item = await self.upload("artifact.txt", b"original", "text/plain")
        async with self.sessions() as session:
            row = await session.get(LibraryItem, item["id"])
            row.extra = {"soduWorkDelivery": {
                "schemaVersion": 1, "kind": "file", "source": "local",
                "sessionId": "session-001", "objectSha256": hashlib.sha256(b"original").hexdigest(),
            }}
            key = row.storage_key
            await session.commit()
        store = self.store

        def read_bytes(key, limit=16 * 1024 * 1024, backend=None):
            return store.read_bytes(key, limit=limit)

        with patch.object(library_storage, "read_bytes", new=read_bytes):
            good = await self.preview(item)
            self.assertEqual(good.status_code, 200, good.text)
            self.store.objects[key] = b"modified"
            response = await self.preview(item)
        self.assertEqual(response.status_code, 502, response.text)

    async def test_preview_preserves_ownership_and_does_not_mutate_file(self):
        item = await self.upload("data.json", b"{}", "application/json")
        other = await self.request("GET", f"/items/{item['id']}/content", owner="bob")
        self.assertEqual(other.status_code, 404, other.text)
        preview = await self.preview(item)
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["item"]["updatedAt"], item["updatedAt"])
        download = await self.request("GET", f"/items/{item['id']}/download")
        self.assertEqual(download.content, b"{}")
