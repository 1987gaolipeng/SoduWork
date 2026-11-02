"""Project membership follows account identities without copying chat content."""
import json
import unittest

import httpx
from fastapi import FastAPI, Request
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.account_conversation_models import AccountConversation, ConversationProject
from app.api import conversation_projects
from app.db import Base, get_session
from app.deps import current_client
from app.models import Client


class ConversationProjectsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda c: Base.metadata.create_all(c, tables=[
                AccountConversation.__table__, ConversationProject.__table__]))
        app = FastAPI()
        app.include_router(conversation_projects.router)

        async def session():
            async with self.sessions() as value:
                yield value

        async def client(request: Request):
            return Client(id=request.headers.get("device", "pc"),
                          user_ref=request.headers.get("owner", "alice"))

        app.dependency_overrides[get_session] = session
        app.dependency_overrides[current_client] = client
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def save(self, body, **headers):
        return await self.http.put("/api/v1/conversation-projects/project-one", json=body, headers=headers)

    async def directory(self, **headers):
        return (await self.http.get("/api/v1/conversation-projects", headers=headers)).json()["items"]

    async def test_sync_before_chat_upload_retains_members_and_resolves_after_upload(self):
        made = await self.save({"name": "Project", "revision": 0, "chatIds": ["native"]})
        self.assertEqual(made.status_code, 200, made.text)
        self.assertEqual(made.json()["chatIds"], ["native"])
        phone = (await self.directory(device="phone"))[0]
        self.assertTrue(phone["chatIds"][0].startswith("member:"))
        # A metadata edit never discards the PC's not-yet-uploaded chat.
        renamed = await self.save({"name": "Renamed", "revision": 1}, device="phone")
        self.assertEqual(renamed.status_code, 200, renamed.text)
        async with self.sessions() as session:
            session.add(AccountConversation(id="mirror", owner_user_id="alice", source_client_id="pc",
                                            source_session_id="native"))
            await session.commit()
        self.assertEqual((await self.directory(device="phone"))[0]["chatIds"], ["account:mirror"])
        self.assertEqual((await self.directory())[0]["chatIds"], ["native"])
        removed = await self.save({"name": "Renamed", "revision": 2, "chatIds": []}, device="phone")
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual((await self.directory())[0]["chatIds"], [])

    async def test_revision_conflicts_and_explicit_tombstones_do_not_overwrite(self):
        await self.save({"name": "Original", "revision": 0, "chatIds": ["one"]})
        conflict = await self.save({"name": "Stale", "revision": 0, "chatIds": []}, device="phone")
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual((await self.directory())[0]["name"], "Original")
        deleted = await self.save({"name": "Original", "revision": 1, "deleted": True})
        self.assertTrue(deleted.json()["deleted"])
        self.assertEqual(deleted.json()["revision"], 2)
        self.assertEqual((await self.directory(device="phone"))[0]["revision"], 2)

    async def test_another_account_cannot_read_or_retain_foreign_members(self):
        await self.save({"name": "Private", "revision": 0, "chatIds": ["native"]})
        opaque = (await self.directory(device="phone"))[0]["chatIds"][0]
        self.assertEqual(await self.directory(owner="bob"), [])
        denied = await self.save({"name": "Other", "revision": 0, "chatIds": [opaque]}, owner="bob")
        self.assertEqual(denied.status_code, 422)
        async with self.sessions() as session:
            session.add(AccountConversation(id="private", owner_user_id="alice", source_client_id="pc",
                                            source_session_id="native"))
            await session.commit()
        denied = await self.save({"name": "Other", "revision": 0, "chatIds": ["account:private"]}, owner="bob")
        self.assertEqual(denied.status_code, 404)

    async def test_unresolved_members_survive_explicit_membership_edits(self):
        await self.save({"name": "Project", "revision": 0, "chatIds": ["native"]})
        phone = (await self.directory(device="phone"))[0]
        changed = await self.save({"name": "Project", "revision": 1,
                                   "chatIds": phone["chatIds"] + ["task:task-one"]}, device="phone")
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual((await self.directory())[0]["chatIds"], ["native", "cloud-task:task-one"])
