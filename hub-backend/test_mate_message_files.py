import base64
import tempfile
import unittest
import uuid
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models
from app.services import mate_message_files as shares, storage, team
from app.api.attachments import (delete_attachment, download_attachment,
                                 list_conversation_media,
                                 refresh_attachment_access)

class MateFilesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as c:
            await c.run_sync(models.Base.metadata.create_all)
        self.factory = async_sessionmaker(self.engine, expire_on_commit=False)
        self.session = self.factory()
        self.temp = tempfile.TemporaryDirectory()
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(storage, "_LOCAL_DIR", self.temp.name))
        self.stack.enter_context(patch.object(storage, "backend_name", return_value="local"))
        self.stack.enter_context(patch.object(shares, "get_settings", return_value=SimpleNamespace(attach_max_mb=20)))
        self.users = [models.User(id=x, username=x, display_name=x, is_active=True) for x in ("sender","recipient","other")]
        self.client = models.Client(id="device",user_ref="sender",auth_state="active")
        self.session.add_all(self.users + [self.client]);await self.session.commit()
        self.stack.enter_context(patch.object(team, "_company_members", new=AsyncMock(return_value=self.users)))
        self.payload = dict(conversationId="conversation-a",messageId=str(uuid.uuid4()),
            files=[dict(name="结果.pptx",data=base64.b64encode(b"pptx-binary\x00\xff").decode())])

    async def asyncTearDown(self):
        await self.session.close();await self.engine.dispose();self.stack.close();self.temp.cleanup()

    async def save(self):
        return await shares.save(self.session,self.client,self.users[0],self.users[1],self.payload,"请查收")

    async def test_binary_roundtrip_and_recipient_ticket(self):
        rows=await self.save();self.assertEqual(len(rows),1);self.assertNotIn("url",rows[0])
        client=SimpleNamespace(user_ref="recipient")
        meta=await shares.access(self.session,client,rows[0]["id"])
        from urllib.parse import urlparse,parse_qs
        ticket=parse_qs(urlparse(meta["url"]).query)["ticket"][0]
        response=await download_attachment(rows[0]["id"],ticket,"",self.session)
        body=b"".join([chunk async for chunk in response.body_iterator])
        self.assertEqual(body,b"pptx-binary\x00\xff")
        self.assertIn("attachment;",response.headers["content-disposition"])

    async def test_conversation_video_owner_can_refresh_and_delete(self):
        key="conversation-media/device/conversation-a/video/video.mp4"
        row=models.Attachment(
            id="conversation-video",task_id="",role="output",filename="video.mp4",
            content_type="video/mp4",storage_key=key,backend=storage.put(
                key,b"\x00\x00\x00\x18ftypmp42","video/mp4"),size=12,
            uploaded_by=self.client.id,source_ref="conversation-video:conversation-a")
        self.session.add(row);await self.session.commit()
        access=await refresh_attachment_access(row.id,self.client,self.session)
        self.assertEqual(access["attachmentId"],row.id)
        self.assertIn("ticket=",access["url"])
        recovered=await list_conversation_media("conversation-a",self.client,self.session)
        self.assertEqual([item["attachmentId"] for item in recovered["items"]],[row.id])
        self.assertEqual(await delete_attachment(row.id,self.client,self.session),{"ok":True})
        self.assertIsNone(await self.session.get(models.Attachment,row.id))
        with self.assertRaises(FileNotFoundError):storage.get(key,"local")

    async def test_retry_reuses_snapshot_but_changed_request_is_rejected(self):
        rows=await self.save();self.assertEqual(await self.save(),rows)
        all_rows=(await self.session.execute(select(models.Attachment))).scalars().all();self.assertEqual(len(all_rows),1)
        self.payload["files"][0]["data"]="eA=="
        with self.assertRaises(HTTPException) as ctx:await self.save()
        self.assertEqual(ctx.exception.status_code,409)

    async def test_other_user_and_deactivated_recipient_denied(self):
        aid=(await self.save())[0]["id"]
        for uid in ("other","unknown"):
            with self.assertRaises(HTTPException):await shares.access(self.session,SimpleNamespace(user_ref=uid),aid)
        self.users[1].is_active=False;await self.session.commit()
        with self.assertRaises(HTTPException):await shares.access(self.session,SimpleNamespace(user_ref="recipient"),aid)

    async def test_original_task_permissions_are_required_and_input_is_rejected(self):
        self.session.add(models.Attachment(id="task-output",task_id="task",role="output",filename="report.md",
            storage_key="original",backend=storage.put("original",b"report","text/plain"),size=6))
        await self.session.commit();self.payload["files"]=[{"attachmentId":"task-output"}]
        with patch.object(shares.task_access,"view_task",new=AsyncMock(side_effect=HTTPException(404,"no"))):
            with self.assertRaises(HTTPException):await self.save()
        with patch.object(shares.task_access,"view_task",new=AsyncMock()) as check:
            rows=await self.save();check.assert_awaited_once()
            self.assertNotEqual(rows[0]["id"],"task-output")
        row=await self.session.get(models.Attachment,"task-output");row.role="input";await self.session.commit()
        self.payload["messageId"]=str(uuid.uuid4())
        with self.assertRaises(HTTPException):await self.save()

    async def test_rejects_invalid_content_before_any_write(self):
        for files in ([{"name":"report.md","data":"not base64!"}], [{}], [{}]*21):
            self.payload["files"]=files
            with self.assertRaises(HTTPException):await self.save()
        rows=(await self.session.execute(select(models.Attachment))).scalars().all();self.assertEqual(rows,[])

    async def test_no_files_preserves_plain_messages(self):
        self.assertEqual(await shares.save(self.session,self.client,*self.users[:2],{},"plain"),[])

    async def test_storage_failure_rolls_back_all_files(self):
        self.payload["files"].append({"name":"b.txt","data":"Yg=="})
        original=storage.put
        def put(key,data,mime):
            if key.endswith("b.txt"):raise OSError("offline")
            return original(key,data,mime)
        with patch.object(storage,"put",side_effect=put):
            with self.assertRaises(OSError):await self.save()
        from pathlib import Path
        self.assertEqual(list(Path(self.temp.name).iterdir()),[])
        self.assertEqual(list((await self.session.execute(select(models.Attachment))).scalars()),[])

    async def test_actual_notice_contains_recipient_bound_files_without_payload_or_tickets(self):
        from app import realtime
        with patch.object(team.task_assignment,"active_devices",new=AsyncMock(return_value=[SimpleNamespace(id="receiver-device")])), \
             patch.object(realtime.hub,"publish",new=AsyncMock()) as publish, \
             patch.object(realtime.hub,"is_online",return_value=True):
            result=await team.message_mate(self.session,self.client,"recipient","请查收",self.payload)
            self.assertFalse(result["delivered"])
            event=next(call.args[1] for call in publish.await_args_list if call.args[1].get("type") == "notice")
            self.assertEqual(event["attachments"][0]["name"],"结果.pptx")
            self.assertNotIn("data",event["attachments"][0]);self.assertNotIn("url",event["attachments"][0])

if __name__=="__main__":unittest.main()
