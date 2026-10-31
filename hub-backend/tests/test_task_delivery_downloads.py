"""Task ZIP downloads use real archive bytes, isolated SQLite and local storage."""
import io
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import uuid
import zipfile

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from fastapi import FastAPI, Request
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import delivery
from app.automation_models import ArtifactVersion, ApprovalAssignment, ApprovalDecision, ApprovalRequest
from app.db import Base, get_session
from app.deps import current_client
from app.models import Attachment, Client, Task, User
from app.services import delivery_collections, storage


def archive_bytes(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as archive:
        for name, data in files:
            archive.writestr(name, data)
    return buf.getvalue()


class TaskDeliveryDownloadsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-task-downloads-")
        self.root = Path(self.temp.name)
        self.engine = create_async_engine("sqlite+aiosqlite:///" + (self.root / "test.sqlite").as_posix())
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda connection: Base.metadata.create_all(connection, tables=[
                Client.__table__, User.__table__, Task.__table__, Attachment.__table__,
                ArtifactVersion.__table__, ApprovalAssignment.__table__,
                ApprovalDecision.__table__, ApprovalRequest.__table__]))
        async with self.sessions() as session:
            session.add_all([User(id="alice", username="alice", is_active=True),
                             User(id="bob", username="bob", is_active=True),
                             Client(id="desktop", user_ref="alice")])
            await session.commit()
        app = FastAPI()
        app.include_router(delivery.router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def client_override(request: Request):
            return Client(id=request.headers.get("X-Device", "desktop"),
                          user_ref=request.headers.get("X-Account", "alice"))

        app.dependency_overrides[get_session] = session_override
        app.dependency_overrides[current_client] = client_override
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.storage_patch = patch.object(storage, "_local_path",
            side_effect=lambda key: str(self.root / "attachments" / key))
        self.storage_patch.start()
        self.backend_patch = patch.object(storage, "backend_name", return_value="local")
        self.backend_patch.start()

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()
        self.backend_patch.stop()
        self.storage_patch.stop()
        self.temp.cleanup()

    async def seed(self, files, *, fixed=True, extra_ids=()):
        tid = str(uuid.uuid4())
        aid = str(uuid.uuid4())
        rows = []
        (self.root / "attachments" / tid).mkdir(parents=True, exist_ok=True)
        async with self.sessions() as session:
            task = Task(id=tid, title="Website and report", owner_client_id="desktop")
            session.add(task)
            for index, (name, data, role) in enumerate(files):
                key = tid + "/" + str(index)
                backend = storage.put(key, data, "application/octet-stream")
                row = Attachment(id=tid + ":" + str(index), task_id=tid, filename=name,
                    size=len(data), storage_key=key, backend=backend,
                    content_type="application/octet-stream", role=role, uploaded_by="agent:test")
                rows.append(row)
                session.add(row)
            if fixed:
                selected = [{"id": row.id} for row in rows if row.role in {"output", "supporting"}]
                session.add(ArtifactVersion(id=aid, task_id=tid, seq=1, kind="files",
                    checksum="fixed-version", manifest={"schemaVersion": "1.0",
                        "primary": selected + [{"id": key} for key in extra_ids],
                        "supporting": [], "problems": []}))
            await session.commit()
            self.assertEqual(task.owner_user_id, "alice")
        return tid, aid, rows

    async def download(self, tid, version="", **kwargs):
        return await self.http.get(f"/api/v1/tasks/{tid}/artifacts.zip",
            params={"artifactVersionId": version} if version else {}, **kwargs)

    def assert_archive(self, reply, expected):
        self.assertEqual(reply.status_code, 200, reply.text[:500] if reply.status_code != 200 else "")
        with zipfile.ZipFile(io.BytesIO(reply.content)) as archive:
            self.assertEqual(len(archive.infolist()), len(expected))
            self.assertEqual({name: archive.read(name) for name in archive.namelist()}, expected)
        self.assertEqual(int(reply.headers["X-Artifact-Count"]), len(expected))

    async def test_complete_website_and_independent_markdown_word_are_all_downloaded(self):
        website = [("site/index.html", b"<html><link href='assets/theme.css'></html>"),
                   ("site/assets/theme.css", b"body{color:#333}")]
        word = archive_bytes([("[Content_Types].xml", b"<Types/>"), ("word/document.xml", b"<document/>")])
        report = b"# Final report\nAll results matter."
        tid, version, _ = await self.seed([
            ("完整产出-site.zip", archive_bytes(website), "output"),
            ("report.md", report, "output"), ("report.docx", word, "output"),
            ("private-input.txt", b"not output", "input")])
        reply = await self.download(tid, version)
        self.assert_archive(reply, dict(website + [("report.md", report), ("report.docx", word)]))
        self.assertEqual(reply.headers["X-Artifact-Version"], version)

    async def test_identical_paths_are_deduplicated_and_original_bundle_preserved(self):
        website = [("index.html", b"<html>Result</html>"), ("assets/theme.css", b"body{}")]
        raw = archive_bytes(website)
        tid, version, _ = await self.seed([("完整产出-site.zip", raw, "output"),
            (website[0][0], website[0][1], "output"), (website[1][0], website[1][1], "supporting")])
        reply = await self.download(tid, version)
        self.assert_archive(reply, dict(website))
        self.assertEqual(reply.content, raw)

    async def test_conflicting_or_case_ambiguous_paths_never_silently_overwrite(self):
        for name, data in (("report.md", b"New report"), ("REPORT.md", b"Old report")):
            with self.subTest(name=name):
                tid, version, _ = await self.seed([
                    ("完整产出-site.zip", archive_bytes([("report.md", b"Old report")]), "output"),
                    (name, data, "output")])
                reply = await self.download(tid, version)
                self.assertEqual(reply.status_code, 409, reply.text)
                self.assertIn("路径冲突", reply.json()["detail"])

    async def test_missing_fixed_version_member_refuses_partial_archive(self):
        tid, version, _ = await self.seed([
            ("完整产出-site.zip", archive_bytes([("index.html", b"<html>Result</html>")]), "output")],
            extra_ids=["missing-report"])
        reply = await self.download(tid, version)
        self.assertEqual(reply.status_code, 502, reply.text)
        self.assertIn("缺少成果文件", reply.json()["detail"])

    async def test_missing_standalone_object_with_valid_bundle_refuses_partial_archive(self):
        tid, version, rows = await self.seed([
            ("完整产出-site.zip", archive_bytes([("index.html", b"<html>Result</html>")]), "output"),
            ("report.md", b"Report", "output")])
        storage.delete(rows[1].storage_key, rows[1].backend)
        reply = await self.download(tid, version)
        self.assertEqual(reply.status_code, 502, reply.text)
        self.assertIn("拒绝返回不完整", reply.json()["detail"])

    async def test_damaged_or_unsafe_zip_member_cannot_be_laundered_by_merge(self):
        link = zipfile.ZipInfo("assets/theme.css")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        broken = archive_bytes([("report.md", b"unique-original-content")])
        broken = broken.replace(b"unique-original-content", b"unique-modified-content")
        for raw in (broken, archive_bytes([(link, b"../outside")]),
                    archive_bytes([("../outside.md", b"escape")])):
            with self.subTest(size=len(raw)):
                tid, version, _ = await self.seed([
                    ("完整产出-site.zip", raw, "output"), ("report.md", b"Report", "output")])
                reply = await self.download(tid, version)
                self.assertEqual(reply.status_code, 502, reply.text)
                self.assertEqual(reply.headers["content-type"], "application/json")

    async def test_missing_bytes_and_file_directory_collision_fail_closed(self):
        tid, version, rows = await self.seed([
            ("完整产出-site.zip", archive_bytes([("index.html", b"<html>Result</html>")]), "output"),
            ("report.md", b"complete report", "output")])
        storage.put(rows[1].storage_key, b"partial", "text/markdown")
        reply = await self.download(tid, version)
        self.assertEqual(reply.status_code, 502, reply.text)
        tid, version, _ = await self.seed([
            ("完整产出-site.zip", archive_bytes([("assets", b"file")]), "output"),
            ("assets/theme.css", b"body{}", "supporting")])
        reply = await self.download(tid, version)
        self.assertEqual(reply.status_code, 502, reply.text)
        self.assertIn("路径冲突", reply.json()["detail"])

    async def test_multiple_complete_bundles_merge_and_ordinary_archives_remain_files(self):
        input_archive = archive_bytes([("sample.csv", b"a,b\n1,2")])
        tid, version, _ = await self.seed([
            ("完整产出-site.zip", archive_bytes([("index.html", b"<html>Result</html>")]), "output"),
            ("完整产出-docs.zip", archive_bytes([("docs/readme.md", b"Guide")]), "output"),
            ("dataset.zip", input_archive, "output")])
        self.assert_archive(await self.download(tid, version), {
            "index.html": b"<html>Result</html>", "docs/readme.md": b"Guide", "dataset.zip": input_archive})

    async def test_download_keeps_existing_limits_instead_of_library_upload_limits(self):
        tid, version, _ = await self.seed([
            ("完整产出-site.zip", archive_bytes([("index.html", b"<html>Result</html>")]), "output"),
            ("report.md", b"Report larger than artificial upload cap", "output")])
        with patch.object(delivery_collections, "byte_limit", return_value=8):
            reply = await self.download(tid, version)
        self.assertEqual(reply.status_code, 200, reply.text[:100] if reply.status_code != 200 else "")

    async def test_fixed_version_ignores_later_files_and_keeps_acl(self):
        tid, version, _ = await self.seed([("report.md", b"original", "output")])
        async with self.sessions() as session:
            key = tid + "/later"
            storage.put(key, b"later", "text/plain")
            session.add(Attachment(id=str(uuid.uuid4()), task_id=tid, filename="report.md", size=5,
                storage_key=key, backend="local", role="output", uploaded_by="agent:test"))
            await session.commit()
        self.assert_archive(await self.download(tid, version), {"report.md": b"original"})
        denied = await self.download(tid, version, headers={"X-Device": "other-device"})
        self.assertEqual(denied.status_code, 404, denied.text)
        async with self.sessions() as session:
            device = await session.get(Client, "desktop")
            device.user_ref = "bob"
            await session.commit()
        rebound = await self.download(tid, version, headers={"X-Account": "bob"})
        self.assertEqual(rebound.status_code, 404, rebound.text)

    async def test_no_fixed_version_still_downloads_latest_files_and_excludes_inputs(self):
        tid, _, _ = await self.seed([("report.md", b"old", "output"),
            ("report.md", b"new", "output"), ("input.txt", b"private", "input"),
            ("process.log", b"internal", "process")], fixed=False)
        self.assert_archive(await self.download(tid), {"report.md": b"new"})


if __name__ == "__main__":
    unittest.main()
