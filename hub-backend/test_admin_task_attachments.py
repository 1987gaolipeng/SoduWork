"""Administrator task attachments must each keep their own stored object."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("AUTH_SECRET", "isolated-admin-attachment-test-key")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from sqlalchemy import select

from app import models
from app.api import admin
from app.auth import sign_token
from app.services import resource_access, storage
import test_unified_requirements as unified


class AdminTaskAttachmentTests(unittest.IsolatedAsyncioTestCase):
    # Reuse the fixture without importing its test class into this module,
    # which would make unittest collect and rerun the whole suite here.
    asyncTearDown = unified.UnifiedRequirementTests.asyncTearDown

    async def asyncSetUp(self):
        await unified.UnifiedRequirementTests.asyncSetUp(self)
        self.app.include_router(admin.router)
        async with self.sessions() as session:
            session.add(models.Role(id="attachment-operator", name="Attachment operator",
                                    permissions=["task.view", "task.dispatch"]))
            for who in ("owner", "outsider"):
                (await session.get(models.User, who)).role_id = "attachment-operator"
            await session.commit()
        folder = tempfile.TemporaryDirectory()
        self.storage_dir = Path(folder.name)
        self.addCleanup(folder.cleanup)
        self.enterContext(patch.object(storage, "_LOCAL_DIR", folder.name))
        self.enterContext(patch.object(storage, "backend_name", return_value="local"))

    async def call(self, method, path, who="owner", **kwargs):
        headers = {"Authorization": "Bearer " + sign_token(who, 1)} if who else {}
        return await self.http.request(method, "/api/v1/" + path, headers=headers, **kwargs)

    async def upload(self, content):
        response = await self.call("POST", "admin/tasks/shared/attachments",
                                   files={"file": ("plan.txt", content, "text/plain")})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_same_filename_uploads_do_not_overwrite_each_other(self):
        await self.assert_independent_uploads(b"first version", b"second version, longer")

    async def test_equal_size_uploads_do_not_silently_change_the_first_file(self):
        await self.assert_independent_uploads(b"version A", b"version B")

    async def test_desktop_upload_keeps_long_filename_and_content(self):
        task_id = "attachment-verification-332"
        async with self.sessions() as session:
            session.add(models.Task(id=task_id, title="Attachment verification",
                                    owner_client_id="owner", created_by="owner"))
            await session.commit()
        filename = "需求验收资料汇总" * 24 + "复核记录.txt"
        content = b"Local attachment verification.\n"
        endpoint = f"tasks/{task_id}/attachments"
        device_call = unified.UnifiedRequirementTests.call
        uploaded = await device_call(self, "POST", endpoint,
                                     files={"file": (filename, content, "text/plain")})
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        listing = await device_call(self, "GET", endpoint)
        self.assertEqual(listing.status_code, 200, listing.text)
        [row] = listing.json()
        self.assertEqual(row["id"], uploaded.json()["id"])
        self.assertEqual(row["filename"], filename)
        download = await self.http.get(row["url"])
        self.assertEqual(download.status_code, 200, download.text)
        self.assertEqual(download.content, content)

    async def assert_independent_uploads(self, first_content, second_content):
        first = await self.upload(first_content)
        second = await self.upload(second_content)
        async with self.sessions() as session:
            rows = {row.id: row for row in await session.scalars(select(models.Attachment).where(
                models.Attachment.id.in_([first["id"], second["id"]])))}
        keys = {row.storage_key for row in rows.values()}
        self.assertEqual(len(keys), 2, keys)
        for row in rows.values():
            self.assertIn("/" + row.id + "/", row.storage_key)
            self.assertNotIn("/None/", row.storage_key)
        self.assertEqual(storage.get(rows[first["id"]].storage_key, "local"), first_content)
        self.assertEqual(storage.get(rows[second["id"]].storage_key, "local"), second_content)
        listing = await self.call("GET", "admin/tasks/shared/attachments")
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertTrue({first["id"], second["id"]}.issubset({a["id"] for a in listing.json()}))
        # Both versions download intact through the public attachment route.
        for uploaded, content in ((first, first_content), (second, second_content)):
            response = await self.http.get(resource_access.attachment_url(uploaded["id"]))
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.content, content)
            self.assertEqual(response.headers["content-length"], str(len(content)))
            invalid = await self.http.get("/api/v1/attachments/" + uploaded["id"] + "?ticket=invalid")
            self.assertEqual(invalid.status_code, 401, invalid.text)
        async with self.sessions() as session:
            logs = (await session.scalars(select(models.AuditLog).where(
                models.AuditLog.action == "task.attachment.upload"))).all()
        self.assertEqual({row.target_id for row in logs}, {first["id"], second["id"]})
        self.assertEqual({row.actor_id for row in logs}, {"owner"})

    async def test_unauthenticated_unprivileged_and_out_of_scope_uploads_are_rejected(self):
        for who, expected in ((None, 401), ("peer", 403), ("outsider", 403)):
            with self.subTest(who=who):
                response = await self.call("POST", "admin/tasks/shared/attachments", who,
                                           files={"file": ("plan.txt", b"forbidden", "text/plain")})
                self.assertEqual(response.status_code, expected, response.text)
        self.assertEqual(list(self.storage_dir.iterdir()), [])

    async def test_missing_task_empty_and_oversized_files_do_not_write_storage(self):
        with patch.object(admin.settings, "attach_max_mb", 1):
            for tid, content, expected in (("missing", b"content", 404), ("shared", b"", 400),
                                           ("shared", b"x" * (1024 * 1024 + 1), 413)):
                with self.subTest(status=expected):
                    response = await self.call("POST", f"admin/tasks/{tid}/attachments",
                                               files={"file": ("plan.txt", content, "text/plain")})
                    self.assertEqual(response.status_code, expected, response.text)
        self.assertEqual(list(self.storage_dir.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
