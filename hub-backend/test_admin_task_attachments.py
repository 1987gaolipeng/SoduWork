"""Administrator task attachments must each keep their own stored object."""
import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("AUTH_SECRET", "isolated-admin-attachment-test-key")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from sqlalchemy import select

from app import automation_models as am, models
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
        self.assertEqual(row["sha256"], hashlib.sha256(content).hexdigest())
        self.assertEqual(uploaded.json()["sha256"], row["sha256"])
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
        hashes = {row["id"]: row["sha256"] for row in listing.json()}
        for uploaded, content in ((first, first_content), (second, second_content)):
            self.assertEqual(uploaded["sha256"], hashlib.sha256(content).hexdigest())
            self.assertEqual(hashes[uploaded["id"]], uploaded["sha256"])
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

    async def test_withdraw_an_uploaded_file_without_affecting_a_same_name_upload(self):
        first = await self.upload(b"withdraw")
        second = await self.upload(b"keep")
        route = "admin/tasks/shared/attachments/" + first["id"]
        async with self.sessions() as session:
            key = (await session.get(models.Attachment, first["id"])).storage_key
        for who, expected in ((None, 401), ("peer", 403), ("outsider", 403)):
            self.assertEqual((await self.call("DELETE", route, who)).status_code, expected)
        async with self.sessions() as session:
            (await session.get(models.User, "peer")).role_id = "attachment-operator"
            await session.commit()
        self.assertEqual((await self.call("DELETE", route, "peer")).status_code, 403)
        self.assertEqual((await self.call("DELETE", route)).status_code, 200)
        self.assertEqual((await self.call("DELETE", route)).status_code, 404)
        self.assertEqual((await self.http.get(first["url"])).status_code, 404)
        self.assertEqual((await self.http.get(second["url"])).content, b"keep")
        with self.assertRaises(FileNotFoundError):
            storage.get(key, "local")
        listing = await self.call("GET", "admin/tasks/shared/attachments")
        self.assertNotIn(first["id"], [row["id"] for row in listing.json()])
        async with self.sessions() as session:
            events = (await session.scalars(select(models.AuditLog).where(
                models.AuditLog.action == "task.attachment.delete"))).all()
            self.assertEqual([(event.actor_id, event.target_id) for event in events], [("owner", first["id"])])

    async def test_withdrawal_preserves_other_task_and_shared_legacy_object(self):
        uploaded = await self.upload(b"shared legacy bytes")
        async with self.sessions() as session:
            row = await session.get(models.Attachment, uploaded["id"])
            key = row.storage_key
            session.add(models.Task(id="second-task", title="Second task", owner_client_id="owner"))
            session.add(models.Attachment(id="shared-object", task_id="second-task", filename=row.filename,
                                          storage_key=key, backend=row.backend, uploaded_by=row.uploaded_by))
            await session.commit()
        mismatch = await self.call("DELETE", "admin/tasks/second-task/attachments/" + uploaded["id"])
        self.assertEqual(mismatch.status_code, 404)
        self.assertEqual((await self.call("DELETE", "admin/tasks/shared/attachments/" + uploaded["id"])).status_code, 200)
        self.assertEqual(storage.get(key, "local"), b"shared legacy bytes")
        self.assertEqual((await self.call("DELETE", "admin/tasks/second-task/attachments/shared-object")).status_code, 200)
        with self.assertRaises(FileNotFoundError):
            storage.get(key, "local")

    async def test_withdrawal_keeps_handoff_and_execution_evidence(self):
        uploaded = await self.upload(b"retained")
        for role, uploader in (("handoff", "admin:owner"), ("output", "admin:owner"),
                               ("process", "admin:owner"), ("input", "agent:SoduWork")):
            async with self.sessions() as session:
                row = await session.get(models.Attachment, uploaded["id"])
                row.role, row.uploaded_by = role, uploader
                (await session.get(models.Task, "shared")).owner_user_id = "owner"
                await session.commit()
            response = await self.call("DELETE", "admin/tasks/shared/attachments/" + uploaded["id"])
            self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual((await self.http.get(uploaded["url"])).content, b"retained")

    async def test_withdrawal_keeps_files_referenced_by_a_version_or_approval(self):
        baseline = await self.upload(b"baseline")
        evidence = await self.upload(b"approval evidence")
        async with self.sessions() as session:
            session.add(am.ArtifactVersion(id="fixed", task_id="shared", kind="requirement", checksum=baseline["sha256"],
                                           manifest={"files": [{"id": baseline["id"]}]}))
            session.add(am.ApprovalRequest(task_id="shared", artifact_version_id="fixed", action="baseline",
                                           context={"gate": {"evidenceRefs": [evidence["id"]]}}))
            await session.commit()
        for row in (baseline, evidence):
            response = await self.call("DELETE", "admin/tasks/shared/attachments/" + row["id"])
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual((await self.http.get(row["url"])).status_code, 200)

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
