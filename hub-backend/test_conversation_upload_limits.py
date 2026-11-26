"""Small in-process regression fixtures for the desktop delivery form."""
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import APIRouter, FastAPI, File, Form, UploadFile

from app.api import conversation_upload as uploads


class ConversationUploadLimitsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.spools = []
        app = FastAPI()
        router = APIRouter(route_class=uploads.DeliveryUploadRoute)

        @router.post("/fixture")
        async def receive(files: list[UploadFile] = File(), paths: list[str] = Form()):
            self.calls.append(paths)
            return [file.size for file in files]

        app.include_router(router)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture")
        self.addAsyncCleanup(self.client.aclose)
        self.enterContext(patch.object(uploads, "MAX_BATCH_BYTES", 8))
        self.enterContext(patch.object(uploads, "MAX_DELIVERY_FILES", 2))
        self.enterContext(patch.object(uploads, "get_settings", return_value=SimpleNamespace(attach_max_mb=4 / 2**20)))

        def spool(*args, **kwargs):
            self.spools.append(tempfile.SpooledTemporaryFile(*args, **kwargs))
            return self.spools[-1]

        self.enterContext(patch("starlette.formparsers.SpooledTemporaryFile", side_effect=spool))

    async def upload(self, sizes):
        files = [("files", (f"part-{index}.txt", b"a" * size)) for index, size in enumerate(sizes)]
        paths = [file[0] for _, file in files]
        return await self.client.post("/fixture", files=files, data={"paths": paths})

    async def test_exact_limits_bind_and_close_all_files(self):
        response = await self.upload([4, 4])
        self.assertEqual(response.json(), [4, 4])
        self.assertEqual(self.calls, [["part-0.txt", "part-1.txt"]])
        self.assertTrue(all(file.closed for file in self.spools))

    async def test_rejects_whole_batch_and_closes_files(self):
        for sizes in ([1, 5], [1, 1, 1], [4, 4]):
            with self.subTest(sizes=sizes), patch.object(uploads, "MAX_BATCH_BYTES", 7):
                response = await self.upload(sizes)
                self.assertEqual(response.status_code, 413)
                self.assertFalse(self.calls)
                self.assertTrue(self.spools and all(file.closed for file in self.spools))

    async def test_declared_length_is_rejected_before_any_file_is_opened(self):
        with patch.object(uploads, "FORM_OVERHEAD_BYTES", 8):
            response = await self.upload([1])
        self.assertEqual(response.status_code, 413)
        self.assertFalse(self.spools)
        self.assertFalse(self.calls)

    async def test_task_delivery_router_enforces_limits_before_ingestion(self):
        from app.api import tasks

        app = FastAPI()
        app.include_router(tasks.router)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
            response = await client.post("/api/v1/tasks/fixture/conversation-delivery",
                                         files=[("files", ("first.txt", b"a")), ("files", ("second.txt", b"12345"))])
        self.assertEqual(response.status_code, 413)
        self.assertTrue(self.spools and all(file.closed for file in self.spools))

    async def test_streamed_form_enforces_wire_and_metadata_limits(self):
        request = self.client.build_request("POST", "/fixture", files={"files": ("file.txt", b"a")},
                                            data={"paths": "file.txt"})
        body = await request.aread()
        for batch_limit in (8, len(body) * 2):
            with self.subTest(batch_limit=batch_limit), patch.object(uploads, "MAX_BATCH_BYTES", batch_limit), \
                    patch.object(uploads, "FORM_OVERHEAD_BYTES", len(body) - 16):
                async def chunks():
                    yield body[:-24]
                    yield body[-24:]

                response = await self.client.post("/fixture", content=chunks(),
                                                  headers={"content-type": request.headers["content-type"]})
                self.assertEqual(response.status_code, 413)
                self.assertFalse(self.calls)
                self.assertTrue(self.spools and all(file.closed for file in self.spools))
