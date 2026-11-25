"""Task upload quotas are shared by authenticated owners and organizations."""
import asyncio
import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import attachments
from app.models import Attachment, User


class TaskAttachmentQuotaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        url = "sqlite+aiosqlite:///" + Path(self.directory.name, "test.db").as_posix()
        self.engine = create_async_engine(url)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            for table in (User.__table__, Attachment.__table__):
                await conn.run_sync(table.create)
        async with self.sessions() as db:
            db.add_all([User(id="u1", username="one", org_id="org"),
                        User(id="u2", username="two", org_id="org")])
            await db.commit()
        self.settings = SimpleNamespace(attach_max_mb=1, attach_owner_quota_bytes=4, attach_org_quota_bytes=6)
        self.enterContext(patch.object(attachments, "get_settings", return_value=self.settings))
        self.enterContext(patch.object(attachments.storage, "_LOCAL_DIR", self.directory.name))

    async def asyncTearDown(self):
        await self.engine.dispose()
        self.directory.cleanup()

    async def upload(self, device, user, data):
        client = SimpleNamespace(id=device, user_ref=user)
        async with self.sessions() as db:
            return await attachments._save_attachment(db, client, "task-" + device, UploadFile(
                filename="input.txt", file=io.BytesIO(data)))

    async def test_simultaneous_devices_share_owner_quota_and_org_caps_other_owners(self):
        results = await asyncio.gather(self.upload("one", "u1", b"1234"),
                                       self.upload("two", "u1", b"1234"), return_exceptions=True)
        errors = [item for item in results if isinstance(item, HTTPException)]
        self.assertEqual([(item.status_code, item.detail) for item in errors], [(413, "attachment_owner_quota_exceeded")])
        async with self.sessions() as db:
            row = (await db.scalars(select(Attachment))).one()
            self.assertEqual(row.evidence_meta["sha256"], hashlib.sha256(b"1234").hexdigest())
        with self.assertRaises(HTTPException) as error:
            await self.upload("three", "u2", b"123")
        self.assertEqual(error.exception.detail, "attachment_org_quota_exceeded")
        self.assertEqual((await self.upload("three", "u2", b"12")).size, 2)

    async def test_legacy_charges_storage_failure_and_deletion_release_the_reservation(self):
        async with self.sessions() as db:
            legacy = Attachment(id="legacy", task_id="existing", uploaded_by="user:u1",
                                size=4, role="input", filename="old", storage_key="att/existing/old")
            db.add(legacy)
            await db.commit()
        with self.assertRaises(HTTPException) as error:
            await self.upload("current", "u1", b"x")
        self.assertEqual(error.exception.detail, "attachment_owner_quota_exceeded")
        async with self.sessions() as db:
            await db.delete(await db.get(Attachment, "legacy"))
            await db.commit()
        with patch.object(attachments.storage, "put_stream", side_effect=OSError("Unavailable")):
            with self.assertRaises(OSError):
                await self.upload("current", "u1", b"1234")
        self.assertEqual((await self.upload("current", "u1", b"1234")).size, 4)


if __name__ == "__main__":
    unittest.main()
